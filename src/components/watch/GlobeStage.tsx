"use client";

import dynamic from "next/dynamic";
import type { Ref } from "react";

import type { MapStackId } from "@/lib/mapStacks";
import type { BuildingStyleId } from "@/lib/buildings";
import type { BuildingInfo } from "@/lib/buildingInfo";
import type { BuildingDetails } from "@/lib/buildingDetails";
import type { Track } from "@/lib/watch/types";
import BuildingInfoCallout from "../BuildingInfoCallout";
import SelectionHud from "./SelectionHud";
import type {
  GlobeStats,
  Layers,
  LayerId,
  ReplayFrame,
  WatchGlobeHandle,
} from "./WatchGlobe";

// Cesium touches `window` and WebGL at import time, so it must never be
// prerendered.
const WatchGlobe = dynamic(() => import("./WatchGlobe"), {
  ssr: false,
  loading: () => (
    <div className="wempty" style={{ padding: 24 }}>
      Bringing the globe up…
    </div>
  ),
});

const LAYER_ROWS: { id: LayerId; label: string; color: string }[] = [
  { id: "air", label: "AIR TRACKS", color: "#4FD1E0" },
  { id: "ground", label: "ON GROUND", color: "#2E8794" },
  { id: "sea", label: "SURFACE", color: "#E8A33D" },
  { id: "lanes", label: "LANES", color: "#6E7F8C" },
  { id: "cams", label: "SENSORS", color: "#7BE38A" },
  { id: "gaps", label: "COVERAGE GAPS", color: "#E8577F" },
  { id: "buildings", label: "3D BUILDINGS", color: "#D8D6CE" },
  { id: "labels", label: "PLACE LABELS", color: "#8A877C" },
];

/** Degrees below horizontal, matching the explorer globe's three presets. */
const TILT_PRESETS: { label: string; deg: number }[] = [
  { label: "HORIZON", deg: 8 },
  { label: "OBLIQUE", deg: 45 },
  { label: "TOP-DOWN", deg: 90 },
];

function group(n: number): string {
  return n.toLocaleString("en-US").replace(/,/g, " ");
}

function fmtScale(metres: number): string {
  if (!(metres > 0)) return "—";
  const km = metres / 1000;
  if (km < 1) return `${Math.round(metres)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  const rounded = km < 100 ? Math.round(km / 5) * 5 : Math.round(km / 50) * 50;
  return `${group(rounded)} km`;
}

type Props = {
  globeRef: Ref<WatchGlobeHandle>;
  tracks: Track[];
  replay: ReplayFrame | null;
  layers: Layers;
  onLayer: (id: LayerId) => void;
  counts: { air: number; ground: number; sea: number; cams: number };
  selected: Track | null;
  trail: [number, number][];
  stackId: MapStackId;
  buildingStyleId: BuildingStyleId;
  buildingsStatus: "idle" | "loading" | "loaded" | "error";
  building: BuildingInfo | null;
  buildingAt: { x: number; y: number } | null;
  buildingDetails: BuildingDetails | null;
  buildingDetailsError: string | null;
  onBuildingPick: (info: BuildingInfo | null) => void;
  onBuildingAnchor: (at: { x: number; y: number } | null) => void;
  onBuildingsStatus: (status: "idle" | "loading" | "loaded" | "error", error?: string) => void;
  tiltDeg: number;
  onTilt: (deg: number) => void;
  /** True while the camera is locked to the selected track. */
  pov: boolean;
  onPov: () => void;
  cursor: { lon: number; lat: number } | null;
  stats: GlobeStats;
  unresolved: number;
  now: number;
  onSelect: (id: string | null) => void;
  onCursor: (position: { lon: number; lat: number } | null) => void;
  onStats: (stats: GlobeStats) => void;
  onReady: () => void;
  onFollow: () => void;
  onCopy: () => void;
};

export default function GlobeStage({
  globeRef, tracks, replay, layers, onLayer, counts, selected, trail, stackId,
  buildingStyleId, buildingsStatus, building, buildingAt, buildingDetails,
  buildingDetailsError, onBuildingPick, onBuildingAnchor, onBuildingsStatus,
  tiltDeg, onTilt, pov, onPov, cursor, stats, unresolved, now, onSelect, onCursor, onStats,
  onReady, onFollow, onCopy,
}: Props) {
  const total = tracks.length;

  return (
    <div className="wstage">
      <WatchGlobe
        ref={globeRef}
        tracks={tracks}
        replay={replay}
        layers={layers}
        selectedId={selected?.id ?? null}
        pov={pov}
        tiltDeg={tiltDeg}
        trail={trail}
        stackId={stackId}
        buildingStyleId={buildingStyleId}
        onSelect={onSelect}
        onCursor={onCursor}
        onStats={onStats}
        onReady={onReady}
        onBuildingPick={onBuildingPick}
        onBuildingAnchor={onBuildingAnchor}
        onBuildingsStatus={onBuildingsStatus}
      />

      <div className="wov wlayers">
        <div className="wlgh">LAYERS</div>
        {LAYER_ROWS.map((row) => (
          <button
            key={row.id}
            type="button"
            className={`wly${layers[row.id] ? " on" : ""}`}
            style={{ color: layers[row.id] ? row.color : undefined }}
            onClick={() => onLayer(row.id)}
          >
            <span className="sw" />
            {row.label}
            {row.id === "air" && <b>{group(counts.air)}</b>}
            {row.id === "ground" && <b>{group(counts.ground)}</b>}
            {row.id === "sea" && <b>{group(counts.sea)}</b>}
            {row.id === "cams" && <b>{counts.cams}</b>}
            {row.id === "buildings" && layers.buildings && (
              <b>{buildingsStatus === "loading" ? "…" : buildingsStatus === "error" ? "ERR" : "ON"}</b>
            )}
          </button>
        ))}
      </div>

      <div className="wov wreadout">
        <div className="wro">
          <span>TRACKS</span>
          <b>{group(total)}</b>
        </div>
        <div className="wro">
          <span>IN VIEW</span>
          <b>{group(stats.inView)}</b>
        </div>
        <div className="wro">
          <span>AIRFRAMES</span>
          <b>{stats.modelled > 0 ? group(stats.modelled) : "—"}</b>
        </div>
        <div className="wro">
          <span>UNRESOLVED</span>
          <b>{group(unresolved)}</b>
        </div>
        <div className="wro">
          <span>CURSOR</span>
          <b>
            {cursor
              ? `${Math.abs(cursor.lat).toFixed(1)}${cursor.lat >= 0 ? "N" : "S"} ${Math.abs(cursor.lon).toFixed(1)}${cursor.lon >= 0 ? "E" : "W"}`
              : "—"}
          </b>
        </div>
        <div className="wro">
          <span>BASE</span>
          <b>{stackId === "esri" ? "ESRI" : "OSM"}</b>
        </div>
      </div>

      <div className="wov wtilt">
        <div className="row">
          {/* In POV the same angle swings the camera between astern of the
              aircraft and above it, so the panel says what it is doing. */}
          <span>{pov ? "CHASE ANGLE" : "CAMERA ATTITUDE"}</span>
          <b>{tiltDeg}°</b>
        </div>
        <input
          type="range"
          min={5}
          max={90}
          step={1}
          value={tiltDeg}
          aria-label="Camera angle below horizontal"
          onChange={(e) => onTilt(Number(e.target.value))}
        />
        <div className="presets">
          {TILT_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className={tiltDeg === preset.deg ? "on" : undefined}
              onClick={() => onTilt(preset.deg)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="wscalebar">
        <i />
        <span>{fmtScale(stats.scaleMetres)}</span>
      </div>

      {selected && (
        <SelectionHud
          track={selected}
          now={now}
          pov={pov}
          onPov={onPov}
          onFollow={onFollow}
          onCopy={onCopy}
          onClear={() => onSelect(null)}
        />
      )}

      {building && buildingAt && (
        <BuildingInfoCallout
          key={JSON.stringify(building.query)}
          info={building}
          details={buildingDetails}
          detailsError={buildingDetailsError}
          x={buildingAt.x}
          y={buildingAt.y}
          onClose={() => {
            onBuildingPick(null);
            onBuildingAnchor(null);
          }}
        />
      )}
    </div>
  );
}
