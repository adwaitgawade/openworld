"use client";

import { useEffect, useState } from "react";

import type { Airport } from "@/lib/watch/airports";

/** Long enough that typing "EGLL" is one request rather than four. */
const DEBOUNCE_MS = 220;

/**
 * Resolves a palette query to an airport, when the query looks like a code.
 *
 * ICAO always reaches adsb.lol; IATA only resolves for airports the console
 * has already seen on a route, which is why the result can be null for a
 * perfectly real code.
 */
export function useAirportSearch(query: string): Airport | null {
  const [found, setFound] = useState<{ code: string; airport: Airport | null } | null>(null);
  const code = /^[A-Za-z0-9]{3,4}$/.test(query.trim())
    ? query.trim().toUpperCase()
    : null;

  useEffect(() => {
    if (!code) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/watch/airport/${encodeURIComponent(code)}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const json = (await res.json()) as { airport: Airport | null };
        if (!controller.signal.aborted) setFound({ code, airport: json.airport });
      } catch {
        // A failed lookup simply offers no airport row; the track results that
        // share the palette are unaffected.
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [code]);

  // A result for a previous query must never be offered against this one.
  return code && found?.code === code ? found.airport : null;
}
