/** A single Nominatim hit, normalised for the client. */
export type GeocodeResult = {
  /** Nominatim place_id, stable enough to use as a React key. */
  id: number;
  /** Full display name, e.g. "Eiffel Tower, Paris, France". */
  name: string;
  lat: number;
  lon: number;
  /** [west, south, east, north] in degrees, when Nominatim supplies one. */
  bbox: [number, number, number, number] | null;
  type: string;
};
