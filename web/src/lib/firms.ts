// Calls to the NASA FIRMS area API, shared by the server routes (app/api) and, on the static GitHub Pages build,
// by the browser directly (FIRMS allows cross-origin requests).

const API = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const FAMILIES = [
  { sp: "MODIS_SP", nrt: "MODIS_NRT" },
  { sp: "VIIRS_SNPP_SP", nrt: "VIIRS_SNPP_NRT" },
  { sp: "VIIRS_NOAA20_SP", nrt: "VIIRS_NOAA20_NRT" },
];
const CHUNK_DAYS = 5;
const MAX_ROWS = 60000;
export const MAX_LIST_AREA = 150;
export const MAX_LIVE_AREA = 2500;
const SAT: Record<string, string> = { N: "Suomi-NPP", N20: "NOAA-20", "1": "NOAA-20", N21: "NOAA-21", T: "Terra", A: "Aqua", Terra: "Terra", Aqua: "Aqua" };

export type Row = { lat: number; lon: number; date: string; time: string; sat: string; inst: string; conf: string; frp: number; dn: string; product: string };
export type Live = { start: string; end: string; source: string; days: { date: string; raw: number; eq: number }[]; total: number; raw: number };
export class FirmsError extends Error {
  constructor(public code: "nokey" | "toolarge" | "badrequest" | "upstream") { super(code); }
}

/** Screened rows from one FIRMS CSV (presumed vegetation fires, no low-confidence detections). */
function parse(csv: string, product: string): Row[] | null {
  const lines = csv.trim().split(/\r?\n/);
  const head = lines[0]?.split(",") ?? [];
  const col = (name: string) => head.indexOf(name);
  const iLat = col("latitude"), iLon = col("longitude");
  if (iLat < 0 || iLon < 0) return null; // an error message, not data
  const iDate = col("acq_date"), iTime = col("acq_time"), iSat = col("satellite"), iInst = col("instrument");
  const iConf = col("confidence"), iFrp = col("frp"), iDn = col("daynight"), iType = col("type");
  const modis = product.startsWith("MODIS");
  const out: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(",");
    if (iType >= 0 && c[iType] !== "0") continue;
    const conf = c[iConf] ?? "";
    if (modis ? Number(conf) < 30 : conf.toLowerCase().startsWith("l")) continue;
    out.push({
      lat: Number(c[iLat]), lon: Number(c[iLon]), date: c[iDate], time: (c[iTime] ?? "").padStart(4, "0"),
      sat: SAT[c[iSat]] ?? c[iSat], inst: iInst >= 0 ? c[iInst] : modis ? "MODIS" : "VIIRS",
      conf: modis ? conf : conf.toLowerCase().startsWith("h") ? "high" : "nominal", frp: Number(c[iFrp]) || 0, dn: c[iDn] ?? "", product,
    });
  }
  return out;
}

async function chunk(key: string, product: string, box: string, days: number, date: string): Promise<Row[] | null> {
  const res = await fetch(`${API}/${key}/${product}/${box}/${days}/${date}`, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) return null;
  return parse(await res.text(), product);
}

/** Every screened detection in a box for one month: standard processing where FIRMS has it, near-real-time otherwise. */
export async function getHotspots(key: string | undefined, w: number, s: number, e: number, n: number, year: number, month: number) {
  if (!key) throw new FirmsError("nokey");
  if (![w, s, e, n, year, month].every(Number.isFinite) || n <= s || e <= w || month < 1 || month > 12 || year < 2000 || year > 2100)
    throw new FirmsError("badrequest");
  if ((e - w) * (n - s) > MAX_LIST_AREA) throw new FirmsError("toolarge");
  const box = [w, s, e, n].map((v) => v.toFixed(4)).join(",");
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const starts: [string, number][] = [];
  for (let d = 1; d <= daysInMonth; d += CHUNK_DAYS)
    starts.push([`${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`, Math.min(CHUNK_DAYS, daysInMonth - d + 1)]);
  try {
    const parts = await Promise.all(
      FAMILIES.flatMap((f) =>
        starts.map(async ([date, days]) => {
          const sp = await chunk(key, f.sp, box, days, date);
          if (sp && sp.length) return sp;
          return (await chunk(key, f.nrt, box, days, date)) ?? sp ?? [];
        }),
      ),
    );
    const rows = parts.flat().sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
  } catch {
    throw new FirmsError("upstream");
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const liveCache = new Map<string, { at: number; body: Live }>();

/** Last 7 complete days of NOAA-20 near-real-time detections, in the calendar's MODIS-equivalent units. */
export async function getLive(key: string | undefined, w: number, s: number, e: number, n: number, factors: { D: number; N: number }): Promise<Live> {
  if (!key) throw new FirmsError("nokey");
  if (![w, s, e, n].every(Number.isFinite) || n <= s || e <= w) throw new FirmsError("badrequest");
  if ((e - w) * (n - s) > MAX_LIVE_AREA) throw new FirmsError("toolarge");
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1));
  const start = new Date(end.getTime() - 6 * 86400000);
  const box = [w, s, e, n].map((v) => v.toFixed(3)).join(",");
  const id = `${box}|${iso(end)}`;
  const hit = liveCache.get(id);
  if (hit && Date.now() - hit.at < 3600000) return hit.body;
  try {
    const chunks: [Date, number][] = [[start, 5], [new Date(start.getTime() + 5 * 86400000), 2]];
    const texts = await Promise.all(
      chunks.map(async ([d, days]) => {
        const res = await fetch(`${API}/${key}/VIIRS_NOAA20_NRT/${box}/${days}/${iso(d)}`, { signal: AbortSignal.timeout(60000) });
        const t = await res.text();
        if (!res.ok || !t.startsWith("latitude")) throw new Error(t.slice(0, 100));
        return t;
      }),
    );
    const days: Record<string, { raw: number; D: Set<string>; N: Set<string> }> = {};
    for (let i = 0; i < 7; i++) days[iso(new Date(start.getTime() + i * 86400000))] = { raw: 0, D: new Set(), N: new Set() };
    for (const t of texts) {
      const lines = t.trim().split(/\r?\n/);
      const h = lines[0].split(",");
      const iLat = h.indexOf("latitude"), iLon = h.indexOf("longitude"), iDate = h.indexOf("acq_date"), iConf = h.indexOf("confidence"), iDn = h.indexOf("daynight");
      for (let k = 1; k < lines.length; k++) {
        const c = lines[k].split(",");
        if ((c[iConf] ?? "").toLowerCase().startsWith("l")) continue;
        const day = days[c[iDate]];
        if (!day) continue;
        day.raw++;
        // collapse 375 m pixels to the ~1 km cells used by the harmonization
        day[c[iDn] === "N" ? "N" : "D"].add(`${Math.floor(Number(c[iLat]) * 100)},${Math.floor(Number(c[iLon]) * 100)}`);
      }
    }
    const out = Object.entries(days).map(([date, v]) => ({ date, raw: v.raw, eq: v.D.size * factors.D + v.N.size * factors.N }));
    const body: Live = { start: iso(start), end: iso(end), source: "VIIRS_NOAA20_NRT", days: out, total: out.reduce((a, d) => a + d.eq, 0), raw: out.reduce((a, d) => a + d.raw, 0) };
    liveCache.set(id, { at: Date.now(), body });
    return body;
  } catch {
    throw new FirmsError("upstream");
  }
}

// ---- browser side ----
export const STATIC = process.env.NEXT_PUBLIC_STATIC === "1";
const KEY_STORE = "burn-almanac-firms-key";

/** The key the browser uses on the static site: the visitor's own if they saved one, else the site's public key. */
export function browserKey(): string | undefined {
  try {
    const own = window.localStorage.getItem(KEY_STORE);
    if (own) return own;
  } catch { /* storage unavailable */ }
  return process.env.NEXT_PUBLIC_FIRMS_KEY || undefined;
}

export function saveBrowserKey(key: string) {
  try {
    if (key) window.localStorage.setItem(KEY_STORE, key.trim());
    else window.localStorage.removeItem(KEY_STORE);
  } catch { /* storage unavailable */ }
}
