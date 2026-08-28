"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Viewer } from "cesium";

import PlaceSearch from "./PlaceSearch";
import SplatControls, { type SplatStatus } from "./SplatControls";
import BuildingsControls, { type BuildingsStatus } from "./BuildingsControls";
import BuildingInfoCallout from "./BuildingInfoCallout";
import type { GeocodeResult } from "@/lib/geocode";
import { describeFeature, type BuildingInfo } from "@/lib/buildingInfo";
import { fetchBuildingDetails, type BuildingDetails } from "@/lib/buildingDetails";
import {
  SSE_RANGE,
  loadSplatTileset,
  resolveSplatSource,
  type SplatSource,
} from "@/lib/splatTilesets";
import {
  DEFAULT_BUILDING_STYLE,
  buildingStyle,
  loadBuildings,
  type BuildingStyleId,
} from "@/lib/buildings";
import {
  DEFAULT_LABELS,
  DEFAULT_STACK_ID,
  ION_TOKEN,
  MAP_STACKS,
  createImageryProviders,
  createTerrainProvider,
  supportsLabels,
  type MapStackId,
} from "@/lib/mapStacks";

import "cesium/Build/Cesium/Widgets/widgets.css";

// Where the Cesium runtime fetches its Workers/Assets from. Must be set before
// the library is imported, hence the dynamic `import("cesium")` below.
declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
  }
}

/**
 * `viewer.flyTo(tileset)` frames the bounding sphere so tightly that a small
 * capture fills the screen from a metre away. Back off to a few radii and come
 * in obliquely, which is how a splat capture actually reads.
 */
function splatFlightOptions(
  Cesium: typeof import("cesium"),
  tileset: import("cesium").Cesium3DTileset,
) {
  return {
    duration: 3,
    offset: new Cesium.HeadingPitchRange(
      0,
      Cesium.Math.toRadians(-35),
      Math.max(tileset.boundingSphere.radius * 3, 20),
    ),
  };
}

/**
 * Selection highlight. Set straight onto the feature rather than through the
 * tileset style: a style is a whole-tileset expression and re-evaluating one to
 * pick out a single building would restyle every other building with it.
 */
const HIGHLIGHT_COLOR = (Cesium: typeof import("cesium")) =>
  Cesium.Color.fromCssColorString("#ffd166");

export default function CesiumGlobe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const cesiumRef = useRef<typeof import("cesium") | null>(null);
  // Base layer first, then any transparent overlays stacked above it.
  const imageryLayersRef = useRef<import("cesium").ImageryLayer[]>([]);
  const stopSpinRef = useRef<(() => void) | null>(null);
  const splatTilesetRef = useRef<import("cesium").Cesium3DTileset | null>(null);
  const buildingsTilesetRef = useRef<import("cesium").Cesium3DTileset | null>(null);
  // The clicked building: the feature itself (to restore its colour), the
  // colour it had before being highlighted, and the point on it the callout is
  // pinned to. All refs — they are read from a postRender handler, which must
  // not close over React state.
  const pickedFeatureRef = useRef<import("cesium").Cesium3DTileFeature | null>(null);
  const pickedColorRef = useRef<import("cesium").Color | null>(null);
  const pickedAnchorRef = useRef<import("cesium").Cartesian3 | null>(null);
  // Splats visible this frame, accumulated by the tileVisible handler and
  // published to React on a slow tick — a setState per frame would re-render
  // the whole overlay 60 times a second.
  const splatFrameCountRef = useRef(0);

  const [stackId, setStackId] = useState<MapStackId>(DEFAULT_STACK_ID);
  const [labelsOn, setLabelsOn] = useState(DEFAULT_LABELS);
  // Degrees below horizontal: 90 looks straight down, 0 sits on the horizon.
  const [tiltDeg, setTiltDeg] = useState(90);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // This component is only ever loaded with `ssr: false`, so `window` exists on
  // the first render and `?splat=<url>` can be read in the initialiser.
  const [splatSource] = useState<SplatSource | null>(() =>
    resolveSplatSource(window.location.search),
  );
  const [splatStatus, setSplatStatus] = useState<SplatStatus>("idle");
  const [splatError, setSplatError] = useState<string | null>(null);
  const [splatShown, setSplatShown] = useState(true);
  const [splatsInView, setSplatsInView] = useState(0);
  // Sticky version of "nothing was selected": a single empty frame happens
  // routinely while the traversal re-settles, so the warning only appears once
  // the tileset has genuinely stopped selecting tiles.
  const [noTilesSelected, setNoTilesSelected] = useState(false);
  const [sse, setSse] = useState<number>(SSE_RANGE.default);

  const [buildingsStatus, setBuildingsStatus] = useState<BuildingsStatus>("idle");
  const [buildingsError, setBuildingsError] = useState<string | null>(null);
  const [buildingsShown, setBuildingsShown] = useState(false);
  const [buildingStyleId, setBuildingStyleId] =
    useState<BuildingStyleId>(DEFAULT_BUILDING_STYLE);
  const [pickedBuilding, setPickedBuilding] = useState<BuildingInfo | null>(null);
  // Window coordinates of the anchor, or null while it is off-screen or hidden
  // behind the globe.
  const [calloutAt, setCalloutAt] = useState<{ x: number; y: number } | null>(null);
  // Address and notability, fetched after the tile's own properties are already
  // on screen — the panel must not wait on the network to show what it has.
  const [details, setDetails] = useState<BuildingDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;

    (async () => {
      window.CESIUM_BASE_URL = "/cesium";
      const Cesium = await import("cesium");
      if (disposed) return;
      cesiumRef.current = Cesium;

      if (ION_TOKEN) {
        Cesium.Ion.defaultAccessToken = ION_TOKEN;
      }

      const [imagery, keylessTerrain] = await Promise.all([
        createImageryProviders(Cesium, DEFAULT_STACK_ID, DEFAULT_LABELS),
        createTerrainProvider(Cesium),
      ]);
      if (disposed) return;

      const viewer = new Cesium.Viewer(container, {
        baseLayer: new Cesium.ImageryLayer(imagery[0]),
        baseLayerPicker: false,
        geocoder: false,
        animation: false,
        timeline: false,
        homeButton: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        sceneModePicker: false,
        selectionIndicator: false,
        infoBox: false,
        msaaSamples: 4,
        // Cesium World Terrain is an ion asset; without a token we attach the
        // keyless Re:Earth provider below instead.
        terrain: ION_TOKEN
          ? Cesium.Terrain.fromWorldTerrain({ requestVertexNormals: true })
          : undefined,
      });
      viewerRef.current = viewer;
      imageryLayersRef.current = [
        viewer.imageryLayers.get(0),
        ...imagery
          .slice(1)
          .map((overlay) => viewer.imageryLayers.addImageryProvider(overlay)),
      ];
      if (process.env.NODE_ENV === "development") {
        const debug = window as unknown as {
          __viewer?: Viewer;
          __Cesium?: typeof import("cesium");
        };
        debug.__viewer = viewer;
        debug.__Cesium = Cesium;
      }

      if (!ION_TOKEN && keylessTerrain) {
        viewer.terrainProvider = keylessTerrain;
      }

      // Sunlit globe with an atmosphere, which is what sells the "3D earth" look.
      const { scene } = viewer;
      scene.globe.enableLighting = true;
      scene.globe.showGroundAtmosphere = true;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
      // Without this, 3D Tiles buildings on the far side of a hill draw through
      // the terrain instead of being occluded by it.
      scene.globe.depthTestAgainstTerrain = true;

      // Slow idle spin that yields the moment the user touches the globe. It
      // must stop on *every* way in — a missed event type leaves the globe
      // drifting under the user's cursor and reads as broken input.
      let spinning = true;
      const spin = () => {
        if (!spinning) return;
        scene.camera.rotate(Cesium.Cartesian3.UNIT_Z, -Cesium.Math.toRadians(0.02));
      };
      const stopSpin = () => {
        if (!spinning) return;
        spinning = false;
        scene.postRender.removeEventListener(spin);
      };
      scene.postRender.addEventListener(spin);
      const INPUT_EVENTS = ["pointerdown", "wheel", "touchstart", "keydown"] as const;
      for (const type of INPUT_EVENTS) {
        viewer.canvas.addEventListener(type, stopSpin, { passive: true });
      }
      stopSpinRef.current = stopSpin;

      // Frame the whole planet. A Rectangle destination fits itself to the
      // viewport's aspect ratio, then we back off so the globe sits inside the
      // frame with a margin rather than touching the top and bottom edges.
      viewer.camera.setView({
        destination: Cesium.Rectangle.fromDegrees(-80, -75, 100, 75),
      });
      viewer.camera.zoomOut(viewer.camera.positionCartographic.height * 0.33);

      setReady(true);
    })().catch((e: unknown) => {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      disposed = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
      imageryLayersRef.current = [];
      stopSpinRef.current = null;
      // The viewer owns the tileset once it is added to scene.primitives, so
      // destroying the viewer destroys it too — just drop our handle.
      splatTilesetRef.current = null;
      buildingsTilesetRef.current = null;
    };
  }, []);

  /**
   * Pivots the camera to `deg` below horizontal around whatever it is currently
   * looking at, holding its distance. `lookAt` locks the camera into the
   * target's reference frame, so the transform is released immediately
   * afterwards — otherwise normal drag/zoom stops working.
   */
  const applyTilt = useCallback((deg: number) => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium || viewer.isDestroyed()) return;

    stopSpinRef.current?.();
    setTiltDeg(deg);

    const { scene, camera } = viewer;
    const centre = new Cesium.Cartesian2(scene.canvas.clientWidth / 2, scene.canvas.clientHeight / 2);
    const ray = camera.getPickRay(centre);
    // Fall back to the ellipsoid when the centre of the screen misses terrain
    // (e.g. the horizon is in frame); bail if it is pointed at empty space.
    const target =
      (ray && scene.globe.pick(ray, scene)) ?? camera.pickEllipsoid(centre);
    if (!target) return;

    const range = Cesium.Cartesian3.distance(camera.positionWC, target);
    camera.lookAt(
      target,
      new Cesium.HeadingPitchRange(camera.heading, Cesium.Math.toRadians(-deg), range),
    );
    camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }, []);

  /**
   * Frames a Nominatim bounding box around the result's own point.
   *
   * Nominatim returns the box of the whole OSM object, which for an
   * administrative area can reach far past the place itself — "Tokyo" comes
   * back spanning its Pacific islands, 800km east of the city. Trimming each
   * edge to its nearer twin keeps the point centred, and capping the aspect
   * ratio stops one very lopsided axis from pulling the camera way out.
   */
  const frameFor = useCallback(
    (Cesium: typeof import("cesium"), place: GeocodeResult) => {
      const bbox = place.bbox;
      // A house-sized box (or an antimeridian-wrapped one, which comes back
      // with west > east) is not usable as a rectangle; fly to the point.
      if (!bbox || bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) return null;

      const [west, south, east, north] = bbox;
      let lonHalf = Math.min(place.lon - west, east - place.lon);
      let latHalf = Math.min(place.lat - south, north - place.lat);
      if (!(lonHalf > 0) || !(latHalf > 0)) return null;

      const MAX_ASPECT = 4;
      lonHalf = Math.min(lonHalf, latHalf * MAX_ASPECT);
      latHalf = Math.min(latHalf, lonHalf * MAX_ASPECT);

      // Below this the rectangle fit drops the camera into the terrain.
      const MIN_HALF_DEG = 0.005;
      if (lonHalf < MIN_HALF_DEG || latHalf < MIN_HALF_DEG) return null;

      return Cesium.Rectangle.fromDegrees(
        place.lon - lonHalf,
        place.lat - latHalf,
        place.lon + lonHalf,
        place.lat + latHalf,
      );
    },
    [],
  );

  /** Flies the camera to a search hit, top-down and north-up. */
  const flyToPlace = useCallback(
    (place: GeocodeResult) => {
      const viewer = viewerRef.current;
      const Cesium = cesiumRef.current;
      if (!viewer || !Cesium || viewer.isDestroyed()) return;

      stopSpinRef.current?.();
      setTiltDeg(90);

      viewer.camera.flyTo({
        destination:
          frameFor(Cesium, place) ??
          Cesium.Cartesian3.fromDegrees(place.lon, place.lat, 2000),
        orientation: {
          heading: 0,
          pitch: Cesium.Math.toRadians(-90),
          roll: 0,
        },
        duration: 3,
      });
    },
    [frameFor],
  );

  /**
   * Loads the configured Gaussian splat tileset and frames it.
   *
   * LOD is plain 3D Tiles traversal: Cesium selects tiles by geometric error
   * against `maximumScreenSpaceError`, then the splat renderer concatenates
   * every selected tile into one buffer and depth-sorts it globally. So the
   * detail slider below is just the tileset's SSE — there is no separate splat
   * LOD control, and a tileset built as a single tile has no LODs to pick from
   * no matter what the slider says.
   */
  const loadSplats = useCallback(async () => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium || viewer.isDestroyed() || !splatSource) return;
    if (splatTilesetRef.current) return;

    setSplatStatus("loading");
    setSplatError(null);
    try {
      const tileset = await loadSplatTileset(Cesium, splatSource, sse);
      if (viewer.isDestroyed()) return;

      viewer.scene.primitives.add(tileset);
      splatTilesetRef.current = tileset;

      // `pointsLength` on splat content is the splat count for that tile, so
      // summing the visible tiles shows the LOD selection changing live.
      tileset.tileVisible.addEventListener(
        (tile: import("cesium").Cesium3DTile) => {
          splatFrameCountRef.current += tile.content.pointsLength;
        },
      );

      setSplatStatus("loaded");
      setSplatShown(true);
      stopSpinRef.current?.();
      await viewer.flyTo(tileset, splatFlightOptions(Cesium, tileset));
    } catch (e: unknown) {
      setSplatError(e instanceof Error ? e.message : String(e));
      setSplatStatus("error");
    }
  }, [splatSource, sse]);

  // Publish the per-frame splat tally about four times a second.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || splatStatus !== "loaded") return;

    const { scene } = viewer;
    let frame = 0;
    let zeroPublishes = 0;
    const tick = () => {
      const count = splatFrameCountRef.current;
      splatFrameCountRef.current = 0;
      if (frame++ % 15 !== 0) return;

      setSplatsInView(count);
      zeroPublishes = count === 0 ? zeroPublishes + 1 : 0;
      setNoTilesSelected(zeroPublishes >= 3);
    };
    scene.postRender.addEventListener(tick);
    return () => {
      if (!viewer.isDestroyed()) scene.postRender.removeEventListener(tick);
    };
  }, [splatStatus]);

  const applySse = useCallback((value: number) => {
    setSse(value);
    const tileset = splatTilesetRef.current;
    if (tileset && !tileset.isDestroyed()) {
      tileset.maximumScreenSpaceError = value;
    }
  }, []);

  const toggleSplatsShown = useCallback(() => {
    const tileset = splatTilesetRef.current;
    if (!tileset || tileset.isDestroyed()) return;
    tileset.show = !tileset.show;
    setSplatShown(tileset.show);
  }, []);

  const flyToSplats = useCallback(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    const tileset = splatTilesetRef.current;
    if (!viewer || !Cesium || viewer.isDestroyed() || !tileset || tileset.isDestroyed())
      return;
    stopSpinRef.current?.();
    viewer.flyTo(tileset, splatFlightOptions(Cesium, tileset));
  }, []);

  /** Drops the current selection and puts the building back to its own colour. */
  const clearSelection = useCallback(() => {
    const feature = pickedFeatureRef.current;
    if (feature && pickedColorRef.current && !feature.tileset.isDestroyed()) {
      feature.color = pickedColorRef.current;
    }
    pickedFeatureRef.current = null;
    pickedColorRef.current = null;
    pickedAnchorRef.current = null;
    setPickedBuilding(null);
    setCalloutAt(null);
    setDetails(null);
    setDetailsError(null);
  }, []);

  // Address and notability for the current selection. Keyed on the query rather
  // than the info object so re-picking the same building does not refetch, and
  // aborted so a fast series of clicks cannot land an earlier building's
  // details on a later one.
  const query = pickedBuilding?.query;
  const queryKey = query ? JSON.stringify(query) : null;
  useEffect(() => {
    if (!queryKey) return;

    // No reset needed here: every selection change goes through
    // `clearSelection` first, which has already emptied both.
    const controller = new AbortController();

    fetchBuildingDetails(JSON.parse(queryKey), controller.signal)
      .then(setDetails)
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setDetailsError(e instanceof Error ? e.message : String(e));
      });

    return () => controller.abort();
  }, [queryKey]);

  /**
   * Toggles the global buildings tileset, loading it on first use.
   *
   * The tileset is global and stays in the scene once loaded — hiding it is a
   * `show` flip, not an unload, so turning it back on is instant. 3D Tiles
   * traversal means nothing is actually fetched until the camera is close
   * enough to a city for the building tiles to refine.
   */
  const toggleBuildings = useCallback(async () => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!viewer || !Cesium || viewer.isDestroyed()) return;

    const existing = buildingsTilesetRef.current;
    if (existing && !existing.isDestroyed()) {
      existing.show = !existing.show;
      setBuildingsShown(existing.show);
      if (!existing.show) clearSelection();
      return;
    }
    if (buildingsStatus === "loading") return;

    setBuildingsStatus("loading");
    setBuildingsError(null);
    try {
      const tileset = await loadBuildings(Cesium, buildingStyleId);
      if (viewer.isDestroyed()) return;

      viewer.scene.primitives.add(tileset);
      buildingsTilesetRef.current = tileset;
      setBuildingsStatus("loaded");
      setBuildingsShown(true);
    } catch (e: unknown) {
      setBuildingsError(e instanceof Error ? e.message : String(e));
      setBuildingsStatus("error");
    }
  }, [buildingsStatus, buildingStyleId, clearSelection]);

  /**
   * Click-to-inspect on the buildings tileset.
   *
   * `scene.pick` returns the individual `Cesium3DTileFeature` under the cursor,
   * which is what carries the per-building properties — the tileset itself has
   * none. The anchor comes from `scene.pickPosition`, the actual point on the
   * roof or wall that was clicked, so the callout hangs off the building rather
   * than off a tile centre; it falls back to the terrain under the cursor on
   * the rare context where the depth texture is unavailable.
   */
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!ready || !viewer || !Cesium || viewer.isDestroyed()) return;

    const { scene } = viewer;
    const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);

    handler.setInputAction(
      ({ position }: { position: import("cesium").Cartesian2 }) => {
        const tileset = buildingsTilesetRef.current;
        const picked = scene.pick(position);
        const isBuilding =
          picked instanceof Cesium.Cesium3DTileFeature &&
          tileset &&
          !tileset.isDestroyed() &&
          picked.tileset === tileset;

        // A click on anything else — terrain, a splat, empty sky — dismisses.
        if (!isBuilding) {
          clearSelection();
          return;
        }

        clearSelection();
        const anchor =
          (scene.pickPositionSupported ? scene.pickPosition(position) : undefined) ??
          scene.camera.pickEllipsoid(position);
        if (!anchor) return;

        pickedFeatureRef.current = picked;
        pickedColorRef.current = Cesium.Color.clone(picked.color);
        pickedAnchorRef.current = anchor;
        picked.color = HIGHLIGHT_COLOR(Cesium);

        const carto = Cesium.Cartographic.fromCartesian(anchor);
        setPickedBuilding(
          describeFeature(picked, {
            lat: Cesium.Math.toDegrees(carto.latitude),
            lon: Cesium.Math.toDegrees(carto.longitude),
          }),
        );
      },
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );

    // Keep the callout pinned to its point on the building as the camera moves.
    // `worldToWindowCoordinates` happily projects a point on the far side of
    // the planet onto the screen, so the anchor is horizon-tested first: if the
    // ground normal there points away from the camera, the building has rotated
    // round the back and the callout must go with it.
    const scratch = new Cesium.Cartesian2();
    const toCamera = new Cesium.Cartesian3();
    const facesCamera = (anchor: import("cesium").Cartesian3) => {
      const normal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(anchor);
      if (!normal) return true;
      Cesium.Cartesian3.subtract(scene.camera.positionWC, anchor, toCamera);
      return Cesium.Cartesian3.dot(normal, toCamera) > 0;
    };
    let last: { x: number; y: number } | null = null;

    const track = () => {
      const anchor = pickedAnchorRef.current;
      if (!anchor) return;

      const window2d = facesCamera(anchor)
        ? Cesium.SceneTransforms.worldToWindowCoordinates(scene, anchor, scratch)
        : undefined;

      if (!window2d) {
        if (last) {
          last = null;
          setCalloutAt(null);
        }
        return;
      }

      // Sub-pixel jitter would re-render the overlay every frame for nothing.
      const next = { x: Math.round(window2d.x), y: Math.round(window2d.y) };
      if (last && last.x === next.x && last.y === next.y) return;
      last = next;
      setCalloutAt(next);
    };
    scene.postRender.addEventListener(track);

    return () => {
      handler.destroy();
      if (!viewer.isDestroyed()) scene.postRender.removeEventListener(track);
    };
  }, [ready, clearSelection]);

  const applyBuildingStyle = useCallback(
    (id: BuildingStyleId) => {
      setBuildingStyleId(id);
      const Cesium = cesiumRef.current;
      const tileset = buildingsTilesetRef.current;
      if (!Cesium || !tileset || tileset.isDestroyed()) return;
      // Re-evaluating the style overwrites every per-feature colour, including
      // the highlight, so the selection has to go before the restore colour we
      // are holding becomes meaningless.
      clearSelection();
      // On ion, `undefined` restores createOsmBuildingsAsync's tag-derived colouring.
      tileset.style = buildingStyle(Cesium, id);
    },
    [clearSelection],
  );

  /**
   * Rebuilds the imagery stack for a base map and label state. Both the stack
   * dropdown and the labels toggle funnel through here so a change to either
   * rebuilds the same way.
   */
  const applyImagery = useCallback(
    async (next: MapStackId, nextLabels: boolean) => {
      const viewer = viewerRef.current;
      const Cesium = cesiumRef.current;
      if (!viewer || !Cesium || viewer.isDestroyed()) return;

      stopSpinRef.current?.();
      setStackId(next);
      setLabelsOn(nextLabels);
      try {
        const providers = await createImageryProviders(Cesium, next, nextLabels);
        if (viewer.isDestroyed()) return;

        // Add the new layers beneath the old ones, then drop the old ones, so
        // the globe never flashes an empty base layer mid-switch.
        const layers = providers.map((provider, i) =>
          viewer.imageryLayers.addImageryProvider(provider, i),
        );
        for (const previous of imageryLayersRef.current) {
          viewer.imageryLayers.remove(previous, true);
        }
        imageryLayersRef.current = layers;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

  // OSM bakes labels into its tiles, so the toggle has nothing to add there.
  const labelsAvailable = supportsLabels(stackId);

  return (
    <div className="relative h-full w-full bg-black">
      <div ref={containerRef} className="h-full w-full" />

      {!ready && !error && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-zinc-400">
          Loading globe…
        </div>
      )}

      {error && (
        <div className="absolute inset-0 grid place-items-center p-8">
          <p className="max-w-md text-center text-sm text-red-400">
            Could not load the globe: {error}
          </p>
        </div>
      )}

      <div className="absolute left-4 top-4 flex flex-col gap-2">
        {ready && <PlaceSearch onSelect={flyToPlace} />}
        {ready && (
          <BuildingsControls
            status={buildingsStatus}
            error={buildingsError}
            shown={buildingsShown}
            style={buildingStyleId}
            onToggle={toggleBuildings}
            onStyleChange={applyBuildingStyle}
          />
        )}
        {ready && splatSource && (
          <SplatControls
            status={splatStatus}
            error={splatError}
            shown={splatShown}
            splatsInView={splatsInView}
            noTilesSelected={noTilesSelected}
            sse={sse}
            onLoad={loadSplats}
            onToggleShown={toggleSplatsShown}
            onSseChange={applySse}
            onFlyTo={flyToSplats}
          />
        )}
        <div className="pointer-events-none w-fit rounded-md bg-black/50 px-3 py-2 text-xs text-zinc-300 backdrop-blur">
          Drag to rotate · Scroll to zoom · Ctrl+drag to tilt{buildingsShown ? " · Click a building for details" : ""}
        </div>
      </div>

      {ready && (
        <div className="absolute right-4 top-4 flex flex-col gap-2 rounded-md bg-black/50 p-2 backdrop-blur">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-zinc-400">
              Base map
            </span>
            <select
              value={stackId}
              onChange={(e) => applyImagery(e.target.value as MapStackId, labelsOn)}
              title={MAP_STACKS.find((stack) => stack.id === stackId)?.note}
              className="rounded bg-white/90 px-2 py-1 text-xs text-black outline-none"
            >
              {MAP_STACKS.map((stack) => (
                <option key={stack.id} value={stack.id}>
                  {stack.label}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            disabled={!labelsAvailable}
            onClick={() => applyImagery(stackId, !labelsOn)}
            title={
              labelsAvailable
                ? "Roads, boundaries and place names over the imagery"
                : "OpenStreetMap tiles already include labels"
            }
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              labelsOn && labelsAvailable
                ? "bg-white/90 text-black"
                : "text-zinc-300 hover:bg-white/10"
            } disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent`}
          >
            Labels {labelsAvailable ? (labelsOn ? "on" : "off") : "—"}
          </button>
        </div>
      )}

      {pickedBuilding && calloutAt && (
        <BuildingInfoCallout
          key={queryKey}
          info={pickedBuilding}
          details={details}
          detailsError={detailsError}
          x={calloutAt.x}
          y={calloutAt.y}
          onClose={clearSelection}
        />
      )}

      {ready && (
        <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 flex-col gap-2 rounded-lg bg-black/55 px-4 py-3 backdrop-blur">
          <div className="flex items-baseline justify-between gap-6">
            <span className="text-xs font-medium text-zinc-200">Camera angle</span>
            <span className="text-xs tabular-nums text-zinc-400">{tiltDeg}° from horizontal</span>
          </div>

          <input
            type="range"
            min={0}
            max={90}
            step={1}
            value={tiltDeg}
            onChange={(e) => applyTilt(Number(e.target.value))}
            aria-label="Camera angle below horizontal"
            className="h-1.5 w-72 cursor-pointer appearance-none rounded-full bg-zinc-600 accent-white"
          />

          <div className="flex items-center justify-center gap-2">
            <div className="flex gap-1">
              {[
                { label: "Horizon", deg: 10 },
                { label: "Oblique", deg: 45 },
                { label: "Top-down", deg: 90 },
              ].map((preset) => (
                <button
                  key={preset.deg}
                  type="button"
                  onClick={() => applyTilt(preset.deg)}
                  className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                    tiltDeg === preset.deg
                      ? "bg-white/90 text-black"
                      : "text-zinc-300 hover:bg-white/10"
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
