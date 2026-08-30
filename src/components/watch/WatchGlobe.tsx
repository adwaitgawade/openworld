"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type { Viewer } from "cesium";

import { circlePoints, project } from "@/lib/watch/geo";
import { LANES } from "@/lib/watch/lanes";
import { COVERAGE_GAPS, PLACES, SENSORS, SENSOR_SITES } from "@/lib/watch/stations";
import type { Track } from "@/lib/watch/types";
import {
  createImageryProviders,
  createTerrainProvider,
  ION_TOKEN,
  type MapStackId,
} from "@/lib/mapStacks";
import { buildingStyle, loadBuildings, type BuildingStyleId } from "@/lib/buildings";
import { describeFeature, type BuildingInfo } from "@/lib/buildingInfo";

import "cesium/Build/Cesium/Widgets/widgets.css";

declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
  }
}

export type LayerId = "air" | "sea" | "lanes" | "cams" | "gaps" | "labels" | "buildings";
export type Layers = Record<LayerId, boolean>;

export type ReplayFrame = {
  ids: string[];
  kind: Uint8Array;
  lon: Float32Array;
  lat: Float32Array;
};

export type GlobeStats = {
  inView: number;
  /** Ground distance the 76px scale bar spans, in metres. */
  scaleMetres: number;
  /** Camera height above the ellipsoid, in metres. */
  cameraHeight: number;
  /** Aircraft currently drawn as airframes rather than dots. */
  modelled: number;
};

export type WatchGlobeHandle = {
  flyTo(lon: number, lat: number, heightMetres?: number): void;
  /** Pivots to `deg` below horizontal around what the camera is looking at. */
  setTilt(deg: number): void;
};

type Props = {
  tracks: Track[];
  /** Non-null while the timeline head is behind live. */
  replay: ReplayFrame | null;
  layers: Layers;
  selectedId: string | null;
  /** True while the camera should ride with the selection. */
  pov: boolean;
  /** Degrees below horizontal; in POV this is the chase angle. */
  tiltDeg: number;
  /** Past positions of the selection, oldest first. */
  trail: [number, number][];
  stackId: MapStackId;
  buildingStyleId: BuildingStyleId;
  onSelect: (id: string | null) => void;
  onCursor: (position: { lon: number; lat: number } | null) => void;
  onStats: (stats: GlobeStats) => void;
  onReady: () => void;
  onBuildingPick: (info: BuildingInfo | null) => void;
  onBuildingAnchor: (at: { x: number; y: number } | null) => void;
  onBuildingsStatus: (status: "idle" | "loading" | "loaded" | "error", error?: string) => void;
};

const AIR_COLOR = "#4FD1E0";
const SEA_COLOR = "#E8A33D";
const ACCENT = "#4FD1E0";
const SENSOR_COLOR = "#7BE38A";
const OFFLINE_COLOR = "#E8577F";

/** How far ahead of its last fix a track may be dead-reckoned. */
const MAX_PROJECT_SEC = 900;
/** Positions are advanced at this rate, not every frame — 12k points is a lot. */
const PROJECT_INTERVAL_MS = 200;
const STATS_INTERVAL_MS = 500;
/** The scale bar's drawn width, matching `.wscalebar i` in watch.css. */
const SCALEBAR_PX = 76;
const FT_TO_M = 0.3048;

/**
 * Within this range a track's dot ignores the depth buffer.
 *
 * A vessel sits at ellipsoid height 0, but the sea surface Cesium draws is the
 * terrain tile, which sits on the geoid — tens of metres above the ellipsoid in
 * places. Zoomed out the tiles are too coarse for it to matter; zoomed in they
 * refine, the sea closes over the dot and every vessel in the view winks out.
 * Beyond this range the depth test is back on, so tracks on the far side of the
 * globe do not draw through it.
 */
const DOT_DEPTH_TEST_OFF_M = 50_000;

const AIRCRAFT_URL = "/models/boeing-787-9.glb";
/** The mesh spans 2 476 units along its fuselage; a 787-9 is 62.8 m long. */
const AIRCRAFT_SCALE = 62.8 / 2476;
/**
 * How many airframes may be on screen at once. Cesium has no public instanced
 * model collection, so each one is its own primitive — 5 000 of them is not a
 * thing you can draw. The pool is filled from the tracks nearest the middle of
 * the view and everything else stays a dot.
 */
const MAX_MODELS = 40;
/** Above this camera height an airframe is smaller than its own dot. */
const MODEL_CAMERA_HEIGHT_M = 3_500_000;
/**
 * The mesh's nose runs along +Z and Cesium maps a glTF's forward axis onto the
 * +X of the heading frame, which `headingPitchRollToFixedFrame` puts due east
 * at heading 0. Track headings are from north, so they need a quarter turn off.
 */
const HEADING_OFFSET_DEG = -90;

/**
 * How far the POV camera sits from what it is following. Far enough that the
 * airframe reads as an aircraft rather than a wall, close enough that the
 * ground beneath it moves.
 */
const POV_RANGE_AIR_M = 260;
const POV_RANGE_SEA_M = 520;
/**
 * Straight down is a degenerate look direction — the up vector has nothing to
 * resolve against and the view rolls — so the chase angle stops short of it.
 */
const POV_MAX_PITCH_DEG = 85;
const POV_MIN_PITCH_DEG = 5;

/** A ring drawn once and reused as the selection marker's billboard image. */
function selectionRing(): HTMLCanvasElement {
  const size = 44;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  g.strokeStyle = ACCENT;
  g.lineWidth = 1.4;
  g.beginPath();
  g.arc(size / 2, size / 2, 13, 0, Math.PI * 2);
  g.stroke();
  g.setLineDash([2, 3]);
  g.globalAlpha = 0.55;
  g.beginPath();
  g.arc(size / 2, size / 2, 20, 0, Math.PI * 2);
  g.stroke();
  return canvas;
}

const HIGHLIGHT_COLOR = (Cesium: typeof import("cesium")) =>
  Cesium.Color.fromCssColorString("#ffd166");

const WatchGlobe = forwardRef<WatchGlobeHandle, Props>(function WatchGlobe(
  {
    tracks, replay, layers, selectedId, pov, tiltDeg, trail, stackId, buildingStyleId,
    onSelect, onCursor, onStats, onReady, onBuildingPick, onBuildingAnchor,
    onBuildingsStatus,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const cesiumRef = useRef<typeof import("cesium") | null>(null);
  const imageryLayersRef = useRef<import("cesium").ImageryLayer[]>([]);
  // Which stack the viewer was constructed with, so the effect below can tell
  // a real base-map change from its own first run.
  const mountedStackRef = useRef<MapStackId | null>(null);

  // Primitive collections, one per layer, so a toggle is a `.show` flip rather
  // than a rebuild.
  const pointsRef = useRef<import("cesium").PointPrimitiveCollection | null>(null);
  const sensorPointsRef = useRef<import("cesium").PointPrimitiveCollection | null>(null);
  const lanesRef = useRef<import("cesium").PolylineCollection | null>(null);
  const gapsRef = useRef<import("cesium").PolylineCollection | null>(null);
  const trailRef = useRef<import("cesium").PolylineCollection | null>(null);
  const labelsRef = useRef<import("cesium").LabelCollection | null>(null);
  const markerRef = useRef<import("cesium").BillboardCollection | null>(null);

  /**
   * Aircraft models, created on first use and then reassigned frame to frame.
   *
   * The pool is keyed to the viewer that owns it. React mounts effects twice in
   * development, and the first mount's pool build is still running when the
   * second one starts: without the key, that stale run finishes against a
   * destroyed viewer and marks the pool "ready" while it is empty, so the live
   * viewer never builds one and no airframe ever appears.
   */
  type ModelPool = {
    viewer: Viewer;
    models: import("cesium").Model[];
    state: "empty" | "loading" | "ready";
  };
  const poolRef = useRef<ModelPool | null>(null);

  const buildingsRef = useRef<import("cesium").Cesium3DTileset | null>(null);
  const buildingsStateRef = useRef<"idle" | "loading" | "loaded" | "error">("idle");
  const pickedFeatureRef = useRef<import("cesium").Cesium3DTileFeature | null>(null);
  const pickedColorRef = useRef<import("cesium").Color | null>(null);
  const pickedAnchorRef = useRef<import("cesium").Cartesian3 | null>(null);

  type Entry = {
    id: string;
    kind: "air" | "sea";
    lon: number;
    lat: number;
    /** Metres above the ellipsoid. */
    height: number;
    hdg: number | null;
    sog: number | null;
    fixedAt: number;
    point: import("cesium").PointPrimitive;
  };
  const entriesRef = useRef<Entry[]>([]);
  const selectedRef = useRef<string | null>(null);
  const replayingRef = useRef(false);
  // Read from the render loop, which must not re-subscribe when they change.
  const povRef = useRef(pov);
  const tiltRef = useRef(tiltDeg);
  const layersRef = useRef<Layers>(layers);
  // Set to true whenever the layer set or the track set changes, so the render
  // loop knows to re-apply visibility. Primitive `.show` flags have exactly one
  // owner — the loop below — because the airframe pass also hides the dots it
  // replaces, and two writers would fight over them every tick.
  const layersDirtyRef = useRef(true);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      flyTo(lon, lat, heightMetres = 2_500_000) {
        const viewer = viewerRef.current;
        const Cesium = cesiumRef.current;
        if (!viewer || !Cesium || viewer.isDestroyed()) return;
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, heightMetres),
          duration: 1.6,
        });
      },
      /**
       * `lookAt` locks the camera into the target's reference frame, so the
       * transform is released immediately afterwards — otherwise normal
       * drag/zoom stops working.
       */
      setTilt(deg) {
        const viewer = viewerRef.current;
        const Cesium = cesiumRef.current;
        if (!viewer || !Cesium || viewer.isDestroyed()) return;

        const { scene, camera } = viewer;
        const centre = new Cesium.Cartesian2(
          scene.canvas.clientWidth / 2,
          scene.canvas.clientHeight / 2,
        );
        const ray = camera.getPickRay(centre);
        // Fall back to the ellipsoid when the centre of the screen misses
        // terrain (the horizon is in frame); bail on empty space.
        const target =
          (ray && scene.globe.pick(ray, scene)) ?? camera.pickEllipsoid(centre);
        if (!target) return;

        const range = Cesium.Cartesian3.distance(camera.positionWC, target);
        camera.lookAt(
          target,
          new Cesium.HeadingPitchRange(camera.heading, Cesium.Math.toRadians(-deg), range),
        );
        camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      },
    }),
    [],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;

    (async () => {
      window.CESIUM_BASE_URL = "/cesium";
      const Cesium = await import("cesium");
      if (disposed) return;
      cesiumRef.current = Cesium;
      if (ION_TOKEN) Cesium.Ion.defaultAccessToken = ION_TOKEN;

      const [imagery, keylessTerrain] = await Promise.all([
        createImageryProviders(Cesium, stackId, false),
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
        // Terrain is what makes an oblique view read as terrain rather than a
        // painted sphere, and the buildings sources are each paired with one.
        terrain: ION_TOKEN
          ? Cesium.Terrain.fromWorldTerrain({ requestVertexNormals: true })
          : undefined,
      });
      viewerRef.current = viewer;
      poolRef.current = { viewer, models: [], state: "empty" };
      if (process.env.NODE_ENV === "development") {
        // Same escape hatch CesiumGlobe exposes: poking at the live scene from
        // the console is how anything about this globe gets diagnosed.
        (window as unknown as { __watchViewer?: Viewer }).__watchViewer = viewer;
      }
      imageryLayersRef.current = [
        viewer.imageryLayers.get(0),
        ...imagery.slice(1).map((o) => viewer.imageryLayers.addImageryProvider(o)),
      ];
      if (!ION_TOKEN && keylessTerrain) viewer.terrainProvider = keylessTerrain;

      const { scene } = viewer;
      // Day/night on the globe is the terminator the design draws by hand.
      scene.globe.enableLighting = true;
      scene.globe.showGroundAtmosphere = true;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
      scene.globe.baseColor = Cesium.Color.fromCssColorString("#070b0e");
      scene.backgroundColor = Cesium.Color.fromCssColorString("#060605");
      scene.globe.showWaterEffect = false;
      // Without this, buildings behind a hill draw through the terrain, and the
      // callout's anchor point lands on the wrong side of it.
      scene.globe.depthTestAgainstTerrain = true;

      const points = scene.primitives.add(new Cesium.PointPrimitiveCollection());
      pointsRef.current = points;
      const sensorPoints = scene.primitives.add(new Cesium.PointPrimitiveCollection());
      sensorPointsRef.current = sensorPoints;
      const lanes = scene.primitives.add(new Cesium.PolylineCollection());
      lanesRef.current = lanes;
      const gaps = scene.primitives.add(new Cesium.PolylineCollection());
      gapsRef.current = gaps;
      const trails = scene.primitives.add(new Cesium.PolylineCollection());
      trailRef.current = trails;
      const labels = scene.primitives.add(new Cesium.LabelCollection());
      labelsRef.current = labels;
      const markers = scene.primitives.add(new Cesium.BillboardCollection());
      markerRef.current = markers;

      // ── static geography ───────────────────────────────────
      for (const lane of LANES) {
        lanes.add({
          positions: Cesium.Cartesian3.fromDegreesArray(lane.points.flat()),
          width: 1,
          material: Cesium.Material.fromType("Color", {
            color: Cesium.Color.fromCssColorString("#6E7F8C").withAlpha(0.3),
          }),
        });
      }

      for (const gap of COVERAGE_GAPS) {
        gaps.add({
          positions: Cesium.Cartesian3.fromDegreesArray(
            circlePoints(gap.lon, gap.lat, gap.radiusDeg).flat(),
          ),
          width: 1.4,
          material: Cesium.Material.fromType("PolylineDash", {
            color: Cesium.Color.fromCssColorString(OFFLINE_COLOR).withAlpha(0.6),
            dashLength: 10,
          }),
        });
      }

      const sites = [
        ...SENSOR_SITES.map(([lon, lat]) => ({ lon, lat, offline: false })),
        ...SENSORS,
      ];
      for (const site of sites) {
        sensorPoints.add({
          position: Cesium.Cartesian3.fromDegrees(site.lon, site.lat),
          pixelSize: 5,
          color: Cesium.Color.fromCssColorString(
            site.offline ? OFFLINE_COLOR : SENSOR_COLOR,
          ),
          outlineColor: Cesium.Color.fromCssColorString(
            site.offline ? OFFLINE_COLOR : SENSOR_COLOR,
          ).withAlpha(0.35),
          outlineWidth: 3,
        });
      }

      const labelStyle = {
        font: "9px ui-monospace, monospace",
        fillColor: Cesium.Color.fromCssColorString("#D8D6CE").withAlpha(0.62),
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        pixelOffset: new Cesium.Cartesian2(0, -8),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      };
      for (const place of PLACES) {
        labels.add({
          position: Cesium.Cartesian3.fromDegrees(place.lon, place.lat),
          text: place.name,
          ...labelStyle,
        });
      }
      for (const sensor of SENSORS) {
        labels.add({
          position: Cesium.Cartesian3.fromDegrees(sensor.lon, sensor.lat),
          text: sensor.id,
          ...labelStyle,
          fillColor: Cesium.Color.fromCssColorString(SENSOR_COLOR).withAlpha(0.8),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          pixelOffset: new Cesium.Cartesian2(7, 3),
        });
      }

      viewer.camera.setView({
        destination: Cesium.Rectangle.fromDegrees(-80, -75, 100, 75),
      });
      viewer.camera.zoomOut(viewer.camera.positionCartographic.height * 0.33);

      mountedStackRef.current = stackId;
      setReady(true);
      onReady();
    })().catch((e: unknown) => {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      disposed = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
      entriesRef.current = [];
      imageryLayersRef.current = [];
      poolRef.current = null;
      // The viewer owns anything added to scene.primitives, so destroying it
      // destroys the tileset too — just drop our handle.
      buildingsRef.current = null;
    };
    // Deliberately mounts once: `stackId` changes are applied by the imagery
    // effect below rather than by tearing down the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── picking ──────────────────────────────────────────────
  const clearBuildingSelection = useCallback(() => {
    const feature = pickedFeatureRef.current;
    if (feature && pickedColorRef.current && !feature.tileset.isDestroyed()) {
      feature.color = pickedColorRef.current;
    }
    pickedFeatureRef.current = null;
    pickedColorRef.current = null;
    pickedAnchorRef.current = null;
    onBuildingPick(null);
    onBuildingAnchor(null);
  }, [onBuildingPick, onBuildingAnchor]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!ready || !viewer || !Cesium || viewer.isDestroyed()) return;

    const { scene } = viewer;
    const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);

    handler.setInputAction(({ position }: { position: import("cesium").Cartesian2 }) => {
      const picked = scene.pick(position);
      const tileset = buildingsRef.current;

      // A track wins over the building under it: on this console the track is
      // what the operator is working, and the building is scenery.
      const trackId = typeof picked?.id === "string" ? picked.id : null;
      if (trackId) {
        clearBuildingSelection();
        onSelect(trackId);
        return;
      }

      const isBuilding =
        picked instanceof Cesium.Cesium3DTileFeature &&
        tileset &&
        !tileset.isDestroyed() &&
        picked.tileset === tileset;

      if (!isBuilding) {
        clearBuildingSelection();
        // Clicking past the aircraft mid-chase would otherwise drop the
        // selection and end POV. CLEAR and the palette still do that
        // deliberately; a missed click should not.
        if (!povRef.current) onSelect(null);
        return;
      }

      clearBuildingSelection();
      // `pickPosition` is the actual point on the roof or wall that was
      // clicked, so the callout hangs off the building rather than a tile centre.
      const anchor =
        (scene.pickPositionSupported ? scene.pickPosition(position) : undefined) ??
        scene.camera.pickEllipsoid(position);
      if (!anchor) return;

      pickedFeatureRef.current = picked;
      pickedColorRef.current = Cesium.Color.clone(picked.color);
      pickedAnchorRef.current = anchor;
      picked.color = HIGHLIGHT_COLOR(Cesium);

      const carto = Cesium.Cartographic.fromCartesian(anchor);
      onBuildingPick(
        describeFeature(picked, {
          lat: Cesium.Math.toDegrees(carto.latitude),
          lon: Cesium.Math.toDegrees(carto.longitude),
        }),
      );
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    handler.setInputAction(
      ({ endPosition }: { endPosition: import("cesium").Cartesian2 }) => {
        const carto = scene.camera.pickEllipsoid(endPosition);
        if (!carto) {
          onCursor(null);
          return;
        }
        const c = Cesium.Cartographic.fromCartesian(carto);
        onCursor({
          lon: Cesium.Math.toDegrees(c.longitude),
          lat: Cesium.Math.toDegrees(c.latitude),
        });
      },
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    );

    // Keep the callout pinned to its point on the building as the camera moves.
    // `worldToWindowCoordinates` happily projects a point on the far side of
    // the planet onto the screen, so the anchor is horizon-tested first.
    const scratch2d = new Cesium.Cartesian2();
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
        ? Cesium.SceneTransforms.worldToWindowCoordinates(scene, anchor, scratch2d)
        : undefined;

      if (!window2d) {
        if (last) {
          last = null;
          onBuildingAnchor(null);
        }
        return;
      }
      // Sub-pixel jitter would re-render the overlay every frame for nothing.
      const next = { x: Math.round(window2d.x), y: Math.round(window2d.y) };
      if (last && last.x === next.x && last.y === next.y) return;
      last = next;
      onBuildingAnchor(next);
    };
    scene.postRender.addEventListener(track);

    return () => {
      handler.destroy();
      if (!viewer.isDestroyed()) scene.postRender.removeEventListener(track);
    };
  }, [ready, onSelect, onCursor, onBuildingAnchor, onBuildingPick, clearBuildingSelection]);

  // ── base map switching ───────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!ready || !viewer || !Cesium || viewer.isDestroyed()) return;
    // The viewer was built with this stack already; only a change needs work.
    if (stackId === mountedStackRef.current) return;
    let cancelled = false;

    void (async () => {
      const providers = await createImageryProviders(Cesium, stackId, false);
      if (cancelled || viewer.isDestroyed()) return;
      // Add below the old stack, then drop it, so the globe never flashes bare.
      const next = providers.map((p, i) => viewer.imageryLayers.addImageryProvider(p, i));
      for (const previous of imageryLayersRef.current) {
        // `destroy: false` is load-bearing. createImageryProviders caches and
        // hands back the *same* provider instances, so destroying one here
        // destroys it for every future switch back to that stack — the globe
        // goes black while its tile requests carry on returning 200.
        viewer.imageryLayers.remove(previous, false);
      }
      imageryLayersRef.current = next;
      mountedStackRef.current = stackId;
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, stackId]);

  // ── buildings ────────────────────────────────────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!ready || !viewer || !Cesium || viewer.isDestroyed()) return;

    const existing = buildingsRef.current;
    if (existing && !existing.isDestroyed()) {
      existing.show = layers.buildings;
      if (!layers.buildings) clearBuildingSelection();
      return;
    }
    // The tileset is global and stays in the scene once loaded — hiding it is a
    // `show` flip, not an unload. Nothing is fetched until the camera is close
    // enough to a city for the building tiles to refine.
    if (!layers.buildings || buildingsStateRef.current === "loading") return;

    buildingsStateRef.current = "loading";
    onBuildingsStatus("loading");
    let cancelled = false;

    void (async () => {
      try {
        const tileset = await loadBuildings(Cesium, buildingStyleId);
        if (cancelled || viewer.isDestroyed()) return;
        viewer.scene.primitives.add(tileset);
        buildingsRef.current = tileset;
        buildingsStateRef.current = "loaded";
        onBuildingsStatus("loaded");
      } catch (e) {
        if (cancelled) return;
        buildingsStateRef.current = "error";
        onBuildingsStatus("error", e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [ready, layers.buildings, buildingStyleId, onBuildingsStatus, clearBuildingSelection]);

  useEffect(() => {
    const Cesium = cesiumRef.current;
    const tileset = buildingsRef.current;
    if (!Cesium || !tileset || tileset.isDestroyed()) return;
    // Re-evaluating the style overwrites every per-feature colour, including the
    // highlight, so the selection goes first.
    clearBuildingSelection();
    tileset.style = buildingStyle(Cesium, buildingStyleId);
  }, [buildingStyleId, clearBuildingSelection]);

  // ── track points ─────────────────────────────────────────
  const rebuild = useCallback(() => {
    const Cesium = cesiumRef.current;
    const collection = pointsRef.current;
    if (!Cesium || !collection) return;

    collection.removeAll();
    const air = Cesium.Color.fromCssColorString(AIR_COLOR);
    const sea = Cesium.Color.fromCssColorString(SEA_COLOR);
    const entries: Entry[] = [];

    if (replay) {
      for (let i = 0; i < replay.ids.length; i++) {
        const kind = replay.kind[i] === 1 ? "sea" : "air";
        entries.push({
          id: replay.ids[i],
          kind,
          lon: replay.lon[i],
          lat: replay.lat[i],
          height: 0,
          hdg: null,
          sog: null,
          fixedAt: 0,
          point: collection.add({
            id: replay.ids[i],
            position: Cesium.Cartesian3.fromDegrees(replay.lon[i], replay.lat[i]),
            pixelSize: 2.4,
            disableDepthTestDistance: DOT_DEPTH_TEST_OFF_M,
            color: (kind === "sea" ? sea : air).withAlpha(0.75),
          }),
        });
      }
    } else {
      for (const t of tracks) {
        // Aircraft fly at their reported altitude; a vessel's `alt` is draught,
        // which is depth below the waterline and not a height at all.
        const height = t.kind === "air" && t.alt != null ? t.alt * FT_TO_M : 0;
        entries.push({
          id: t.id,
          kind: t.kind,
          lon: t.lon,
          lat: t.lat,
          height,
          hdg: t.hdg,
          sog: t.sog,
          fixedAt: t.fixedAt,
          point: collection.add({
            id: t.id,
            position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat, height),
            pixelSize: t.emergency ? 5 : 2.6,
            disableDepthTestDistance: DOT_DEPTH_TEST_OFF_M,
            color: t.emergency
              ? Cesium.Color.fromCssColorString(OFFLINE_COLOR)
              : t.kind === "sea"
                ? sea
                : air,
          }),
        });
      }
    }

    entriesRef.current = entries;
    replayingRef.current = Boolean(replay);
    layersDirtyRef.current = true;
  }, [tracks, replay]);

  useEffect(() => {
    if (ready) rebuild();
  }, [ready, rebuild]);

  // ── layer visibility ─────────────────────────────────────
  useEffect(() => {
    layersRef.current = layers;
    layersDirtyRef.current = true;
  }, [layers]);

  useEffect(() => {
    povRef.current = pov;
  }, [pov]);

  useEffect(() => {
    tiltRef.current = tiltDeg;
  }, [tiltDeg]);

  // ── selection marker, label and trail ────────────────────
  useEffect(() => {
    selectedRef.current = selectedId;
    const Cesium = cesiumRef.current;
    const markers = markerRef.current;
    const trails = trailRef.current;
    if (!ready || !Cesium || !markers || !trails) return;

    markers.removeAll();
    trails.removeAll();
    if (!selectedId) return;

    const entry = entriesRef.current.find((e) => e.id === selectedId);
    if (!entry) return;

    markers.add({
      id: selectedId,
      image: selectionRing(),
      position: Cesium.Cartesian3.fromDegrees(entry.lon, entry.lat, entry.height),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });

    if (trail.length > 1) {
      trails.add({
        positions: Cesium.Cartesian3.fromDegreesArray(trail.flat()),
        width: 1.2,
        material: Cesium.Material.fromType("Color", {
          color: Cesium.Color.fromCssColorString(ACCENT).withAlpha(0.6),
        }),
      });
    }
  }, [ready, selectedId, trail, tracks, replay]);

  // ── the render loop: dead reckoning, airframes, readouts ─
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!ready || !viewer || !Cesium || viewer.isDestroyed()) return;

    const { scene, camera } = viewer;
    const scratch = new Cesium.Cartesian3();
    const hpr = new Cesium.HeadingPitchRoll(0, 0, 0);
    // Scratch for the on-screen count below, which runs over every track.
    const viewProjection = new Cesium.Matrix4();
    const clip = new Cesium.Cartesian4();
    // The globe as a horizon occluder. Its minimum radius, so the sphere sits
    // just inside the ellipsoid and the test errs towards counting a track
    // rather than dropping one that is really on screen.
    const occluder = new Cesium.Occluder(
      new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, Cesium.Ellipsoid.WGS84.minimumRadius),
      camera.positionWC,
    );
    let lastProject = 0;
    let lastStats = 0;
    let modelled = 0;

    // POV runs every frame rather than at the projection rate — at 500 kt a
    // 200ms step is 50 m, which reads as the camera stuttering along behind the
    // aircraft. The entry it follows is refreshed by the projection pass below.
    const povPosition = new Cesium.Cartesian3();
    const povOffset = new Cesium.Cartesian3();
    const povFrame = new Cesium.Matrix4();
    const povHpr = new Cesium.HeadingPitchRoll(0, 0, 0);
    let povEntry: Entry | null = null;
    let cameraLocked = false;

    /** Builds the model pool the first time the camera comes low enough. */
    const ensureModels = () => {
      const pool = poolRef.current;
      if (!pool || pool.viewer !== viewer || pool.state !== "empty") return;
      pool.state = "loading";
      void (async () => {
        try {
          for (let i = 0; i < MAX_MODELS; i++) {
            // Every instance is the same URL, so Cesium's resource cache parses
            // the glTF once and the rest share it.
            const model = await Cesium.Model.fromGltfAsync({
              url: AIRCRAFT_URL,
              scale: AIRCRAFT_SCALE,
              // Keeps an airframe legible when it is a long way off without
              // letting it grow into a landmark up close.
              minimumPixelSize: 28,
              maximumScale: 20_000,
              incrementallyLoadTextures: false,
            });
            // This pool may have been replaced while the glTF was loading.
            if (poolRef.current !== pool || viewer.isDestroyed()) return;
            model.show = false;
            scene.primitives.add(model);
            pool.models.push(model);
          }
          pool.state = "ready";
        } catch (e) {
          // A missing or unreadable glb is not fatal: the console falls back to
          // dots, which is what it drew before the model existed. It should not
          // be silent, though — that is a long hunt otherwise.
          if (process.env.NODE_ENV === "development") {
            console.error("[watch] aircraft model pool failed to build", e);
          }
          pool.state = "ready";
        }
      })();
    };

    const tick = () => {
      const now = Date.now();

      // Advance air tracks between polls. Surface traffic moves a few hundred
      // metres in a poll interval — below a pixel at this scale — so it is left
      // where the feed put it.
      if (now - lastProject > PROJECT_INTERVAL_MS) {
        lastProject = now;
        const marker = markerRef.current?.length ? markerRef.current.get(0) : null;
        const selected = selectedRef.current;
        const entries = entriesRef.current;
        const live = !replayingRef.current;
        const showing = layersRef.current;

        if (layersDirtyRef.current) {
          layersDirtyRef.current = false;
          for (const entry of entries) entry.point.show = showing[entry.kind];
          if (lanesRef.current) lanesRef.current.show = showing.lanes;
          if (gapsRef.current) gapsRef.current.show = showing.gaps;
          if (sensorPointsRef.current) sensorPointsRef.current.show = showing.cams;
          if (labelsRef.current) labelsRef.current.show = showing.labels;
          if (!showing.air) {
            for (const model of poolRef.current?.models ?? []) model.show = false;
          }
        }

        povEntry = null;

        for (const entry of entries) {
          if (entry.id === selected) povEntry = entry;
          if (live && entry.kind === "air" && entry.hdg != null && entry.sog) {
            const seconds = Math.min(MAX_PROJECT_SEC, (now - entry.fixedAt) / 1000);
            const [lon, lat] = project(entry.lon, entry.lat, entry.hdg, entry.sog, seconds);
            entry.point.position = Cesium.Cartesian3.fromDegrees(
              lon, lat, entry.height, undefined, scratch,
            );
          }
          if (selected && entry.id === selected && marker) {
            marker.position = entry.point.position;
          }
        }

        // Airframes for the aircraft nearest the middle of the view, dots for
        // everything else.
        const height = camera.positionCartographic.height;
        const wantModels = live && showing.air && height < MODEL_CAMERA_HEIGHT_M;

        if (wantModels) ensureModels();
        const owned = poolRef.current;
        const pool = owned && owned.viewer === viewer ? owned.models : [];


        if (!wantModels || pool.length === 0) {
          if (modelled > 0) {
            for (const model of pool) model.show = false;
            modelled = 0;
          }
        } else {
          const centre = camera.positionWC;
          const candidates: { entry: Entry; d: number }[] = [];
          for (const entry of entries) {
            if (entry.kind !== "air") continue;
            const d = Cesium.Cartesian3.distance(centre, entry.point.position);
            // Cheap frustum-ish reject: anything further than the camera is
            // from the horizon is not worth sorting.
            if (d > height * 3) continue;
            candidates.push({ entry, d });
          }
          candidates.sort((a, b) => a.d - b.d);

          const take = Math.min(pool.length, candidates.length);
          for (let i = 0; i < take; i++) {
            const { entry } = candidates[i];
            const model = pool[i];
            hpr.heading = Cesium.Math.toRadians(
              (entry.hdg ?? 0) + HEADING_OFFSET_DEG,
            );
            Cesium.Transforms.headingPitchRollToFixedFrame(
              entry.point.position,
              hpr,
              Cesium.Ellipsoid.WGS84,
              Cesium.Transforms.eastNorthUpToFixedFrame,
              model.modelMatrix,
            );
            model.color =
              entry.id === selectedRef.current
                ? Cesium.Color.fromCssColorString(ACCENT)
                : Cesium.Color.WHITE;
            model.colorBlendMode = Cesium.ColorBlendMode.MIX;
            model.colorBlendAmount = entry.id === selectedRef.current ? 0.65 : 0.15;
            // What `scene.pick` hands back when the airframe is clicked. Without
            // it a model picks as `undefined` and the click reads as a click on
            // empty space, which clears the selection instead of making one —
            // the dot underneath is hidden, so there is nothing else to hit.
            model.id = entry.id;
            model.show = true;
            // The dot would z-fight with its own airframe.
            entry.point.show = false;
          }
          for (let i = take; i < pool.length; i++) pool[i].show = false;
          // Anything that lost its airframe this tick goes back to being a dot.
          if (take < modelled || take < candidates.length) {
            for (let i = take; i < candidates.length; i++) {
              candidates[i].entry.point.show = showing.air;
            }
          }
          modelled = take;
        }

      }

      // Ride with the selection. The aircraft's own heading frame is the
      // reference, so the offset is simply "behind the nose and above it":
      // -X is astern, +Z is up, and the chase angle swings between the two.
      if (povRef.current && povEntry && !replayingRef.current) {
        const entry = povEntry;
        const seconds = Math.min(MAX_PROJECT_SEC, (now - entry.fixedAt) / 1000);
        const [lon, lat] =
          entry.kind === "air" && entry.hdg != null && entry.sog
            ? project(entry.lon, entry.lat, entry.hdg, entry.sog, seconds)
            : [entry.lon, entry.lat];

        Cesium.Cartesian3.fromDegrees(lon, lat, entry.height, undefined, povPosition);
        povHpr.heading = Cesium.Math.toRadians((entry.hdg ?? 0) + HEADING_OFFSET_DEG);
        Cesium.Transforms.headingPitchRollToFixedFrame(
          povPosition,
          povHpr,
          Cesium.Ellipsoid.WGS84,
          Cesium.Transforms.eastNorthUpToFixedFrame,
          povFrame,
        );

        const pitch = Cesium.Math.toRadians(
          Math.min(POV_MAX_PITCH_DEG, Math.max(POV_MIN_PITCH_DEG, tiltRef.current)),
        );
        const range = entry.kind === "air" ? POV_RANGE_AIR_M : POV_RANGE_SEA_M;
        povOffset.x = -range * Math.cos(pitch);
        povOffset.y = 0;
        povOffset.z = range * Math.sin(pitch);
        camera.lookAtTransform(povFrame, povOffset);
        cameraLocked = true;
      } else if (cameraLocked) {
        // Hand the camera back where it stands, rather than snapping it home.
        cameraLocked = false;
        camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      }

      if (now - lastStats > STATS_INTERVAL_MS) {
        lastStats = now;
        // What is actually on screen, not what falls inside the ground rectangle
        // the camera sees. The two are the same only looking straight down from
        // orbit: zoomed in, the rectangle is a few hundred metres across while
        // the screen is full of traffic beyond it, and an aircraft at altitude
        // is on screen long after its ground position has left the rectangle.
        occluder.cameraPosition = camera.positionWC;
        Cesium.Matrix4.multiply(
          camera.frustum.projectionMatrix, camera.viewMatrix, viewProjection,
        );
        let inView = 0;
        for (const entry of entriesRef.current) {
          if (!layersRef.current[entry.kind]) continue;
          const at = entry.point.position;
          // Over the horizon: on the far side of the globe, and drawn or not it
          // is not something the operator can see.
          if (!occluder.isPointVisible(at)) continue;
          clip.x = at.x; clip.y = at.y; clip.z = at.z; clip.w = 1;
          Cesium.Matrix4.multiplyByVector(viewProjection, clip, clip);
          // Behind the camera, or outside the frustum's side planes.
          if (clip.w <= 0) continue;
          if (Math.abs(clip.x) > clip.w || Math.abs(clip.y) > clip.w) continue;
          inView++;
        }

        // Measure the scale bar against the globe rather than deriving it from
        // camera height: at a tilt the two disagree by a lot.
        const canvas = scene.canvas;
        const cx = canvas.clientWidth / 2;
        const cy = canvas.clientHeight / 2;
        const a = camera.pickEllipsoid(new Cesium.Cartesian2(cx - SCALEBAR_PX / 2, cy));
        const b = camera.pickEllipsoid(new Cesium.Cartesian2(cx + SCALEBAR_PX / 2, cy));
        const scaleMetres =
          a && b
            ? new Cesium.EllipsoidGeodesic(
                Cesium.Cartographic.fromCartesian(a),
                Cesium.Cartographic.fromCartesian(b),
              ).surfaceDistance
            : 0;

        onStats({
          inView,
          scaleMetres,
          cameraHeight: camera.positionCartographic.height,
          modelled,
        });
      }
    };

    scene.postRender.addEventListener(tick);
    return () => {
      if (viewer.isDestroyed()) return;
      scene.postRender.removeEventListener(tick);
      // A camera left inside a reference frame ignores drag and zoom, so the
      // lock must not outlive the loop that maintains it.
      if (cameraLocked) camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    };
  }, [ready, onStats]);

  return (
    <>
      <div ref={containerRef} style={{ height: "100%", width: "100%" }} />
      {error && (
        <div className="wempty" style={{ position: "absolute", inset: 0, padding: 24 }}>
          Could not load the globe: {error}
        </div>
      )}
    </>
  );
});

export default WatchGlobe;
