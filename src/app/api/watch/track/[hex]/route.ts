/**
 * The live position of one aircraft.
 *
 * The feed snapshot is a global sweep cached for a minute, which is the right
 * trade for twenty thousand dots and the wrong one for the aircraft an operator
 * has selected. This asks adsb.lol for that hex alone, so the selection moves
 * on real fixes rather than on dead reckoning between sweeps.
 *
 * Briefly cached in module state so several viewers watching the same aircraft
 * are one request upstream, not one each.
 */

import { NextResponse } from "next/server";

import { fetchAdsbOne } from "@/lib/watch/adsb";
import type { Track } from "@/lib/watch/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Comfortably under the client's poll interval, so it never serves a stale fix. */
const TTL_MS = 2_000;
/** Bounds the cache: a watch floor has a handful of selections, not thousands. */
const MAX_ENTRIES = 50;

type Entry = { at: number; track: Track | null };

const globalRef = globalThis as typeof globalThis & {
  __liveTrackCache?: Map<string, Entry>;
  __liveTrackInflight?: Map<string, Promise<Track | null>>;
};

const cache = (globalRef.__liveTrackCache ??= new Map<string, Entry>());
const inflight = (globalRef.__liveTrackInflight ??= new Map<string, Promise<Track | null>>());

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ hex: string }> },
) {
  const { hex: raw } = await params;
  const hex = raw.trim().toLowerCase();

  if (!/^[0-9a-f]{6}$/.test(hex)) {
    return NextResponse.json(
      { track: null },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const cached = cache.get(hex);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json(
      { track: cached.track },
      { headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const pending =
      inflight.get(hex) ??
      fetchAdsbOne(hex)
        .then((track) => {
          if (cache.size >= MAX_ENTRIES) {
            const oldest = cache.keys().next();
            if (!oldest.done) cache.delete(oldest.value);
          }
          cache.set(hex, { at: Date.now(), track });
          return track;
        })
        .finally(() => {
          inflight.delete(hex);
        });
    inflight.set(hex, pending);

    return NextResponse.json(
      { track: await pending },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    // No live fix is not an error the console needs to show: the caller falls
    // back to the sweep's own position for this aircraft.
    return NextResponse.json(
      { track: null, error: e instanceof Error ? e.message : String(e) },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
