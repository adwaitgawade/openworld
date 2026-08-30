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
import { distanceNm } from "@/lib/watch/geo";
import { SENSORS } from "@/lib/watch/stations";
import type { Alert, Sensor, Track } from "@/lib/watch/types";

import CommandPalette, { type Command } from "./CommandPalette";
import GlobeStage from "./GlobeStage";
import PriorityQueue, { type AlertFilter } from "./PriorityQueue";
import SensorBank from "./SensorBank";
import Timeline, { WINDOW_MS } from "./Timeline";
import TopBar, { type ViewId } from "./TopBar";
import { useFeed, type HistoryFrame } from "./useFeed";
import type { GlobeStats, LayerId, Layers, ReplayFrame, WatchGlobeHandle } from "./WatchGlobe";
import "./watch.css";

/** How close a track has to be to count against a sensor's tile. */
const SENSOR_RANGE_NM = 40;
/** Below this the timeline head counts as live. */
const LIVE_EPSILON_MS = 30_000;

/** Degrees below horizontal the camera starts at: straight down. */
const DEFAULT_TILT = 90;

const LIVE_LAYERS: Layers = {
  air: true,
  ground: true,
  sea: true,
  lanes: false,
  cams: true,
  gaps: false,
  labels: false,
  buildings: false,
};

const COVERAGE_LAYERS: Layers = {
  air: false,
  ground: false,
  sea: true,
  lanes: true,
  cams: true,
  gaps: true,
  labels: true,
  buildings: false,
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export default function WatchConsole() {
  const { snapshot, history, since, error } = useFeed();
  const globeRef = useRef<WatchGlobeHandle>(null);

  const [coverage, setCoverage] = useState(false);
  const [layers, setLayers] = useState<Layers>(LIVE_LAYERS);
  const [stackId, setStackId] = useState<MapStackId>("esri");
  const [filter, setFilter] = useState<AlertFilter>("ALL");
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [selectedSensorId, setSelectedSensorId] = useState<string | null>(null);
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
  const [offsetMs, setOffsetMs] = useState(0);
  const [speed, setSpeed] = useState<number | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // One shared second-resolution clock. Ages, the sensor timestamp and the
  // timeline all read from it rather than each running their own interval.
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
    return { air, ground, sea, cams: SENSORS.length };
  }, [tracks]);

  // Tracks currently inside each sensor's stated range — the one live number on
  // an otherwise simulated camera tile.
  const inRange = useMemo(() => {
    const out: Record<string, number> = {};
    for (const sensor of SENSORS) {
      let n = 0;
      for (const track of tracks) {
        // Cheap reject before the great-circle: one degree of latitude is 60nm.
        if (Math.abs(track.lat - sensor.lat) > 1) continue;
        if (distanceNm(sensor.lon, sensor.lat, track.lon, track.lat) < SENSOR_RANGE_NM) n++;
      }
      out[sensor.id] = n;
    }
    return out;
  }, [tracks]);

  // ── replay ───────────────────────────────────────────────
  const live = offsetMs < LIVE_EPSILON_MS;

  // Advance the head in real time while a playback rate is engaged.
  useEffect(() => {
    if (speed == null || live) return;
    const timer = setInterval(() => {
      setOffsetMs((previous) => {
        const next = previous - 250 * speed;
        // Catching up with live ends playback; there is nothing ahead to play.
        if (next <= 0) setSpeed(null);
        return Math.max(0, next);
      });
    }, 250);
    return () => clearInterval(timer);
  }, [speed, live]);

  const replayFrame: HistoryFrame | null = useMemo(() => {
    if (live || history.length === 0) return null;
    const target = now - offsetMs;
    if (target < history[0].ts) return null;
    let best = history[0];
    for (const frame of history) {
      if (Math.abs(frame.ts - target) < Math.abs(best.ts - target)) best = frame;
    }
    return best;
  }, [live, history, now, offsetMs]);

  const replay: ReplayFrame | null = replayFrame
    ? {
        ids: replayFrame.ids,
        kind: replayFrame.kind,
        lon: replayFrame.lon,
        lat: replayFrame.lat,
      }
    : null;

  const shownAlerts = replayFrame ? replayFrame.alerts : alerts;

  // Past positions of the selection, for the trail behind it.
  const trail = useMemo<[number, number][]>(() => {
    if (!selectedTrackId) return [];
    const path: [number, number][] = [];
    for (const frame of history) {
      const i = frame.ids.indexOf(selectedTrackId);
      if (i >= 0) path.push([frame.lon[i], frame.lat[i]]);
    }
    const current = byId.get(selectedTrackId);
    if (current && live) path.push([current.lon, current.lat]);
    return path;
  }, [selectedTrackId, history, byId, live]);

  const selected = selectedTrackId ? (byId.get(selectedTrackId) ?? null) : null;
  // A track can drop out of the feed mid-chase; when it does the camera comes
  // free on its own rather than riding a position that stopped updating.
  const povActive = pov && selected !== null;

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

  const selectSensor = useCallback(
    (sensor: Sensor) => {
      setSelectedSensorId(sensor.id);
      globeRef.current?.flyTo(sensor.lon, sensor.lat, 700_000);
      const n = inRange[sensor.id] ?? 0;
      say(
        sensor.offline
          ? `${sensor.id} · ${sensor.place} — site offline`
          : `${sensor.id} · ${sensor.place} — ${n} live track${n === 1 ? "" : "s"} within ${SENSOR_RANGE_NM}nm`,
      );
    },
    [inRange, say],
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
        say("Coverage view — sensor sites, lanes and the circles nothing watches");
      } else {
        setLayers(LIVE_LAYERS);
        if (next === "live") {
          setOffsetMs(0);
          setSpeed(null);
        } else if (history.length === 0) {
          say("Replay has nothing buffered yet — history starts when the console opens");
        } else {
          setOffsetMs(Math.min(WINDOW_MS, now - since));
        }
      }
    },
    [history.length, now, since, say],
  );

  // The tab is a readout of what the console is doing, not a separate source of
  // truth: scrubbing the timeline moves it to REPLAY on its own.
  const view: ViewId = coverage ? "coverage" : live ? "live" : "replay";

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

      for (const sensor of SENSORS) {
        commands.push({
          scope: "JUMP",
          label: `Sensor — ${sensor.id} ${sensor.place}`,
          run: () => selectSensor(sensor),
        });
      }

      const layerLabels: Record<LayerId, string> = {
        air: "air tracks",
        ground: "aircraft on the ground",
        sea: "surface tracks",
        lanes: "sea lanes",
        cams: "sensor sites",
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
          label: "Return to live",
          run: () => {
            setOffsetMs(0);
            setSpeed(null);
          },
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
      tracks, layers, stackId, selected, selectTrack, selectSensor,
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

  const utc = `${pad(new Date(now).getUTCHours())}:${pad(new Date(now).getUTCMinutes())}:${pad(new Date(now).getUTCSeconds())}`;
  const unresolved = shownAlerts.filter((a) => a.sev <= 2).length;

  return (
    <div className="watch">
      <TopBar
        view={view}
        onView={applyView}
        air={snapshot?.health.air ?? null}
        sea={snapshot?.health.sea ?? null}
        airCount={counts.air}
        seaCount={counts.sea}
        sensorsOnline={`${SENSORS.filter((s) => !s.offline).length}/${SENSORS.length}`}
        onOpenPalette={() => setPaletteOpen(true)}
      />

      <div className="wmid">
        <PriorityQueue
          alerts={shownAlerts}
          filter={filter}
          onFilter={setFilter}
          selectedId={selectedAlertId}
          onSelect={selectAlert}
          now={now}
        />

        <GlobeStage
          globeRef={globeRef}
          tracks={tracks}
          replay={replay}
          layers={layers}
          onLayer={toggleLayer}
          counts={counts}
          selected={selected}
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

      <SensorBank
        selectedId={selectedSensorId}
        onSelect={selectSensor}
        inRange={inRange}
        utc={utc}
      />

      <Timeline
        offsetMs={offsetMs}
        onOffset={setOffsetMs}
        speed={speed}
        onSpeed={setSpeed}
        since={since}
        alerts={alerts}
        now={now}
      />

      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} commands={buildCommands} />
      )}

      <div className={`wtoast${toast || error ? " on" : ""}`}>
        {toast ?? (error ? `Feed error — ${error}` : "")}
      </div>
    </div>
  );
}
