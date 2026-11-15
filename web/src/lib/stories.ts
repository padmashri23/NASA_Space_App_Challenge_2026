// Ready-made stories for a quick tour. Every number in the text is read from the record at run time, so the words
// can never disagree with the calendar.
import { Calendar, MONTHS_LONG, fmt } from "./stats";

export type Story = {
  id: string;
  title: string;
  area: { preset?: string; country?: string };
  years: [number, number];
  pick: { year: number; month: number };
  tab: "calendar" | "anomalies";
  text: (cal: Calendar) => string;
};

const val = (cal: Calendar, y: number, m: number) => {
  const i = cal.years.indexOf(y);
  return i < 0 ? null : cal.val[i][m];
};

/** The most recent earlier year whose same month was at least this high. */
function busiestSince(cal: Calendar, y: number, m: number): string {
  const v = val(cal, y, m);
  if (v == null) return "";
  for (let yy = y - 1; yy >= cal.years[0]; yy--) {
    const o = val(cal, yy, m);
    if (o != null && o >= v) return `the most since ${yy}`;
  }
  return `the most on record here (since ${cal.years[0]})`;
}

const pct = (a: number | null, b: number | null) => (a != null && b ? Math.round((a / b - 1) * 100) : null);

export const STORIES: Story[] = [
  {
    id: "punjab",
    title: "Punjab's crop fires are fading",
    area: { preset: "Punjab plains, India" },
    years: [2003, 2026],
    pick: { year: 2021, month: 10 },
    tab: "calendar",
    text: (cal) => {
      const hi = val(cal, 2021, 10), lo = val(cal, 2025, 10), ch = pct(lo, hi);
      return `Farmers here burn rice stubble after the harvest, so fires peak every October and November. November 2021 had ${fmt(hi)} fire detections, ${busiestSince(cal, 2021, 10)}. November 2025 had ${fmt(lo)}${ch != null ? `, ${Math.abs(ch)}% fewer` : ""}. Click 2026 in the calendar to see this year so far.`;
    },
  },
  {
    id: "brazil",
    title: "Brazil's 2024 fire season",
    area: { country: "Brazil" },
    years: [2003, 2026],
    pick: { year: 2024, month: 8 },
    tab: "calendar",
    text: (cal) => {
      const s = val(cal, 2024, 8), a = val(cal, 2024, 7);
      return `Brazil burns most from August to October. September 2024 had ${fmt(s)} fire detections, ${busiestSince(cal, 2024, 8)}, and August 2024 had ${fmt(a)}, ${busiestSince(cal, 2024, 7)}.`;
    },
  },
  {
    id: "california",
    title: "Northern California, 2020",
    area: { preset: "Northern California, USA" },
    years: [2003, 2026],
    pick: { year: 2020, month: 8 },
    tab: "anomalies",
    text: (cal) => {
      const s = val(cal, 2020, 8), a = val(cal, 2020, 7), i = cal.years.indexOf(2020);
      const p = i >= 0 ? cal.pct[i][8] : null;
      return `This view shows each month as a percent of normal. September 2020 had ${fmt(s)} fire detections${p != null ? `, ${Math.round(p)}% of a normal September` : ""}, and August 2020 had ${fmt(a)}, ${busiestSince(cal, 2020, 7)}. Look how rare such months are in this area's record.`;
    },
  },
  {
    id: "topend",
    title: "Australia's Top End season",
    area: { preset: "Top End, Australia" },
    years: [2003, 2026],
    pick: { year: 2025, month: 8 },
    tab: "calendar",
    text: (cal) => {
      const p = cal.periods[0];
      return p
        ? `Savanna here burns every dry season. The main season runs ${p.from} – ${p.to} and holds about ${Math.round(p.share * 100)}% of a typical year's fires. Rangers light early fires on purpose to prevent bigger ones later; compare the early months with ${MONTHS_LONG[8]} to ${MONTHS_LONG[10]}.`
        : "Savanna here burns every dry season.";
    },
  },
];
