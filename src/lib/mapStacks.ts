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

export type MapStackId = "esri" | "osm";

export type MapStack = {
  id: MapStackId;
  label: string;
  note: string;
  /**
   * False when the base tiles already carry place names and roads, so stacking
   * a reference overlay on top would only double up the labels.
   */
  supportsLabels: boolean;
};

export const MAP_STACKS: MapStack[] = [
  {
    id: "esri",
    label: "Esri World Imagery",
    note: "satellite · no key required",
    supportsLabels: true,
  },
  {
    id: "osm",
    label: "OpenStreetMap",
    note: "street map · labels baked into the tiles",
    supportsLabels: false,
  },
];

export const DEFAULT_STACK_ID: MapStackId = "esri";
export const DEFAULT_LABELS = false;

export function supportsLabels(id: MapStackId): boolean {
  return MAP_STACKS.find((stack) => stack.id === id)?.supportsLabels ?? false;
}

const ESRI_WORLD_IMAGERY =
  "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";

/**
 * Esri's transparent reference tiles: boundaries, roads and place names meant to
 * be drawn over World Imagery. Two services together give the full label set —
 * "Boundaries and Places" carries admin borders and place names, "Transportation"
 * carries road casings and street names.
 */
const ESRI_BOUNDARIES_AND_PLACES =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}";
const ESRI_TRANSPORTATION =
  "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}";

/**
 * Keyless global terrain: Re:Earth Terrain / Mapterhorn (CC BY 4.0), a
 * quantized-mesh DEM blended with the EGM2008 geoid. Cesium World Terrain is an
 * ion asset, so without a token this is what gives the globe real relief instead
 * of a smooth ellipsoid.
 */
const REEARTH_TERRAIN_URL = "https://terrain.reearth.land/cesium-mesh/ellipsoid";

/** Keyed by stack *and* label state — the two differ by more than a visibility flag. */
const imageryCache = new Map<string, Promise<ImageryProvider[]>>();
let keylessTerrain: Promise<TerrainProvider> | undefined;

/**
 * Providers for a stack, bottom-up: index 0 is the base imagery, anything after
 * it is a transparent overlay to be layered on top in order.
 */
export function createImageryProviders(
  Cesium: CesiumModule,
  id: MapStackId,
  labels: boolean,
): Promise<ImageryProvider[]> {
  // A stack that bakes in its own labels renders identically either way; collapse
  // the flag so toggling it while on OSM can't split the cache.
  const wantsLabels = labels && supportsLabels(id);
  const key = `${id}:${wantsLabels}`;

  const cached = imageryCache.get(key);
  if (cached) return cached;

  const pending = build(Cesium, id, wantsLabels);
  imageryCache.set(key, pending);
  // A failed provider shouldn't poison the cache — let the next attempt retry.
  pending.catch(() => imageryCache.delete(key));
  return pending;
}

async function build(
  Cesium: CesiumModule,
  id: MapStackId,
  wantsLabels: boolean,
): Promise<ImageryProvider[]> {
  if (id === "osm") {
    return [
      new Cesium.OpenStreetMapImageryProvider({
        url: "https://tile.openstreetmap.org/",
        credit: "© OpenStreetMap contributors",
      }),
    ];
  }

  const esriCredit = new Cesium.Credit(
    '&copy; <a href="https://www.esri.com/">Esri</a>, Maxar, Earthstar Geographics',
    true,
  );

  const base = new Cesium.UrlTemplateImageryProvider({
    url: ESRI_WORLD_IMAGERY,
    maximumLevel: 19,
    credit: esriCredit,
  });

  if (!wantsLabels) return [base];

  // Roads sit under place names so labels stay readable over dense street grids.
  return [
    base,
    new Cesium.UrlTemplateImageryProvider({
      url: ESRI_TRANSPORTATION,
      maximumLevel: 19,
      credit: esriCredit,
    }),
    new Cesium.UrlTemplateImageryProvider({
      url: ESRI_BOUNDARIES_AND_PLACES,
      maximumLevel: 19,
      credit: esriCredit,
    }),
  ];
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
