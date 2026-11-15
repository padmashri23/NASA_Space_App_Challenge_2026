// Downloads: the calendar as CSV and as a PNG that matches what is on screen.
import { Area, Meta, Series } from "./data";
import { Calendar, MONTHS, anomalyClass, classOf, fmt } from "./stats";

export const RAMP = ["#1F2327", "#4A1D16", "#7E2416", "#C0321E", "#EC6A1C", "#F5B52A", "#FFF0A8"];
const ANOM: Record<string, string> = {
  dm3: "#9CC3E8", dm2: "#2E66B0", dm1: "#24415F", d0: "#2A2F35", dp1: "#7A3A12", dp2: "#F07C1A", dp3: "#D7261E", dx: "#1A1D21",
};
const DARK_TEXT = new Set(["#F5B52A", "#FFF0A8", "#EC6A1C", "#9CC3E8", "#F07C1A"]);
const ANOM_KEYS: [string, string][] = [
  ["dm3", "25% or less"], ["dm2", "26–50%"], ["dm1", "51–80%"], ["d0", "81–124%"], ["dp1", "125–199%"], ["dp2", "200–399%"], ["dp3", "400%+"],
];
const INK = "#F4F4F0", PAPER = "#111315", GREEN = "#1A1D21", MUTED = "#BCC1C7";

/** "1–49", "50+"; a class holding a single value shows just that value. */
export function rangeLabel(breaks: number[], k: number): string {
  if (k === breaks.length - 1) return `${fmt(breaks[k])}+`;
  const hi = breaks[k + 1] - 1;
  return hi <= breaks[k] ? fmt(breaks[k]) : `${fmt(breaks[k])}–${fmt(hi)}`;
}

export function download(name: string, blob: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function slug(area: Area): string {
  return area.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "area";
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

export function calendarCsv(meta: Meta, cal: Calendar, area: Area, s: Series): string {
  const head = [
    "area", "west", "south", "east", "north", "year", "month", "hotspots_harmonized", "source_sensor",
    "modis_observed", "viirs_modis_equivalent", "median_same_month", "percent_of_median", "flag", "days_covered",
  ];
  const { w, s: south, e, n } = area.box;
  const lines = [head.join(",")];
  cal.years.forEach((year, i) => {
    for (let m = 0; m < 12; m++) {
      const v = cal.val[i][m];
      if (v == null) continue;
      const mon = (year - meta.origin_year) * 12 + m;
      const pct = cal.pct[i][m];
      const part = cal.partial && cal.partial.year === year && cal.partial.month === m ? cal.partial : null;
      lines.push([
        q(area.label), w.toFixed(3), south.toFixed(3), e.toFixed(3), n.toFixed(3), year, m + 1, v.toFixed(1),
        cal.src[i][m] === "V" ? "VIIRS (MODIS-equivalent)" : "MODIS",
        s.modis[mon].toFixed(1), meta.viirs_valid[mon] ? s.veq[mon].toFixed(1) : "",
        (part ? part.med : cal.med[m]).toFixed(1), pct == null ? "" : pct.toFixed(0),
        cal.mark[i][m] === "hi" ? "top tenth for month" : cal.mark[i][m] === "lo" ? "bottom tenth for month" : "",
        part ? `1-${part.day}` : `1-${new Date(Date.UTC(year, m + 1, 0)).getUTCDate()}`,
      ].join(","));
    }
  });
  return lines.join("\r\n") + "\r\n";
}

export function calendarPng(meta: Meta, cal: Calendar, area: Area, mode: "count" | "anomaly" = "count"): Promise<Blob> {
  const css = getComputedStyle(document.documentElement);
  const sans = css.getPropertyValue("--font-sans").trim() || "sans-serif";
  const mono = css.getPropertyValue("--font-mono").trim() || "monospace";
  const rows = [...cal.years].reverse();
  const W = 1320, top = 156, rh = 30, left = 84, cw = (W - left - 28) / 12;
  const H = top + (rows.length + 1) * rh + 150;
  const c = document.createElement("canvas");
  c.width = W * 2;
  c.height = H * 2;
  const g = c.getContext("2d")!;
  g.scale(2, 2);
  g.fillStyle = PAPER;
  g.fillRect(0, 0, W, H);
  g.fillStyle = GREEN;
  g.fillRect(0, 0, W, 64);
  g.fillStyle = INK;
  g.fillRect(0, 64, W, 4);
  g.fillStyle = INK;
  g.font = `900 26px ${sans}`;
  g.textBaseline = "middle";
  g.fillText("BURN ALMANAC", 28, 35);
  g.font = `700 15px ${sans}`;
  g.fillStyle = MUTED;
  g.textAlign = "right";
  g.fillText(
    mode === "count" ? "Fire detections each month" : "Each month as a percent of normal",
    W - 28, 33,
  );
  g.textAlign = "left";
  g.fillStyle = INK;
  g.font = `700 20px ${sans}`;
  g.fillText(area.label, 28, 92);
  g.font = `500 12px ${mono}`;
  const { w, s, e, n } = area.box;
  g.fillText(`${s.toFixed(2)} to ${n.toFixed(2)} N, ${w.toFixed(2)} to ${e.toFixed(2)} E · ${cal.years[0]}–${cal.years[cal.years.length - 1]}`, 28, 114);

  g.font = `700 11px ${sans}`;
  g.textAlign = "center";
  MONTHS.forEach((m, i) => g.fillText(m.toUpperCase(), left + i * cw + cw / 2, top - 10));

  const cell = (x: number, y: number, fill: string, light: boolean, text: string, mark: string | null) => {
    g.fillStyle = fill;
    g.fillRect(x + 2, y + 2, cw - 4, rh - 4);
    g.fillStyle = g.strokeStyle = light ? "#F4F4F0" : "#111111";
    if (mark === "hi") { g.fillRect(x + 3, y + rh - 8, cw - 6, 1.5); g.fillRect(x + 3, y + rh - 5, cw - 6, 1.5); }
    if (mark === "lo") { g.setLineDash([4, 3]); g.beginPath(); g.moveTo(x + 3, y + rh - 5); g.lineTo(x + cw - 3, y + rh - 5); g.stroke(); g.setLineDash([]); }
    g.font = `600 12px ${mono}`;
    g.textAlign = "right";
    g.fillText(text, x + cw - 9, y + rh / 2 - (mark ? 3 : 0));
  };
  const countCell = (x: number, y: number, v: number, mark: string | null) => {
    const k = classOf(v, cal.breaks);
    cell(x, y, RAMP[k], k <= 3, fmt(v), mark);
  };

  g.textAlign = "left";
  g.fillStyle = INK;
  g.font = `700 12px ${sans}`;
  g.fillText("NORMAL", 28, top + rh / 2);
  cal.med.forEach((v, m) => countCell(left + m * cw, top, v, null));
  g.fillStyle = INK;
  g.fillRect(28, top + rh + 1, W - 56, 1);
  rows.forEach((year, r) => {
    const i = cal.years.indexOf(year), y = top + (r + 1) * rh + 4;
    g.fillStyle = INK;
    g.textAlign = "left";
    g.font = `600 12px ${mono}`;
    g.fillText(String(year) + (year >= meta.switch_year ? " V" : ""), 28, y + rh / 2);
    for (let m = 0; m < 12; m++) {
      const v = cal.val[i][m];
      if (v == null) continue;
      if (mode === "count") countCell(left + m * cw, y, v, cal.mark[i][m]);
      else {
        const pct = cal.pct[i][m], k = anomalyClass(pct);
        cell(left + m * cw, y, ANOM[k], !DARK_TEXT.has(ANOM[k]), pct == null ? "–" : `${Math.round(pct)}%`, cal.mark[i][m]);
      }
    }
  });

  let y = top + (rows.length + 1) * rh + 30;
  let x = 28;
  const keys: [string, string][] =
    mode === "count"
      ? [["0", RAMP[0]] as [string, string]].concat(
          cal.breaks.map((b, k): [string, string] => [rangeLabel(cal.breaks, k), RAMP[k + 1]]),
        )
      : ANOM_KEYS.map(([k, label]): [string, string] => [label, ANOM[k]]);
  g.font = `500 11px ${mono}`;
  g.textAlign = "left";
  keys.forEach(([label, colour]) => {
    g.fillStyle = colour;
    g.fillRect(x, y - 8, 22, 16);
    g.fillStyle = MUTED;
    g.fillText(label, x + 28, y);
    x += 40 + g.measureText(label).width + 14;
  });
  y += 30;
  g.font = `500 11px ${sans}`;
  g.fillStyle = MUTED;
  const notes = [
    `${mode === "count" ? "Normal row and cells: fire detections per month." : "Normal row: fire detections per month (median). Cells: percent of normal for that month."} Double line: among the highest 10% for that month. Dashed line: among the lowest 10%.`,
    `V: newer VIIRS satellites, converted to match the older MODIS record (from ${meta.switch_year}). A fire detection is a satellite pixel with active burning, not a separate fire and not burned area.`,
    (cal.partial ? `${MONTHS[cal.partial.month]} ${cal.partial.year} covers days 1–${cal.partial.day} only and is compared with the same days in earlier years. ` : "") +
      `Source: NASA FIRMS (MODIS Collection 6.1; VIIRS 375 m Suomi-NPP and NOAA-20), harmonized by Burn Almanac. Data version ${meta.generated}.`,
  ];
  notes.forEach((t, i) => g.fillText(t, 28, y + i * 18));
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("PNG export failed"))), "image/png"));
}
