/**
 * AISStream.io adapter — the global surface feed.
 *
 * AIS is a firehose, not a request/response API: one WebSocket subscribed to a
 * whole-world bounding box delivers thousands of position reports a second.
 * So this module holds a single long-lived connection at module scope and keeps
 * the latest report per MMSI in memory; the HTTP route reads a snapshot of that
 * map rather than talking to the provider itself.
 *
 * Consequences worth knowing:
 * - The store is per server process. A cold start begins empty and fills over
 *   the first minute or so, which is why the health line reports vessel count.
 * - It is capped (MAX_VESSELS). When full, the oldest fixes are evicted, so the
 *   store trends toward whatever is currently moving and reporting.
 *
 * Needs AISSTREAM_API_KEY (free, aisstream.io). Without it the adapter reports
 * itself as unconfigured and the surface layer stays empty rather than being
 * quietly filled with something invented.
 */

import type { Track } from "./types";

const STREAM_URL = "wss://stream.aisstream.io/v0/stream";
const MAX_VESSELS = 9000;
/** Ignore a vessel's new report if we already have one this recent. */
const MIN_UPDATE_MS = 12_000;
/** Drop anything we have not heard from in this long. */
const STALE_MS = 45 * 60_000;

type Vessel = {
  mmsi: string;
  name: string;
  lon: number;
  lat: number;
  sog: number | null;
  cog: number | null;
  fixedAt: number;
  cls: string | null;
  draught: number | null;
  /** Overall length in metres, bow to stern, from the static report. */
  len: number | null;
};

type Store = {
  vessels: Map<string, Vessel>;
  socket: WebSocket | null;
  status: "idle" | "connecting" | "open" | "error" | "unconfigured";
  error: string | null;
  connectedAt: number | null;
  messages: number;
  retry: number;
  timer: ReturnType<typeof setTimeout> | null;
};

// Next re-evaluates modules across dev hot reloads; hanging the store off
// globalThis keeps one socket rather than one per reload.
const globalRef = globalThis as typeof globalThis & { __aisStore?: Store };

const store: Store = (globalRef.__aisStore ??= {
  vessels: new Map(),
  socket: null,
  status: "idle",
  error: null,
  connectedAt: null,
  messages: 0,
  retry: 0,
  timer: null,
});

/** Maritime Identification Digits — the first three of an MMSI are the flag. */
const MID: Record<string, string> = {
  "201": "AL", "202": "AD", "203": "AT", "205": "BE", "206": "BY", "207": "BG",
  "209": "CY", "210": "CY", "211": "DE", "212": "CY", "213": "GE", "214": "MD",
  "215": "MT", "218": "DE", "219": "DK", "220": "DK", "224": "ES", "225": "ES",
  "226": "FR", "227": "FR", "228": "FR", "230": "FI", "231": "FO", "232": "GB",
  "233": "GB", "234": "GB", "235": "GB", "236": "GI", "237": "GR", "238": "HR",
  "239": "GR", "240": "GR", "241": "GR", "242": "MA", "243": "HU", "244": "NL",
  "245": "NL", "246": "NL", "247": "IT", "248": "MT", "249": "MT", "250": "IE",
  "251": "IS", "252": "LI", "253": "LU", "254": "MC", "255": "PT", "256": "MT",
  "257": "NO", "258": "NO", "259": "NO", "261": "PL", "262": "PT", "263": "PT",
  "264": "RO", "265": "SE", "266": "SE", "267": "SK", "268": "SM", "269": "CH",
  "270": "CZ", "271": "TR", "272": "UA", "273": "RU", "274": "MK", "275": "LV",
  "276": "EE", "277": "LT", "278": "SI", "279": "RS",
  "301": "AI", "303": "US", "304": "AG", "305": "AG", "306": "CW", "307": "AW",
  "308": "BS", "309": "BS", "310": "BM", "311": "BS", "312": "BZ", "314": "BB",
  "316": "CA", "319": "KY", "321": "CR", "323": "CU", "325": "DM", "327": "DO",
  "329": "GP", "330": "GD", "331": "GL", "332": "GT", "334": "HN", "336": "HT",
  "338": "US", "339": "JM", "341": "KN", "343": "LC", "345": "MX", "347": "MQ",
  "348": "MS", "350": "NI", "351": "PA", "352": "PA", "353": "PA", "354": "PA",
  "355": "PA", "356": "PA", "357": "PA", "358": "PR", "359": "SV", "361": "PM",
  "362": "TT", "364": "TC", "366": "US", "367": "US", "368": "US", "369": "US",
  "370": "PA", "371": "PA", "372": "PA", "373": "PA", "374": "PA", "375": "VC",
  "376": "VC", "377": "VC", "378": "VG", "379": "VI",
  "401": "AF", "403": "SA", "405": "BD", "408": "BH", "410": "BT", "412": "CN",
  "413": "CN", "414": "CN", "416": "TW", "417": "LK", "419": "IN", "422": "IR",
  "423": "AZ", "425": "IQ", "428": "IL", "431": "JP", "432": "JP", "434": "TM",
  "436": "KZ", "437": "UZ", "438": "JO", "440": "KR", "441": "KR", "443": "PS",
  "445": "KP", "447": "KW", "450": "LB", "451": "KG", "453": "MO", "455": "MV",
  "457": "MN", "459": "NP", "461": "OM", "463": "PK", "466": "QA", "468": "SY",
  "470": "AE", "471": "AE", "472": "TJ", "473": "YE", "475": "YE", "477": "HK",
  "478": "BA",
  "501": "AQ", "503": "AU", "506": "MM", "508": "BN", "510": "FM", "511": "PW",
  "512": "NZ", "514": "KH", "515": "KH", "516": "CX", "518": "CK", "520": "FJ",
  "523": "CC", "525": "ID", "529": "KI", "531": "LA", "533": "MY", "536": "MP",
  "538": "MH", "540": "NC", "542": "NU", "544": "NR", "546": "PF", "548": "PH",
  "553": "PG", "555": "PN", "557": "SB", "559": "AS", "561": "WS", "563": "SG",
  "564": "SG", "565": "SG", "566": "SG", "567": "TH", "570": "TO", "572": "TV",
  "574": "VN", "576": "VU", "577": "VU", "578": "WF",
  "601": "ZA", "603": "AO", "605": "DZ", "607": "TF", "608": "IO", "609": "BI",
  "610": "BJ", "611": "BW", "612": "CF", "613": "CM", "615": "CG", "616": "KM",
  "617": "CV", "618": "TF", "619": "CI", "620": "KM", "621": "DJ", "622": "EG",
  "624": "ET", "625": "ER", "626": "GA", "627": "GH", "629": "GM", "630": "GW",
  "631": "GQ", "632": "GN", "633": "BF", "634": "KE", "635": "TF", "636": "LR",
  "637": "LR", "642": "LY", "644": "LS", "645": "MU", "647": "MG", "649": "ML",
  "650": "MZ", "654": "MR", "655": "MW", "656": "NE", "657": "NG", "659": "NA",
  "664": "RW", "665": "SD", "666": "SN", "667": "SL", "668": "SH", "669": "SC",
  "670": "SO", "671": "TG", "672": "TN", "674": "TZ", "675": "UG", "676": "CD",
  "677": "TZ", "678": "ZM", "679": "ZW",
  "701": "AR", "710": "BR", "720": "BO", "725": "CL", "730": "CO", "735": "EC",
  "740": "FK", "745": "GF", "750": "GY", "755": "PY", "760": "PE", "765": "SR",
  "770": "UY", "775": "VE",
};

/** AIS ship-type code to something readable in a table cell. */
function shipClass(code: number | undefined): string | null {
  if (code == null || code === 0) return null;
  if (code === 30) return "Fishing";
  if (code === 31 || code === 32) return "Towing";
  if (code === 33) return "Dredger";
  if (code === 35) return "Military";
  if (code === 36) return "Sailing";
  if (code === 37) return "Pleasure craft";
  if (code === 50) return "Pilot";
  if (code === 51) return "SAR";
  if (code === 52) return "Tug";
  if (code === 53) return "Port tender";
  if (code === 55) return "Law enforcement";
  if (code >= 60 && code <= 69) return "Passenger";
  if (code >= 70 && code <= 79) return "Cargo";
  if (code >= 80 && code <= 89) return "Tanker";
  if (code >= 90 && code <= 99) return "Other";
  if (code >= 40 && code <= 49) return "High-speed craft";
  return null;
}

type AisEnvelope = {
  MessageType: string;
  MetaData?: { MMSI?: number; ShipName?: string; time_utc?: string };
  Message?: {
    PositionReport?: {
      UserID: number;
      Latitude: number;
      Longitude: number;
      Sog?: number;
      Cog?: number;
      TrueHeading?: number;
    };
    ShipStaticData?: {
      UserID: number;
      Name?: string;
      Type?: number;
      MaximumStaticDraught?: number;
      /** Metres from the position reference to bow (A), stern (B), port (C)
       *  and starboard (D). A + B is the hull's overall length. */
      Dimension?: { A?: number; B?: number; C?: number; D?: number };
    };
  };
};

function handle(raw: string) {
  store.messages++;
  let msg: AisEnvelope;
  try {
    msg = JSON.parse(raw) as AisEnvelope;
  } catch {
    return;
  }

  const now = Date.now();

  const pos = msg.Message?.PositionReport;
  if (pos) {
    const mmsi = String(pos.UserID);
    const existing = store.vessels.get(mmsi);
    // The firehose repeats hot vessels many times a minute; one fix per
    // MIN_UPDATE_MS is plenty for a globe and keeps the store cheap.
    if (existing && now - existing.fixedAt < MIN_UPDATE_MS) return;

    const reportedAt = msg.MetaData?.time_utc
      ? Date.parse(msg.MetaData.time_utc.replace(" +0000 UTC", "Z"))
      : now;

    store.vessels.set(mmsi, {
      mmsi,
      name: existing?.name ?? msg.MetaData?.ShipName?.trim() ?? mmsi,
      lon: pos.Longitude,
      lat: pos.Latitude,
      // 102.3 is the AIS "not available" sentinel for speed over ground.
      sog: pos.Sog == null || pos.Sog > 102 ? null : pos.Sog,
      cog:
        pos.TrueHeading != null && pos.TrueHeading < 360
          ? pos.TrueHeading
          : pos.Cog == null || pos.Cog >= 360
            ? null
            : pos.Cog,
      fixedAt: Number.isFinite(reportedAt) ? reportedAt : now,
      cls: existing?.cls ?? null,
      draught: existing?.draught ?? null,
      len: existing?.len ?? null,
    });

    if (store.vessels.size > MAX_VESSELS) evict();
    return;
  }

  const stat = msg.Message?.ShipStaticData;
  if (stat) {
    const v = store.vessels.get(String(stat.UserID));
    if (!v) return;
    if (stat.Name?.trim()) v.name = stat.Name.trim();
    v.cls = shipClass(stat.Type) ?? v.cls;
    v.draught = stat.MaximumStaticDraught ?? v.draught;
    const dim = stat.Dimension;
    if (dim) {
      // Both halves are needed: a receiver that reports only A is giving the
      // distance to the aerial, not a hull length. 511 is the AIS "unavailable"
      // sentinel for these fields.
      const bow = dim.A ?? 0;
      const stern = dim.B ?? 0;
      if (bow > 0 && stern > 0 && bow < 511 && stern < 511) v.len = bow + stern;
    }
  }
}

/** Drops the stalest tenth of the store — cheaper than an exact LRU per insert. */
function evict() {
  const entries = [...store.vessels.entries()].sort((a, b) => a[1].fixedAt - b[1].fixedAt);
  for (let i = 0; i < Math.ceil(entries.length * 0.1); i++) {
    store.vessels.delete(entries[i][0]);
  }
}

function connect() {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) {
    store.status = "unconfigured";
    return;
  }
  if (store.status === "connecting" || store.status === "open") return;

  store.status = "connecting";
  store.error = null;

  let socket: WebSocket;
  try {
    socket = new WebSocket(STREAM_URL);
  } catch (e) {
    store.status = "error";
    store.error = e instanceof Error ? e.message : String(e);
    scheduleReconnect();
    return;
  }
  store.socket = socket;

  socket.addEventListener("open", () => {
    store.status = "open";
    store.connectedAt = Date.now();
    store.retry = 0;
    socket.send(
      JSON.stringify({
        APIKey: key,
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ["PositionReport", "ShipStaticData"],
      }),
    );
  });

  socket.addEventListener("message", (event: MessageEvent) => {
    const data = event.data;
    if (typeof data === "string") handle(data);
    else if (data instanceof Blob) void data.text().then(handle);
    else if (data instanceof ArrayBuffer) handle(new TextDecoder().decode(data));
  });

  socket.addEventListener("error", () => {
    // The error event carries nothing useful in the WHATWG API; `close` follows.
    store.error = "AISStream socket error";
  });

  socket.addEventListener("close", (event: CloseEvent) => {
    store.socket = null;
    store.status = "error";
    // 1008/1011 with a reason is how AISStream reports a bad key.
    if (event.reason) store.error = event.reason;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (store.timer) return;
  const delay = Math.min(30_000, 1000 * 2 ** store.retry++);
  store.timer = setTimeout(() => {
    store.timer = null;
    connect();
  }, delay);
}

/** Idempotent: safe to call on every request. */
export function ensureAisConnected() {
  if (store.status === "idle" || store.status === "error") connect();
}

export function aisConfigured(): boolean {
  return Boolean(process.env.AISSTREAM_API_KEY);
}

export function aisStatus() {
  return {
    status: store.status,
    error: store.error,
    vessels: store.vessels.size,
    messages: store.messages,
    connectedAt: store.connectedAt,
  };
}

export function aisTracks(): Track[] {
  const now = Date.now();
  const tracks: Track[] = [];
  for (const v of store.vessels.values()) {
    const age = now - v.fixedAt;
    if (age > STALE_MS) continue;
    tracks.push({
      id: v.mmsi,
      kind: "sea",
      name: v.name || v.mmsi,
      lon: v.lon,
      lat: v.lat,
      sog: v.sog,
      hdg: v.cog,
      alt: v.draught,
      flag: MID[v.mmsi.slice(0, 3)] ?? null,
      cls: v.cls,
      len: v.len,
      fixedAt: v.fixedAt,
      gapMinutes: Math.round(age / 60_000),
      source: "aisstream",
    });
  }
  return tracks;
}
