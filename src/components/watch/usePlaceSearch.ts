"use client";

import { useEffect, useState } from "react";

import type { GeocodeResult } from "@/lib/geocode";

/** Same pace as the globe page's place search; the server throttles Nominatim anyway. */
const DEBOUNCE_MS = 350;
/**
 * The palette is command-first, so two letters ("ai", "hi") would mostly be
 * someone reaching for a command — three keeps those off the geocoder.
 */
const MIN_LENGTH = 3;
const MAX_RESULTS = 5;
/** One shared empty list, so callers memoising on `places` see a stable value. */
const NONE: GeocodeResult[] = [];

export type PlaceSearch = {
  places: GeocodeResult[];
  /** A lookup for the current query is still in flight. */
  searching: boolean;
};

/** Resolves a palette query to named places through `/api/geocode`. */
export function usePlaceSearch(query: string): PlaceSearch {
  const [found, setFound] = useState<{ term: string; places: GeocodeResult[] } | null>(null);
  const term = query.trim();
  const eligible = term.length >= MIN_LENGTH;

  useEffect(() => {
    if (!eligible) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(term)}`, {
          signal: controller.signal,
        });
        const json = (await res.json()) as { results?: GeocodeResult[] };
        if (controller.signal.aborted) return;
        setFound({ term, places: (json.results ?? []).slice(0, MAX_RESULTS) });
      } catch {
        // A failed lookup offers no place rows; commands and tracks are unaffected.
        if (!controller.signal.aborted) setFound({ term, places: [] });
      }
    }, DEBOUNCE_MS);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [term, eligible]);

  if (!eligible) return { places: NONE, searching: false };
  // Results for a previous query must never be offered against this one.
  if (found?.term !== term) return { places: NONE, searching: true };
  return { places: found.places, searching: false };
}
