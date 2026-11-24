import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import { io } from "socket.io-client";

const port = 32000 + (process.pid % 10000);
const baseUrl = `http://127.0.0.1:${port}`;
let server;
const clients = [];

function connectClient() {
  return new Promise((resolve, reject) => {
    const socket = io(baseUrl, { reconnection: false, timeout: 5000 });
    clients.push(socket);
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(3000).emit(event, payload, (error, response) => {
      if (error) reject(error);
      else resolve(response);
    });
  });
}

function isValidSlap(values) {
  const cards = values.slice(-3);
  if (cards.length >= 2) {
    const a = cards[cards.length - 2];
    const b = cards[cards.length - 1];
    if (a === b || a + b === 10) return true;
  }
  if (cards.length >= 3) {
    const [a, b, c] = cards;
    if (a === c || (b === a + 1 && c === b + 1) || (b === a - 1 && c === b - 1)) return true;
  }
  return false;
}

async function waitForState(getState, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = getState();
    if (state && predicate(state)) return state;
    await delay(10);
  }
  throw new Error("Timed out waiting for expected game state");
}

test("wrong-slap penalty cards stay out of the pile for 600ms", { timeout: 30000 }, async t => {
  server = spawn(process.execPath, ["index.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  server.stdout.on("data", chunk => { serverOutput += chunk.toString(); });
  server.stderr.on("data", chunk => { serverOutput += chunk.toString(); });

  try {
    const healthDeadline = Date.now() + 8000;
    let healthy = false;
    while (Date.now() < healthDeadline) {
      try {
        const response = await fetch(`${baseUrl}/health`);
        if (response.ok) { healthy = true; break; }
      } catch {}
      await delay(100);
    }
    assert.equal(healthy, true, `server failed to start: ${serverOutput}`);

    const [a, b] = await Promise.all([connectClient(), connectClient()]);
    let stateA;
    let stateB;
    a.on("state", state => { stateA = state; });
    b.on("state", state => { stateB = state; });

    const created = await emitAck(a, "createRoom", { name: "Test A", playerToken: "test-a" });
    assert.equal(created.ok, true);
    const joined = await emitAck(b, "joinRoom", { code: created.code, name: "Test B", playerToken: "test-b" });
    assert.equal(joined.ok, true);
    assert.equal((await emitAck(a, "startGame")).ok, true);
    await waitForState(() => stateA, s => s.status === "playing");

    // Play until the pile has a pattern that is definitely not slap-valid.
    let invalidPile;
    for (let turn = 0; turn < 30; turn++) {
      const state = await waitForState(() => stateA, s => s.status === "playing" && s.turnPlayerId);
      const playerSocket = state.turnPlayerId === a.id ? a : b;
      const previousLength = state.pile.length;
      assert.equal((await emitAck(playerSocket, "playCard")).ok, true);
      const next = await waitForState(() => stateA, s => s.pile.length > previousLength);
      const values = next.pile.filter(card => !card.hidden).map(card => card.value);
      if (values.length >= 2 && !isValidSlap(values)) {
        invalidPile = next;
        break;
      }
    }
    assert.ok(invalidPile, "could not produce an invalid pile in 30 plays");

    const pileLengthBefore = invalidPile.pile.length;
    const snapshot = invalidPile.pile.map(card => card.pileEntryId);
    const slap = await emitAck(a, "slap", { pileCardIds: snapshot });
    assert.equal(slap.ok, true);
    assert.equal(slap.correct, false);
    assert.equal(slap.penalty, 2);

    const penaltyState = await waitForState(
      () => stateA,
      s => s.lastSlap?.type === "penalty" && s.lastSlap.playerId === a.id
    );
    assert.equal(penaltyState.pile.length, pileLengthBefore);

    // At 450ms, the configured 600ms grace period must still be holding the cards.
    await delay(450);
    assert.equal(stateA.pile.length, pileLengthBefore, "penalty cards entered the pile before 600ms");

    // After the grace period, both penalty cards must be appended.
    await waitForState(() => stateA, s => s.pile.length === pileLengthBefore + 2, 1500);
    assert.equal(stateA.pile.length, pileLengthBefore + 2);
  } finally {
    for (const socket of clients) socket.disconnect();
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      await Promise.race([once(server, "exit"), delay(2000)]);
    }
  }
});
