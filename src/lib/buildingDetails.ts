/**
 * Everything about a building that isn't in the tile itself.
 *
 * The 3D Tiles feature carries whatever OSM or Overture tagged, which is
 * usually a name, a height and little else. The full postal address, the
 * administrative hierarchy it sits in and any reason the building is notable
 * have to be fetched — this is the shape that comes back, shared by the route
 * that assembles it and the callout that renders it.
 */

export type DetailRow = { label: string; value: string };

export type BuildingDetails = {
  /** Nominatim's one-line address, as it would be written on an envelope. */
  addressLine: string | null;
  /** The same address broken into its parts, plus the enclosing areas. */
  addressRows: DetailRow[];
  /** Architect, style, heritage listing and so on, from Wikidata. */
  facts: DetailRow[];
  wiki: {
    title: string;
    description: string | null;
    extract: string;
    url: string;
    /** The article was found by proximity, so it may describe a neighbour. */
    nearby: boolean;
  } | null;
  /** Non-fatal: a source that failed while the others succeeded. */
  partial: boolean;
};

/** What the client needs to send to identify the building it picked. */
export type BuildingQuery = {
  lat: number;
  lon: number;
  osmType: string | null;
  osmId: string | null;
  wikidata: string | null;
};

export async function fetchBuildingDetails(
  query: BuildingQuery,
  signal: AbortSignal,
): Promise<BuildingDetails> {
  const params = new URLSearchParams({
    lat: String(query.lat),
    lon: String(query.lon),
  });
  if (query.osmType && query.osmId) {
    params.set("osmType", query.osmType);
    params.set("osmId", query.osmId);
  }
  if (query.wikidata) params.set("wikidata", query.wikidata);

  const response = await fetch(`/api/building?${params}`, { signal });
  if (!response.ok) throw new Error(`Lookup failed (${response.status})`);
  return response.json();
}
