// Everything the board shows is derived here from one harmonized monthly series.
import { Meta, Series, sourceOf } from "./data";

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export type Mark = "hi" | "lo" | null;
export type Verdict = "Well above normal" | "Above normal" | "Near normal" | "Below normal" | "Well below normal";
export type Period = { start: number; end: number; share: number; from: string; to: string; days: number; left: number; width: number };

export type Calendar = {
  years: number[];
  val: (number | null)[][];
  src: ("M" | "V" | null)[][];
  mark: Mark[][];
  pct: (number | null)[][];
  med: number[];
  p10: number[];
  p90: number[];
  baseN: number[];
  breaks: number[];
  totals: { year: number; total: number; months: number }[];
  grand: number;
  base: number[][];
  cur: null | { year: number; month: number };
  /** Set when the latest month is still in progress. */
  partial: null | { year: number; month: number; day: number; daysInMonth: number; base: number[]; med: number };
  top: { year: number; month: number; value: number }[];
  trend: null | { slopePct: number; p: number; from: number; to: number };
  periods: Period[];
  overlap: { year: number; month: number; modis: number; veq: number }[];
  overlapStats: null | { biasPct: number; medianAbsPct: number; r: number; n: number };
};

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const p = (sorted.length - 1) * q;
  const lo = Math.floor(p);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (p - lo);
}

function nice(x: number): number {
  if (x <= 1) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

export function anomalyClass(pct: number | null): string {
  if (pct == null) return "dx";
  if (pct <= 25) return "dm3";
  if (pct <= 50) return "dm2";
  if (pct <= 80) return "dm1";
  if (pct < 125) return "d0";
  if (pct < 200) return "dp1";
  if (pct < 400) return "dp2";
  return "dp3";
}

export function classOf(v: number | null, breaks: number[]): number {
  if (v == null || Math.round(v) < 1) return 0;
  let k = 0;
  for (const b of breaks) if (v >= b) k++;
  return Math.max(1, k);
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function criticalPeriods(dek: Float64Array): Period[] {
  const total = dek.reduce((a, b) => a + b, 0);
  const peak = Math.max(...dek);
  if (total <= 0) return [];
  const on = Array.from(dek, (v) => v >= 0.25 * peak);
  if (on.every(Boolean)) return [];
  const out: Period[] = [];
  const first = on.findIndex((v, i) => v && !on[(i + 35) % 36]);
  for (let step = 0, i = first; step < 36; step++, i = (i + 1) % 36) {
    if (!on[i] || on[(i + 35) % 36]) continue;
    let end = i, sum = 0;
    for (let j = i; on[j % 36] && j < i + 36; j++) {
      end = j % 36;
      sum += dek[end];
    }
    const m0 = Math.floor(i / 3), m1 = Math.floor(end / 3);
    const d0 = [1, 11, 21][i % 3], d1 = [10, 20, DAYS[m1]][end % 3];
    const left = ((m0 + (d0 - 1) / DAYS[m0]) / 12) * 100;
    const right = ((m1 + d1 / DAYS[m1]) / 12) * 100;
    const len = ((end - i + 36) % 36) + 1;
    out.push({
      start: i, end, share: sum / total, from: `${d0} ${MONTHS[m0]}`, to: `${d1} ${MONTHS[m1]}`,
      days: Math.round(len * 10.14), left, width: right >= left ? right - left : 100 - left + right,
    });
  }
  return out.filter((p) => p.share >= 0.08).sort((a, b) => b.share - a.share).slice(0, 2);
}

function mannKendall(y: number[]): number {
  const n = y.length;
  let s = 0;
  for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) s += Math.sign(y[j] - y[i]);
  const v = (n * (n - 1) * (2 * n + 5)) / 18;
  const z = s === 0 ? 0 : (s - Math.sign(s)) / Math.sqrt(v);
  // two-sided p from the normal distribution
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return Math.min(1, 2 * tail);
}

/** typeFiltered: the series is one fire type. A month in progress then shows its count without a comparison,
 *  because the same-days baseline exists for all fires only. */
export function buildCalendar(meta: Meta, s: Series, fromYear: number, toYear: number, typeFiltered = false): Calendar {
  const lastMon = meta.n_months - 1;
  const lastYear = meta.origin_year + Math.floor(lastMon / 12);
  const years: number[] = [];
  for (let y = Math.max(fromYear, meta.origin_year); y <= Math.min(toYear, lastYear); y++) years.push(y);

  const val = years.map((y) =>
    MONTHS.map((_, m) => {
      const mon = (y - meta.origin_year) * 12 + m;
      const src = sourceOf(meta, mon);
      return src === "V" ? s.veq[mon] : src === "M" ? s.modis[mon] : null;
    }),
  );
  const src = years.map((y) => MONTHS.map((_, m) => sourceOf(meta, (y - meta.origin_year) * 12 + m)));

  const curYear = years[years.length - 1];
  const curRow = val[val.length - 1] ?? [];
  let curMonth = -1;
  for (let m = 11; m >= 0; m--) if (curRow[m] != null) { curMonth = m; break; }

  // Baseline for a calendar month: every year in the period except the latest one.
  const base = MONTHS.map((_, m) =>
    years.slice(0, -1).map((_, i) => val[i][m]).filter((v): v is number => v != null).sort((a, b) => a - b),
  );
  const med = base.map((b) => quantile(b, 0.5));
  const p10 = base.map((b) => quantile(b, 0.1));
  const p90 = base.map((b) => quantile(b, 0.9));
  const peakMed = Math.max(1, ...med);

  // A month still in progress is compared with the same days of that month in earlier years.
  let partial: Calendar["partial"] = null;
  if (meta.partial && curMonth >= 0 && (curYear - meta.origin_year) * 12 + curMonth === meta.partial.mon) {
    const pb = typeFiltered ? [] : years.slice(0, -1).map((y) => s.mtd[y - meta.origin_year]).filter((v) => v != null).sort((a, b) => a - b);
    partial = { year: curYear, month: curMonth, day: meta.partial.day, daysInMonth: meta.partial.days_in_month, base: pb, med: quantile(pb, 0.5) };
  }
  const baseFor = (i: number, m: number) => (partial && i === years.length - 1 && m === partial.month ? partial.base : base[m]);
  const medFor = (i: number, m: number) => (partial && i === years.length - 1 && m === partial.month ? partial.med : med[m]);

  const pct = val.map((row, i) => row.map((v, m) => (v == null || medFor(i, m) < 1 ? null : (v / medFor(i, m)) * 100)));
  const mark = val.map((row, i) =>
    row.map((v, m): Mark => {
      const b = baseFor(i, m);
      if (v == null || b.length < 5) return null;
      const inSeason = med[m] >= 0.05 * peakMed;
      const lo = quantile(b, 0.1), hi = quantile(b, 0.9);
      if (v > hi && (inSeason || v >= 0.05 * peakMed)) return "hi";
      if (v < lo && inSeason) return "lo";
      return null;
    }),
  );

  const flat = val.flat().filter((v): v is number => v != null);
  const max = Math.max(1, ...flat);
  const top6 = nice(max * 0.45);
  const breaks = [1, top6 / 81, top6 / 27, top6 / 9, top6 / 3, top6].map((b, i) => (i ? nice(b) : 1));
  for (let i = 1; i < breaks.length; i++) if (breaks[i] <= breaks[i - 1]) breaks[i] = breaks[i - 1] * 2;

  const totals = years.map((year, i) => ({
    year,
    total: val[i].reduce<number>((a, v) => a + (v ?? 0), 0),
    months: val[i].filter((v) => v != null).length,
  }));
  const grand = totals.reduce((a, t) => a + t.total, 0);

  const cur = curMonth >= 0 ? { year: curYear, month: curMonth } : null;

  const top = years
    .flatMap((year, i) => val[i].map((v, month) => ({ year, month, value: v ?? -1 })))
    .filter((t) => t.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);

  const complete = totals.filter((t) => t.months === 12);
  let trend: Calendar["trend"] = null;
  if (complete.length >= 8) {
    const slopes: number[] = [];
    for (let i = 0; i < complete.length - 1; i++)
      for (let j = i + 1; j < complete.length; j++)
        slopes.push((complete[j].total - complete[i].total) / (complete[j].year - complete[i].year));
    slopes.sort((a, b) => a - b);
    const mid = quantile(complete.map((t) => t.total).sort((a, b) => a - b), 0.5);
    if (mid > 0)
      trend = {
        slopePct: (quantile(slopes, 0.5) / mid) * 100, p: mannKendall(complete.map((t) => t.total)),
        from: complete[0].year, to: complete[complete.length - 1].year,
      };
  }

  // Seam check: months where MODIS and the VIIRS equivalent both exist, before the switch.
  const overlap: Calendar["overlap"] = [];
  for (let mon = 0; mon < meta.n_months; mon++) {
    const year = meta.origin_year + Math.floor(mon / 12);
    if (meta.viirs_valid[mon] && year < meta.switch_year) overlap.push({ year, month: mon % 12, modis: s.modis[mon], veq: s.veq[mon] });
  }
  let overlapStats: Calendar["overlapStats"] = null;
  const sumM = overlap.reduce((a, o) => a + o.modis, 0), sumV = overlap.reduce((a, o) => a + o.veq, 0);
  if (sumM >= 50) {
    const big = overlap.filter((o) => o.modis >= Math.max(5, (sumM / overlap.length) * 0.25));
    const errs = big.map((o) => Math.abs(o.veq - o.modis) / o.modis).sort((a, b) => a - b);
    const lx = overlap.map((o) => Math.log1p(o.modis)), ly = overlap.map((o) => Math.log1p(o.veq));
    const mx = lx.reduce((a, b) => a + b, 0) / lx.length, my = ly.reduce((a, b) => a + b, 0) / ly.length;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < lx.length; i++) {
      sxy += (lx[i] - mx) * (ly[i] - my);
      sxx += (lx[i] - mx) ** 2;
      syy += (ly[i] - my) ** 2;
    }
    overlapStats = {
      biasPct: (sumV / sumM - 1) * 100, medianAbsPct: quantile(errs, 0.5) * 100,
      r: sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0, n: big.length,
    };
  }

  return {
    years, val, src, mark, pct, med, p10, p90, baseN: base.map((b) => b.length), base, partial, breaks, totals, grand, cur, top, trend,
    periods: criticalPeriods(s.dek), overlap, overlapStats,
  };
}

export type Assessment = {
  year: number; month: number; value: number; median: number; pct: number | null;
  rank: number; of: number; verdict: Verdict; history: number[]; latest: boolean;
  /** Last day covered when the month is still in progress. */
  toDay: number | null;
};

/** How one month compares with the same calendar month in the other years of the period. */
export function assess(cal: Calendar, year: number, month: number): Assessment | null {
  const i = cal.years.indexOf(year);
  const value = i < 0 ? null : cal.val[i][month];
  const b = cal.base[month];
  if (value == null || b.length < 3) return null;
  const latest = i === cal.years.length - 1;
  const p = latest && cal.partial && cal.partial.month === month ? cal.partial : null;
  if (p) {
    const pb = p.base;
    if (pb.length < 3) return null;
    const below = pb.filter((v) => v < value).length, above = pb.filter((v) => v > value).length, r = below / pb.length;
    const verdict: Verdict =
      r >= 0.9 ? "Well above normal" : r >= 0.67 ? "Above normal" : r > 0.33 ? "Near normal" : r > 0.1 ? "Below normal" : "Well below normal";
    return {
      year, month, value, median: p.med, pct: p.med >= 1 ? (value / p.med) * 100 : null,
      rank: above + 1, of: pb.length + 1, verdict, history: pb, latest, toDay: p.day,
    };
  }
  const below = b.filter((v) => v < value).length;
  const above = b.filter((v) => v > value).length;
  const r = below / b.length;
  const verdict: Verdict =
    r >= 0.9 ? "Well above normal" : r >= 0.67 ? "Above normal" : r > 0.33 ? "Near normal" : r > 0.1 ? "Below normal" : "Well below normal";
  return {
    year, month, value, median: cal.med[month], pct: cal.med[month] >= 1 ? (value / cal.med[month]) * 100 : null,
    rank: above + 1, of: b.length + (latest ? 1 : 0), verdict, history: b, latest, toDay: null,
  };
}

export const fmt = (v: number | null | undefined): string => (v == null ? "" : Math.round(v).toLocaleString("en-US"));

export function compact(v: number | null): string {
  if (v == null) return "";
  const r = Math.round(v);
  if (r < 1000) return String(r);
  if (r < 10000) return (r / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return Math.round(r / 1000) + "k";
}
