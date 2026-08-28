/**
 * Nominatim forward-geocoding for the place search. The shared client in
 * `lib/nominatim` carries the User-Agent and the app-wide rate limit.
 */

import type { GeocodeResult } from "@/lib/geocode";
import { nominatim } from "@/lib/nominatim";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length < 2) return Response.json({ results: [] });

  type NominatimPlace = {
    place_id: number;
    display_name: string;
    lat: string;
    lon: string;
    type?: string;
    /** Nominatim order is [south, north, west, east], all as strings. */
    boundingbox?: [string, string, string, string];
  };

  let places: NominatimPlace[];
  try {
    // Repeat keystrokes converge on the same prefixes; a short cache keeps us
    // well inside Nominatim's rate limit.
    places = (await nominatim(
      "search",
      { q: query, limit: "8", addressdetails: "0" },
      300,
    )) as NominatimPlace[];
  } catch (e: unknown) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Geocoder unreachable" },
      { status: 502 },
    );
  }

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
