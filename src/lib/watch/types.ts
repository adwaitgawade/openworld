/**
 * Shapes the watch console works in. Every feed adapter — OpenSky, adsb.lol,
 * AISStream — normalises into these, so the UI never learns which source a
 * track came from.
 */

export type TrackKind = "air" | "sea";

export type Track = {
  /** Stable across polls: ICAO24 for air, MMSI for sea. */
  id: string;
  kind: TrackKind;
  /** Callsign or vessel name when the feed carries one, else the id. */
  name: string;
  lon: number;
  lat: number;
  /** Knots. */
  sog: number | null;
  /** Degrees true, 0–360. */
  hdg: number | null;
  /** Feet for air, metres of draught for sea. Null when unreported. */
  alt: number | null;
  /** ISO-3166 alpha-2 where the feed gives one, else null. */
  flag: string | null;
  /** Aircraft type / vessel class, when reported. */
  cls: string | null;
  /** Epoch ms of the position report itself, not of our poll. */
  fixedAt: number;
  /** True while the aircraft is squawking 7500/7600/7700. */
  emergency?: string | null;
  /** Set by the AIS adapter: minutes since the last position report. */
  gapMinutes?: number;
  /** Which adapter produced this. Surfaced in the HUD so nothing is implied. */
  source: string;
};

export type Severity = 1 | 2 | 3;

export type Alert = {
  id: string;
  sev: Severity;
  /** Short rule name shown in the queue's first line. */
  rule: string;
  title: string;
  sub: string;
  /** Two short metadata chips. */
  meta: string[];
  /** Track this alert fired on, when it fired on one. */
  trackId: string | null;
  raisedAt: number;
};

export type Sensor = {
  id: string;
  place: string;
  lon: number;
  lat: number;
  /** Bearing the camera looks along, degrees true. */
  brg: number;
  offline?: boolean;
};

/** Dashed circles on the globe: a centre and a radius in degrees of arc. */
export type CoverageGap = {
  id: string;
  lon: number;
  lat: number;
  radiusDeg: number;
};

export type FeedHealth = {
  /** Adapter that answered, e.g. "opensky" / "adsb.lol" / "aisstream". */
  source: string;
  /** 0–1, or null when the adapter cannot express one. */
  integrity: number | null;
  /** Seconds between the newest position report and now. */
  latencySec: number | null;
  status: "ok" | "degraded" | "down";
  note: string | null;
};

export type FeedSnapshot = {
  ts: number;
  tracks: Track[];
  alerts: Alert[];
  health: {
    air: FeedHealth;
    sea: FeedHealth;
  };
};
