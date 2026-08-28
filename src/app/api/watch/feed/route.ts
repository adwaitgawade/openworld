/**
 * One snapshot of everything the watch floor is looking at.
 *
 * Air and surface have very different cadences — a polled REST call versus a
 * standing AIS socket — but the console wants a single consistent picture per
 * tick, so both are read here and returned together with the alerts derived
 * from them.
 */

import { NextResponse } from "next/server";

import { airFeed } from "@/lib/watch/air";
import { deriveAlerts } from "@/lib/watch/alerts";
import {
  aisConfigured,
  aisStatus,
  aisTracks,
  ensureAisConnected,
} from "@/lib/watch/aisstream";
import type { FeedHealth, FeedSnapshot } from "@/lib/watch/types";

// The AIS socket and the air cache both live in module state, which only works
// on a long-lived Node process.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function seaHealth(now: number, newestFix: number, count: number): FeedHealth {
  if (!aisConfigured()) {
    return {
      source: "aisstream",
      integrity: null,
      latencySec: null,
      status: "down",
      note: "AISSTREAM_API_KEY not set — surface layer is empty",
    };
  }

  const ais = aisStatus();
  if (ais.status !== "open") {
    return {
      source: "aisstream",
      integrity: 0,
      latencySec: null,
      status: ais.status === "connecting" ? "degraded" : "down",
      note: ais.error ?? `socket ${ais.status}`,
    };
  }

  // A socket that has just opened has a legitimately thin store; say "filling"
  // rather than reporting a real feed as degraded.
  const filling = ais.connectedAt != null && now - ais.connectedAt < 60_000;
  return {
    source: "aisstream",
    integrity: count > 0 ? 1 : 0,
    latencySec: newestFix ? Math.max(0, Math.round((now - newestFix) / 1000)) : null,
    status: count > 0 ? "ok" : filling ? "degraded" : "down",
    note: filling ? `filling · ${count} hulls` : null,
  };
}

export async function GET() {
  ensureAisConnected();

  const now = Date.now();
  const air = await airFeed();
  const sea = aisTracks();
  const tracks = [...air.tracks, ...sea];
  const newestSea = sea.reduce((max, t) => Math.max(max, t.fixedAt), 0);

  const snapshot: FeedSnapshot = {
    ts: now,
    tracks,
    alerts: deriveAlerts(tracks, now),
    health: {
      air: air.health,
      sea: seaHealth(now, newestSea, sea.length),
    },
  };

  return NextResponse.json(snapshot, {
    headers: { "cache-control": "no-store" },
  });
}
