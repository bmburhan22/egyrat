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
const CARD_COPIES = Math.max(1, Math.min(8, Number.parseInt(process.env.CARD_COPIES || "2", 10) || 2));
const DECK_SIZE = 10 * CARD_COPIES;

function makeDeck() {
  return Array.from({ length: DECK_SIZE }, (_, index) => ({
    id: `card-${index + 1}`,
    value: Math.floor(index / CARD_COPIES)
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

function publicState(room, viewerId) {
  return {
    code: room.code,
    status: room.status,
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
    lastAction: room.lastAction ?? null
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
  const winner = room.players.find(p => p.cards.length === DECK_SIZE);
  if (winner) {
    room.status = "finished";
    room.winnerId = winner.id;
    room.lastAction = `${winner.name} collected all ${DECK_SIZE} cards and wins!`;
    return true;
  }
  return false;
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name }, ack = () => {}) => {
    const cleanName = String(name || "Player").trim().slice(0, 18) || "Player";
    let code;
    do code = roomCode(); while (rooms.has(code));
    const player = { id: socket.id, name: cleanName, cards: [], connected: true };
    const room = {
      code, players: [player], pile: [], status: "lobby",
      turnPlayerId: null, winnerId: null, lastAction: `${cleanName} created the room.`
    };
    rooms.set(code, room);
    socket.join(code);
    ack({ ok: true, code });
    emitRoom(room);
  });

  socket.on("joinRoom", ({ code, name }, ack = () => {}) => {
    const room = rooms.get(String(code || "").trim().toUpperCase());
    if (!room) return ack({ ok: false, error: "Room not found." });
    if (room.status !== "lobby") return ack({ ok: false, error: "Game has already started." });
    if (room.players.length >= 40) return ack({ ok: false, error: "Room is full (40-player limit)." });
    const cleanName = String(name || "Player").trim().slice(0, 18) || "Player";
    if (room.players.some(p => p.name.toLowerCase() === cleanName.toLowerCase())) {
      return ack({ ok: false, error: "That name is already taken in this room." });
    }
    room.players.push({ id: socket.id, name: cleanName, cards: [], connected: true });
    socket.join(room.code);
    ack({ ok: true, code: room.code });
    room.lastAction = `${cleanName} joined.`;
    emitRoom(room);
  });

  socket.on("startGame", (_payload, ack = () => {}) => {
    const found = findRoomForSocket(socket.id);
    if (!found) return ack({ ok: false, error: "Join a room first." });
    const { room, player } = found;
    if (room.players[0].id !== player.id) return ack({ ok: false, error: "Only the room host can start." });
    if (room.status !== "lobby") return ack({ ok: false, error: "Game already started." });
    if (room.players.length < 2) return ack({ ok: false, error: "At least 2 players are required." });

    const deck = shuffle(makeDeck());
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
    if (!player.cards.length) return ack({ ok: false, error: "You have no cards to play. You can still slap." });

    const card = player.cards.pop();
    room.pile.push({ card, faceUp: true });
    const nextId = nextPlayer(room, player.id);
    room.turnPlayerId = nextId;
    room.lastAction = `${player.name} played a card.`;
    if (!nextId && !hasValidSlap(room.pile)) {
      player.cards.push(...room.pile.map(entry => entry.card));
      room.pile = [];
      room.status = "finished";
      room.winnerId = player.id;
      room.lastAction = `${player.name} wins: nobody else has cards to play.`;
    } else {
      finishIfNeeded(room);
    }
    ack({ ok: true });
    emitRoom(room);
  });

  socket.on("slap", (_payload, ack = () => {}) => {
    const found = findRoomForSocket(socket.id);
    if (!found) return ack({ ok: false, error: "You are not in a room." });
    const { room, player } = found;
    if (room.status !== "playing") return ack({ ok: false, error: "Game is not in progress." });

    const pattern = hasValidSlap(room.pile);
    if (pattern) {
      player.cards.push(...room.pile.map(entry => entry.card));
      room.pile = [];
      room.turnPlayerId = player.id;
      room.lastAction = `${player.name} slapped correctly (${pattern}) and won the middle pile.`;
      finishIfNeeded(room);
      ack({ ok: true, correct: true, pattern });
    } else {
      const penalty = player.cards.splice(Math.max(0, player.cards.length - 2), 2);
      room.pile.push(...penalty.map(card => ({ card, faceUp: false })));
      room.lastAction = `${player.name} slapped incorrectly and added ${penalty.length} face-down penalty card(s) to the middle pile.`;
      ack({ ok: true, correct: false, penalty: penalty.length });
    }
    emitRoom(room);
  });

  socket.on("disconnect", () => {
    const found = findRoomForSocket(socket.id);
    if (!found) return;
    const { room, player } = found;
    player.connected = false;
    room.lastAction = `${player.name} disconnected.`;
    if (room.status === "lobby") {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (!room.players.length) rooms.delete(room.code);
    } else if (room.status === "playing" && room.turnPlayerId === player.id) {
      room.turnPlayerId = nextPlayer(room, player.id);
      finishIfNeeded(room);
    }
    emitRoom(room);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`ERS server listening on ${PORT}`));
