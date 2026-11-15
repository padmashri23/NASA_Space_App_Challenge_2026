// "What's coming next": the area's usual fire season, read forward from the last day in the record.
import { Calendar, MONTHS_LONG, Period, quantile } from "./stats";

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const dekadDays = (d: number) => (d % 3 < 2 ? 10 : DAYS[Math.floor(d / 3)] - 20);

export function dekadOf(date: Date): { d: number; doneFrac: number } {
  const m = date.getUTCMonth(), day = date.getUTCDate();
  const k = Math.min(2, Math.floor((day - 1) / 10));
  const start = k * 10 + 1;
  const len = k < 2 ? 10 : DAYS[m] - 20;
  return { d: m * 3 + k, doneFrac: Math.min(1, (day - start + 1) / len) };
}

/** Share of a typical year's fires in the n days after a date, spreading each ten-day total evenly over its days. */
function shareNextDays(dek: Float64Array, total: number, from: Date, n: number): number {
  let s = 0;
  for (let i = 1; i <= n; i++) {
    const day = new Date(from.getTime() + i * 86400000);
    const { d } = dekadOf(day);
    s += dek[d] / dekadDays(d);
  }
  return total > 0 ? s / total : 0;
}

function inPeriod(p: Period, d: number) {
  return p.start <= p.end ? d >= p.start && d <= p.end : d >= p.start || d <= p.end;
}

export type Outlook = {
  asOf: Date;
  state: "in" | "before" | "after" | "none";
  period: Period | null;
  daysToStart: number | null;
  peakLabel: string | null;
  peakDek: number | null;
  peakPassed: boolean;
  seasonLeftShare: number | null;
  next30Share: number;
  next30Expected: number | null;
  normalYear: number;
};

export function outlook(cal: Calendar, dek: Float64Array, asOf: Date): Outlook | null {
  const total = dek.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const { d, doneFrac } = dekadOf(asOf);
  const complete = cal.totals.filter((t) => t.months === 12).map((t) => t.total).sort((a, b) => a - b);
  const normalYear = quantile(complete, 0.5);
  const next30Share = shareNextDays(dek, total, asOf, 30);
  const next30Expected = normalYear > 0 ? next30Share * normalYear : null;

  const main = cal.periods[0] ?? null;
  if (!main) {
    return { asOf, state: "none", period: null, daysToStart: null, peakLabel: null, peakDek: null, peakPassed: false, seasonLeftShare: null, next30Share, next30Expected, normalYear };
  }
  // peak dekad of the main season
  let peak = main.start, best = -1;
  for (let i = 0; i < 36; i++) {
    const dd = (main.start + i) % 36;
    if (!inPeriod(main, dd)) break;
    if (dek[dd] > best) { best = dek[dd]; peak = dd; }
  }
  const pm = Math.floor(peak / 3);
  const peakLabel = `${["early", "mid", "late"][peak % 3]} ${MONTHS_LONG[pm]}`;

  let seasonTotal = 0;
  for (let i = 0; i < 36; i++) { const dd = (main.start + i) % 36; if (!inPeriod(main, dd)) break; seasonTotal += dek[dd]; }

  if (inPeriod(main, d)) {
    let left = dek[d] * (1 - doneFrac);
    for (let i = 1; i < 36; i++) { const dd = (d + i) % 36; if (!inPeriod(main, dd)) break; left += dek[dd]; }
    const passed = (d - main.start + 36) % 36 > (peak - main.start + 36) % 36;
    return { asOf, state: "in", period: main, daysToStart: null, peakLabel, peakDek: peak, peakPassed: passed, seasonLeftShare: seasonTotal ? left / seasonTotal : null, next30Share, next30Expected, normalYear };
  }
  // days until the season's first dekad
  let days = Math.round(dekadDays(d) * (1 - doneFrac));
  for (let i = 1; i < 36; i++) {
    const dd = (d + i) % 36;
    if (dd === main.start) break;
    days += dekadDays(dd);
  }
  const sinceEnd = (d - main.end + 36) % 36;
  const state = sinceEnd <= 3 ? "after" : "before";
  return { asOf, state, period: main, daysToStart: days, peakLabel, peakDek: peak, peakPassed: false, seasonLeftShare: null, next30Share, next30Expected, normalYear };
}
