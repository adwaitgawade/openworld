/**
 * Assembles the "everything else" panel for a picked building: postal address
 * from Nominatim, notability from Wikidata and Wikipedia.
 *
 * The two halves are independent and are fetched together — one failing (a rate
 * limit, an article that does not exist) must not cost the user the other, so
 * failures degrade to `partial: true` rather than to an error response.
 */

import type { BuildingDetails, DetailRow } from "@/lib/buildingDetails";
import { nominatim } from "@/lib/nominatim";
import { articleSummary, nearestArticle, wikidataFacts } from "@/lib/wiki";

/** Address components, coarse to fine, as they should read in the panel. */
const ADDRESS_PARTS: [key: string, label: string][] = [
  ["house_number", "Number"],
  ["road", "Street"],
  ["neighbourhood", "Neighbourhood"],
  ["suburb", "Borough"],
  ["city", "City"],
  ["county", "County"],
  ["state", "State"],
  ["postcode", "Postcode"],
  ["country", "Country"],
];

type NominatimPlace = {
  display_name?: string;
  address?: Record<string, string>;
};

/**
 * The exact OSM object when we know its id, otherwise the nearest one to the
 * click. `lookup` is the better of the two — reverse geocoding a coordinate
 * inside a large building can land on a neighbour's address.
 */
async function addressFor(
  lat: number,
  lon: number,
  osmType: string | null,
  osmId: string | null,
): Promise<NominatimPlace | null> {
  if (osmType && osmId) {
    const prefix = { node: "N", way: "W", relation: "R" }[osmType];
    if (prefix) {
      const found = (await nominatim(
        "lookup",
        { osm_ids: `${prefix}${osmId}`, addressdetails: "1" },
        86_400,
      )) as NominatimPlace[];
      if (found[0]) return found[0];
    }
  }

  return (await nominatim(
    "reverse",
    { lat: String(lat), lon: String(lon), addressdetails: "1", zoom: "18" },
    86_400,
  )) as NominatimPlace;
}

/**
 * Wikidata first, then the article it points at. Only when the building has no
 * `wikidata` tag at all do we fall back to searching by coordinate, and that
 * result is flagged as `nearby` so the UI never presents it as this building's
 * own entry.
 */
async function notabilityFor(lat: number, lon: number, wikidata: string | null) {
  if (wikidata) {
    const { facts, article, description } = await wikidataFacts(wikidata);
    const summary = article ? await articleSummary(article, false) : null;
    // Wikidata's own one-line description is a usable stand-in when the entity
    // exists but has no English article behind it.
    return {
      facts,
      wiki:
        summary ??
        (description
          ? {
              title: "",
              description: null,
              extract: description,
              url: `https://www.wikidata.org/wiki/${wikidata}`,
              nearby: false,
            }
          : null),
    };
  }

  const title = await nearestArticle(lat, lon);
  return { facts: [], wiki: title ? await articleSummary(title, true) : null };
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const lat = Number(params.get("lat"));
  const lon = Number(params.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: "lat and lon are required" }, { status: 400 });
  }

  const wikidata = params.get("wikidata");
  const [address, notability] = await Promise.allSettled([
    addressFor(lat, lon, params.get("osmType"), params.get("osmId")),
    notabilityFor(lat, lon, /^Q\d+$/.test(wikidata ?? "") ? wikidata : null),
  ]);

  const addressRows: DetailRow[] = [];
  let addressLine: string | null = null;
  if (address.status === "fulfilled" && address.value) {
    addressLine = address.value.display_name ?? null;
    const parts = address.value.address ?? {};
    for (const [key, label] of ADDRESS_PARTS) {
      // Nominatim names the same tier differently by country — a "city" may
      // come back as town, village or hamlet depending on how it is tagged.
      const value =
        parts[key] ??
        (key === "city" ? (parts.town ?? parts.village ?? parts.hamlet) : undefined) ??
        (key === "county" ? parts.city_district : undefined);
      if (value) addressRows.push({ label, value });
    }
  }

  const details: BuildingDetails = {
    addressLine,
    addressRows,
    facts: notability.status === "fulfilled" ? notability.value.facts : [],
    wiki: notability.status === "fulfilled" ? notability.value.wiki : null,
    partial: address.status === "rejected" || notability.status === "rejected",
  };

  return Response.json(details);
}
