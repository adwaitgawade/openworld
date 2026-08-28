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

import { circlePoints } from "@/lib/watch/geo";
import { project } from "@/lib/watch/geo";
import { LANES } from "@/lib/watch/lanes";
import { COVERAGE_GAPS, PLACES, SENSORS, SENSOR_SITES } from "@/lib/watch/stations";
import type { Track } from "@/lib/watch/types";
import { createImageryProviders, ION_TOKEN, type MapStackId } from "@/lib/mapStacks";

import "cesium/Build/Cesium/Widgets/widgets.css";

declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
  }
}

export type LayerId = "air" | "sea" | "lanes" | "cams" | "gaps" | "labels";
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
};

export type WatchGlobeHandle = {
  flyTo(lon: number, lat: number, heightMetres?: number): void;
};

type Props = {
  tracks: Track[];
  /** Non-null while the timeline head is behind live. */
  replay: ReplayFrame | null;
  layers: Layers;
  selectedId: string | null;
  /** Past positions of the selection, oldest first. */
  trail: [number, number][];
  stackId: MapStackId;
  onSelect: (id: string | null) => void;
  onCursor: (position: { lon: number; lat: number } | null) => void;
  onStats: (stats: GlobeStats) => void;
  onReady: () => void;
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

const WatchGlobe = forwardRef<WatchGlobeHandle, Props>(function WatchGlobe(
  { tracks, replay, layers, selectedId, trail, stackId, onSelect, onCursor, onStats, onReady },
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

  // Dead-reckoning state. Refs, not state: this is read from a render loop that
  // must not re-run React.
  type Entry = {
    id: string;
    kind: "air" | "sea";
    lon: number;
    lat: number;
    hdg: number | null;
    sog: number | null;
    fixedAt: number;
    point: import("cesium").PointPrimitive;
  };
  const entriesRef = useRef<Entry[]>([]);
  const selectedRef = useRef<string | null>(null);
  const replayingRef = useRef(false);

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

      const imagery = await createImageryProviders(Cesium, stackId, false);
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
        // No terrain: this console works at ocean scale, where terrain tiles buy
        // nothing and cost a lot of requests.
      });
      viewerRef.current = viewer;
      if (process.env.NODE_ENV === "development") {
        // Same escape hatch CesiumGlobe exposes: poking at the live scene from
        // the console is how anything about this globe gets diagnosed.
        (window as unknown as { __watchViewer?: Viewer }).__watchViewer = viewer;
      }
      imageryLayersRef.current = [
        viewer.imageryLayers.get(0),
        ...imagery.slice(1).map((o) => viewer.imageryLayers.addImageryProvider(o)),
      ];

      const { scene } = viewer;
      // Day/night on the globe is the terminator the design draws by hand.
      scene.globe.enableLighting = true;
      scene.globe.showGroundAtmosphere = true;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
      scene.globe.baseColor = Cesium.Color.fromCssColorString("#070b0e");
      scene.backgroundColor = Cesium.Color.fromCssColorString("#060605");
      scene.globe.showWaterEffect = false;
      // Nothing on this console is placed on terrain, and the depth test costs
      // a pass that shows up at 12 000 points.
      scene.globe.depthTestAgainstTerrain = false;

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

      for (const site of [...SENSOR_SITES.map(([lon, lat]) => ({ lon, lat, offline: false })), ...SENSORS]) {
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

      // ── interaction ────────────────────────────────────────
      const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
      handler.setInputAction(({ position }: { position: import("cesium").Cartesian2 }) => {
        const picked = scene.pick(position);
        const id = picked?.id;
        onSelect(typeof id === "string" ? id : null);
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

      viewer.camera.setView({
        destination: Cesium.Rectangle.fromDegrees(-80, -75, 100, 75),
      });
      viewer.camera.zoomOut(viewer.camera.positionCartographic.height * 0.33);

      mountedStackRef.current = stackId;
      setReady(true);
      onReady();

      return () => handler.destroy();
    })().catch((e: unknown) => {
      if (!disposed) setError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      disposed = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
      entriesRef.current = [];
      imageryLayersRef.current = [];
    };
    // Deliberately mounts once: `stackId` changes are applied by the imagery
    // effect below rather than by tearing down the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
          hdg: null,
          sog: null,
          fixedAt: 0,
          point: collection.add({
            id: replay.ids[i],
            position: Cesium.Cartesian3.fromDegrees(replay.lon[i], replay.lat[i]),
            pixelSize: 2.4,
            color: (kind === "sea" ? sea : air).withAlpha(0.75),
          }),
        });
      }
    } else {
      for (const t of tracks) {
        entries.push({
          id: t.id,
          kind: t.kind,
          lon: t.lon,
          lat: t.lat,
          hdg: t.hdg,
          sog: t.sog,
          fixedAt: t.fixedAt,
          point: collection.add({
            id: t.id,
            position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat),
            pixelSize: t.emergency ? 5 : 2.6,
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
  }, [tracks, replay]);

  useEffect(() => {
    if (ready) rebuild();
  }, [ready, rebuild]);

  // ── layer visibility ─────────────────────────────────────
  useEffect(() => {
    if (!ready) return;
    const collection = pointsRef.current;
    if (collection) {
      for (const entry of entriesRef.current) {
        entry.point.show = layers[entry.kind];
      }
    }
    if (lanesRef.current) lanesRef.current.show = layers.lanes;
    if (gapsRef.current) gapsRef.current.show = layers.gaps;
    if (sensorPointsRef.current) sensorPointsRef.current.show = layers.cams;
    if (labelsRef.current) labelsRef.current.show = layers.labels;
  }, [ready, layers, tracks, replay]);

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
      position: Cesium.Cartesian3.fromDegrees(entry.lon, entry.lat),
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

  // ── the render loop: dead reckoning, readouts ────────────
  useEffect(() => {
    const viewer = viewerRef.current;
    const Cesium = cesiumRef.current;
    if (!ready || !viewer || !Cesium || viewer.isDestroyed()) return;

    const { scene, camera } = viewer;
    const scratch = new Cesium.Cartesian3();
    let lastProject = 0;
    let lastStats = 0;

    const tick = () => {
      const now = Date.now();

      // Advance air tracks between polls. Surface traffic moves a few hundred
      // metres in a poll interval — below a pixel at this scale — so it is left
      // where the feed put it.
      if (!replayingRef.current && now - lastProject > PROJECT_INTERVAL_MS) {
        lastProject = now;
        const marker = markerRef.current?.length ? markerRef.current.get(0) : null;
        const selected = selectedRef.current;
        for (const entry of entriesRef.current) {
          if (entry.kind !== "air" || entry.hdg == null || !entry.sog) {
            if (selected && entry.id === selected && marker) {
              marker.position = Cesium.Cartesian3.fromDegrees(entry.lon, entry.lat, 0, undefined, scratch);
            }
            continue;
          }
          const seconds = Math.min(MAX_PROJECT_SEC, (now - entry.fixedAt) / 1000);
          const [lon, lat] = project(entry.lon, entry.lat, entry.hdg, entry.sog, seconds);
          entry.point.position = Cesium.Cartesian3.fromDegrees(lon, lat, 0, undefined, scratch);
          if (selected && entry.id === selected && marker) {
            marker.position = entry.point.position;
          }
        }
      }

      if (now - lastStats > STATS_INTERVAL_MS) {
        lastStats = now;
        const view = camera.computeViewRectangle();
        let inView = 0;
        if (view) {
          const west = Cesium.Math.toDegrees(view.west);
          const east = Cesium.Math.toDegrees(view.east);
          const south = Cesium.Math.toDegrees(view.south);
          const north = Cesium.Math.toDegrees(view.north);
          // A rectangle that crosses the antimeridian comes back with west > east.
          const wraps = west > east;
          for (const entry of entriesRef.current) {
            if (!layers[entry.kind]) continue;
            if (entry.lat < south || entry.lat > north) continue;
            const inLon = wraps
              ? entry.lon >= west || entry.lon <= east
              : entry.lon >= west && entry.lon <= east;
            if (inLon) inView++;
          }
        } else {
          inView = entriesRef.current.filter((e) => layers[e.kind]).length;
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

        onStats({ inView, scaleMetres });
      }
    };

    scene.postRender.addEventListener(tick);
    return () => {
      if (!viewer.isDestroyed()) scene.postRender.removeEventListener(tick);
    };
  }, [ready, layers, onStats]);

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
