/**
 * Airport lookup for the command palette.
 *
 * Two sources, because neither is complete on its own:
 *
 * 1. adsb.lol's `/api/0/airport/{icao}` answers any ICAO identifier with a
 *    position, name and elevation. It does not accept IATA codes — LHR and BOM
 *    both come back as a literal `null` — so it alone would mean typing EGLL
 *    to reach Heathrow.
 * 2. Every flightroute adsbdb resolves carries both codes for both ends. Those
 *    are recorded here as they arrive, so an airport the console has already
 *    seen on a route is reachable by the code printed on a boarding pass.
 *
 * The index is therefore warm for wherever the operator has been looking, and
 * ICAO always works regardless.
 */

const AIRPORT_URL = "https://api.adsb.lol/api/0/airport";
/**
 * adsb.lol's /api/0 endpoints answer a default fetch with
 * `403 User-Agent too generic; include valid contact info`, so this identifies
 * the console the way the /v2 sweep already does.
 */
const UA = "openworld-watch-console";
/** Airports do not move; this only bounds a long-lived process. */
const HIT_TTL_MS = 24 * 60 * 60_000;
/**
 * A miss is remembered far more briefly than a hit: an IATA code that is not
 * in the index yet becomes findable the moment a route mentions it, and a day
 * of "no such airport" would hide it until tomorrow.
 */
const MISS_TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 500;
const TIMEOUT_MS = 5_000;

export type Airport = {
  icao: string;
  iata: string | null;
  name: string;
  /** The town or city the field serves, where the source names one. */
  location: string | null;
  /** ISO-3166 alpha-2, matching the code the HUD draws flags from. */
  countryIso: string | null;
  lat: number;
  lon: number;
  elevationFt: number | null;
};

type Entry = { at: number; airport: Airport | null };

const globalRef = globalThis as typeof globalThis & {
  __airportCache?: Map<string, Entry>;
  __airportIndex?: Map<string, Airport>;
};

const cache = (globalRef.__airportCache ??= new Map<string, Entry>());
/** Keyed by both ICAO and IATA, populated from resolved flightroutes. */
const index = (globalRef.__airportIndex ??= new Map<string, Airport>());

/** Airport codes are 3 (IATA) or 4 (ICAO) alphanumerics; anything else is noise. */
export function normaliseAirportCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toUpperCase();
  return /^[A-Z0-9]{3,4}$/.test(trimmed) ? trimmed : null;
}

/**
 * Records an airport seen on a resolved route, so it can later be found by
 * either of its codes. Called as routes are looked up, never on its own.
 */
export function rememberAirport(airport: Airport): void {
  if (index.size >= MAX_ENTRIES) {
    const oldest = index.keys().next();
    if (!oldest.done) index.delete(oldest.value);
  }
  index.set(airport.icao, airport);
  if (airport.iata) index.set(airport.iata, airport);
}

type RawAirport = {
  icao?: string;
  iata?: string;
  name?: string;
  location?: string;
  countryiso2?: string;
  lat?: number;
  lon?: number;
  alt_feet?: number;
};

async function fetchByIcao(icao: string): Promise<Airport | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${AIRPORT_URL}/${encodeURIComponent(icao)}`, {
      signal: controller.signal,
      cache: "no-store",
      headers: { accept: "application/json", "user-agent": UA },
    });
    // Refused or unreachable is not an answer about this airport, so it is
    // raised rather than cached as "no such place".
    if (!res.ok) throw new Error(`adsb.lol airport ${res.status}`);

    // An unknown identifier is answered with a literal `null` body and a 200,
    // so the shape has to be checked rather than the status.
    const raw = (await res.json()) as RawAirport | null;
    if (!raw?.icao || raw.lat == null || raw.lon == null) return null;

    return {
      icao: raw.icao,
      iata: raw.iata || null,
      name: raw.name ?? raw.icao,
      location: raw.location || null,
      countryIso: raw.countryiso2 || null,
      lat: raw.lat,
      lon: raw.lon,
      elevationFt: raw.alt_feet ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The airport for a code, or null when neither source knows it. */
export async function lookupAirport(code: string): Promise<Airport | null> {
  const known = index.get(code);
  if (known) return known;

  const cached = cache.get(code);
  if (cached) {
    const ttl = cached.airport ? HIT_TTL_MS : MISS_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.airport;
    cache.delete(code);
  }

  // Only ICAO reaches the network; a three-letter code that missed the index
  // has nowhere else to go, and asking would spend a request to be told null.
  const airport = code.length === 4 ? await fetchByIcao(code) : null;

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(code, { at: Date.now(), airport });
  if (airport) rememberAirport(airport);

  return airport;
}
