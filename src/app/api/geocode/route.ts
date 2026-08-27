/**
 * Nominatim proxy.
 *
 * Nominatim's usage policy requires an identifying User-Agent and caps traffic
 * at ~1 req/s. Browsers refuse to set User-Agent, so the request has to go
 * through the server; that also lets us cache and rate-limit in one place.
 */

import type { GeocodeResult } from "@/lib/geocode";

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const CONTACT =
  process.env.NOMINATIM_CONTACT ?? "openworld-globe (contact not configured)";

/**
 * In-process throttle. Nominatim allows ~1 req/s; concurrent handlers are
 * chained through a single promise so two in-flight requests can't both read
 * the same `lastRequestAt` and fire together.
 */
const MIN_INTERVAL_MS = 1100;
let lastRequestAt = 0;
let gate: Promise<void> = Promise.resolve();

function takeSlot(): Promise<void> {
  gate = gate.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  return gate;
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) return Response.json({ results: [] });

  await takeSlot();

  const url = new URL(NOMINATIM_URL);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "8");
  url.searchParams.set("addressdetails", "0");

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      headers: { "User-Agent": CONTACT, "Accept-Language": "en" },
      // Repeat keystrokes converge on the same prefixes; a short cache keeps
      // us well inside Nominatim's rate limit.
      next: { revalidate: 300 },
    });
  } catch (e: unknown) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Geocoder unreachable" },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    return Response.json(
      { error: `Nominatim returned ${upstream.status}` },
      { status: 502 },
    );
  }

  type NominatimPlace = {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    type?: string;
    /** Nominatim order is [south, north, west, east], all as strings. */
    boundingbox?: [string, string, string, string];
  };

  const places: NominatimPlace[] = await upstream.json();

  const results: GeocodeResult[] = places.map((place) => {
    const box = place.boundingbox?.map(Number);
    return {
      id: place.place_id,
      name: place.display_name,
      lat: Number(place.lat),
      lon: Number(place.lon),
      bbox:
        box && box.length === 4 && box.every(Number.isFinite)
          ? [box[2], box[0], box[3], box[1]]
          : null,
      type: place.type ?? "place",
    };
  });

  return Response.json({ results });
}
