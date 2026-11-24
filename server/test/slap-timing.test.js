import test from "node:test";
import assert from "node:assert/strict";
import { adjustedArrivalTime, chooseSlapCandidate, estimateOneWayLatency } from "../slap-timing.js";

test("estimates one-way latency from the minimum server-measured RTT", () => {
  assert.equal(estimateOneWayLatency([58, 64, 71]), 29);
  assert.equal(estimateOneWayLatency([]), 0);
  assert.equal(estimateOneWayLatency([Infinity, -1, 400]), 100);
});

test("caps compensation and never allows a negative compensation", () => {
  assert.equal(adjustedArrivalTime(1000, 250), 900);
  assert.equal(adjustedArrivalTime(1000, -10), 1000);
});

test("corrects server arrival ordering when the slower route has higher RTT", () => {
  const laptop = { playerId: "laptop", receivedAt: 1010, oneWayLatencyMs: 5 };
  const phone = { playerId: "phone", receivedAt: 1060, oneWayLatencyMs: 55 };
  assert.equal(chooseSlapCandidate([laptop, phone], () => 0).playerId, "phone");
});

test("uses a random tie-break inside the configured timing tolerance", () => {
  const a = { playerId: "a", receivedAt: 1000, oneWayLatencyMs: 0 };
  const b = { playerId: "b", receivedAt: 1002, oneWayLatencyMs: 0 };
  assert.equal(chooseSlapCandidate([a, b], () => 0).playerId, "a");
  assert.equal(chooseSlapCandidate([a, b], () => 0.99).playerId, "b");
});
