# Air feed capabilities — OpenSky vs adsb.lol

What each source can and cannot give the watch console. Verified against the
live endpoints on 2026-08-30, not from documentation alone; where the docs and
the wire disagree, the wire wins and the disagreement is noted.

The third column is [adsbdb](https://api.adsbdb.com), a route database rather
than a position feed. It is here because neither of the other two can answer
"where is this flight going", and it is the only keyless thing that can.

| Capability | OpenSky | adsb.lol | adsbdb |
| --- | :---: | :---: | :---: |
| **Live positions** | | | |
| One call covers the whole globe | ✅ | ❌ | — |
| Positions within a radius of a point | ✅ | ✅ | — |
| Lookup by ICAO24 hex | ✅ | ✅ | — |
| Lookup by callsign / registration / type | ❌ | ✅ | — |
| Lookup by squawk, military, PIA, LADD | ❌ | ✅ | — |
| Altitude, ground speed, track, vertical rate | ✅ | ✅ | — |
| Emitter category | ✅ | ✅ | — |
| Registration and aircraft type in the feed | ❌ | ✅ | — |
| **History** | | | |
| Flown path of one aircraft, current flight | ✅ | ✅ | — |
| Altitude / speed per waypoint of that path | ✅ | ✅ | — |
| That path for a past date | ✅ | ✅ | — |
| Positions of *all* aircraft at a past instant | ✅ | ❌ | — |
| **Route** | | | |
| Origin airport of a completed flight | ✅ | ❌ | ✅ |
| Destination of an *in-progress* flight | ❌ | ❌ | ✅ |
| Airline and IATA flight number | ❌ | ❌ | ✅ |
| Airport coordinates and names | ❌ | ✅ | ✅ |
| **Airframe identity** | | | |
| Registration / tail number | ❌ | ✅ | ✅ |
| Airframe type and manufacturer | ⚠️ | ✅ | ✅ |
| Registered owner / operator | ❌ | ❌ | ✅ |
| Photograph of the airframe | ❌ | ❌ | ✅ |
| Airframe + route in one request | ❌ | ❌ | ✅ |
| **Access** | | | |
| Usable without credentials | ✅ | ✅ | ✅ |
| No per-call quota | ❌ | ✅ | ✅ |
| Documented and version-stable | ✅ | ⚠️ | ✅ |

✅ yes · ❌ no · ⚠️ works but undocumented · — not applicable

## The asterisks that matter

**OpenSky's origin/destination is not what it sounds like.** `/flights/aircraft`
returns `estDepartureAirport` and `estArrivalAirport`, but they are *estimated*:
inferred by matching the first and last observed positions against an airport
database, which is why each one ships with a `*AirportHorizDistance` and a
`*AirportCandidatesCount`. Both can be null. More decisively, the endpoint states
that "only flights from the previous day or earlier are available" — a flight
becomes a flight object only after it has landed and been batch-processed. For
an aircraft currently airborne, which is the only kind the console ever has
selected, it returns nothing, and by construction can never say where one is
*going*.

**OpenSky's track endpoint is credit-metered and self-described as fragile.**
`/tracks?icao24=&time=0` gives the live trajectory, but the documentation calls
it "purely experimental and can be out of order at any time", nothing older than
30 days is reachable, and each call costs 4 credits against a 4 000/day
authenticated allowance.

**That allowance is already overcommitted.** A global `/states/all` costs 4
credits and `AIR_POLL_MS` floors polling at 60s, so a console left open for a
day spends 5 760 — see the "leaves headroom" comment at `src/lib/watch/air.ts:20`,
which does not hold. Any per-selection OpenSky call competes with the live feed.

**adsb.lol's traces are real but off the books.** They are absent from the
OpenAPI spec and served by the tar1090 globe service:

```
https://globe.adsb.lol/data/traces/<last 2 chars of hex>/trace_full_<icao24>.json
https://globe.adsb.lol/globe_history/<YYYY>/<MM>/<DD>/traces/<xx>/trace_full_<icao24>.json
```

A test fetch for `406b0a` (G-STBK, a 777-300ER) returned 3 273 waypoints from
pushback at Heathrow through to cruise. Two traps: it 302-redirects to
`adsb.lol`, so redirects must be followed, and the body is **gzipped despite the
`.json` extension**. Each waypoint is
`[seconds_since_timestamp, lat, lon, alt, gs, track, flags, vrate, {extended}, source, …]`.
Being undocumented and volunteer-funded, this is a nice-to-have that must
degrade, never a contract.

**adsb.lol's route endpoint does not work.** `POST /api/0/routeset` takes
`{planes:[{callsign,lat,lng}]}` and looks exactly like the lookup you want. It
returns HTTP 201, `content-type: text/html`, zero bytes — for live callsigns and
scheduled ones alike. The spec declares its 200 response as a bare
`"type": "string"`. Treat it as unusable; adsbdb covers this instead.

**adsbdb's combined endpoint does not fall back as documented.**
`GET /v0/aircraft/{mode_s}?callsign={callsign}` returns airframe and route
together in one request, and the project README says it "returns aircraft-only
if callsign is unknown but aircraft exists". It does not: tested with a known
Mode-S (`407B8F`) and a bogus callsign, the live API returns 404
`{"response":"unknown callsign"}` and discards airframe data it demonstrably
holds. Any caller must re-ask with the plain `/v0/aircraft/{mode_s}` form on a
404, which matters precisely for general aviation — the population where the
callsign is unknown and the airframe record is the whole value.

**adsbdb only knows scheduled routes.** `GET /v0/callsign/BAW117` returned
EGLL/LHR → KJFK/JFK with airline, IATA number and airport coordinates, and it
works mid-flight because it reads a schedule rather than inferring from
position. The flip side is that private, GA, military and positioning flights
have no entry — of three live aircraft sampled near Heathrow, two were a DA40
and an NG5 that no route database carries.

## How they divide the work

Nothing here replaces anything else:

- **OpenSky** — the global "everything at once" sheet. Nothing else does that in
  one keyless call, which is why `src/lib/watch/opensky.ts` is the primary feed.
- **adsb.lol** — dense regional coverage as the keyless fallback
  (`src/lib/watch/adsb.ts`), plus one aircraft in depth, on demand.
- **adsbdb** — what route a callsign is flying.
