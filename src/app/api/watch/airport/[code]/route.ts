/**
 * One airport, by ICAO or IATA code.
 *
 * Server-side so the lookup cache and the index built from resolved
 * flightroutes are shared across viewers rather than rebuilt per tab.
 */

import { NextResponse } from "next/server";

import { lookupAirport, normaliseAirportCode } from "@/lib/watch/airports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code: raw } = await params;
  const code = normaliseAirportCode(raw);

  if (!code) {
    return NextResponse.json(
      { airport: null },
      { headers: { "cache-control": "no-store" } },
    );
  }

  try {
    return NextResponse.json(
      { airport: await lookupAirport(code) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json(
      { airport: null, error: e instanceof Error ? e.message : String(e) },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}
