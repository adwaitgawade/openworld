/**
 * adsbdb adapter — the airframe behind a Mode-S address and the scheduled
 * route behind a callsign.
 *
 * Neither position feed answers "where is this flight going". A state vector is
 * a snapshot of the air, not a flight plan: OpenSky's estimated departure and
 * arrival airports are inferred from observed positions and only exist for
 * flights that have already landed and been batch-processed, and adsb.lol's
 * /api/0/routeset returns 201 with an empty body. adsbdb reads a route
 * database instead, so it answers mid-flight, which is the only case the
 * console ever asks about.
 *
 * The trade is coverage: it knows scheduled airline routes and nothing else.
 * Private, GA, military and positioning flights simply have no entry, and that
 * is a normal answer here rather than a failure — see MISS_TTL_MS.
 *
 * Aircraft data has no such gap. /v0/aircraft/{mode_s} answers for nearly
 * anything with a transponder, and carries what the position feeds do not:
 * registration, airframe type, operator and a photograph. OpenSky's state
 * vector has no registration field at all and reports "NO INFO" for the
 * emitter category of most airframes, so this is where the HUD's identity
 * fields actually come from.
 */

const BASE = "https://api.adsbdb.com/v0/aircraft";
/** A published route does not change during a session. */
const HIT_TTL_MS = 6 * 60 * 60_000;
/**
 * Misses are the common case over general aviation, and they are permanent for
 * as long as the aircraft holds that callsign. Cached nearly as hard as hits so
 * a GA-heavy view does not re-ask on every selection.
 */
const MISS_TTL_MS = 60 * 60_000;
/** Bounds the cache on a long-lived server process. */
const MAX_ENTRIES = 500;
const TIMEOUT_MS = 6_000;

/**
 * Raised when adsbdb turns a lookup away for asking too often, as distinct from
 * being down or not knowing the aircraft. Carried through to the browser so the
 * HUD can say which it was.
 */
export class RateLimitedError extends Error {
  /** Seconds adsbdb asks us to wait, when it says. */
  readonly retryAfterSec: number | null;

  constructor(retryAfterSec: number | null) {
    super(
      retryAfterSec == null
        ? "adsbdb rate limit reached"
        : `adsbdb rate limit reached — retry in ${retryAfterSec}s`,
    );
    this.name = "RateLimitedError";
    this.retryAfterSec = retryAfterSec;
  }
}

export type AircraftInfo = {
  /** ICAO24 / Mode-S hex, uppercase. */
  modeS: string;
  /** Tail number, e.g. G-TTNP. */
  registration: string;
  /** Full type name, e.g. "A320 251NSL". */
  type: string;
  /** ICAO type designator, e.g. A20N. */
  icaoType: string | null;
  manufacturer: string | null;
  /** Registered owner, e.g. British Airways. */
  owner: string | null;
  ownerCountry: string | null;
  /** ISO-3166 alpha-2, matching the code the HUD draws flags from. */
  ownerCountryIso: string | null;
  /** airport-data.com thumbnail. Null for airframes nobody has photographed. */
  photoThumb: string | null;
  photo: string | null;
};

export type RouteAirport = {
  /** ICAO identifier, e.g. VABB. Always present. */
  icao: string;
  /** IATA identifier, e.g. BOM. Present for anything with commercial service. */
  iata: string | null;
  name: string;
  municipality: string | null;
  country: string | null;
  /** ISO-3166 alpha-2, matching the code the HUD draws flags from. */
  countryIso: string | null;
  lat: number;
  lon: number;
  elevationFt: number | null;
};

export type FlightRoute = {
  /** The ICAO callsign this was resolved from, e.g. IGO5234. */
  callsign: string;
  /** The IATA form the public knows, e.g. 6E5234. */
  callsignIata: string | null;
  airline: {
    name: string;
    icao: string | null;
    iata: string | null;
    /** Radio callsign, e.g. IFLY for IndiGo. */
    radio: string | null;
    country: string | null;
  } | null;
  origin: RouteAirport;
  destination: RouteAirport;
};

/** adsbdb's own shape, before it is flattened into the above. */
type RawAirport = {
  icao_code?: string;
  iata_code?: string;
  name?: string;
  municipality?: string;
  country_name?: string;
  country_iso_name?: string;
  latitude?: number;
  longitude?: number;
  elevation?: number;
};

type RawAircraft = {
  mode_s?: string;
  registration?: string;
  type?: string;
  icao_type?: string;
  manufacturer?: string;
  registered_owner?: string;
  registered_owner_country_name?: string;
  registered_owner_country_iso_name?: string;
  url_photo?: string | null;
  url_photo_thumbnail?: string | null;
};

type RawFlightroute = {
  callsign?: string;
  callsign_icao?: string;
  callsign_iata?: string;
  airline?: {
    name?: string;
    icao?: string;
    iata?: string;
    callsign?: string;
    country?: string;
  };
  origin?: RawAirport;
  destination?: RawAirport;
};

type RawResponse = {
  response?: string | { aircraft?: RawAircraft; flightroute?: RawFlightroute };
};

/** What one lookup yields: the airframe, the route, or either alone. */
export type AircraftDetail = {
  aircraft: AircraftInfo | null;
  route: FlightRoute | null;
};

type Entry = { at: number; detail: AircraftDetail };

// Module scope, like the air cache: the server process outlives any request, so
// a route resolved for one viewer is free for the next.
const globalRef = globalThis as typeof globalThis & {
  __adsbdbCache?: Map<string, Entry>;
  __adsbdbInflight?: Map<string, Promise<AircraftDetail>>;
};

const cache = (globalRef.__adsbdbCache ??= new Map<string, Entry>());
const inflight = (globalRef.__adsbdbInflight ??= new Map<string, Promise<AircraftDetail>>());

/**
 * Callsigns arrive from the transponder padded and occasionally garbled. Only
 * the plain alphanumeric shape is worth a lookup; anything else is a receiver
 * artefact and would just be a guaranteed 404.
 */
export function normaliseCallsign(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toUpperCase();
  return /^[A-Z0-9]{3,8}$/.test(trimmed) ? trimmed : null;
}

function toAirport(raw: RawAirport | undefined): RouteAirport | null {
  if (!raw?.icao_code || raw.latitude == null || raw.longitude == null) return null;
  return {
    icao: raw.icao_code,
    iata: raw.iata_code || null,
    name: raw.name ?? raw.icao_code,
    municipality: raw.municipality || null,
    country: raw.country_name || null,
    countryIso: raw.country_iso_name || null,
    lat: raw.latitude,
    lon: raw.longitude,
    elevationFt: raw.elevation ?? null,
  };
}

/** Mode-S addresses are 24-bit hex; anything else is a malformed id. */
export function normaliseModeS(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toUpperCase();
  return /^[0-9A-F]{6}$/.test(trimmed) ? trimmed : null;
}

function toAircraft(raw: RawAircraft | undefined): AircraftInfo | null {
  if (!raw?.mode_s || !raw.registration) return null;
  return {
    modeS: raw.mode_s.toUpperCase(),
    registration: raw.registration,
    type: raw.type ?? "",
    icaoType: raw.icao_type || null,
    manufacturer: raw.manufacturer || null,
    owner: raw.registered_owner || null,
    ownerCountry: raw.registered_owner_country_name || null,
    ownerCountryIso: raw.registered_owner_country_iso_name || null,
    photoThumb: raw.url_photo_thumbnail || null,
    photo: raw.url_photo || null,
  };
}

function toRoute(
  flightroute: RawFlightroute | undefined,
  fallbackCallsign: string,
): FlightRoute | null {
  if (!flightroute) return null;

  const origin = toAirport(flightroute.origin);
  const destination = toAirport(flightroute.destination);
  // Half a route is not a route: the HUD draws an arrow between two ends.
  if (!origin || !destination) return null;

  const airline = flightroute.airline;
  return {
    callsign: flightroute.callsign_icao || flightroute.callsign || fallbackCallsign,
    callsignIata: flightroute.callsign_iata || null,
    airline: airline?.name
      ? {
        name: airline.name,
        icao: airline.icao || null,
        iata: airline.iata || null,
        radio: airline.callsign || null,
        country: airline.country || null,
      }
      : null,
    origin,
    destination,
  };
}

/** One GET against /v0/aircraft, with or without the callsign query. */
async function get(path: string, callsign: string): Promise<AircraftDetail | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${BASE}/${path}`, {
      signal: controller.signal,
      cache: "no-store",
      headers: { accept: "application/json" },
    });

    // 404 carries {"response":"unknown aircraft"} or "unknown callsign" — an
    // answer about coverage, not a failure. null means "ask differently".
    if (res.status === 404) return null;

    if (res.status === 429) {
      // adsbdb states the wait in a `retry-after` header when it sets one, and
      // otherwise in the body; neither is guaranteed, so the log degrades to
      // "no interval given" rather than inventing one.
      const header = res.headers.get("retry-after");
      const parsed = header ? Number.parseInt(header, 10) : Number.NaN;
      let retryAfterSec = Number.isFinite(parsed) ? parsed : null;

      if (retryAfterSec == null) {
        const body = await res.text().catch(() => "");
        const seconds = /(\d+)\s*second/i.exec(body);
        if (seconds) retryAfterSec = Number.parseInt(seconds[1], 10);
      }

      console.warn(
        `[watch] adsbdb rate limited on ${path.split("?")[0]}` +
        (retryAfterSec == null
          ? " — no retry interval given"
          : ` — retry in ${retryAfterSec}s`),
      );
      throw new RateLimitedError(retryAfterSec);
    }

    if (!res.ok) throw new Error(`adsbdb ${res.status}`);

    const body = (await res.json()) as RawResponse;
    const payload = typeof body.response === "object" ? body.response : undefined;
    return {
      aircraft: toAircraft(payload?.aircraft),
      route: toRoute(payload?.flightroute, callsign),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function load(modeS: string, callsign: string | null): Promise<AircraftDetail> {
  if (callsign) {
    const combined = await get(
      `${encodeURIComponent(modeS)}?callsign=${encodeURIComponent(callsign)}`,
      callsign,
    );
    if (combined) return combined;
    // The README says an unknown callsign still yields the aircraft. It does
    // not: the live API 404s the whole request and discards airframe data it
    // demonstrably holds. Verified against a known Mode-S with a bogus
    // callsign, so the airframe is re-asked for on its own.
  }

  return (await get(encodeURIComponent(modeS), "")) ?? { aircraft: null, route: null };
}

/**
 * The airframe behind a Mode-S address, and the route behind its callsign.
 *
 * Either half can be null: an unphotographed homebuilt has no aircraft record,
 * and a GA flight has no scheduled route. Throws only on a transport failure,
 * which the caller reports as a degraded lookup rather than as "nothing known"
 * — the two must not look the same in the HUD.
 */
export async function aircraftDetail(
  modeS: string,
  callsign: string | null,
): Promise<AircraftDetail> {
  // Keyed on both: the same airframe flies under a different callsign tomorrow,
  // and the route half of the answer would be stale.
  const key = `${modeS}|${callsign ?? ""}`;

  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.detail.route ?? cached.detail.aircraft ? HIT_TTL_MS : MISS_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.detail;
    cache.delete(key);
  }

  const pending = inflight.get(key);
  if (pending) return pending;

  const request = load(modeS, callsign)
    .then((detail) => {
      // Oldest-first eviction: Map preserves insertion order, and an aircraft
      // not asked for in 500 selections is not the hot one.
      if (cache.size >= MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(key, { at: Date.now(), detail });
      return detail;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, request);
  return request;
}
