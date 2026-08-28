/**
 * Picks the air adapter, caches its answer, and refreshes it in the background.
 *
 * OpenSky when OPENSKY_CLIENT_ID/SECRET are set — one unbounded call covers the
 * whole planet. Otherwise the keyless fan-out, which needs no signup but only
 * covers the anchor bubbles and, because the providers rate-limit to about one
 * request a second, takes ~20s to complete a sweep.
 *
 * That last number is why this is stale-while-revalidate rather than a plain
 * TTL cache: a request must never sit for twenty seconds waiting on a sweep.
 * A stale snapshot is served immediately and a refresh is kicked off behind it;
 * the very first request, with nothing cached at all, returns empty and says
 * so.
 */

import { fetchAdsb } from "./adsb";
import { fetchOpenSky, openSkyConfigured } from "./opensky";
import type { FeedHealth, Track } from "./types";

/** OpenSky: 4 credits per global call, 4 000/day — a 60s floor leaves headroom. */
const OPENSKY_TTL_MS = 60_000;
/** A keyless sweep already takes ~20s; refreshing more often than this is moot. */
const ADSB_TTL_MS = 45_000;

type Cached = {
  at: number;
  tracks: Track[];
  health: FeedHealth;
};

const globalRef = globalThis as typeof globalThis & {
  __airCache?: Cached | null;
  __airInflight?: Promise<Cached> | null;
  __airSweepStartedAt?: number;
};

function ttl(): number {
  return openSkyConfigured() ? OPENSKY_TTL_MS : ADSB_TTL_MS;
}

async function load(): Promise<Cached> {
  const usingOpenSky = openSkyConfigured();
  const at = Date.now();

  try {
    if (usingOpenSky) {
      const tracks = await fetchOpenSky();
      const newest = tracks.reduce((max, t) => Math.max(max, t.fixedAt), 0);
      return {
        at,
        tracks,
        health: {
          source: "opensky",
          integrity: tracks.length > 0 ? 1 : 0,
          latencySec: newest ? Math.max(0, Math.round((at - newest) / 1000)) : null,
          status: tracks.length > 0 ? "ok" : "degraded",
          note: null,
        },
      };
    }

    const sweep = await fetchAdsb();
    const newest = sweep.tracks.reduce((max, t) => Math.max(max, t.fixedAt), 0);
    const complete = sweep.anchorsOk === sweep.anchorsTotal;
    return {
      at: Date.now(),
      tracks: sweep.tracks,
      health: {
        source: sweep.provider,
        integrity: sweep.anchorsOk / sweep.anchorsTotal,
        latencySec: newest ? Math.max(0, Math.round((Date.now() - newest) / 1000)) : null,
        status: complete ? "ok" : "degraded",
        note: `keyless · ${sweep.anchorsOk}/${sweep.anchorsTotal} anchors × 250nm — coverage follows volunteer receivers, not the globe`,
      },
    };
  } catch (e) {
    return {
      at,
      tracks: [],
      health: {
        source: usingOpenSky ? "opensky" : "adsb",
        integrity: 0,
        latencySec: null,
        status: "down",
        note: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

function refresh(): Promise<Cached> {
  globalRef.__airInflight ??= load()
    .then((next) => {
      // A failed refresh must not blank a globe that had traffic on it a minute
      // ago: keep the tracks, take the new health line.
      const previous = globalRef.__airCache;
      const merged =
        next.health.status === "down" && previous && previous.tracks.length > 0
          ? { ...previous, health: next.health }
          : next;
      globalRef.__airCache = merged;
      return merged;
    })
    .finally(() => {
      globalRef.__airInflight = null;
    });
  return globalRef.__airInflight;
}

export async function airFeed(): Promise<Cached> {
  const cached = globalRef.__airCache;

  if (cached && Date.now() - cached.at < ttl()) return cached;

  if (cached) {
    // Stale but usable: hand it back now, refresh behind the request.
    void refresh();
    return cached;
  }

  // Cold start. OpenSky answers in about a second, so waiting for it is fine;
  // a keyless sweep is not something to hold a request open for.
  if (openSkyConfigured()) return refresh();

  globalRef.__airSweepStartedAt ??= Date.now();
  void refresh();
  return {
    at: Date.now(),
    tracks: [],
    health: {
      source: "adsb",
      integrity: 0,
      latencySec: null,
      status: "degraded",
      note: "first sweep in progress — the keyless fan-out takes about 20 seconds",
    },
  };
}
