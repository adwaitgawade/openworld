/**
 * Global 3D building massing, from whichever source the current keys allow.
 *
 * - With `NEXT_PUBLIC_CESIUM_ION_TOKEN`: Cesium OSM Buildings (ion asset 96188),
 *   ~350M OpenStreetMap footprints extruded to their tagged height.
 * - Without one: Re:Earth Buildings, a keyless 3D Tiles 1.1 set generated from
 *   Overture Maps footprints (ODbL) with ground elevation sampled from Re:Earth
 *   Terrain.
 *
 * The pairing is not arbitrary — it tracks the terrain choice in `mapStacks.ts`.
 * Re:Earth bakes ellipsoidal ground elevation into the building geometry, so it
 * sits flush on Re:Earth Terrain (the keyless path) and would float or sink on
 * Cesium World Terrain; OSM Buildings is clamped by ion's own terrain and has
 * the mirror-image problem. Each source is used only with its matching terrain.
 *
 * Either way the tileset is global, so it is loaded once and left in the scene;
 * 3D Tiles traversal means nothing is fetched until the camera is close enough
 * for buildings to refine.
 */

type CesiumModule = typeof import("cesium");
type Cesium3DTileset = import("cesium").Cesium3DTileset;

import { ION_TOKEN } from "./mapStacks";

export type BuildingsSourceId = "ion" | "reearth";

/** ion when a token is present, otherwise the keyless Overture-derived set. */
export const BUILDINGS_SOURCE: BuildingsSourceId = ION_TOKEN ? "ion" : "reearth";

const REEARTH_BUILDINGS_URL = "https://buildings.reearth.land/tileset.json";

export type BuildingStyleId = "osm" | "white" | "height";

/**
 * The first preset means "colour by what the building is", but the two sources
 * express that differently: ion's own tag-derived colouring cannot be
 * reproduced as an expression, while Re:Earth carries an Overture `subtype`
 * enum we colour ourselves.
 */
export const BUILDING_STYLES: { id: BuildingStyleId; label: string; note: string }[] = [
  BUILDINGS_SOURCE === "ion"
    ? { id: "osm", label: "OSM tags", note: "colour inferred from OpenStreetMap tags" }
    : { id: "osm", label: "By type", note: "Overture subtype — most footprints are unclassified" },
  { id: "white", label: "White", note: "uniform white massing model" },
  { id: "height", label: "By height", note: "colour ramp from low to tall" },
];

export const DEFAULT_BUILDING_STYLE: BuildingStyleId = "osm";

/** Short line for the UI, naming who the footprints actually came from. */
export const BUILDINGS_NOTE =
  BUILDINGS_SOURCE === "ion"
    ? "OpenStreetMap footprints via Cesium ion. Zoom into a city to see them refine."
    : "Overture Maps footprints via Re:Earth Buildings (ODbL). Some heights are estimated. Zoom into a city to see them refine.";

/**
 * Height in metres, as a style expression. ion exposes `cesium#estimatedHeight`
 * (tagged height, else derived from building:levels); Re:Earth exposes a plain
 * `height` resolved through its own cascade. Neither source reliably has the
 * bare `height` OSM tag on every feature, so the property name matters.
 */
const HEIGHT_PROPERTY =
  BUILDINGS_SOURCE === "ion" ? "${feature['cesium#estimatedHeight']}" : "${feature['height']}";

/**
 * Overture's `subtype` is a small, stable enum (13 values) — unlike `class`,
 * which is granular enough that a lookup here would go stale. Most footprints
 * carry neither: sampling ~11k features over Manhattan, 83% had no `subtype`,
 * and none of those had a `class` either, so a `class` fallback would buy
 * nothing. They fall through to the neutral default, which is why this preset
 * reads as "grey city, with the tagged buildings picked out".
 */
const SUBTYPE_CONDITIONS: [string, string][] = [
  ["${feature['subtype']} === 'residential'", "color('#cfe8d8')"],
  ["${feature['subtype']} === 'commercial'", "color('#8fa7ff')"],
  ["${feature['subtype']} === 'industrial'", "color('#c8a98f')"],
  ["${feature['subtype']} === 'education'", "color('#f2d98f')"],
  ["${feature['subtype']} === 'medical'", "color('#f4a7a7')"],
  ["${feature['subtype']} === 'civic'", "color('#c8b6ff')"],
  ["${feature['subtype']} === 'religious'", "color('#e6c9f0')"],
  ["${feature['subtype']} === 'transportation'", "color('#9fd6d2')"],
  ["${feature['subtype']} === 'service'", "color('#b8bcc4')"],
  ["${feature['subtype']} === 'agricultural'", "color('#b6d69a')"],
  ["${feature['subtype']} === 'outbuilding'", "color('#b8bcc4')"],
  ["${feature['subtype']} === 'entertainment'", "color('#f9d2ff')"],
  ["${feature['subtype']} === 'military'", "color('#8f9a86')"],
  ["true", "color('#d8dae0')"],
];

/**
 * A `Cesium3DTileStyle` for the given preset, or undefined for "osm" on the ion
 * source — omitting the style is what makes `createOsmBuildingsAsync` apply its
 * own tag-derived colouring, which cannot be reproduced from an expression.
 */
export function buildingStyle(
  Cesium: CesiumModule,
  id: BuildingStyleId,
): import("cesium").Cesium3DTileStyle | undefined {
  if (id === "osm") {
    if (BUILDINGS_SOURCE === "ion") return undefined;
    return new Cesium.Cesium3DTileStyle({ color: { conditions: SUBTYPE_CONDITIONS } });
  }

  if (id === "white") {
    return new Cesium.Cesium3DTileStyle({ color: "color('#e8e8ea')" });
  }

  return new Cesium.Cesium3DTileStyle({
    color: {
      conditions: [
        [`${HEIGHT_PROPERTY} > 200`, "color('#f9d2ff')"],
        [`${HEIGHT_PROPERTY} > 120`, "color('#c8b6ff')"],
        [`${HEIGHT_PROPERTY} > 60`, "color('#8fa7ff')"],
        [`${HEIGHT_PROPERTY} > 30`, "color('#6fd0e8')"],
        [`${HEIGHT_PROPERTY} > 12`, "color('#7fe0b0')"],
        [true, "color('#cfe8d8')"],
      ],
    },
  });
}

/** Loads the global buildings tileset. Caller adds it to the scene. */
export async function loadBuildings(
  Cesium: CesiumModule,
  style: BuildingStyleId,
): Promise<Cesium3DTileset> {
  if (BUILDINGS_SOURCE === "reearth") {
    // Attribution rides along in the tileset's `asset.copyright`, which Cesium
    // turns into a credit automatically — ODbL is satisfied without a hardcoded
    // string here that could drift from the served one.
    const tileset = await Cesium.Cesium3DTileset.fromUrl(REEARTH_BUILDINGS_URL);
    tileset.style = buildingStyle(Cesium, style);
    return tileset;
  }

  return Cesium.createOsmBuildingsAsync({
    style: buildingStyle(Cesium, style),
    // Outlines read as clutter over a whole city block and cost extra geometry
    // processing at load time; the massing alone is what carries the shape.
    enableShowOutline: false,
  });
}
