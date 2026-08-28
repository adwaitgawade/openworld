"use client";

import type { Track } from "@/lib/watch/types";

function fmtLatLon(lon: number, lat: number): string {
  return `${Math.abs(lat).toFixed(2)}${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}${lon >= 0 ? "E" : "W"}`;
}

function fixAge(fixedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - fixedAt) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

type Props = {
  track: Track;
  now: number;
  onFollow: () => void;
  onCopy: () => void;
  onClear: () => void;
};

export default function SelectionHud({ track, now, onFollow, onCopy, onClear }: Props) {
  const sea = track.kind === "sea";
  const stale = now - track.fixedAt > 30 * 60_000;

  const cells: [string, string][] = [
    [sea ? "MMSI" : "ICAO24", sea ? track.id : track.id.toUpperCase()],
    [sea ? "CLASS" : "TYPE", track.cls ?? "—"],
    [sea ? "SOG" : "GS", track.sog == null ? "—" : `${track.sog} kt`],
    [
      sea ? "DRAUGHT" : "ALT",
      track.alt == null ? "—" : sea ? `${track.alt.toFixed(1)} m` : `${track.alt.toLocaleString("en-US")} ft`,
    ],
    ["COURSE", track.hdg == null ? "—" : `${String(Math.round(track.hdg)).padStart(3, "0")}°`],
    ["FIX AGE", fixAge(track.fixedAt, now)],
    ["POSITION", fmtLatLon(track.lon, track.lat)],
    ["SOURCE", track.source.toUpperCase()],
  ];

  return (
    <div className="wov whud">
      <div className="hh">
        <span className="tt">{sea ? "VESSEL" : "AIRCRAFT"}</span>
        <b>{track.name}</b>
        <em>{track.flag ?? "—"}</em>
      </div>

      <div className="wkv">
        {cells.map(([label, value]) => (
          <div key={label}>
            <i>{label}</i>
            <b style={label === "FIX AGE" && stale ? { color: "#E8577F" } : undefined}>
              {value}
            </b>
          </div>
        ))}
      </div>

      {track.emergency && (
        <div
          style={{
            padding: "6px 11px",
            borderBottom: "1px solid var(--line)",
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            letterSpacing: "0.1em",
            color: "#E8577F",
          }}
        >
          SQUAWK · {track.emergency}
        </div>
      )}

      <div className="wacts">
        <button type="button" className="wbtn pri" onClick={onFollow}>
          CENTRE
        </button>
        <button type="button" className="wbtn" onClick={onCopy}>
          COPY
        </button>
        <button type="button" className="wbtn" onClick={onClear}>
          CLEAR
        </button>
      </div>
    </div>
  );
}
