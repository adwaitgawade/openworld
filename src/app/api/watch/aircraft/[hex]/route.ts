/**
 * Everything adsbdb knows about one selected aircraft: the airframe behind its
 * Mode-S address and, when it is flying a scheduled service, the route behind
 * its callsign.
 *
 * Kept server-side rather than called from the browser for the same reason the
 * feed is: it is one shared cache for every viewer instead of one per tab, and
 * adsbdb sees a single origin rather than every console visitor.
 */

import { NextResponse } from "next/server";

import {
  aircraftDetail,
  normaliseCallsign,
  normaliseModeS,
  RateLimitedError,
} from "@/lib/watch/adsbdb";

// The lookup cache lives in module state, which needs a long-lived process.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY = { aircraft: null, route: null };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ hex: string }> },
) {
  const { hex } = await params;
  const modeS = normaliseModeS(hex);
  const callsign = normaliseCallsign(new URL(request.url).searchParams.get("callsign"));

  // Not a Mode-S address at all — answer without spending a lookup on it.
  if (!modeS) {
    return NextResponse.json(EMPTY, { headers: { "cache-control": "no-store" } });
  }

  try {
    const detail = await aircraftDetail(modeS, callsign);
    return NextResponse.json(detail, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    // Being turned away for asking too often is its own condition: it is
    // temporary, it is our fault rather than adsbdb's, and it is worth naming
    // in both consoles. The status mirrors upstream so the browser's network
    // pane says the same thing.
    if (e instanceof RateLimitedError) {
      return NextResponse.json(
        {
          ...EMPTY,
          error: e.message,
          rateLimited: true,
          retryAfterSec: e.retryAfterSec,
        },
        {
          status: 429,
          headers: {
            "cache-control": "no-store",
            ...(e.retryAfterSec == null
              ? {}
              : { "retry-after": String(e.retryAfterSec) }),
          },
        },
      );
    }

    // A lookup that failed is not the same as an aircraft nothing is known
    // about, so it gets its own field and the HUD says so.
    return NextResponse.json(
      { ...EMPTY, error: e instanceof Error ? e.message : String(e) },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
