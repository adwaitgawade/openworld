"use client";

import { useEffect, useState } from "react";

import type { AircraftDetail } from "@/lib/watch/adsbdb";

export type DetailState = AircraftDetail & {
  /** The Mode-S address a lookup was made for, or null when none was worth making. */
  modeS: string | null;
  /** True while a lookup for the current aircraft is outstanding. */
  loading: boolean;
  /** Set only when the lookup itself failed — an unknown airframe is not an error. */
  error: string | null;
};

const IDLE: DetailState = {
  modeS: null,
  aircraft: null,
  route: null,
  loading: false,
  error: null,
};

/** What the last completed lookup returned, whichever aircraft it was for. */
type Resolved = AircraftDetail & { key: string; error: string | null };

/**
 * The airframe and route for the selected aircraft.
 *
 * One lookup per selection, never per frame. The key is the Mode-S address
 * plus the callsign, so re-selecting the same flight re-uses the server's
 * cache, and an aircraft that changes callsign mid-session is re-asked.
 *
 * `loading` is derived from the stored result carrying a stale key rather than
 * being set when the effect starts. That keeps the effect free of synchronous
 * setState, and means a new selection never renders for a frame holding the
 * previous aircraft's details.
 */
export function useAircraftDetail(
  modeS: string | null,
  callsign: string | null,
): DetailState {
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const key = modeS ? `${modeS}|${callsign ?? ""}` : null;

  useEffect(() => {
    if (!modeS || !key) return;

    const controller = new AbortController();
    const query = callsign ? `?callsign=${encodeURIComponent(callsign)}` : "";

    void (async () => {
      try {
        const res = await fetch(
          `/api/watch/aircraft/${encodeURIComponent(modeS)}${query}`,
          { signal: controller.signal, cache: "no-store" },
        );
        const json = (await res.json()) as AircraftDetail & { error?: string };
        if (controller.signal.aborted) return;
        setResolved({
          key,
          aircraft: json.aircraft,
          route: json.route,
          error: res.ok ? null : (json.error ?? `lookup ${res.status}`),
        });
      } catch (e) {
        if (controller.signal.aborted) return;
        setResolved({
          key,
          aircraft: null,
          route: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();

    return () => controller.abort();
  }, [modeS, callsign, key]);

  if (!modeS || !key) return IDLE;
  if (resolved?.key === key) {
    return {
      modeS,
      aircraft: resolved.aircraft,
      route: resolved.route,
      loading: false,
      error: resolved.error,
    };
  }
  return { modeS, aircraft: null, route: null, loading: true, error: null };
}
