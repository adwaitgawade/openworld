"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import type { Ref } from "react";

import type { MapStackId } from "@/lib/mapStacks";
import type { BuildingStyleId } from "@/lib/buildings";
import type { BuildingInfo } from "@/lib/buildingInfo";
import type { BuildingDetails } from "@/lib/buildingDetails";
import type { Track } from "@/lib/watch/types";
import BuildingInfoCallout from "../BuildingInfoCallout";
import SelectionHud from "./SelectionHud";
import type { DetailState } from "./useAircraftDetail";
import type {
  GlobeStats,
  Layers,
  LayerId,
  RouteGeometry,
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

type LayerRow = { id: LayerId; label: string; color: string };

const LAYER_ROWS: LayerRow[] = [
  { id: "air", label: "AIR TRACKS", color: "#4FD1E0" },
  { id: "ground", label: "ON GROUND", color: "#2E8794" },
  { id: "sea", label: "SURFACE", color: "#E8A33D" },
  { id: "buildings", label: "3D BUILDINGS", color: "#D8D6CE" },
];

/**
 * Reference geometry rather than feed data, so it sits behind a disclosure
 * instead of on the main list. Each row carries the caveat its geometry needs:
 * these are hand-placed approximations, not something the feeds produce.
 */
const EXTRA_LAYER_ROWS: (LayerRow & { info: string })[] = [
  {
    id: "lanes",
    label: "LANES",
    color: "#6E7F8C",
    info:
      "Twelve hand-drawn polylines tracing the approximate centrelines of the world's busiest commercial shipping routes — Asia–Europe via Suez, Transpacific North, Cape Route, Panama–Asia and so on. Pure reference geometry: nothing reads them for alerts or track logic. They are here so a scatter of AIS hulls reads as traffic on a route rather than random dots.",
  },
  {
    id: "labels",
    label: "PLACE LABELS",
    color: "#8A877C",
    info:
      "Nine chokepoint names — Gibraltar, Suez, Hormuz, Malacca, Panama, Dover, Bab el Mandeb, Taiwan Strait and the Cape — pinned at fixed coordinates. Like the lanes, they are static captions rather than anything the feeds report, and the loiter alert measures against these same points.",
  },
  {
    id: "gaps",
    label: "COVERAGE GAPS",
    color: "#E8577F",
    info:
      "Five dashed circles over the central Pacific, south Atlantic, south Indian Ocean, southwest Pacific and Labrador Sea — regions with no reporting coverage. ADS-B and AIS are receiver-based, so mid-ocean traffic genuinely goes dark, and these say so rather than letting the map imply uniform global coverage. A track inside one raises a P3 COVERAGE GAP alert. The circles themselves are hand-placed approximations, not derived from the feeds.",
  },
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
  layers: Layers;
  onLayer: (id: LayerId) => void;
  counts: { air: number; ground: number; sea: number };
  selected: Track | null;
  /** Airframe and route for the selected aircraft, from adsbdb. */
  detail: DetailState;
  /** Scheduled route of the selection, drawn on the globe. */
  route: RouteGeometry | null;
  /** Fly the camera to one end of that route. */
  onAirport: (lon: number, lat: number) => void;
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
  globeRef, tracks, layers, onLayer, counts, selected, detail, route, onAirport, trail, stackId,
  buildingStyleId, buildingsStatus, building, buildingAt, buildingDetails,
  buildingDetailsError, onBuildingPick, onBuildingAnchor, onBuildingsStatus,
  tiltDeg, onTilt, pov, onPov, cursor, stats, unresolved, now, onSelect, onCursor, onStats,
  onReady, onFollow, onCopy,
}: Props) {
  const total = tracks.length;

  // Reference geometry lives behind a disclosure. The coverage view turns both
  // layers on by preset, so the section opens itself rather than leaving the
  // user looking at lines with no control for them.
  const [opened, setOpened] = useState(false);
  const [info, setInfo] = useState<LayerId | null>(null);
  // Either the user opened it, or a preset (the coverage view) switched one of
  // these layers on — in which case the section has to be open to own its
  // control.
  const extrasOpen = opened || EXTRA_LAYER_ROWS.some((row) => layers[row.id]);

  // Collapsing hides the geometry too: an unreachable layer left drawn on the
  // globe is the confusing case.
  const toggleExtras = () => {
    if (extrasOpen) {
      setInfo(null);
      for (const row of EXTRA_LAYER_ROWS) if (layers[row.id]) onLayer(row.id);
    }
    setOpened(!extrasOpen);
  };

  return (
    <div className="wstage">
      <WatchGlobe
        ref={globeRef}
        tracks={tracks}
        layers={layers}
        selectedId={selected?.id ?? null}
        pov={pov}
        tiltDeg={tiltDeg}
        trail={trail}
        route={route}
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
            {row.id === "buildings" && layers.buildings && (
              <b>{buildingsStatus === "loading" ? "…" : buildingsStatus === "error" ? "ERR" : "ON"}</b>
            )}
          </button>
        ))}

        <button
          type="button"
          className={`wly wlyx${extrasOpen ? " on" : ""}`}
          aria-expanded={extrasOpen}
          onClick={toggleExtras}
        >
          <span className="sw" />
          EXTRA OPTIONS
          <b>{extrasOpen ? "−" : "+"}</b>
        </button>

        {extrasOpen && (
          <div className="wlyex">
            {EXTRA_LAYER_ROWS.map((row) => (
              <div key={row.id} className="wlyrow">
                <button
                  type="button"
                  className={`wly${layers[row.id] ? " on" : ""}`}
                  style={{ color: layers[row.id] ? row.color : undefined }}
                  onClick={() => onLayer(row.id)}
                >
                  <span className="sw" />
                  {row.label}
                </button>
                <button
                  type="button"
                  className={`wlyi${info === row.id ? " on" : ""}`}
                  aria-label={`What ${row.label.toLowerCase()} are`}
                  aria-expanded={info === row.id}
                  onClick={() => setInfo((previous) => (previous === row.id ? null : row.id))}
                >
                  i
                </button>
                {info === row.id && <p className="wlyinfo">{row.info}</p>}
              </div>
            ))}
          </div>
        )}
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
          detail={detail}
          onAirport={onAirport}
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
