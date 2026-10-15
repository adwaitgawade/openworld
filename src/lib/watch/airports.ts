/**
 * Airport lookup for the command palette.
 *
 * Two sources, because neither is complete on its own:
 *
 * 1. adsb.lol's `/api/0/airport/{icao}` answers any ICAO identifier with a
 *    position, name and elevation. It does not accept IATA codes — LHR and BOM
 *    both come back as a literal `null` — so it alone would mean typing EGLL
 *    to reach Heathrow.
 * 2. A translation table for the busiest few hundred airports turns the IATA
 *    code a passenger knows into the ICAO code the endpoint wants.
 * 3. Every flightroute adsbdb resolves carries both codes for both ends. Those
 *    are recorded here as they arrive, so anywhere the console has been
 *    looking is reachable by either code, table or no table.
 *
 * ICAO therefore always works, common IATA codes work from the start, and the
 * index fills in the rest as routes are resolved.
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

/**
 * IATA to ICAO, for the 306 busiest and most-searched airports.
 *
 * adsb.lol's airport endpoint answers only to ICAO, and none of the three
 * feeds this console uses can resolve an IATA code — so BOM would otherwise
 * only be findable after some flight's route happened to mention it. This is
 * a translation table and nothing more: the airport's actual record still
 * comes from adsb.lol, and every entry here was checked against that endpoint,
 * so a stale or mistaken pair fails the search rather than misdirecting it.
 */
const IATA_TO_ICAO: Record<string, string> = {
  ABV: "DNAA", ACC: "DGAA", ADB: "LTBJ", ADD: "HAAB",
  ADL: "YPAD", AEP: "SABE", AGP: "LEMG", AKL: "NZAA",
  ALA: "UAAA", ALC: "LEAL", ALG: "DAAG", AMD: "VAAH",
  AMM: "OJAI", AMS: "EHAM", ANC: "PANC", ARN: "ESSA",
  ATH: "LGAV", ATL: "KATL", AUA: "TNCA", AUH: "OMAA",
  AUS: "KAUS", AYT: "LTAI", BAH: "OBBI", BCN: "LEBL",
  BEG: "LYBE", BER: "EDDB", BEY: "OLBA", BGI: "TBPB",
  BGO: "ENBR", BGY: "LIME", BHX: "EGBB", BIO: "LEBB",
  BKI: "WBKK", BKK: "VTBS", BLQ: "LIPE", BLR: "VOBL",
  BNA: "KBNA", BNE: "YBBN", BOG: "SKBO", BOM: "VABB",
  BOS: "KBOS", BRU: "EBBR", BSB: "SBBR", BUD: "LHBP",
  BWI: "KBWI", CAI: "HECA", CAN: "ZGGG", CBR: "YSCB",
  CCS: "SVMI", CCU: "VECC", CDG: "LFPG", CEB: "RPVM",
  CFU: "LGKR", CGH: "SBSP", CGK: "WIII", CGN: "EDDK",
  CHC: "NZCH", CJU: "RKPC", CKG: "ZUCK", CLE: "KCLE",
  CLT: "KCLT", CMB: "VCBI", CMH: "KCMH", CMN: "GMMN",
  CNF: "SBCF", CNS: "YBCS", CNX: "VTCC", COK: "VOCI",
  CPH: "EKCH", CPT: "FACT", CRK: "RPLC", CSX: "ZGHA",
  CTA: "LICC", CTS: "RJCC", CTU: "ZUUU", CUN: "MMUN",
  CUR: "TNCC", DAC: "VGHS", DAD: "VVDN", DCA: "KDCA",
  DEL: "VIDP", DEN: "KDEN", DFW: "KDFW", DLC: "ZYTL",
  DME: "UUDD", DMK: "VTBD", DMM: "OEDF", DOH: "OTHH",
  DPS: "WADD", DRW: "YPDN", DTW: "KDTW", DUB: "EIDW",
  DUR: "FALE", DUS: "EDDL", DXB: "OMDB", EDI: "EGPH",
  ESB: "LTAC", EVN: "UDYZ", EWR: "KEWR", EZE: "SAEZ",
  FAO: "LPFR", FCO: "LIRF", FLL: "KFLL", FOR: "SBFZ",
  FRA: "EDDF", FUK: "RJFF", GDL: "MMGL", GDN: "EPGD",
  GIG: "SBGL", GLA: "EGPF", GMP: "RKSS", GOI: "VOGO",
  GOT: "ESGG", GRU: "SBGR", GUA: "MGGT", GVA: "LSGG",
  GYD: "UBBB", HAJ: "EDDV", HAM: "EDDH", HAN: "VVNB",
  HAV: "MUHA", HBA: "YMHB", HEL: "EFHK", HER: "LGIR",
  HGH: "ZSHC", HKG: "VHHH", HKT: "VTSP", HND: "RJTT",
  HNL: "PHNL", HRB: "ZYHB", HRG: "HEGN", HYD: "VOHS",
  IAD: "KIAD", IAH: "KIAH", ICN: "RKSI", IND: "KIND",
  ISB: "OPIS", IST: "LTFM", ITM: "RJOO", JED: "OEJN",
  JFK: "KJFK", JNB: "FAOR", KBP: "UKBB", KEF: "BIKF",
  KHH: "RCKH", KHI: "OPKC", KIN: "MKJP", KIX: "RJBB",
  KMG: "ZPPP", KRK: "EPKK", KTM: "VNKT", KUL: "WMKK",
  KWI: "OKKK", LAS: "KLAS", LAX: "KLAX", LED: "ULLI",
  LEJ: "EDDP", LGA: "KLGA", LGW: "EGKK", LHE: "OPLA",
  LHR: "EGLL", LIM: "SPJC", LIN: "LIML", LIS: "LPPT",
  LJU: "LJLJ", LOS: "DNMM", LTN: "EGGW", LUX: "ELLX",
  LYS: "LFLL", MAA: "VOMM", MAD: "LEMD", MAN: "EGCC",
  MBJ: "MKJS", MCI: "KMCI", MCO: "KMCO", MCT: "OOMS",
  MDE: "SKRG", MDW: "KMDW", MEL: "YMML", MEX: "MMMX",
  MFM: "VMMC", MIA: "KMIA", MLE: "VRMM", MNL: "RPLL",
  MRS: "LFML", MRU: "FIMP", MSP: "KMSP", MSY: "KMSY",
  MTY: "MMMY", MUC: "EDDM", MVD: "SUMU", MXP: "LIMC",
  NAP: "LIRN", NAS: "MYNN", NBO: "HKJK", NCE: "LFMN",
  NGO: "RJGG", NKG: "ZSNJ", NQZ: "UACC", NRT: "RJAA",
  NUE: "EDDN", OAK: "KOAK", OKA: "ROAH", OOL: "YBCG",
  OPO: "LPPR", ORD: "KORD", ORY: "LFPO", OSL: "ENGM",
  OTP: "LROP", PDX: "KPDX", PEK: "ZBAA", PEN: "WMKP",
  PER: "YPPH", PHL: "KPHL", PHX: "KPHX", PIT: "KPIT",
  PKX: "ZBAD", PMI: "LEPA", PMO: "LICJ", PNH: "VDPP",
  PNQ: "VAPO", POA: "SBPA", POS: "TTPP", PRG: "LKPR",
  PTY: "MPTO", PUJ: "MDPC", PUS: "RKPK", PVG: "ZSPD",
  RAK: "GMMX", RDU: "KRDU", REC: "SBRF", RGN: "VYYY",
  RHO: "LGRP", RIX: "EVRA", RUH: "OERK", SAL: "MSLP",
  SAN: "KSAN", SAW: "LTFJ", SCL: "SCEL", SDQ: "MDSD",
  SEA: "KSEA", SEZ: "FSIA", SFO: "KSFO", SGN: "VVTS",
  SHA: "ZSSS", SHE: "ZYTX", SHJ: "OMSJ", SIN: "WSSS",
  SJC: "KSJC", SJO: "MROC", SJU: "TJSJ", SKG: "LGTS",
  SLC: "KSLC", SMF: "KSMF", SOF: "LBSF", SSA: "SBSV",
  SSH: "HESH", STL: "KSTL", STN: "EGSS", STR: "EDDS",
  SUB: "WARR", SVG: "ENZV", SVO: "UUEE", SVQ: "LEZL",
  SXM: "TNCM", SYD: "YSSY", SZX: "ZGSZ", TAO: "ZSQD",
  TAS: "UTTT", TBS: "UGTB", TFU: "ZUTF", TIJ: "MMTJ",
  TLL: "EETN", TLS: "LFBO", TLV: "LLBG", TNA: "ZSJN",
  TPA: "KTPA", TPE: "RCTP", TRD: "ENVA", TSA: "RCSS",
  TSN: "ZBTJ", TUN: "DTTA", UIO: "SEQM", URC: "ZWWW",
  VCE: "LIPZ", VCP: "SBKP", VIE: "LOWW", VKO: "UUWW",
  VLC: "LEVC", VNO: "EYVI", WAW: "EPWA", WLG: "NZWN",
  WUH: "ZHHH", XIY: "ZLXY", XMN: "ZSAM", YEG: "CYEG",
  YHZ: "CYHZ", YOW: "CYOW", YUL: "CYUL", YVR: "CYVR",
  YWG: "CYWG", YYC: "CYYC", YYZ: "CYYZ", ZAG: "LDZA",
  ZQN: "NZQN", ZRH: "LSZH",
};

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

  // An ICAO code goes straight to adsb.lol; an IATA code is translated first,
  // since the endpoint answers only to ICAO. The record that comes back is
  // then checked against the code that was asked for, so a wrong entry in the
  // table fails the search rather than flying the camera somewhere else.
  const icao = code.length === 4 ? code : IATA_TO_ICAO[code];
  const found = icao ? await fetchByIcao(icao) : null;
  const airport = found && (code.length === 4 || found.iata === code) ? found : null;

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(code, { at: Date.now(), airport });
  if (airport) rememberAirport(airport);

  return airport;
}
