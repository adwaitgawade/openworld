/**
 * Shared Nominatim access, server-side only.
 *
 * Nominatim's usage policy requires an identifying User-Agent and caps traffic
 * at ~1 req/s *per application*, not per endpoint — so the throttle has to live
 * here rather than in each route, or two routes would each hold their own gate
 * and together run at double the allowed rate. Browsers refuse to set
 * User-Agent anyway, which is what forces this through the server.
 */

const BASE = "https://nominatim.openstreetmap.org";
const CONTACT =
  process.env.NOMINATIM_CONTACT ?? "openworld-globe (contact not configured)";

const MIN_INTERVAL_MS = 1100;
let lastRequestAt = 0;
// Concurrent handlers are chained through a single promise so two in-flight
// requests can't both read the same `lastRequestAt` and fire together.
let gate: Promise<void> = Promise.resolve();

function takeSlot(): Promise<void> {
  gate = gate.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  return gate;
}

/** One throttled, identified Nominatim call. `revalidate` is in seconds. */
export async function nominatim(
  endpoint: "search" | "reverse" | "lookup",
  params: Record<string, string>,
  revalidate: number,
): Promise<unknown> {
  await takeSlot();

  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set("format", "jsonv2");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const upstream = await fetch(url, {
    headers: { "User-Agent": CONTACT, "Accept-Language": "en" },
    next: { revalidate },
  });
  if (!upstream.ok) throw new Error(`Nominatim returned ${upstream.status}`);
  return upstream.json();
}
