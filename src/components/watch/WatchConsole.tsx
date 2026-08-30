"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MapStackId } from "@/lib/mapStacks";
import {
  BUILDING_STYLES,
  DEFAULT_BUILDING_STYLE,
  type BuildingStyleId,
} from "@/lib/buildings";
import { fetchBuildingDetails, type BuildingDetails } from "@/lib/buildingDetails";
import type { BuildingInfo } from "@/lib/buildingInfo";
import type { Alert, Track } from "@/lib/watch/types";

import CommandPalette, { type Command } from "./CommandPalette";
import GlobeStage from "./GlobeStage";
import PriorityQueue, { type AlertFilter } from "./PriorityQueue";
import TopBar, { type ViewId } from "./TopBar";
import { useFeed } from "./useFeed";
import { useAircraftDetail } from "./useAircraftDetail";
import type {
  GlobeStats,
  LayerId,
  Layers,
  RouteGeometry,
  WatchGlobeHandle,
} from "./WatchGlobe";
import "./watch.css";

/** Degrees below horizontal the camera starts at: straight down. */
const DEFAULT_TILT = 90;

const LIVE_LAYERS: Layers = {
  air: true,
  ground: true,
  sea: true,
  lanes: false,
  gaps: false,
  labels: false,
  buildings: false,
};

const COVERAGE_LAYERS: Layers = {
  air: false,
  ground: false,
  sea: true,
  lanes: true,
  gaps: true,
  labels: true,
  buildings: false,
};

export default function WatchConsole() {
  const { snapshot, history, error } = useFeed();
  const globeRef = useRef<WatchGlobeHandle>(null);

  const [coverage, setCoverage] = useState(false);
  const [layers, setLayers] = useState<Layers>(LIVE_LAYERS);
  const [stackId, setStackId] = useState<MapStackId>("esri");
  const [filter, setFilter] = useState<AlertFilter>("ALL");
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ lon: number; lat: number } | null>(null);
  const [stats, setStats] = useState<GlobeStats>({
    inView: 0,
    scaleMetres: 0,
    cameraHeight: 0,
    modelled: 0,
  });
  const [tiltDeg, setTiltDeg] = useState(DEFAULT_TILT);
  const [pov, setPov] = useState(false);
  const [buildingStyleId, setBuildingStyleId] =
    useState<BuildingStyleId>(DEFAULT_BUILDING_STYLE);
  const [buildingsStatus, setBuildingsStatus] =
    useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [building, setBuilding] = useState<BuildingInfo | null>(null);
  // Window coordinates of the anchor, or null while it is off-screen or hidden
  // behind the globe.
  const [buildingAt, setBuildingAt] = useState<{ x: number; y: number } | null>(null);
  const [buildingDetails, setBuildingDetails] = useState<BuildingDetails | null>(null);
  const [buildingDetailsError, setBuildingDetailsError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // One shared second-resolution clock. Alert ages and the timeline both read
  // from it rather than each running their own interval.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const say = useCallback((message: string) => {
    setToast(message);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(timer);
  }, [toast]);

  const tracks = useMemo(() => snapshot?.tracks ?? [], [snapshot]);
  const alerts = useMemo(() => snapshot?.alerts ?? [], [snapshot]);

  const byId = useMemo(() => {
    const map = new Map<string, Track>();
    for (const track of tracks) map.set(track.id, track);
    return map;
  }, [tracks]);

  const counts = useMemo(() => {
    let air = 0;
    let ground = 0;
    let sea = 0;
    for (const track of tracks) {
      if (track.kind === "sea") sea++;
      else if (track.onGround) ground++;
      else air++;
    }
    return { air, ground, sea };
  }, [tracks]);

  // Past positions of the selection, for the trail behind it.
  const trail = useMemo<[number, number][]>(() => {
    if (!selectedTrackId) return [];
    const path: [number, number][] = [];
    for (const frame of history) {
      const i = frame.ids.indexOf(selectedTrackId);
      if (i >= 0) path.push([frame.lon[i], frame.lat[i]]);
    }
    const current = byId.get(selectedTrackId);
    if (current) path.push([current.lon, current.lat]);
    return path;
  }, [selectedTrackId, history, byId]);

  const selected = selectedTrackId ? (byId.get(selectedTrackId) ?? null) : null;
  // A track can drop out of the feed mid-chase; when it does the camera comes
  // free on its own rather than riding a position that stopped updating.
  const povActive = pov && selected !== null;

  /**
   * The callsign to look a route up by, or null when there is nothing to ask.
   *
   * `name` falls back to the ICAO24 or the registration when the transponder
   * reports no callsign, and neither of those resolves to a route — recognise
   * them here rather than spending a request to be told so.
   */
  const routeCallsign = useMemo(() => {
    if (!selected || selected.kind !== "air") return null;
    const name = selected.name.trim().toUpperCase();
    if (!name || name === selected.id.trim().toUpperCase()) return null;
    if (selected.reg && name === selected.reg.trim().toUpperCase()) return null;
    return name;
  }, [selected]);

  const aircraftDetail = useAircraftDetail(
    selected?.kind === "air" ? selected.id : null,
    routeCallsign,
  );

  /** The route as the globe wants it: two endpoints and where the flight is. */
  const routeGeometry = useMemo<RouteGeometry | null>(() => {
    const route = aircraftDetail.route;
    if (!route || !selected || selected.kind !== "air") return null;
    return {
      origin: { lon: route.origin.lon, lat: route.origin.lat, code: route.origin.iata ?? route.origin.icao },
      destination: {
        lon: route.destination.lon,
        lat: route.destination.lat,
        code: route.destination.iata ?? route.destination.icao,
      },
      at: { lon: selected.lon, lat: selected.lat },
    };
  }, [aircraftDetail.route, selected]);

  const flyToAirport = useCallback((lon: number, lat: number) => {
    globeRef.current?.flyToAirport(lon, lat);
  }, []);

  // ── actions ──────────────────────────────────────────────
  const flyToTrack = useCallback(
    (track: Track) => {
      globeRef.current?.flyTo(track.lon, track.lat, track.kind === "air" ? 1_800_000 : 900_000);
    },
    [],
  );

  const selectTrack = useCallback(
    (id: string | null, options: { fly?: boolean } = {}) => {
      setSelectedTrackId(id);
      if (!id) {
        // Nothing to ride with.
        setPov(false);
        return;
      }
      setSelectedAlertId(null);
      const track = byId.get(id);
      // A chase already frames the track; flying the camera would fight it.
      if (track && options.fly && !pov) flyToTrack(track);
    },
    [byId, flyToTrack, pov],
  );

  const selectAlert = useCallback(
    (alert: Alert) => {
      setSelectedAlertId(alert.id);
      if (!alert.trackId) {
        say(`${alert.rule} · ${alert.sub}`);
        return;
      }
      const track = byId.get(alert.trackId);
      if (!track) {
        say(`${alert.rule} · track ${alert.trackId} is no longer in the live picture`);
        return;
      }
      setSelectedTrackId(track.id);
      flyToTrack(track);
    },
    [byId, flyToTrack, say],
  );

  const toggleLayer = useCallback((id: LayerId) => {
    setLayers((previous) => ({ ...previous, [id]: !previous[id] }));
  }, []);

  const applyTilt = useCallback(
    (deg: number) => {
      setTiltDeg(deg);
      // In POV the globe reads the angle straight off the prop each frame; the
      // imperative pivot is only for a free camera.
      if (!pov) globeRef.current?.setTilt(deg);
    },
    [pov],
  );

  const togglePov = useCallback(() => {
    if (pov) {
      setPov(false);
      say("Camera released");
      return;
    }
    if (!selectedTrackId) return;
    setPov(true);
    // The chase starts astern rather than overhead — top-down is what the
    // camera was already doing, and it makes a poor ride-along.
    setTiltDeg((deg) => (deg > 60 ? 18 : deg));
    say(`Camera locked to ${byId.get(selectedTrackId)?.name ?? selectedTrackId} — chase angle on the attitude slider`);
  }, [pov, selectedTrackId, byId, say]);

  const clearBuilding = useCallback((info: BuildingInfo | null) => {
    setBuilding(info);
    // Every selection change comes through here, so the details that belonged
    // to the previous building go with it rather than lingering under the new
    // one's header while the fetch is in flight.
    setBuildingDetails(null);
    setBuildingDetailsError(null);
  }, []);

  const noteBuildingsStatus = useCallback(
    (status: "idle" | "loading" | "loaded" | "error", error?: string) => {
      setBuildingsStatus(status);
      if (status === "error") say(`3D buildings failed to load — ${error ?? "unknown error"}`);
      if (status === "loaded") say(BUILDING_STYLES.length ? "3D buildings on — zoom into a city to see them refine" : "3D buildings on");
    },
    [say],
  );

  const applyView = useCallback(
    (next: ViewId) => {
      setCoverage(next === "coverage");
      if (next === "coverage") {
        setLayers(COVERAGE_LAYERS);
        say("Coverage view — lanes and the circles nothing reports from");
      } else {
        setLayers(LIVE_LAYERS);
      }
    },
    [say],
  );

  const view: ViewId = coverage ? "coverage" : "live";

  const copySelection = useCallback(() => {
    if (!selected) return;
    // The whole record, not a summary of it: whatever the feed reported is
    // what lands on the clipboard.
    const text = Object.entries(selected)
      .filter(([, value]) => value != null && value !== "")
      .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(" ") : value}`)
      .join("\n");
    void navigator.clipboard?.writeText(text).then(
      () => say("Selection copied"),
      () => say("Clipboard unavailable in this context"),
    );
  }, [selected, say]);

  // ── command palette ──────────────────────────────────────
  const buildCommands = useCallback(
    (query: string): Command[] => {
      const q = query.trim().toLowerCase();
      const commands: Command[] = [];

      // Track hits are kept apart from the rest: they have already been matched
      // against the query, and the label filter at the bottom would drop them
      // again. An MMSI search is exactly that case — the hull's identifier is
      // what matched, and the label need not repeat it.
      const trackHits: Command[] = [];
      if (q.length >= 2) {
        // A vessel's id is its MMSI, an aircraft's its ICAO24, and a search may
        // spell either with the label in front of it, as the feeds print them.
        const bare = q.replace(/^(mmsi|imo|icao|icao24|hex)[\s:]*/, "");
        const hits = tracks
          .filter(
            (t) =>
              t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(bare),
          )
          .slice(0, 8);
        for (const track of hits) {
          const sea = track.kind === "sea";
          // The identifier earns its place in the row when it is not already
          // the name — an unnamed vessel comes through as its own MMSI.
          const identifier =
            track.name === track.id
              ? ""
              : ` · ${sea ? "MMSI" : "ICAO"} ${sea ? track.id : track.id.toUpperCase()}`;
          trackHits.push({
            scope: "JUMP",
            label: `${track.name}${identifier} · ${sea ? "surface" : "air"}${track.sog != null ? ` · ${track.sog}kt` : ""}`,
            keys: track.flag ?? "",
            run: () => selectTrack(track.id, { fly: true }),
          });
        }
      }

      const layerLabels: Record<LayerId, string> = {
        air: "air tracks",
        ground: "aircraft on the ground",
        sea: "surface tracks",
        lanes: "sea lanes",
        gaps: "coverage gaps",
        buildings: "3D buildings",
        labels: "place labels",
      };
      for (const id of Object.keys(layerLabels) as LayerId[]) {
        commands.push({
          scope: "LAYER",
          label: `${layers[id] ? "Hide" : "Show"} ${layerLabels[id]}`,
          run: () => toggleLayer(id),
        });
      }

      commands.push(
        {
          scope: "VIEW",
          label: stackId === "esri" ? "Base map — OpenStreetMap" : "Base map — Esri imagery",
          run: () => setStackId(stackId === "esri" ? "osm" : "esri"),
        },
        {
          scope: "VIEW",
          label: "Frame the whole globe",
          run: () => globeRef.current?.flyTo(0, 15, 22_000_000),
        },
        {
          scope: "VIEW",
          label: "Coverage view",
          run: () => applyView("coverage"),
        },
      );

      for (const preset of [
        { label: "Horizon", deg: 8 },
        { label: "Oblique", deg: 45 },
        { label: "Top-down", deg: 90 },
      ]) {
        commands.push({
          scope: "VIEW",
          label: `Camera — ${preset.label}`,
          run: () => applyTilt(preset.deg),
        });
      }

      if (layers.buildings) {
        for (const style of BUILDING_STYLES) {
          if (style.id === buildingStyleId) continue;
          commands.push({
            scope: "VIEW",
            label: `Buildings — ${style.label}`,
            keys: style.note,
            run: () => setBuildingStyleId(style.id),
          });
        }
      }

      if (selected) {
        commands.push(
          {
            scope: "ACTION",
            label: povActive
              ? `Release the camera from ${selected.name}`
              : `POV — ride with ${selected.name}`,
            run: togglePov,
          },
          {
            scope: "ACTION",
            label: `Centre on ${selected.name}`,
            run: () => flyToTrack(selected),
          },
          {
            scope: "ACTION",
            label: "Copy selection",
            run: copySelection,
          },
          {
            scope: "ACTION",
            label: "Clear selection",
            run: () => selectTrack(null),
          },
        );
      }

      if (!q) return commands;
      return [
        ...trackHits,
        ...commands.filter((c) => `${c.scope} ${c.label}`.toLowerCase().includes(q)),
      ];
    },
    [
      tracks, layers, stackId, selected, selectTrack,
      toggleLayer, applyView, flyToTrack, copySelection, applyTilt,
      buildingStyleId, povActive, togglePov,
    ],
  );

  // Address and notability for the current building. Keyed on the query rather
  // than the info object so re-picking the same building does not refetch, and
  // aborted so a fast series of clicks cannot land an earlier building's
  // details on a later one.
  const buildingQueryKey = building ? JSON.stringify(building.query) : null;
  useEffect(() => {
    if (!buildingQueryKey) return;
    const controller = new AbortController();

    fetchBuildingDetails(JSON.parse(buildingQueryKey), controller.signal)
      .then(setBuildingDetails)
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setBuildingDetailsError(e instanceof Error ? e.message : String(e));
      });

    return () => controller.abort();
  }, [buildingQueryKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const unresolved = alerts.filter((a) => a.sev <= 2).length;

  return (
    <div className="watch">
      <TopBar
        view={view}
        onView={applyView}
        air={snapshot?.health.air ?? null}
        sea={snapshot?.health.sea ?? null}
        airCount={counts.air}
        seaCount={counts.sea}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="wmid">
        <PriorityQueue
          alerts={alerts}
          filter={filter}
          onFilter={setFilter}
          selectedId={selectedAlertId}
          onSelect={selectAlert}
          now={now}
        />

        <GlobeStage
          globeRef={globeRef}
          tracks={tracks}
          layers={layers}
          onLayer={toggleLayer}
          counts={counts}
          selected={selected}
          detail={aircraftDetail}
          route={routeGeometry}
          onAirport={flyToAirport}
          trail={trail}
          stackId={stackId}
          buildingStyleId={buildingStyleId}
          buildingsStatus={buildingsStatus}
          building={building}
          buildingAt={buildingAt}
          buildingDetails={buildingDetails}
          buildingDetailsError={buildingDetailsError}
          onBuildingPick={clearBuilding}
          onBuildingAnchor={setBuildingAt}
          onBuildingsStatus={noteBuildingsStatus}
          tiltDeg={tiltDeg}
          onTilt={applyTilt}
          pov={povActive}
          onPov={togglePov}
          cursor={cursor}
          stats={stats}
          unresolved={unresolved}
          now={now}
          onSelect={(id) => selectTrack(id)}
          onCursor={setCursor}
          onStats={setStats}
          onReady={() => undefined}
          onFollow={() => selected && flyToTrack(selected)}
          onCopy={copySelection}
        />
      </div>

      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} commands={buildCommands} />
      )}

      <div className={`wtoast${toast || error ? " on" : ""}`}>
        {toast ?? (error ? `Feed error — ${error}` : "")}
      </div>
    </div>
  );
}
