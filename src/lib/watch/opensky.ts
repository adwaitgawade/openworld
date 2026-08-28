/**
 * OpenSky Network adapter — the global air feed.
 *
 * `/states/all` with no bounding box returns every aircraft OpenSky can see, so
 * one call fills the whole globe. That is the reason to prefer it over the
 * keyless fan-out: no anchor points, no seams.
 *
 * It costs credits, though. An authenticated account gets 4 000 credits a day
 * and a global unbounded call costs 4, so the poll interval is deliberately
 * conservative (see AIR_POLL_MS in ./air) — roughly one call a minute leaves
 * headroom for a day's continuous watch.
 */

import type { Track } from "./types";

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all";

/** OpenSky reports `origin_country` as a full name; the HUD wants a short tag. */
const COUNTRY_A2: Record<string, string> = {
  "United States": "US", Germany: "DE", "United Kingdom": "GB", France: "FR",
  Spain: "ES", Italy: "IT", Netherlands: "NL", Ireland: "IE", Turkey: "TR",
  "Russian Federation": "RU", China: "CN", Japan: "JP", "Republic of Korea": "KR",
  India: "IN", "United Arab Emirates": "AE", Qatar: "QA", "Saudi Arabia": "SA",
  Canada: "CA", Brazil: "BR", Mexico: "MX", Australia: "AU", Switzerland: "CH",
  Austria: "AT", Belgium: "BE", Portugal: "PT", Poland: "PL", Sweden: "SE",
  Norway: "NO", Denmark: "DK", Finland: "FI", Greece: "GR", Israel: "IL",
  Singapore: "SG", Malaysia: "MY", Indonesia: "ID", Thailand: "TH",
  Vietnam: "VN", "Hong Kong": "HK", Taiwan: "TW", "New Zealand": "NZ",
  "South Africa": "ZA", Egypt: "EG", Morocco: "MA", Kenya: "KE", Nigeria: "NG",
  Chile: "CL", Argentina: "AR", Colombia: "CO", Peru: "PE", Czechia: "CZ",
  Hungary: "HU", Romania: "RO", Ukraine: "UA", Iceland: "IS", Luxembourg: "LU",
};

const EMERGENCY_SQUAWK: Record<string, string> = {
  "7500": "UNLAWFUL INTERFERENCE",
  "7600": "RADIO FAILURE",
  "7700": "GENERAL EMERGENCY",
};

const MS_TO_KT = 1.94384;
const M_TO_FT = 3.28084;

export function openSkyConfigured(): boolean {
  return Boolean(process.env.OPENSKY_CLIENT_ID && process.env.OPENSKY_CLIENT_SECRET);
}

// Tokens last about half an hour. Cached at module scope so a poll every minute
// does not re-authenticate every time; the server process outlives any request.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(signal?: AbortSignal): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.OPENSKY_CLIENT_ID ?? "",
    client_secret: process.env.OPENSKY_CLIENT_SECRET ?? "",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`OpenSky auth failed: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.value;
}

/** One element of the `states` array, positionally addressed as OpenSky sends it. */
type StateVector = [
  string, string | null, string, number | null, number, number | null, number | null,
  number | null, boolean, number | null, number | null, number | null,
  number[] | null, number | null, string | null, boolean, number, number?,
];

export async function fetchOpenSky(signal?: AbortSignal): Promise<Track[]> {
  const token = await accessToken(signal);
  const res = await fetch(STATES_URL, {
    headers: { authorization: `Bearer ${token}` },
    signal,
    cache: "no-store",
  });

  if (res.status === 429) throw new Error("OpenSky rate limit reached (429)");
  if (!res.ok) throw new Error(`OpenSky states failed: ${res.status}`);

  const json = (await res.json()) as { time: number; states: StateVector[] | null };
  const states = json.states ?? [];
  const tracks: Track[] = [];

  for (const s of states) {
    const [icao24, callsign, country, timePosition, lastContact, lon, lat, baroAlt] = s;
    // A state vector with no position is a receiver contact, not a track.
    if (lon == null || lat == null) continue;
    // On-ground aircraft are the majority of a global snapshot and are noise on
    // a watch floor working at ocean scale.
    if (s[8]) continue;

    const velocity = s[9];
    const trueTrack = s[10];
    const geoAlt = s[13];
    const squawk = s[14];

    tracks.push({
      id: icao24,
      kind: "air",
      name: callsign?.trim() || icao24.toUpperCase(),
      lon,
      lat,
      sog: velocity == null ? null : Math.round(velocity * MS_TO_KT),
      hdg: trueTrack,
      alt: (geoAlt ?? baroAlt) == null ? null : Math.round((geoAlt ?? baroAlt)! * M_TO_FT),
      flag: COUNTRY_A2[country] ?? null,
      cls: null,
      fixedAt: (timePosition ?? lastContact) * 1000,
      emergency: squawk ? (EMERGENCY_SQUAWK[squawk] ?? null) : null,
      source: "opensky",
    });
  }

  return tracks;
}
