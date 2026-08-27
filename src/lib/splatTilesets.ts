/**
 * Gaussian splat 3D Tiles.
 *
 * CesiumJS renders splat tilesets natively (1.144 here): a tile whose glTF
 * carries `KHR_gaussian_splatting` + `KHR_gaussian_splatting_compression_spz_2`
 * loads as a `GaussianSplat3DTileContent` instead of a mesh. Level of detail is
 * ordinary 3D Tiles traversal — the tree's `geometricError` and `refine` decide
 * which tiles are selected, and `maximumScreenSpaceError` sets how eagerly the
 * camera refines into them. There is no splat-specific LOD switch.
 *
 * The catch is that the *tileset* has to advertise the extensions, not just the
 * glTFs: Cesium picks the splat content path from
 * `extensions["3DTILES_content_gltf"].extensionsRequired` in tileset.json. A
 * tileset that lists the extensions only inside each .glb silently loads as
 * regular geometry (and usually renders as nothing).
 */

type CesiumModule = typeof import("cesium");
type Cesium3DTileset = import("cesium").Cesium3DTileset;

export const SPLAT_TILESET_URL = process.env.NEXT_PUBLIC_SPLAT_TILESET_URL;
export const SPLAT_ION_ASSET_ID = process.env.NEXT_PUBLIC_SPLAT_ION_ASSET_ID;

export type SplatSource =
  | { kind: "url"; url: string }
  | { kind: "ion"; assetId: number };

/**
 * Where to load splats from, in precedence order: a `?splat=` query parameter
 * (handy for trying a dataset without a rebuild — it takes either a tileset URL
 * or a bare ion asset id), then env config. Returns null when nothing is
 * configured, which is what keeps the splat UI hidden rather than showing a
 * control that cannot do anything.
 */
export function resolveSplatSource(search?: string): SplatSource | null {
  const fromQuery = search
    ? new URLSearchParams(search).get("splat")?.trim()
    : undefined;
  if (fromQuery) {
    const asAssetId = Number(fromQuery);
    return Number.isInteger(asAssetId) && asAssetId > 0
      ? { kind: "ion", assetId: asAssetId }
      : { kind: "url", url: fromQuery };
  }
  if (SPLAT_TILESET_URL) return { kind: "url", url: SPLAT_TILESET_URL };

  const assetId = Number(SPLAT_ION_ASSET_ID);
  if (Number.isInteger(assetId) && assetId > 0) return { kind: "ion", assetId };

  return null;
}

/** Screen-space-error range offered in the UI. Lower = refine deeper = more splats. */
export const SSE_RANGE = { min: 2, max: 48, default: 16 } as const;

export async function loadSplatTileset(
  Cesium: CesiumModule,
  source: SplatSource,
  maximumScreenSpaceError: number,
): Promise<Cesium3DTileset> {
  const options = {
    maximumScreenSpaceError,
    // Splats are heavy; the 512MB default cache thrashes on a decent capture.
    cacheBytes: 1_073_741_824,
    maximumCacheOverflowBytes: 1_073_741_824,
  };

  let tileset: Cesium3DTileset;
  try {
    tileset =
      source.kind === "ion"
        ? await Cesium.Cesium3DTileset.fromIonAssetId(source.assetId, options)
        : await Cesium.Cesium3DTileset.fromUrl(source.url, options);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    // ion asset ids are scoped to an account, so a 404 here nearly always means
    // "not in the account this token belongs to" rather than "does not exist" —
    // the sample assets in Cesium's tutorials only resolve under CesiumJS's own
    // evaluation token.
    if (source.kind === "ion" && message.includes("404")) {
      throw new Error(
        `ion asset ${source.assetId} was not found for the configured access ` +
          `token. Check that the asset is in that ion account.`,
      );
    }
    throw e;
  }

  if (!isSplatTileset(Cesium, tileset)) {
    throw new Error(
      "Tileset loaded, but it does not require the Gaussian splatting glTF " +
        "extensions, so Cesium will render it as ordinary geometry. Re-tile it " +
        "with KHR_gaussian_splatting + KHR_gaussian_splatting_compression_spz_2.",
    );
  }

  return tileset;
}

/** True when Cesium will route this tileset's tiles through the splat renderer. */
export function isSplatTileset(Cesium: CesiumModule, tileset: Cesium3DTileset) {
  return Cesium.GaussianSplat3DTileContent.tilesetRequiresGaussianSplattingExt(
    tileset,
  );
}
