/**
 * Base map ("stack") definitions for the globe.
 *
 * Structure follows the map-stack pattern used by bilawalsidhu/gods-eye-view:
 * each stack declares what it needs, and provider construction is centralised and
 * cached so switching between stacks doesn't refetch metadata.
 */

type CesiumModule = typeof import("cesium");
type ImageryProvider = import("cesium").ImageryProvider;
type TerrainProvider = import("cesium").TerrainProvider;

export const ION_TOKEN = process.env.NEXT_PUBLIC_CESIUM_ION_TOKEN;
export const BING_KEY = process.env.NEXT_PUBLIC_BING_MAPS_KEY;

/** Bing imagery is reachable either with a direct Bing key or through Cesium ion. */
export const HAS_BING = Boolean(BING_KEY || ION_TOKEN);

export type MapStackId = "bing-aerial" | "bing-labels" | "esri-aerial" | "osm";

export type MapStack = {
  id: MapStackId;
  label: string;
  shortLabel: string;
  /** False when the stack needs a key nobody supplied — shown disabled in the UI. */
  available: boolean;
  note: string;
};

export const MAP_STACKS: MapStack[] = [
  {
    id: "bing-aerial",
    label: "Bing Aerial",
    shortLabel: "Aerial",
    available: HAS_BING,
    note: BING_KEY ? "Bing Maps REST" : "via Cesium ion",
  },
  {
    id: "bing-labels",
    label: "Bing Aerial + Labels",
    shortLabel: "Labels",
    available: HAS_BING,
    note: BING_KEY ? "Bing Maps REST" : "via Cesium ion",
  },
  {
    id: "esri-aerial",
    label: "Esri World Imagery",
    shortLabel: "Esri",
    available: true,
    note: "no key required",
  },
  {
    id: "osm",
    label: "OpenStreetMap",
    shortLabel: "OSM",
    available: true,
    note: "no key required",
  },
];

/** Bing needs a key; without one we fall back to the keyless aerial stack. */
export const DEFAULT_STACK_ID: MapStackId = HAS_BING ? "bing-aerial" : "esri-aerial";

const ESRI_WORLD_IMAGERY =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

/**
 * Keyless global terrain: Re:Earth Terrain / Mapterhorn (CC BY 4.0), a
 * quantized-mesh DEM blended with the EGM2008 geoid. Cesium World Terrain is an
 * ion asset, so without a token this is what gives the globe real relief instead
 * of a smooth ellipsoid.
 */
const REEARTH_TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid";

const imageryCache = new Map<MapStackId, Promise<ImageryProvider>>();
let keylessTerrain: Promise<TerrainProvider> | undefined;

export function createImageryProvider(
  Cesium: CesiumModule,
  id: MapStackId,
): Promise<ImageryProvider> {
  const cached = imageryCache.get(id);
  if (cached) return cached;

  const pending = build(Cesium, id);
  imageryCache.set(id, pending);
  // A failed provider shouldn't poison the cache — let the next attempt retry.
  pending.catch(() => imageryCache.delete(id));
  return pending;
}

async function build(Cesium: CesiumModule, id: MapStackId): Promise<ImageryProvider> {
  const wantsLabels = id === "bing-labels";

  if (id === "bing-aerial" || id === "bing-labels") {
    if (BING_KEY) {
      return Cesium.BingMapsImageryProvider.fromUrl("https://dev.virtualearth.net", {
        key: BING_KEY,
        mapStyle: wantsLabels
          ? Cesium.BingMapsStyle.AERIAL_WITH_LABELS_ON_DEMAND
          : Cesium.BingMapsStyle.AERIAL,
      });
    }
    // ion's world imagery is Bing aerial served through Cesium ion.
    return Cesium.createWorldImageryAsync({
      style: wantsLabels
        ? Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS
        : Cesium.IonWorldImageryStyle.AERIAL,
    });
  }

  if (id === "osm") {
    return new Cesium.OpenStreetMapImageryProvider({
      url: "https://tile.openstreetmap.org/",
      credit: "© OpenStreetMap contributors",
    });
  }

  return new Cesium.UrlTemplateImageryProvider({
    url: ESRI_WORLD_IMAGERY,
    maximumLevel: 19,
    credit: new Cesium.Credit(
      '&copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics',
      true,
    ),
  });
}

/**
 * Best terrain available for the current keys: Cesium World Terrain when an ion
 * token is present, otherwise keyless Re:Earth terrain, otherwise a flat
 * ellipsoid. Never throws.
 */
export async function createTerrainProvider(
  Cesium: CesiumModule,
): Promise<TerrainProvider | undefined> {
  if (ION_TOKEN) return undefined; // caller uses Cesium.Terrain.fromWorldTerrain()

  keylessTerrain ??= Cesium.CesiumTerrainProvider.fromUrl(REEARTH_TERRAIN_URL).catch(
    (error: unknown) => {
      console.warn("[globe] Re:Earth terrain unavailable, using flat ellipsoid:", error);
      return new Cesium.EllipsoidTerrainProvider();
    },
  );
  return keylessTerrain;
}
