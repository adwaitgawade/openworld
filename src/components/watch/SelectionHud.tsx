"use client";

import type { ReactNode } from "react";

import type { Track } from "@/lib/watch/types";

import type { RouteAirport } from "@/lib/watch/adsbdb";

import type { DetailState } from "./useAircraftDetail";

/**
 * Waving flags from flagcdn.com (flagpedia.net/download/api), keyed by the
 * lowercase ISO-3166 alpha-2 code the feeds already give us.
 *
 * The fixed WxH sizes are the API's waving set: the ripple and its cloth
 * shading are drawn into the image, on a transparent 4:3 canvas, so an odd
 * shape like Nepal's pennant keeps its outline instead of being stretched to a
 * rectangle. An unknown code 404s, so the image hides itself and the text tag
 * stands alone.
 */
function Flag({ code }: { code: string }) {
  const cc = code.toLowerCase();
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="wflag"
      src={`https://flagcdn.com/24x18/${cc}.png`}
      srcSet={`https://flagcdn.com/48x36/${cc}.png 2x, https://flagcdn.com/72x54/${cc}.png 3x`}
      width={24}
      height={18}
      alt=""
      onError={(e) => {
        e.currentTarget.style.display = "none";
      }}
    />
  );
}

function fmtLatLon(lon: number, lat: number): string {
  return `${Math.abs(lat).toFixed(2)}${lat >= 0 ? "N" : "S"} ${Math.abs(lon).toFixed(2)}${lon >= 0 ? "E" : "W"}`;
}

function fixAge(fixedAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - fixedAt) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * The airframe: photograph, type and registered operator.
 *
 * Rendered only once adsbdb has answered — this is the one part of the HUD
 * that is not off the transponder, and a placeholder frame flashing on every
 * selection would read as a feed glitch. The photograph is best-effort: plenty
 * of airframes have never been photographed, and airport-data.com occasionally
 * 404s one it has indexed, so it removes itself rather than leaving a gap.
 */
function AircraftBand({ state }: { state: DetailState }) {
  const aircraft = state.aircraft;
  if (!aircraft) return null;

  const type = [aircraft.manufacturer, aircraft.type].filter(Boolean).join(" ");

  return (
    <div className="wac">
      {aircraft.photoThumb && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="acphoto"
          src={aircraft.photoThumb}
          alt=""
          onError={(e) => {
            e.currentTarget.style.display = "none";
          }}
        />
      )}
      <div className="acmeta">
        <b>{aircraft.registration}</b>
        <span title={type}>{type || aircraft.icaoType || "\u2014"}</span>
        {aircraft.owner && (
          <em title={aircraft.owner}>
            {aircraft.ownerCountryIso && <Flag code={aircraft.ownerCountryIso} />}
            {aircraft.owner}
          </em>
        )}
      </div>
    </div>
  );
}

/**
 * One end of the route: the airport code, and the ICAO identifier under it.
 *
 * The code is a button — clicking it flies the camera to the field. Underlined
 * because that is the affordance the dense panel has room for; a separate
 * control per end would cost a row the band cannot spare.
 */
function RouteEnd({
  at,
  onAirport,
  to,
}: {
  at: RouteAirport;
  onAirport: (lon: number, lat: number) => void;
  to?: boolean;
}) {
  return (
    <span className={to ? "rto" : undefined}>
      <button
        type="button"
        className="racode"
        onClick={() => onAirport(at.lon, at.lat)}
        title={`Fly to ${at.name}`}
      >
        {/* IATA is what a boarding pass says, but a freight or regional field
            may only have an ICAO identifier — never show an empty code. */}
        {at.iata ?? at.icao}
      </button>
      <i>{at.icao}</i>
    </span>
  );
}

/**
 * Origin and destination for the selected flight.
 *
 * Four states, and they must not be confused with each other: no lookup was
 * made (nothing rendered at all), one is in flight, one failed, and one came
 * back saying this aircraft has no scheduled route. The last is the normal
 * answer over general aviation, so it is stated plainly rather than styled as
 * a fault.
 */
function RouteBand({
  state,
  onAirport,
}: {
  state: DetailState;
  onAirport: (lon: number, lat: number) => void;
}) {
  if (!state.modeS) return null;

  if (state.loading || state.error || !state.route) {
    return (
      <div className="wroute rnone">
        {state.loading
          ? "RESOLVING ROUTE\u2026"
          : state.rateLimited
            ? "RATE LIMITED \u00b7 ADSBDB"
            : state.error
              ? "LOOKUP UNAVAILABLE"
              : "NO SCHEDULED ROUTE"}
      </div>
    );
  }

  const { origin, destination, airline, callsignIata } = state.route;

  return (
    <div className="wroute">
      <div className="rends">
        <RouteEnd at={origin} onAirport={onAirport} />
        <u />
        <RouteEnd at={destination} onAirport={onAirport} to />
      </div>
      <div className="rplaces">
        <span title={origin.name}>{origin.municipality ?? origin.name}</span>
        <span className="rto" title={destination.name}>
          {destination.municipality ?? destination.name}
        </span>
      </div>
      {(airline || callsignIata) && (
        <div className="rop">
          {[airline?.name, callsignIata].filter(Boolean).join(" \u00b7 ")}
        </div>
      )}
    </div>
  );
}

type Props = {
  track: Track;
  /** Airframe and route from adsbdb, when the selection is an aircraft. */
  detail: DetailState;
  /** Fly the camera to an airport named in the route band. */
  onAirport: (lon: number, lat: number) => void;
  now: number;
  /** True while the camera is locked to this track. */
  pov: boolean;
  onPov: () => void;
  onFollow: () => void;
  onCopy: () => void;
  onClear: () => void;
};

export default function SelectionHud({
  track, detail, onAirport, now, pov, onPov, onFollow, onCopy, onClear,
}: Props) {
  const sea = track.kind === "sea";
  const stale = now - track.fixedAt > 30 * 60_000;

  const dash = (v: string | null | undefined) => (v == null || v === "" ? "\u2014" : v);
  const feet = (v: number | null | undefined) =>
    v == null ? "\u2014" : `${v.toLocaleString("en-US")} ft`;
  const course =
    track.hdg == null ? "\u2014" : `${String(Math.round(track.hdg)).padStart(3, "0")}\u00b0`;

  const cells: [string, ReactNode][] = sea
    ? [
      ["MMSI", track.id],
      ["CLASS", dash(track.cls)],
      ["SOG", track.sog == null ? "\u2014" : `${track.sog} kt`],
      ["DRAUGHT", track.alt == null ? "\u2014" : `${track.alt.toFixed(1)} m`],
      ["COURSE", course],
      ["AIS GAP", track.gapMinutes == null ? "\u2014" : `${Math.round(track.gapMinutes)}m`],
      ["FIX AGE", fixAge(track.fixedAt, now)],
      ["POSITION", fmtLatLon(track.lon, track.lat)],
      [
        "FLAG",
        track.flag ? (
          <>
            {track.flag}<Flag code={track.flag} />
          </>
        ) : (
          "\u2014"
        ),
      ],
      ["SOURCE", track.source.toUpperCase()],
    ]
    : [
      ["ICAO24", track.id.toUpperCase()],
      // adsbdb knows the tail number and ICAO type for nearly every airframe;
      // OpenSky's state vector has no registration field at all and reports
      // "NO INFO" as the category for most of them.
      ["REGISTRATION", dash(detail.aircraft?.registration ?? track.reg)],
      ["TYPE", dash(detail.aircraft?.icaoType ?? track.cls)],
      ["GS", track.sog == null ? "\u2014" : `${track.sog} kt`],
      // The globe puts a surfaced aircraft on the terrain, so its altitude
      // field is the one thing here that is not a number off the feed.
      ["ALT", track.onGround ? "ON GND" : feet(track.alt)],
      [
        "V/S",
        track.vrate == null
          ? "\u2014"
          : `${track.vrate > 0 ? "+" : ""}${track.vrate.toLocaleString("en-US")} fpm`,
      ],
      ["BARO ALT", feet(track.baroAlt)],
      ["GEO ALT", feet(track.geoAlt)],
      ["COURSE", course],
      ["SQUAWK", dash(track.squawk)],
      ["IDENT", track.spi ? "SPI ACTIVE" : "\u2014"],
      ["POS SOURCE", dash(track.posSource)],
      [
        "RECEIVERS",
        track.sensors?.length
          ? `${track.sensors.length} \u00b7 ${track.sensors.slice(0, 3).join(" ")}`
          : "\u2014",
      ],
      ["RSSI", track.rssi == null ? "\u2014" : `${track.rssi.toFixed(1)} dBFS`],
      ["MESSAGES", track.messages == null ? "\u2014" : track.messages.toLocaleString("en-US")],
      ["FIX AGE", fixAge(track.fixedAt, now)],
      ["LAST MSG", track.contactAt == null ? "\u2014" : fixAge(track.contactAt, now)],
      ["POSITION", fmtLatLon(track.lon, track.lat)],
      [
        "COUNTRY",
        track.country ? (
          <>
            {track.flag && <Flag code={track.flag} />}
            {track.country}
          </>
        ) : (
          "\u2014"
        ),
      ],
      ["SOURCE", track.source.toUpperCase()],
    ];

  return (
    <div className="wov whud">
      <div className="hh">
        <span className="tt">{sea ? "VESSEL" : "AIRCRAFT"}</span>
        <b>{track.name}</b>
        <em>
          {track.flag ? (
            <>
              {track.flag}
              <Flag code={track.flag} />
            </>
          ) : (
            "—"
          )}
        </em>
      </div>

      <AircraftBand state={detail} />
      <RouteBand state={detail} onAirport={onAirport} />

      <div className="wkv">
        {cells.map(([label, value]) => (
          <div key={label}>
            <i>{label}</i>
            <b
              style={
                (label === "FIX AGE" && stale) ||
                  (label === "SQUAWK" && track.emergency) ||
                  (label === "IDENT" && track.spi)
                  ? { color: "#E8577F" }
                  : undefined
              }
            >
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
        {/* Exactly one accent button at a time: POV takes it while the camera is
            locked to this track, CENTRE has it otherwise. */}
        <button
          type="button"
          className={`wbtn${pov ? " pri" : ""}`}
          onClick={onPov}
          title={
            pov
              ? "Release the camera"
              : `Ride with ${track.name} — drag to orbit it, scroll to zoom`
          }
        >
          POV
        </button>
        <button type="button" className={`wbtn${pov ? "" : " pri"}`} onClick={onFollow}>
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
