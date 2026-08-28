/**
 * The priority queue's contents.
 *
 * Every rule here fires on something the live feeds actually report — a squawk
 * code, a stale AIS fix, a speed over ground, two hulls close together. Nothing
 * in the queue is fabricated: if the feeds are quiet, the queue is short.
 */

import { distanceNm, separationDeg } from "./geo";
import { COVERAGE_GAPS, SENSORS } from "./stations";
import type { Alert, Severity, Track } from "./types";

/** Beyond this, a vessel's last AIS fix counts as a gap rather than latency. */
const AIS_GAP_MIN = 30;
/** Under this speed over ground a vessel is not making way. */
const LOITER_KT = 0.6;
/** How close to a chokepoint sensor a loiter has to be to matter. */
const CHOKEPOINT_NM = 45;
/** Two hulls closer than this, both stopped, is a rendezvous. */
const RENDEZVOUS_NM = 0.4;
const MAX_ALERTS = 40;

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}m`;
}

function bearingLabel(track: Track, lon: number, lat: number, place: string): string {
  const nm = Math.round(distanceNm(lon, lat, track.lon, track.lat));
  return `${track.name} · ${nm}nm of ${place}`;
}

export function deriveAlerts(tracks: Track[], now: number): Alert[] {
  const alerts: Alert[] = [];
  const push = (
    sev: Severity, rule: string, title: string, sub: string,
    meta: string[], trackId: string | null, raisedAt: number,
  ) => {
    alerts.push({
      id: `${rule}:${trackId ?? sub}`.replace(/\s+/g, "-").toUpperCase(),
      sev, rule, title, sub, meta, trackId, raisedAt,
    });
  };

  const sea = tracks.filter((t) => t.kind === "sea");

  for (const t of tracks) {
    // 1. Emergency squawk — the only thing on this floor that outranks everything.
    if (t.emergency) {
      push(
        1, "EMERGENCY SQUAWK", t.emergency,
        `${t.name} · ${t.alt ? `${t.alt.toLocaleString("en-US")} ft` : "altitude unreported"}`,
        [t.source.toUpperCase(), t.flag ?? "FLAG UNKNOWN"], t.id, t.fixedAt,
      );
      continue;
    }

    // 2. Dark vessel — AIS has gone quiet on a hull that was reporting.
    if (t.kind === "sea" && (t.gapMinutes ?? 0) >= AIS_GAP_MIN) {
      const gap = t.gapMinutes!;
      push(
        gap >= 120 ? 1 : 2, "DARK VESSEL", `AIS gap ${hhmm(gap)}`,
        `${t.name}${t.cls ? ` · ${t.cls}` : ""}`,
        ["RULE R-118", t.flag ?? "FLAG UNKNOWN"], t.id, t.fixedAt,
      );
      continue;
    }

    // 3. Loiter — stopped inside a chokepoint the sensor net watches.
    if (t.kind === "sea" && t.sog != null && t.sog < LOITER_KT) {
      const near = SENSORS.find(
        (s) => distanceNm(s.lon, s.lat, t.lon, t.lat) < CHOKEPOINT_NM,
      );
      if (near) {
        push(
          2, "LOITER", `Not making way · SOG ${t.sog.toFixed(1)}kt`,
          bearingLabel(t, near.lon, near.lat, near.place),
          [near.id, t.flag ?? "FLAG UNKNOWN"], t.id, t.fixedAt,
        );
      }
    }
  }

  // 4. Rendezvous — two stopped hulls alongside each other. Bucketed by whole
  //    degree so this stays linear rather than comparing every pair of vessels.
  const stopped = sea.filter((t) => t.sog != null && t.sog < 1);
  const cells = new Map<string, Track[]>();
  for (const t of stopped) {
    const key = `${Math.round(t.lon)}:${Math.round(t.lat)}`;
    (cells.get(key) ?? cells.set(key, []).get(key)!).push(t);
  }
  const paired = new Set<string>();
  for (const bucket of cells.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        if (paired.has(a.id) || paired.has(b.id)) continue;
        const nm = distanceNm(a.lon, a.lat, b.lon, b.lat);
        if (nm > RENDEZVOUS_NM) continue;
        paired.add(a.id);
        paired.add(b.id);
        push(
          1, "RENDEZVOUS", `Two hulls alongside · ${(nm * 1852).toFixed(0)}m apart`,
          `${a.name} + ${b.name}`,
          [`${a.flag ?? "??"} / ${b.flag ?? "??"}`, "BOTH SOG < 1KT"],
          a.id, Math.max(a.fixedAt, b.fixedAt),
        );
      }
    }
  }

  // 5. Sensor health — a site with no failover is a coverage problem, not a nuisance.
  for (const s of SENSORS) {
    if (!s.offline) continue;
    push(
      2, "SENSOR", `${s.id} offline`, `${s.place} · no failover`,
      ["COVERAGE −8%", "SIMULATED SITE"], null, now,
    );
  }

  // 6. Gap incursion — traffic inside a circle no sensor covers.
  for (const gap of COVERAGE_GAPS) {
    const inside = tracks.filter(
      (t) => separationDeg(gap.lon, gap.lat, t.lon, t.lat) < gap.radiusDeg,
    );
    if (inside.length === 0) continue;
    push(
      3, "COVERAGE GAP", `${inside.length} track${inside.length === 1 ? "" : "s"} unobserved`,
      `${gap.id} · ${gap.radiusDeg}° radius, no sensor in range`,
      ["NO EO/IR", "TELEMETRY ONLY"], inside[0].id, now,
    );
  }

  // P1 first, then whatever fired most recently.
  alerts.sort((a, b) => a.sev - b.sev || b.raisedAt - a.raisedAt);
  return alerts.slice(0, MAX_ALERTS);
}
