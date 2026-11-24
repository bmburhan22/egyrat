import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";
import { randomInt } from "node:crypto";

const app = express();
app.use(cors({ origin: process.env.CLIENT_ORIGIN?.split(",") ?? "*" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_ORIGIN?.split(",") ?? "*", methods: ["GET", "POST"] }
});

const rooms = new Map();
const DEFAULT_CARD_COPIES = 4;
const MIN_CARD_COPIES = 1;
const MAX_CARD_COPIES = 8;

function makeDeck(cardCopies) {
  return Array.from({ length: 10 * cardCopies }, (_, index) => ({
    id: `card-${index + 1}`,
    value: Math.floor(index / cardCopies)
  }));
}

function shuffle(cards) {
  const result = [...cards];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function roomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => chars[randomInt(chars.length)]).join("");
}

function normalizeRoomCode(value) {
  const raw = String(value || "").trim();
  try {
    const fromUrl = new URL(raw).searchParams.get("room");
    if (fromUrl) return fromUrl.trim().toUpperCase();
  } catch { /* A plain room code is also valid. */ }
  if (raw.includes("room=")) {
    const query = raw.slice(raw.indexOf("room="));
    const fromQuery = new URLSearchParams(query).get("room");
    if (fromQuery) return fromQuery.trim().toUpperCase();
  }
  return raw.toUpperCase();
}

function publicState(room, viewerId) {
  return {
    code: room.code,
    status: room.status,
    cardCopies: room.cardCopies,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      count: p.cards.length,
      connected: p.connected
    })),
    pile: room.pile.map(entry => entry.faceUp ? entry.card : { hidden: true }),
    turnPlayerId: room.turnPlayerId,
    myCards: room.players.find(p => p.id === viewerId)?.cards.length ?? 0,
    winnerId: room.winnerId ?? null,
    lastAction: room.lastAction ?? null,
    lastSlap: room.lastSlap ?? null,
    lastPlay: room.lastPlay ?? null
  };
}

function emitRoom(room) {
  for (const p of room.players) {
    if (p.connected) io.to(p.id).emit("state", publicState(room, p.id));
  }
}

function findRoomForSocket(socketId) {
  for (const room of rooms.values()) {
    const player = room.players.find(p => p.id === socketId);
    if (player) return { room, player };
  }
  return null;
}

function nextPlayer(room, fromId) {
  if (!room.players.length) return null;
  const start = room.players.findIndex(p => p.id === fromId);
  for (let step = 1; step <= room.players.length; step++) {
    const p = room.players[(start + step + room.players.length) % room.players.length];
    if (p.cards.length > 0 && p.connected) return p.id;
  }
  return null;
}

function visibleTail(pile) {
  const tail = [];
  for (let i = pile.length - 1; i >= 0 && tail.length < 3; i--) {
    if (!pile[i].faceUp) break;
    tail.unshift(pile[i].card);
  }
  return tail;
}

function hasValidSlap(pile) {
  const cards = visibleTail(pile);
  if (cards.length >= 2) {
    const a = cards[cards.length - 2];
    const b = cards[cards.length - 1];
    if (a.value === b.value) return "Doubles";
    if (a.value + b.value === 10) return "Sum to 10";
  }
  if (cards.length >= 3) {
    const a = cards[cards.length - 3];
    const b = cards[cards.length - 2];
    const c = cards[cards.length - 1];
    if (a.value === c.value) return "Sandwich";
    const ascending = b.value === a.value + 1 && c.value === b.value + 1;
    const descending = b.value === a.value - 1 && c.value === b.value - 1;
    if (ascending || descending) return "Three consecutive";
  }
  return null;
}

function finishIfNeeded(room) {
  const playersWithCards = room.players.filter(p => p.cards.length > 0);
  if (playersWithCards.length === 1) {
    const winner = playersWithCards[0];
    room.status = "finished";
    room.winnerId = winner.id;
    room.turnPlayerId = null;
    room.lastAction = `${winner.name} is the last player with cards and wins!`;
    return true;
  }
  if (playersWithCards.length === 0) {
    room.status = "finished";
    room.winnerId = null;
    room.turnPlayerId = null;
    room.lastAction = "Game over: no players have cards left.";
    return true;
  }
  return false;
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name, playerToken }, ack = () => {}) => {
    const cleanName = String(name || "Player").trim().slice(0, 18) || "Player";
    let code;
    do code = roomCode(); while (rooms.has(code));
    const player = { id: socket.id, token: String(playerToken || ""), name: cleanName, cards: [], connected: true, disconnectedAt: null };
    const room = {
      code, players: [player], pile: [], status: "lobby", cardCopies: DEFAULT_CARD_COPIES,
      turnPlayerId: null, winnerId: null, lastAction: `${cleanName} created the room.`, lastSlap: null, lastPlay: null, actionSeq: 0
    };
    rooms.set(code, room);
    socket.join(code);
    ack({ ok: true, code, invitePath: `/?room=${code}` });
    emitRoom(room);
  });

  socket.on("joinRoom", ({ code, name, playerToken }, ack = () => {}) => {
    const room = rooms.get(normalizeRoomCode(code));
    if (!room) return ack({ ok: false, error: "Room not found." });
    const cleanName = String(name || "Player").trim().slice(0, 18) || "Player";
    const token = String(playerToken || "").slice(0, 128);

    // Reclaim the existing player record, including their cards and seat.
    const returningPlayer = token ? room.players.find(p => p.token === token) : null;
    if (returningPlayer) {
      if (returningPlayer.connected && returningPlayer.id !== socket.id) {
        return ack({ ok: false, error: "This player is already connected." });
      }
      returningPlayer.id = socket.id;
      returningPlayer.connected = true;
      returningPlayer.disconnectedAt = null;
      if (room.status === "playing" && !room.turnPlayerId && returningPlayer.cards.length > 0) {
        room.turnPlayerId = returningPlayer.id;
      }
      socket.join(room.code);
      room.lastAction = `${returningPlayer.name} reconnected.`;
      ack({ ok: true, code: room.code, invitePath: `/?room=${room.code}`, reconnected: true });
      emitRoom(room);
      return;
    }

    // New players can only join before the game starts.
    if (room.status !== "lobby") return ack({ ok: false, error: "Game has already started. Only players who were already in this room can rejoin." });
    if (room.players.length >= 40) return ack({ ok: false, error: "Room is full (40-player limit)." });
    if (room.players.some(p => p.name.toLowerCase() === cleanName.toLowerCase())) {
      return ack({ ok: false, error: "That name is already taken in this room." });
    }
    room.players.push({ id: socket.id, token, name: cleanName, cards: [], connected: true, disconnectedAt: null });
    socket.join(room.code);
    ack({ ok: true, code: room.code, invitePath: `/?room=${room.code}` });
    room.lastAction = `${cleanName} joined.`;
    emitRoom(room);
  });

  socket.on("setCardCopies", ({ copies }, ack = () => {}) => {
    const found = findRoomForSocket(socket.id);
    if (!found) return ack({ ok: false, error: "Join a room first." });
    const { room, player } = found;
    if (room.players[0].id !== player.id) return ack({ ok: false, error: "Only the room host can change deck settings." });
    if (room.status !== "lobby") return ack({ ok: false, error: "Deck settings are locked after the game starts." });
    const parsed = Number(copies);
    if (!Number.isInteger(parsed) || parsed < MIN_CARD_COPIES || parsed > MAX_CARD_COPIES) return ack({ ok: false, error: `Choose between ${MIN_CARD_COPIES} and ${MAX_CARD_COPIES} copies.` });
    room.cardCopies = parsed;
    room.lastAction = `${player.name} set ${parsed} copies of each number (${10 * parsed} cards total).`;
    ack({ ok: true });
    emitRoom(room);
  });

  socket.on("startGame", (_payload, ack = () => {}) => {
    const found = findRoomForSocket(socket.id);
    if (!found) return ack({ ok: false, error: "Join a room first." });
    const { room, player } = found;
    if (room.players[0].id !== player.id) return ack({ ok: false, error: "Only the room host can start." });
    if (room.status !== "lobby") return ack({ ok: false, error: "Game already started." });
    if (room.players.length < 2) return ack({ ok: false, error: "At least 2 players are required." });
    if (room.players.length > 10 * room.cardCopies) return ack({ ok: false, error: `This deck has ${10 * room.cardCopies} cards. Increase copies or reduce the player count.` });

    const deck = shuffle(makeDeck(room.cardCopies));
    room.players.forEach(p => { p.cards = []; });
    deck.forEach((card, i) => room.players[i % room.players.length].cards.push(card));
    room.players.forEach(p => { p.cards = shuffle(p.cards); });
    room.pile = [];
    room.status = "playing";
    room.turnPlayerId = room.players[0].id;
    room.winnerId = null;
    room.lastAction = "Game started. " + room.players[0].name + " plays first.";
    ack({ ok: true });
    emitRoom(room);
  });

  socket.on("playCard", (_payload, ack = () => {}) => {
    const found = findRoomForSocket(socket.id);
    if (!found) return ack({ ok: false, error: "You are not in a room." });
    const { room, player } = found;
    if (room.status !== "playing") return ack({ ok: false, error: "Game is not in progress." });
    if (room.turnPlayerId !== player.id) return ack({ ok: false, error: "It is not your turn." });
    if (!player.cards.length) return ack({ ok: false, error: "You are out of cards and cannot play." });

    const card = player.cards.pop();
    room.pile.push({ card, faceUp: true });
    room.actionSeq = (room.actionSeq || 0) + 1;
    room.lastPlay = { id: room.actionSeq, playerId: player.id, value: card.value };
    room.turnPlayerId = nextPlayer(room, player.id);
    room.lastAction = `${player.name} played a card.`;
    if (!finishIfNeeded(room) && !room.turnPlayerId) {
      room.status = "finished";
      room.winnerId = null;
      room.lastAction = "Game over: no players have cards left.";
    }
    ack({ ok: true });
    emitRoom(room);
  });

  socket.on("slap", (_payload, ack = () => {}) => {
    const found = findRoomForSocket(socket.id);
    if (!found) return ack({ ok: false, error: "You are not in a room." });
    const { room, player } = found;
    if (room.status !== "playing") return ack({ ok: false, error: "Game is not in progress." });
    if (player.cards.length === 0) return ack({ ok: false, error: "You are out of cards and cannot slap." });

    const pattern = hasValidSlap(room.pile);
    if (pattern) {
      const claimedCards = room.pile.map(entry => entry.card);
      player.cards.push(...claimedCards);
      room.actionSeq = (room.actionSeq || 0) + 1;
      room.lastSlap = { id: room.actionSeq, type: "win", playerId: player.id, cardCount: claimedCards.length, cards: claimedCards.map(card => card.value) };
      room.pile = [];
      room.turnPlayerId = player.id;
      room.lastAction = `${player.name} slapped correctly (${pattern}) and won the middle pile.`;
      finishIfNeeded(room);
      ack({ ok: true, correct: true, pattern });
    } else {
      const penalty = player.cards.splice(Math.max(0, player.cards.length - 2), 2);
      room.pile.push(...penalty.map(card => ({ card, faceUp: true })));
      room.actionSeq = (room.actionSeq || 0) + 1;
      room.lastSlap = { id: room.actionSeq, type: "penalty", playerId: player.id, cards: penalty.map(card => card.value) };
      room.lastAction = `${player.name} slapped incorrectly and added ${penalty.length} face-up penalty card(s) to the middle pile.`;
      if (player.cards.length === 0 && room.turnPlayerId === player.id) {
        room.turnPlayerId = nextPlayer(room, player.id);
      }
      finishIfNeeded(room);
      ack({ ok: true, correct: false, penalty: penalty.length });
    }
    emitRoom(room);
  });

  socket.on("disconnect", () => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    const { room, player } = found;
    player.connected = false;
    player.disconnectedAt = Date.now();
    room.lastAction = `${player.name} disconnected. They can rejoin this room.`;
    if (room.status === "playing" && room.turnPlayerId === player.id) {
      room.turnPlayerId = nextPlayer(room, player.id);
      // Keep the room available if everyone is temporarily disconnected.
    }
    emitRoom(room);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`ERS server listening on ${PORT}`));
