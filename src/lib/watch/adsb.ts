/**
 * Keyless ADS-B adapter, used when OpenSky credentials are absent.
 *
 * Two things shape this module:
 *
 * 1. Every keyless provider caps a query at a 250nm radius, so "global" means a
 *    fan-out across the busiest airspace (see AIR_ANCHORS) merged and deduped by
 *    ICAO24. Coverage is a set of dense bubbles rather than a uniform sheet, and
 *    the console reports the source in the health bar so that is never implied
 *    away.
 * 2. These are volunteer-run services with no uptime promise, and at least one
 *    of them is unreachable from some networks. So there is a list of them, in
 *    preference order, and the first that answers wins.
 *
 * They all speak the readsb JSON dialect; only the path and the array's key
 * differ.
 */

import { AIR_ANCHORS } from "./stations";
import type { Track } from "./types";

const RADIUS_NM = 250;
const UA = "openworld-watch-console";
/**
 * These endpoints rate-limit to about one request a second per address, and
 * they answer a burst with 429 rather than queuing it. Measured: 20 anchors
 * fired six-at-a-time returns two answers and eighteen refusals; the same 20
 * spaced a second apart all answer. So the sweep is deliberately serial, and
 * takes about as many seconds as there are anchors.
 */
const REQUEST_SPACING_MS = 1100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Provider = {
  id: string;
  url: (lat: number, lon: number) => string;
  /** Single-aircraft lookup by ICAO24 hex, where the provider offers one. */
  one?: (hex: string) => string;
  /** Which key the aircraft array arrives under. */
  key: "aircraft" | "ac";
};

const PROVIDERS: Provider[] = [
  {
    id: "adsb.fi",
    url: (lat, lon) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${RADIUS_NM}`,
    key: "aircraft",
  },
  {
    id: "adsb.lol",
    url: (lat, lon) => `https://api.adsb.lol/v2/point/${lat}/${lon}/${RADIUS_NM}`,
    one: (hex) => `https://api.adsb.lol/v2/icao/${hex.toLowerCase()}`,
    key: "ac",
  },
];

/** readsb's `type` names the message that produced the position. */
const SOURCE_LABEL: Record<string, string> = {
  adsb_icao: "ADS-B",
  adsb_icao_nt: "ADS-B",
  adsb_other: "ADS-B",
  adsr_icao: "ADS-R",
  tisb_icao: "TIS-B",
  tisb_other: "TIS-B",
  tisb_trackfile: "TIS-B",
  mlat: "MLAT",
  mode_s: "MODE S",
  adsc: "ADS-C",
};

const EMERGENCY_SQUAWK: Record<string, string> = {
  "7500": "UNLAWFUL INTERFERENCE",
  "7600": "RADIO FAILURE",
  "7700": "GENERAL EMERGENCY",
};

type Aircraft = {
  hex: string;
  flight?: string;
  r?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | "ground";
  alt_geom?: number;
  baro_rate?: number;
  geom_rate?: number;
  gs?: number;
  track?: number;
  squawk?: string;
  /** readsb reports "none" when there is nothing to report. */
  emergency?: string;
  category?: string;
  /** "adsb_icao", "mlat", "tisb_icao" and friends. */
  type?: string;
  rssi?: number;
  messages?: number;
  seen?: number;
  seen_pos?: number;
};

async function fetchAnchor(
  provider: Provider,
  anchor: (typeof AIR_ANCHORS)[number],
  signal?: AbortSignal,
): Promise<Aircraft[]> {
  const res = await fetch(provider.url(anchor.lat, anchor.lon), {
    headers: { accept: "application/json", "user-agent": UA },
    signal,
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${provider.id} ${anchor.code}: ${res.status}`);
  const json = (await res.json()) as Partial<Record<Provider["key"], Aircraft[]>>;
  return json[provider.key] ?? [];
}

function normalise(byHex: Map<string, Aircraft>, source: string): Track[] {
  const now = Date.now();
  const tracks: Track[] = [];
  for (const ac of byHex.values()) {
    // readsb spells "on the surface" as the literal string "ground" in the
    // barometric field; carry that through instead of dropping the aircraft.
    const onGround = ac.alt_baro === "ground";
    const alt = onGround
      ? null
      : (ac.alt_geom ?? (typeof ac.alt_baro === "number" ? ac.alt_baro : null));
    const emergency =
      ac.emergency && ac.emergency !== "none"
        ? ac.emergency.toUpperCase()
        : ac.squawk
          ? (EMERGENCY_SQUAWK[ac.squawk] ?? null)
          : null;

    tracks.push({
      id: ac.hex,
      kind: "air",
      name: ac.flight?.trim() || ac.r || ac.hex.toUpperCase(),
      lon: ac.lon!,
      lat: ac.lat!,
      sog: ac.gs == null ? null : Math.round(ac.gs),
      hdg: ac.track ?? null,
      alt: alt == null ? null : Math.round(alt),
      baroAlt: typeof ac.alt_baro === "number" ? ac.alt_baro : null,
      geoAlt: ac.alt_geom ?? null,
      vrate: ac.geom_rate ?? ac.baro_rate ?? null,
      flag: null,
      country: null,
      cls: ac.t ?? (ac.category ? `CATEGORY ${ac.category}` : null),
      reg: ac.r ?? null,
      fixedAt: now - (ac.seen_pos ?? 0) * 1000,
      contactAt: now - (ac.seen ?? 0) * 1000,
      squawk: ac.squawk ?? null,
      emergency,
      onGround,
      posSource: SOURCE_LABEL[ac.type ?? ""] ?? (ac.type ? ac.type.toUpperCase() : null),
      rssi: ac.rssi ?? null,
      messages: ac.messages ?? null,
      source,
    });
  }
  return tracks;
}

export type AdsbSweep = {
  tracks: Track[];
  provider: string;
  anchorsOk: number;
  anchorsTotal: number;
};

/**
 * One aircraft, live.
 *
 * The globe's picture is a 60-second cache of a global sweep, which is right
 * for 20 000 dots and wrong for the one an operator is watching. adsb.lol
 * answers a single hex in well under a second with a fix typically a fraction
 * of a second old, keyless and unmetered — OpenSky charges a credit per query
 * against a 4 000/day allowance, which a 5-second poll would drain in an
 * afternoon.
 *
 * Returns null when no receiver currently hears the aircraft: coverage is
 * volunteer-run and genuinely absent over oceans, so the caller keeps the
 * sweep's own position rather than treating this as an error.
 */
export async function fetchAdsbOne(
  hex: string,
  signal?: AbortSignal,
): Promise<Track | null> {
  for (const provider of PROVIDERS) {
    if (!provider.one) continue;
    try {
      const res = await fetch(provider.one(hex), {
        headers: { accept: "application/json", "user-agent": UA },
        signal,
        cache: "no-store",
      });
      if (!res.ok) continue;

      const json = (await res.json()) as Partial<Record<Provider["key"], Aircraft[]>>;
      const ac = (json[provider.key] ?? []).find(
        (a) => a.lat != null && a.lon != null,
      );
      if (!ac) continue;

      const [track] = normalise(new Map([[ac.hex, ac]]), provider.id);
      return track ?? null;
    } catch {
      // Try the next provider; a single unreachable one is not a failure.
    }
  }
  return null;
}

export async function fetchAdsb(signal?: AbortSignal): Promise<AdsbSweep> {
  const failures: string[] = [];

  for (const provider of PROVIDERS) {
    const byHex = new Map<string, Aircraft>();
    let anchorsOk = 0;
    let firstError: unknown = null;

    for (const [i, anchor] of AIR_ANCHORS.entries()) {
      if (i > 0) await sleep(REQUEST_SPACING_MS);
      try {
        const aircraft = await fetchAnchor(provider, anchor, signal);
        anchorsOk++;
        // Anchor circles overlap heavily over Europe and the US east coast, so
        // the same aircraft comes back several times; keep its freshest report.
        for (const ac of aircraft) {
          if (ac.lat == null || ac.lon == null) continue;
          const previous = byHex.get(ac.hex);
          if (!previous || (ac.seen_pos ?? 999) < (previous.seen_pos ?? 999)) {
            byHex.set(ac.hex, ac);
          }
        }
      } catch (e) {
        firstError ??= e;
        // One unreachable anchor is not a reason to abandon the sweep; a
        // provider that refuses every one of them is.
        if (anchorsOk === 0 && i >= 2) break;
      }
    }

    if (anchorsOk === 0) {
      failures.push(`${provider.id}: ${firstError ? String(firstError) : "no anchor answered"}`);
      continue;
    }

    return {
      tracks: normalise(byHex, provider.id),
      provider: provider.id,
      anchorsOk,
      anchorsTotal: AIR_ANCHORS.length,
    };
  }

  throw new Error(failures.join(" · "));
}
