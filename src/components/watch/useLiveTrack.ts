"use client";

import { useEffect, useState } from "react";

import type { Track } from "@/lib/watch/types";

/**
 * How often the selected aircraft is re-asked for.
 *
 * adsb.lol answers a single hex in well under a second with a sub-second-old
 * fix, and rate-limits at roughly one request a second, so five seconds is
 * comfortable for it and far finer than the sixty-second global sweep. Chosen
 * for that rather than for OpenSky, whose single-aircraft query costs a credit
 * against a 4 000/day allowance — 720 an hour would drain it by mid-afternoon.
 */
const POLL_MS = 5_000;

/** Feeds report altitude in feet; the globe wants metres. */
const FT_TO_M = 0.3048;

/** An hour of five-second fixes. Beyond that the oldest are dropped. */
const MAX_PATH_POINTS = 720;

/** Below this the aircraft has not moved enough to be worth another vertex. */
const MIN_STEP_DEG = 1e-4;

export type LiveTrack = {
  /** The freshest fix, or null while there is none. */
  track: Track | null;
  /** Fixes since this aircraft was selected, oldest first, lon/lat/metres. */
  path: [number, number, number][];
  /** When live tracking began, so older history can be joined in front of it. */
  since: number;
};

const EMPTY: LiveTrack = { track: null, path: [], since: 0 };

/**
 * A live fix for one aircraft, or null while there is none.
 *
 * Null is the ordinary answer over an ocean or anywhere without a volunteer
 * receiver in range, so the caller keeps the sweep's own position rather than
 * treating it as a failure.
 */
export function useLiveTrack(hex: string | null): LiveTrack {
  const [state, setState] = useState<(LiveTrack & { hex: string }) | null>(null);

  useEffect(() => {
    if (!hex) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;

    const tick = async () => {
      try {
        const res = await fetch(`/api/watch/track/${encodeURIComponent(hex)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const json = (await res.json()) as { track: Track | null };
        if (stopped) return;

        setState((previous) => {
          // A result for a previous selection must not seed this one's path.
          const base: LiveTrack & { hex: string } =
            previous && previous.hex === hex
              ? previous
              : { hex, track: null, path: [], since: Date.now() };

          const next = json.track;
          if (!next) return { ...base, track: null };

          const point: [number, number, number] = [
            next.lon,
            next.lat,
            next.onGround || next.alt == null ? 0 : next.alt * FT_TO_M,
          ];
          const last = base.path[base.path.length - 1];
          const moved =
            !last ||
            Math.abs(last[0] - point[0]) > MIN_STEP_DEG ||
            Math.abs(last[1] - point[1]) > MIN_STEP_DEG;

          return {
            ...base,
            track: next,
            path: moved ? [...base.path, point].slice(-MAX_PATH_POINTS) : base.path,
          };
        });
      } catch {
        // A dropped poll is not worth reporting; the next one is five seconds
        // away and the selection still has its position from the sweep.
      } finally {
        if (!stopped) timer = setTimeout(tick, POLL_MS);
      }
    };

    void tick();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [hex]);

  // A result for the previous selection must never be shown against this one.
  return hex && state?.hex === hex ? state : EMPTY;
}
