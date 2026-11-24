import { randomInt } from "node:crypto";

export const MAX_ONE_WAY_COMPENSATION_MS = 100;
export const SLAP_TIE_WINDOW_MS = 3;

// RTT is measured by the server from Engine.IO ping creation to pong receipt.
// Half the minimum recent RTT is a conservative baseline estimate of one-way
// latency. It cannot model asymmetric routes or transient jitter perfectly.
export function estimateOneWayLatency(rttSamples, maxMs = MAX_ONE_WAY_COMPENSATION_MS) {
  const valid = (Array.isArray(rttSamples) ? rttSamples : [])
    .filter(value => Number.isFinite(value) && value >= 0);
  if (!valid.length) return 0;
  return Math.min(maxMs, Math.min(...valid) / 2);
}

export function adjustedArrivalTime(receivedAt, oneWayLatencyMs) {
  const compensation = Number.isFinite(oneWayLatencyMs)
    ? Math.max(0, Math.min(MAX_ONE_WAY_COMPENSATION_MS, oneWayLatencyMs))
    : 0;
  return receivedAt - compensation;
}

export function chooseSlapCandidate(candidates, pickIndex = max => randomInt(max)) {
  if (!candidates.length) return null;
  const ordered = [...candidates].sort((a, b) =>
    adjustedArrivalTime(a.receivedAt, a.oneWayLatencyMs) -
    adjustedArrivalTime(b.receivedAt, b.oneWayLatencyMs)
  );
  const earliest = adjustedArrivalTime(ordered[0].receivedAt, ordered[0].oneWayLatencyMs);
  const tied = ordered.filter(candidate =>
    adjustedArrivalTime(candidate.receivedAt, candidate.oneWayLatencyMs) <= earliest + SLAP_TIE_WINDOW_MS
  );
  return tied[pickIndex(tied.length)];
}
