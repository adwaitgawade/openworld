"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Viewer } from "cesium";

import {
  DEFAULT_STACK_ID,
  ION_TOKEN,
  MAP_STACKS,
  createImageryProvider,
  createTerrainProvider,
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

export default function CesiumGlobe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const cesiumRef = useRef<typeof import("cesium") | null>(null);
  const imageryLayerRef = useRef<import("cesium").ImageryLayer | null>(null);
  const stopSpinRef = useRef<(() => void) | null>(null);

  const [stackId, setStackId] = useState<MapStackId>(DEFAULT_STACK_ID);
  // Degrees below horizontal: 90 looks straight down, 0 sits on the horizon.
  const [tiltDeg, setTiltDeg] = useState(90);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

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
        createImageryProvider(Cesium, DEFAULT_STACK_ID),
        createTerrainProvider(Cesium),
      ]);
      if (disposed) return;

      const viewer = new Cesium.Viewer(container, {
        baseLayer: new Cesium.ImageryLayer(imagery),
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
      imageryLayerRef.current = viewer.imageryLayers.get(0);
      if (process.env.NODE_ENV === "development") {
        (window as unknown as { __viewer?: Viewer }).__viewer = viewer;
      }

      if (!ION_TOKEN && keylessTerrain) {
        viewer.terrainProvider = keylessTerrain;
      }

      // Sunlit globe with an atmosphere, which is what sells the "3D earth" look.
      const { scene } = viewer;
      scene.globe.enableLighting = true;
      scene.globe.showGroundAtmosphere = true;
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;

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
      imageryLayerRef.current = null;
      stopSpinRef.current = null;
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

  const switchStack = useCallback(
    async (next: MapStackId) => {
      const viewer = viewerRef.current;
      const Cesium = cesiumRef.current;
      if (!viewer || !Cesium || viewer.isDestroyed()) return;

      stopSpinRef.current?.();
      setStackId(next);
      try {
        const provider = await createImageryProvider(Cesium, next);
        if (viewer.isDestroyed()) return;

        // Add the new layer beneath the old one, then drop the old one, so the
        // globe never flashes an empty base layer mid-switch.
        const layer = viewer.imageryLayers.addImageryProvider(provider, 0);
        const previous = imageryLayerRef.current;
        if (previous) viewer.imageryLayers.remove(previous, true);
        imageryLayerRef.current = layer;
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

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

      <div className="pointer-events-none absolute left-4 top-4 rounded-md bg-black/50 px-3 py-2 text-xs text-zinc-300 backdrop-blur">
        Drag to rotate · Scroll to zoom · Ctrl+drag to tilt
      </div>

      {ready && (
        <div className="absolute right-4 top-4 flex flex-col gap-1 rounded-md bg-black/50 p-1.5 backdrop-blur">
          {MAP_STACKS.map((stack) => (
            <button
              key={stack.id}
              type="button"
              disabled={!stack.available}
              onClick={() => switchStack(stack.id)}
              title={
                stack.available
                  ? `${stack.label} — ${stack.note}`
                  : `${stack.label} — needs a Bing Maps key or Cesium ion token`
              }
              className={`rounded px-2.5 py-1 text-left text-xs transition-colors ${
                stackId === stack.id
                  ? "bg-white/90 text-black"
                  : "text-zinc-300 hover:bg-white/10"
              } disabled:cursor-not-allowed disabled:text-zinc-600 disabled:hover:bg-transparent`}
            >
              {stack.label}
            </button>
          ))}
        </div>
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
