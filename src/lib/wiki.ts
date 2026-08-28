/**
 * Wikidata and Wikipedia lookups for a picked building, server-side only.
 *
 * OSM tags say what a building *is*; they say nothing about why it matters.
 * That lives on Wikidata (architect, style, heritage listing, inception) and in
 * the Wikipedia lead paragraph, reachable from the `wikidata` tag that ion
 * carries through from OSM.
 *
 * Both APIs ask for an identifying User-Agent, which browsers refuse to set —
 * the same reason Nominatim goes through the server.
 */

const CONTACT =
  process.env.NOMINATIM_CONTACT ?? "openworld-globe (contact not configured)";

const HEADERS = { "User-Agent": CONTACT, "Accept-Language": "en" };
/** Wikidata and Wikipedia content is stable on the scale we care about. */
const REVALIDATE = 86_400;

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: HEADERS, next: { revalidate: REVALIDATE } });
  if (!response.ok) throw new Error(`${new URL(url).host} returned ${response.status}`);
  return response.json();
}

export type WikiFact = { label: string; value: string };

export type WikiSummary = {
  title: string;
  /** Wikipedia's one-line description, e.g. "Building in Manhattan". */
  description: string | null;
  /** Lead paragraph. */
  extract: string;
  url: string;
  /**
   * True when the article was found by searching near the coordinate rather
   * than followed from the building's own `wikidata` tag — it may describe a
   * neighbour, so the UI has to label it as nearby rather than as this
   * building's own entry.
   */
  nearby: boolean;
};

/* -------------------------------------------------------------------------- */
/* Wikidata                                                                   */
/* -------------------------------------------------------------------------- */

type Snak = { datavalue?: { value: unknown; type: string } };
type Claim = { mainsnak: Snak; rank?: string };
type Entity = {
  descriptions?: Record<string, { value: string }>;
  sitelinks?: Record<string, { title: string; url: string }>;
  claims?: Record<string, Claim[]>;
  labels?: Record<string, { value: string }>;
};

/**
 * Properties worth a row, in display order. Entity-valued ones come back as
 * Q-ids and are resolved to labels in a second batched call.
 */
const CLAIMS: { property: string; label: string; kind: "time" | "entity" | "quantity" }[] = [
  { property: "P571", label: "Built", kind: "time" },
  { property: "P1619", label: "Opened", kind: "time" },
  { property: "P84", label: "Architect", kind: "entity" },
  { property: "P149", label: "Style", kind: "entity" },
  { property: "P1435", label: "Heritage status", kind: "entity" },
  { property: "P31", label: "Kind", kind: "entity" },
  { property: "P127", label: "Owner", kind: "entity" },
  { property: "P1101", label: "Floors", kind: "quantity" },
];

/** `+1921-00-00T00:00:00Z` at precision 9 is a year; 10 a month, 11 a day. */
function formatTime(value: unknown): string | null {
  const time = value as { time?: string; precision?: number };
  const match = time?.time?.match(/^([+-])(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, sign, year, month, day] = match;
  const era = sign === "-" ? " BC" : "";
  const precision = time.precision ?? 9;
  if (precision <= 8) return `${year.replace(/\d$/, "0")}s${era}`;
  if (precision === 9 || month === "00") return `${Number(year)}${era}`;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) || 1));
  return precision === 10
    ? date.toLocaleDateString("en", { year: "numeric", month: "long", timeZone: "UTC" })
    : date.toLocaleDateString("en", { dateStyle: "long", timeZone: "UTC" });
}

function claimValue(claim: Claim, kind: string): { text?: string; entityId?: string } {
  const value = claim.mainsnak.datavalue?.value;
  if (value === undefined) return {};
  if (kind === "time") {
    const text = formatTime(value);
    return text ? { text } : {};
  }
  if (kind === "entity") {
    const id = (value as { id?: string }).id;
    return id ? { entityId: id } : {};
  }
  const amount = (value as { amount?: string }).amount;
  return amount ? { text: String(Number(amount)) } : {};
}

/** Labels for a batch of Q-ids, as one call. */
async function labelsFor(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;

  const url =
    "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json" +
    `&props=labels&languages=en&ids=${ids.slice(0, 50).join("|")}`;
  const data = (await getJson(url)) as { entities?: Record<string, Entity> };
  for (const [id, entity] of Object.entries(data.entities ?? {})) {
    const label = entity.labels?.en?.value;
    if (label) out.set(id, label);
  }
  return out;
}

export async function wikidataFacts(
  id: string,
): Promise<{ facts: WikiFact[]; article: string | null; description: string | null }> {
  const url =
    "https://www.wikidata.org/w/api.php?action=wbgetentities&format=json" +
    `&props=sitelinks%2Furls%7Cdescriptions%7Cclaims&sitefilter=enwiki&languages=en&ids=${id}`;
  const data = (await getJson(url)) as { entities?: Record<string, Entity> };
  const entity = data.entities?.[id];
  if (!entity) return { facts: [], article: null, description: null };

  // Gather every value first so the Q-ids across all properties resolve in one
  // labels call rather than one per property.
  const pending: { label: string; text?: string; entityId?: string }[] = [];
  for (const { property, label, kind } of CLAIMS) {
    // `preferred` beats `normal` where a property has several values (a
    // building with two architects, a heritage listing that was upgraded).
    const claims = entity.claims?.[property];
    if (!claims?.length) continue;
    const best = claims.find((c) => c.rank === "preferred") ?? claims[0];
    const value = claimValue(best, kind);
    if (value.text || value.entityId) pending.push({ label, ...value });
  }

  const labels = await labelsFor(
    pending.map((p) => p.entityId).filter((id): id is string => Boolean(id)),
  );

  const facts: WikiFact[] = [];
  for (const item of pending) {
    const value = item.text ?? (item.entityId ? labels.get(item.entityId) : undefined);
    if (value) facts.push({ label: item.label, value });
  }

  return {
    facts,
    article: entity.sitelinks?.enwiki?.title ?? null,
    description: entity.descriptions?.en?.value ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* Wikipedia                                                                  */
/* -------------------------------------------------------------------------- */

export async function articleSummary(
  title: string,
  nearby: boolean,
): Promise<WikiSummary | null> {
  const data = (await getJson(
    `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
  )) as {
    title?: string;
    description?: string;
    extract?: string;
    type?: string;
    content_urls?: { desktop?: { page?: string } };
  };
  // Disambiguation pages carry no useful lead paragraph.
  if (!data.extract || data.type === "disambiguation") return null;

  return {
    title: data.title ?? title,
    description: data.description ?? null,
    extract: data.extract,
    url:
      data.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    nearby,
  };
}

/**
 * Nearest article to a point, for buildings with no `wikidata` tag of their
 * own. The radius is deliberately tight: past a block or so the nearest article
 * is a different building, and a wrong attribution is worse than no article.
 */
export async function nearestArticle(
  lat: number,
  lon: number,
  radiusMetres = 60,
): Promise<string | null> {
  const url =
    "https://en.wikipedia.org/w/api.php?action=query&format=json&list=geosearch" +
    `&gscoord=${lat}%7C${lon}&gsradius=${radiusMetres}&gslimit=1`;
  const data = (await getJson(url)) as {
    query?: { geosearch?: { title: string }[] };
  };
  return data.query?.geosearch?.[0]?.title ?? null;
}
