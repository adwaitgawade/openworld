/**
 * OpenSky Network adapter — the global air feed.
 *
 * `/states/all` with no bounding box returns every aircraft OpenSky can see, so
 * one call fills the whole globe. `extended=1` adds the emitter category.
 *
 * An authenticated account gets 4 000 credits a day and a global call costs 4,
 * so the poll interval is conservative — see AIR_POLL_MS in ./air.
 */

import type { Track } from "./types";

const TOKEN_URL =
  "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const STATES_URL = "https://opensky-network.org/api/states/all?extended=1";

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

/** Field 16, position_source. */
const POSITION_SOURCE = ["ADS-B", "ASTERIX", "MLAT", "FLARM"];

/** Field 17, the emitter category `extended=1` asks for. */
const CATEGORY = [
  "NO INFO", "NO ADS-B INFO", "LIGHT <15.5T", "SMALL 15.5-75T", "LARGE 75-300T",
  "HIGH VORTEX LARGE", "HEAVY >300T", "HIGH PERFORMANCE", "ROTORCRAFT",
  "GLIDER", "LIGHTER-THAN-AIR", "PARACHUTIST", "ULTRALIGHT", "RESERVED", "UAV",
  "SPACECRAFT", "SURFACE - EMERGENCY", "SURFACE - SERVICE", "POINT OBSTACLE",
  "CLUSTER OBSTACLE", "LINE OBSTACLE",
];

const MS_TO_KT = 1.94384;
const M_TO_FT = 3.28084;
/** Metres per second to feet per minute. */
const MS_TO_FPM = 196.85;

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

/** One `states` element, positionally addressed as OpenSky sends it. */
type StateVector = [
  icao24: string,
  callsign: string | null,
  originCountry: string,
  timePosition: number | null,
  lastContact: number,
  longitude: number | null,
  latitude: number | null,
  baroAltitude: number | null,
  onGround: boolean,
  velocity: number | null,
  trueTrack: number | null,
  verticalRate: number | null,
  sensors: number[] | null,
  geoAltitude: number | null,
  squawk: string | null,
  spi: boolean,
  positionSource: number,
  category?: number,
];

const feet = (metres: number | null) =>
  metres == null ? null : Math.round(metres * M_TO_FT);

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
  const tracks: Track[] = [];

  for (const s of json.states ?? []) {
    const [
      icao24, callsign, country, timePosition, lastContact, lon, lat, baroAlt,
      onGround, velocity, trueTrack, verticalRate, sensors, geoAlt, squawk, spi,
      positionSource, category,
    ] = s;
    // A state vector with no position is a receiver contact, not a track.
    if (lon == null || lat == null) continue;

    tracks.push({
      id: icao24,
      kind: "air",
      name: callsign?.trim() || icao24.toUpperCase(),
      lon,
      lat,
      sog: velocity == null ? null : Math.round(velocity * MS_TO_KT),
      hdg: trueTrack,
      alt: feet(geoAlt ?? baroAlt),
      baroAlt: feet(baroAlt),
      geoAlt: feet(geoAlt),
      vrate: verticalRate == null ? null : Math.round(verticalRate * MS_TO_FPM),
      flag: COUNTRY_A2[country] ?? null,
      country,
      cls: category == null ? null : (CATEGORY[category] ?? null),
      fixedAt: (timePosition ?? lastContact) * 1000,
      contactAt: lastContact * 1000,
      squawk,
      emergency: squawk ? (EMERGENCY_SQUAWK[squawk] ?? null) : null,
      spi,
      onGround,
      posSource: POSITION_SOURCE[positionSource] ?? null,
      sensors: sensors?.length ? sensors : null,
      source: "opensky",
    });
  }

  return tracks;
}
