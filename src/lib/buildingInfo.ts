/**
 * Turns a picked 3D Tiles building feature into something displayable.
 *
 * The two sources in `buildings.ts` carry different property vocabularies —
 * ion's OSM Buildings uses OSM tag names plus a few `cesium#`-prefixed derived
 * ones, Re:Earth's tiles carry Overture's schema — so every lookup here probes
 * a list of candidate keys rather than assuming one. A feature that matches
 * nothing still gets a panel: the raw property list is always available, which
 * is the only honest thing to show for the ~83% of Overture footprints that
 * carry no classification at all.
 */

import type { BuildingQuery } from "./buildingDetails";

type Cesium3DTileFeature = import("cesium").Cesium3DTileFeature;

export type BuildingInfoRow = { label: string; value: string };

export type BuildingInfo = {
  title: string;
  subtitle: string | null;
  rows: BuildingInfoRow[];
  /** Every property on the feature, for the expandable "all properties" list. */
  raw: BuildingInfoRow[];
  /** OpenStreetMap page for the underlying element, when the source names one. */
  osmUrl: string | null;
  /** Wikidata entity, for the minority of buildings notable enough to have one. */
  wikidataUrl: string | null;
  /** Where the building is, in degrees. */
  coords: { lat: number; lon: number };
  /** Identity to hand to `/api/building` for the address and notability lookup. */
  query: BuildingQuery;
};

/** `40.76286° N, 73.97472° W` — five decimals is roughly a metre. */
export function formatCoords(lat: number, lon: number): string {
  const axis = (value: number, positive: string, negative: string) =>
    `${Math.abs(value).toFixed(5)}° ${value >= 0 ? positive : negative}`;
  return `${axis(lat, "N", "S")}, ${axis(lon, "E", "W")}`;
}

/** A property as a raw number, bypassing `asText`'s display rounding. */
function pickNumber(feature: Cesium3DTileFeature, keys: string[]): number | null {
  const value = pick(feature, keys);
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** First candidate key that holds a non-empty value. */
function pick(feature: Cesium3DTileFeature, keys: string[]): unknown {
  for (const key of keys) {
    const value = feature.getProperty(key);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/**
 * Flattens whatever a tile property holds into one line. Overture nests some
 * values (`names` is an object keyed by `primary`/`common`), and numbers come
 * through with more precision than is meaningful for a building.
 */
function asText(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
  }
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map(asText).filter(Boolean);
    return parts.length ? parts.join(", ") : null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // Overture's `names`: prefer the primary name over the locale variants.
    const primary = asText(record.primary ?? record.common ?? record.name);
    if (primary) return primary;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
  return String(value);
}

/** `building=apartments` → `Apartments`; `mixed_use` → `Mixed use`. */
function humanise(value: string): string {
  const spaced = value.replace(/[_-]+/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function metres(value: unknown): string | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const feet = Math.round(n * 3.28084);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} m (${feet} ft)`;
}

const NAME_KEYS = ["name", "names", "name:en", "cesium#name", "building:name"];
const HEIGHT_KEYS = ["cesium#estimatedHeight", "height", "building:height", "roof:height"];
const LEVELS_KEYS = ["building:levels", "num_floors", "levels"];
const TYPE_KEYS = ["building", "subtype", "class", "building:use", "amenity"];
const OPERATOR_KEYS = ["operator", "brand", "owner"];
const BUILT_KEYS = ["start_date", "construction_date", "year_built", "building:year"];

/**
 * OSM's `building=yes` / Overture's bare `true` mean "this is a building and
 * nothing more was tagged" — a Type row reading "Yes" is noise, not data.
 */
const EMPTY_TYPES = new Set(["yes", "true", "building"]);

/** `1921-03` and `~1921` both reduce to the year, which is all that fits. */
function builtYear(value: unknown): string | null {
  const text = asText(value);
  const year = text?.match(/\d{4}/)?.[0];
  return year ?? null;
}

function roof(feature: Cesium3DTileFeature): string | null {
  const shape = asText(pick(feature, ["roof:shape", "roof_shape"]));
  const material = asText(pick(feature, ["roof:material", "roof_material"]));
  const parts = [shape && humanise(shape), material].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** `12 Main Street, Springfield` from whichever address tags are present. */
function address(feature: Cesium3DTileFeature): string | null {
  const flat = asText(pick(feature, ["addr:full", "address", "freeform"]));
  if (flat) return flat;

  const number = asText(pick(feature, ["addr:housenumber", "housenumber"]));
  const street = asText(pick(feature, ["addr:street", "street"]));
  const city = asText(pick(feature, ["addr:city", "locality", "city"]));
  const postcode = asText(pick(feature, ["addr:postcode", "postcode"]));

  const line = [number, street].filter(Boolean).join(" ");
  const parts = [line, city, postcode].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/**
 * ion's OSM Buildings keeps the source element's identity, so a feature can be
 * linked back to the tag data it was extruded from. Overture-derived tiles
 * carry their own GERS id instead, which has no equivalent public page.
 */
function osmElement(
  feature: Cesium3DTileFeature,
): { type: string; id: string } | null {
  const id = asText(pick(feature, ["elementId", "osm_id", "id"]));
  if (!id || !/^\d+$/.test(id)) return null;
  const type = (asText(pick(feature, ["elementType", "osm_type"])) ?? "way").toLowerCase();
  if (type !== "way" && type !== "relation" && type !== "node") return null;
  return { type, id };
}

function wikidataId(feature: Cesium3DTileFeature): string | null {
  const id = asText(pick(feature, ["wikidata", "brand:wikidata"]));
  return id && /^Q\d+$/.test(id) ? id : null;
}

/**
 * @param clicked Where on the globe the user clicked, in degrees. Used only
 * when the feature does not carry its own centroid — ion does, and its
 * centroid identifies the building better than a corner of its roof.
 */
export function describeFeature(
  feature: Cesium3DTileFeature,
  clicked: { lat: number; lon: number },
): BuildingInfo {
  const ids = feature.getPropertyIds();
  const raw: BuildingInfoRow[] = [];
  for (const id of ids) {
    // ion repeats a building's tags on its `building:part` geometry under a
    // `part#` prefix. Where the plain tag is also present the two are the same
    // value, so listing both just doubles the property list.
    if (id.startsWith("part#") && ids.includes(id.slice(5))) continue;
    const value = asText(feature.getProperty(id));
    if (value !== null) raw.push({ label: id, value });
  }
  raw.sort((a, b) => a.label.localeCompare(b.label));

  const name = asText(pick(feature, NAME_KEYS));
  const type = asText(pick(feature, TYPE_KEYS));
  // `building=yes` is OSM's "this is a building and nothing more is tagged",
  // which is noise as a subtitle but worth keeping in the rows.
  const typeLabel = type && !EMPTY_TYPES.has(type.toLowerCase()) ? humanise(type) : null;

  const rows: BuildingInfoRow[] = [];
  const push = (label: string, value: string | null) => {
    if (value) rows.push({ label, value });
  };

  push("Address", address(feature));
  push("Height", metres(pick(feature, HEIGHT_KEYS)));
  push("Floors", asText(pick(feature, LEVELS_KEYS)));
  push("Type", typeLabel);
  push("Built", builtYear(pick(feature, BUILT_KEYS)));
  push("Roof", roof(feature));
  push("Operator", asText(pick(feature, OPERATOR_KEYS)));

  // Full precision: `asText` rounds to two decimals for display, which at this
  // latitude is a kilometre — enough to reverse-geocode the wrong block.
  const centroidLat = pickNumber(feature, ["cesium#latitude"]);
  const centroidLon = pickNumber(feature, ["cesium#longitude"]);
  const coords =
    centroidLat !== null && centroidLon !== null
      ? { lat: centroidLat, lon: centroidLon }
      : clicked;

  const osm = osmElement(feature);
  const wikidata = wikidataId(feature);

  return {
    title: name ?? typeLabel ?? "Untitled building",
    subtitle: name ? typeLabel : null,
    rows,
    raw,
    osmUrl: osm ? `https://www.openstreetmap.org/${osm.type}/${osm.id}` : null,
    wikidataUrl: wikidata ? `https://www.wikidata.org/wiki/${wikidata}` : null,
    coords,
    query: {
      ...coords,
      osmType: osm?.type ?? null,
      osmId: osm?.id ?? null,
      wikidata,
    },
  };
}
