// Loads the static harmonized record (see pipeline/export_web.py) and sums it over an area.

export type SatMetrics = {
  n: number;
  median_abs_pct_error: number;
  median_abs_pct_error_global_factor: number;
  median_abs_pct_error_degraded_only: number;
  median_abs_pct_error_raw_viirs: number;
  share_within_25pct: number;
  r_log: number;
  raw_viirs_to_modis_ratio: number;
};

export type Validation = {
  reference_unit: string;
  calibration_years: Record<string, [number, number]>;
  switch_year: number;
  cell_1deg_month: Record<string, SatMetrics>;
  block_5deg_month: Record<string, SatMetrics>;
  global_month: Record<string, SatMetrics>;
  global_year: Record<string, SatMetrics>;
  totals: Record<string, { bias_pct: number; raw_viirs_per_modis: number; viirs_1km_cells_per_modis: number }>;
  global_factor: Record<string, number>;
  yearly: { sat: string; year: number; modis: number; viirs_equivalent: number; raw_viirs: number }[];
  record_end?: string;
};

export type Meta = {
  generated: string;
  origin_year: number;
  n_months: number;
  modis_first_month: number;
  switch_year: number;
  veq_scale: number;
  viirs_valid: number[];
  clim_years: [number, number];
  tiles: [number, number, number, number][];
  countries: [string, number, number][];
  overview: { bounds: [number, number, number, number]; annual_breaks: number[]; month_breaks: number[]; ramp: string[] };
  validation: Validation;
  sources: string[];
  overpass?: Record<string, [number, number][]>;
  /** The record's last month when it is still in progress: month index, last day covered, days in month. */
  partial?: { mon: number; day: number; days_in_month: number } | null;
};

export type Box = { w: number; s: number; e: number; n: number };
export type Area = { label: string; box: Box; cells?: Uint32Array };

export type Series = {
  modis: Float64Array;
  veq: Float64Array;
  dek: Float64Array;
  /** Hotspots in days 1..partial.day of the partial month, by year since origin (earlier years only). */
  mtd: Float64Array;
  nCells: number;
  /** The same record split by what was burning: 0 cropland, 1 forest, 2 grass/savanna/shrub, 3 other land. */
  byType: { modis: Float64Array; veq: Float64Array }[];
  /** VIIRS fire radiative power (MW) and detections per year since origin, 2012 on. */
  frp: Float64Array;
  frpN: Float64Array;
  hasTypes: boolean;
};

export const FIRE_TYPES = ["Cropland", "Forest", "Grass, savanna and shrub", "Other land"];

type Tile = {
  cell: Uint16Array;
  mon: Uint16Array;
  modis: Uint16Array;
  veq: Uint16Array;
  cell2: Uint16Array;
  dek: Uint16Array;
  cnt: Uint32Array;
  cell3: Uint16Array;
  yr3: Uint16Array;
  val3: Uint16Array;
  share: Uint8Array | null;
  cell5: Uint16Array;
  yr5: Uint16Array;
  frp5: Float32Array;
  cnt5: Uint32Array;
};

const BASE = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data`;
let metaPromise: Promise<Meta> | null = null;
const tileCache = new Map<string, Promise<Tile | null>>();
let countryCells: Promise<Uint32Array> | null = null;

async function fetchBin(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const buf = await res.arrayBuffer();
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return buf; // host already decoded it
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export function loadMeta(): Promise<Meta> {
  metaPromise ??= fetch(`${BASE}/meta.json`).then((r) => {
    if (!r.ok) throw new Error(`meta.json: ${r.status}`);
    return r.json() as Promise<Meta>;
  });
  return metaPromise;
}

function loadTile(meta: Meta, key: string): Promise<Tile | null> {
  let p = tileCache.get(key);
  if (!p) {
    const exists = meta.tiles.some(([ty, tx]) => `${ty}_${tx}` === key);
    p = !exists
      ? Promise.resolve(null)
      : fetchBin(`${BASE}/tiles/t_${key}.bin.gz`).then((buf) => {
          const dv = new DataView(buf);
          const n = dv.getUint32(4, true);
          const n2 = dv.getUint32(8, true);
          const magic = dv.getUint32(0, true);
          const v3 = magic === 0x33544142; // "BAT3"
          const v2 = v3 || magic === 0x32544142; // "BAT2"
          const n3 = v2 ? dv.getUint32(12, true) : 0;
          const n5 = v3 ? dv.getUint32(16, true) : 0;
          let o = v3 ? 20 : v2 ? 16 : 12;
          const u16 = (len: number) => {
            const a = new Uint16Array(buf, o, len);
            o += len * 2;
            return a;
          };
          const cell = u16(n), mon = u16(n), modis = u16(n), veq = u16(n);
          const cell2 = u16(n2), dek = u16(n2);
          const cnt = new Uint32Array(buf, o, n2);
          o += n2 * 4;
          const cell3 = u16(n3), yr3 = u16(n3), val3 = u16(n3);
          let share: Uint8Array | null = null;
          if (v3) {
            o += (4 - (o % 4)) % 4;
            share = new Uint8Array(buf, o, n * 3);
            o += n * 3;
            o += (4 - (o % 4)) % 4;
          }
          const cell5 = u16(n5), yr5 = u16(n5);
          const frp5 = new Float32Array(buf, o, n5);
          o += n5 * 4;
          const cnt5 = new Uint32Array(buf, o, n5);
          return { cell, mon, modis, veq, cell2, dek, cnt, cell3, yr3, val3, share, cell5, yr5, frp5, cnt5 };
        });
    tileCache.set(key, p);
  }
  return p;
}

/** Share of each 0.25 degree cell that lies inside the area, grouped by 10 degree tile. */
export function areaWeights(area: Area): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  const add = (iy: number, ix: number, w: number) => {
    if (w <= 0) return;
    const key = `${Math.floor(iy / 40)}_${Math.floor(ix / 40)}`;
    let a = out.get(key);
    if (!a) out.set(key, (a = new Float32Array(1600)));
    a[(iy % 40) * 40 + (ix % 40)] += w;
  };
  if (area.cells) {
    for (const c of area.cells) add(Math.floor(c / 1440), c % 1440, 1);
    return out;
  }
  const { w, s, e, n } = area.box;
  const y0 = Math.max(0, Math.floor((s + 90) * 4)), y1 = Math.min(719, Math.ceil((n + 90) * 4) - 1);
  const x0 = Math.max(0, Math.floor((w + 180) * 4)), x1 = Math.min(1439, Math.ceil((e + 180) * 4) - 1);
  for (let iy = y0; iy <= y1; iy++) {
    const lat = iy / 4 - 90;
    const fy = (Math.min(n, lat + 0.25) - Math.max(s, lat)) * 4;
    for (let ix = x0; ix <= x1; ix++) {
      const lon = ix / 4 - 180;
      add(iy, ix, fy * (Math.min(e, lon + 0.25) - Math.max(w, lon)) * 4);
    }
  }
  return out;
}

export async function aggregate(meta: Meta, area: Area): Promise<Series> {
  const weights = areaWeights(area);
  const modis = new Float64Array(meta.n_months);
  const veq = new Float64Array(meta.n_months);
  const dek = new Float64Array(36);
  const nYears = Math.ceil(meta.n_months / 12);
  const mtd = new Float64Array(nYears);
  const byType = [0, 1, 2, 3].map(() => ({ modis: new Float64Array(meta.n_months), veq: new Float64Array(meta.n_months) }));
  const frp = new Float64Array(nYears), frpN = new Float64Array(nYears);
  let hasTypes = false;
  let nCells = 0;
  for (const w of weights.values()) for (let i = 0; i < 1600; i++) nCells += w[i];
  await Promise.all(
    [...weights].map(async ([key, w]) => {
      const t = await loadTile(meta, key);
      if (!t) return;
      for (let i = 0; i < t.cell.length; i++) {
        const k = w[t.cell[i]];
        if (k) {
          const mo = k * t.modis[i], ve = (k * t.veq[i]) / meta.veq_scale, mn = t.mon[i];
          modis[mn] += mo;
          veq[mn] += ve;
          if (t.share) {
            hasTypes = true;
            const s0 = t.share[i * 3] / 255, s1 = t.share[i * 3 + 1] / 255, s2 = t.share[i * 3 + 2] / 255;
            const s3 = Math.max(0, 1 - s0 - s1 - s2);
            const sh = [s0, s1, s2, s3];
            for (let g = 0; g < 4; g++) {
              byType[g].modis[mn] += mo * sh[g];
              byType[g].veq[mn] += ve * sh[g];
            }
          }
        }
      }
      for (let i = 0; i < t.cell5.length; i++) {
        const k = w[t.cell5[i]];
        if (k) {
          frp[t.yr5[i]] += k * t.frp5[i];
          frpN[t.yr5[i]] += k * t.cnt5[i];
        }
      }
      for (let i = 0; i < t.cell2.length; i++) {
        const k = w[t.cell2[i]];
        if (k) dek[t.dek[i]] += k * t.cnt[i];
      }
      for (let i = 0; i < t.cell3.length; i++) {
        const k = w[t.cell3[i]];
        if (k) mtd[t.yr3[i]] += (k * t.val3[i]) / meta.veq_scale;
      }
    }),
  );
  return { modis, veq, dek, mtd, nCells, byType, frp, frpN, hasTypes };
}

/** Which sensor the harmonized record uses for a month, or null before the record starts. */
export function sourceOf(meta: Meta, mon: number): "M" | "V" | null {
  if (mon < meta.modis_first_month || mon >= meta.n_months) return null;
  const year = meta.origin_year + Math.floor(mon / 12);
  return year >= meta.switch_year && meta.viirs_valid[mon] ? "V" : "M";
}

export type CellValue = { iy: number; ix: number; v: number };

/** Harmonized count in every cell of the area for one month (tiles are already cached). */
export async function monthCells(meta: Meta, area: Area, mon: number): Promise<CellValue[]> {
  const src = sourceOf(meta, mon);
  const out: CellValue[] = [];
  for (const [key, w] of areaWeights(area)) {
    const [ty, tx] = key.split("_").map(Number);
    const vals = new Float32Array(1600);
    const t = src ? await loadTile(meta, key) : null;
    if (t) {
      for (let i = 0; i < t.cell.length; i++) {
        if (t.mon[i] === mon) vals[t.cell[i]] = src === "V" ? t.veq[i] / meta.veq_scale : t.modis[i];
      }
    }
    for (let c = 0; c < 1600; c++) {
      if (w[c] > 0) out.push({ iy: ty * 40 + Math.floor(c / 40), ix: tx * 40 + (c % 40), v: vals[c] });
    }
  }
  return out;
}

export async function loadCountry(meta: Meta, name: string): Promise<Area | null> {
  const row = meta.countries.find((c) => c[0] === name);
  if (!row) return null;
  countryCells ??= fetchBin(`${BASE}/countries.bin.gz`).then((b) => new Uint32Array(b));
  const cells = (await countryCells).slice(row[1], row[1] + row[2]);
  const xs: number[] = [];
  let s = 90, n = -90;
  for (const c of cells) {
    const lat = Math.floor(c / 1440) / 4 - 90;
    s = Math.min(s, lat);
    n = Math.max(n, lat + 0.25);
    xs.push((c % 1440) / 4 - 180);
  }
  // Longitude span without the far-flung few percent, so a country that crosses the date line still frames well.
  xs.sort((a, b) => a - b);
  const w = xs[Math.floor(xs.length * 0.01)], e = xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.99))] + 0.25;
  return { label: name, box: { w, s, e, n }, cells };
}
