"use client";

import { Area, Meta, Series, sourceOf } from "@/lib/data";
import { T, useT } from "@/lib/i18n";
import { Assessment, Calendar, Period, Verdict, quantile } from "@/lib/stats";
import type { RackMode } from "./Rack";

const STEPS: [Verdict, string][] = [
  ["Well below normal", "s-wb"],
  ["Below normal", "s-b"],
  ["Near normal", "s-n"],
  ["Above normal", "s-a"],
  ["Well above normal", "s-wa"],
];

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** First and last day of a season, in the reader's language. */
export function periodDates(t: T, p: Period): [string, string] {
  const m0 = Math.floor(p.start / 3), m1 = Math.floor(p.end / 3);
  const d0 = [1, 11, 21][p.start % 3], d1 = [10, 20, DAYS[m1]][p.end % 3];
  return [`${d0} ${t.monthShort(m0)}`, `${d1} ${t.monthShort(m1)}`];
}

/** Where this month sits among the same month in other years: one tick per year. */
function Spread({ a }: { a: Assessment }) {
  const t = useT();
  const max = Math.max(a.value, ...a.history, 1);
  const x = (v: number) => 8 + (v / max) * 504;
  const p10 = quantile(a.history, 0.1), p90 = quantile(a.history, 0.9);
  return (
    <svg className="spread" viewBox="0 0 520 58" role="img"
      aria-label={`${t.month(a.month)}: ${t.num(a.history[0])} – ${t.num(a.history[a.history.length - 1])}; ${t("st.normal")} ${t.num(a.median)}; ${t.num(a.value)}.`}>
      <rect x={x(p10)} y="20" width={Math.max(1, x(p90) - x(p10))} height="14" className="band" />
      <line x1="8" x2="512" y1="27" y2="27" className="axis" />
      {a.history.map((v, i) => <line key={i} x1={x(v)} x2={x(v)} y1="20" y2="34" className="tick" />)}
      <line x1={x(a.median)} x2={x(a.median)} y1="13" y2="41" className="medtick" />
      <text x={Math.min(Math.max(x(a.median), 30), 490)} y="55" textAnchor="middle">{t("st.normal")}</text>
      <path d={`M${x(a.value)} 16 l8 11 l-8 11 l-8 -11 z`} className="here" />
      <text x="8" y="9">0</text>
      <text x="512" y="9" textAnchor="end">{t.num(max)}</text>
    </svg>
  );
}

type StatusProps = { cal: Calendar; a: Assessment | null; area: Area; recordEnd: { year: number; month: number } | null };

/** The sign: one verdict in big plain words, then the numbers behind it. */
export function Status({ cal, a, area, recordEnd }: StatusProps) {
  const t = useT();
  if (!a) {
    return (
      <section className="status" aria-live="polite">
        <div>
          <p className="where">{area.label}</p>
          <p className="say">{t("st.short")}</p>
        </div>
      </section>
    );
  }
  const today = new Date();
  const stale = !!recordEnd && a.year === recordEnd.year && a.month === recordEnd.month && !a.toDay &&
    (today.getFullYear() - a.year) * 12 + today.getMonth() - a.month > 1;
  const month = t.month(a.month);
  const span = a.toDay ? `1–${a.toDay} ${month} ${a.year}` : `${month} ${a.year}`;
  const tone = a.verdict.includes("above") ? "up" : a.verdict.includes("elow") ? "down" : "mid";
  return (
    <section className="status" aria-live="polite" aria-label={t(`v.${a.verdict}`)}>
      <div className="sayit">
        <p className="where">
          <span>{area.label}, {span}</span>
          <span className="tag">{t(a.toDay ? "tag.progress" : a.latest ? "tag.latest" : "tag.picked")}</span>
        </p>
        <p className={`verdict ${tone}`}>{t(`v.${a.verdict}`)}</p>
        <p className="line">
          {t("st.count", { n: t.num(a.value) })}{" "}
          {a.pct != null &&
            (a.toDay
              ? t("st.pctDays", { pct: Math.round(a.pct), days: a.toDay, med: t.num(a.median) })
              : t("st.pctMonth", { pct: Math.round(a.pct), month, med: t.num(a.median) }))}
        </p>
        <p className="sub">
          {a.toDay
            ? t("st.rankDays", { rank: a.rank, of: a.of, day: a.toDay, month })
            : t("st.rank", { rank: a.rank, of: a.of, month, from: cal.years[0] })}
          {stale && ` ${t("st.stale")}`}
        </p>
      </div>
      <div className="scalebox">
        <ol className="scale" aria-label={t(`v.${a.verdict}`)}>
          {STEPS.map(([v, cls]) => (
            <li key={v} className={`${cls}${v === a.verdict ? " on" : ""}`} aria-current={v === a.verdict ? "true" : undefined}>{t(`s.${v}`)}</li>
          ))}
        </ol>
        <Spread a={a} />
        <p className="note">{t("st.note")}</p>
      </div>
    </section>
  );
}

function Season({ cal, dek, climYears }: { cal: Calendar; dek: Float64Array; climYears: [number, number] }) {
  const t = useT();
  const peak = Math.max(...dek, 1);
  const total = dek.reduce((a, b) => a + b, 0);
  const inPeriod = (d: number) => cal.periods.some((p) => (p.start <= p.end ? d >= p.start && d <= p.end : d >= p.start || d <= p.end));
  return (
    <section className="panel">
      <h2>{t("p.season")}</h2>
      <p className="hint">{t("p.seasonHint", { from: climYears[0], to: climYears[1] })}</p>
      <div className="season" aria-hidden="true">
        <div className="dekads">
          {Array.from(dek, (v, d) => (
            <i key={d} className={inPeriod(d) ? "on" : undefined} style={{ height: `${Math.max(2, (v / peak) * 100)}%` }} />
          ))}
        </div>
        <div className="monthnames">{Array.from({ length: 12 }, (_, m) => <span key={m}>{t.monthShort(m)}</span>)}</div>
      </div>
      {total <= 0 ? (
        <p className="big-line">{t("p.noSeason")}</p>
      ) : cal.periods.length === 0 ? (
        <p className="big-line">{t("p.spread")}</p>
      ) : (
        cal.periods.map((p, i) => {
          const [from, to] = periodDates(t, p);
          return (
            <p className="big-line" key={p.start}>
              {t(i === 0 ? "p.main" : "p.second")}: <b>{from} – {to}</b>
              <span className="hint"> {t("p.about", { days: p.days, pct: Math.round(p.share * 100) })}</span>
            </p>
          );
        })
      )}
    </section>
  );
}

const TYPE_CLASS = ["t-crop", "t-forest", "t-grass", "t-other"];

/** What was burning over the period: share of harmonized detections on each land-cover type. */
function WhatBurns({ cal, series, meta }: { cal: Calendar; series: Series; meta: Meta }) {
  const t = useT();
  const tot = [0, 0, 0, 0];
  for (const y of cal.years) {
    for (let m = 0; m < 12; m++) {
      const mon = (y - meta.origin_year) * 12 + m, src = sourceOf(meta, mon);
      if (!src) continue;
      for (let g = 0; g < 4; g++) tot[g] += src === "V" ? series.byType[g].veq[mon] : series.byType[g].modis[mon];
    }
  }
  const sum = tot.reduce((a, b) => a + b, 0);
  if (sum <= 0) return null;
  const share = tot.map((v) => v / sum);
  const top = share.indexOf(Math.max(...share));
  const name = (g: number) => t(`type.${g}`);
  return (
    <section className="panel">
      <h2>{t("p.burns")}</h2>
      <p className="big-line">{t("p.mostOn", { type: name(top).toLowerCase(), pct: Math.round(share[top] * 100) })}</p>
      <div className="stack" role="img" aria-label={[0, 1, 2, 3].map((g) => `${name(g)} ${Math.round(share[g] * 100)}%`).join(", ")}>
        {share.map((s, g) => (s > 0.004 ? <i key={g} className={TYPE_CLASS[g]} style={{ width: `${s * 100}%` }} /> : null))}
      </div>
      <ul className="typekey">
        {[0, 1, 2, 3].map((g) => <li key={g}><i className={TYPE_CLASS[g]} />{name(g)} <b>{Math.round(share[g] * 100)}%</b></li>)}
      </ul>
      <p className="hint">{t("p.burnsHint", { from: cal.years[0], to: cal.years[cal.years.length - 1] })}</p>
    </section>
  );
}

/** How hot: average fire radiative power per VIIRS detection, by year. */
function Strength({ series, meta, cal }: { series: Series; meta: Meta; cal: Calendar }) {
  const t = useT();
  const rows = cal.years
    .map((y) => ({ y, n: series.frpN[y - meta.origin_year] ?? 0, f: series.frp[y - meta.origin_year] ?? 0 }))
    .filter((r) => r.y >= 2012 && r.n >= 20)
    .map((r) => ({ ...r, mean: r.f / r.n }));
  if (rows.length < 3) return null;
  const allMean = rows.reduce((a, r) => a + r.f, 0) / rows.reduce((a, r) => a + r.n, 0);
  const max = Math.max(...rows.map((r) => r.mean));
  const last = rows[rows.length - 1];
  const hottest = rows.reduce((a, r) => (r.mean > a.mean ? r : a));
  const ch = Math.round((last.mean / allMean - 1) * 100);
  return (
    <section className="panel">
      <h2>{t("p.hot")}</h2>
      <p className="big-line">{t("p.hotLine", { avg: allMean.toFixed(1), year: last.y, last: last.mean.toFixed(1), ch: `${ch >= 0 ? "+" : "−"}${Math.abs(ch)}%` })}</p>
      <p className="hint">{t("p.hotHint", { from: rows[0].y, hot: hottest.y })}</p>
      <ol className="bars">
        {[...rows].reverse().map((r) => (
          <li key={r.y}>
            <b>{r.y}</b>
            <span className="track"><u style={{ width: `${(r.mean / max) * 100}%` }} className={r.y === hottest.y ? "max" : undefined} /></span>
            <s>{r.mean.toFixed(1)} MW</s>
          </li>
        ))}
      </ol>
    </section>
  );
}

type PanelsProps = {
  cal: Calendar; allCal: Calendar; mode: RackMode; dek: Float64Array; climYears: [number, number];
  series: Series; meta: Meta; fireType: number | null;
};

export function Panels({ cal, allCal, mode, dek, climYears, series, meta, fireType }: PanelsProps) {
  const t = useT();
  const maxTotal = Math.max(1, ...cal.totals.map((x) => x.total));
  const complete = cal.totals.filter((x) => x.months === 12).map((x) => x.total).sort((a, b) => a - b);
  const medTotal = quantile(complete, 0.5);
  const maxDev = Math.max(0.01, ...cal.totals.filter((x) => x.months === 12).map((x) => Math.abs(x.total / (medTotal || 1) - 1)));
  const years = [...cal.totals].reverse();

  if (mode === "count") {
    return (
      <div className="panels">
        <Season cal={allCal} dek={dek} climYears={climYears} />
        <section className="panel">
          <h2>{t("p.years")}{fireType != null ? `: ${t(`type.${fireType}`).toLowerCase()}` : ""}</h2>
          <p className="hint">{t("p.busiest")}</p>
          <ol className="bars">
            {years.map((x) => (
              <li key={x.year}>
                <b>{x.year}</b>
                <span className="track"><u style={{ width: `${(x.total / maxTotal) * 100}%` }} className={x.total === maxTotal ? "max" : undefined} /></span>
                <s>{t.num(x.total)}{x.months < 12 ? "*" : ""}</s>
              </li>
            ))}
          </ol>
          {years.some((x) => x.months < 12) && <p className="hint">{t("p.partialYear")}</p>}
        </section>
        {series.hasTypes && <WhatBurns cal={allCal} series={series} meta={meta} />}
        <Strength series={series} meta={meta} cal={allCal} />
      </div>
    );
  }
  return (
    <div className="panels three">
      <section className="panel">
        <h2>{t("p.trend")}</h2>
        {cal.trend ? (
          <>
            <p className="big-line"><b>{cal.trend.p < 0.05 ? t(cal.trend.slopePct >= 0 ? "p.rising" : "p.falling") : t("p.noTrend")}</b></p>
            <p className="hint">
              {t("p.trendHint", { pct: `${cal.trend.slopePct >= 0 ? "+" : "−"}${Math.abs(cal.trend.slopePct).toFixed(1)}`, from: cal.trend.from, to: cal.trend.to })}{" "}
              {t(cal.trend.p < 0.05 ? "p.trendYes" : "p.trendNo", { p: cal.trend.p < 0.001 ? "<0.001" : cal.trend.p.toFixed(cal.trend.p < 0.05 ? 3 : 2) })}
            </p>
          </>
        ) : (
          <p className="hint">{t("p.trendShort")}</p>
        )}
      </section>
      <section className="panel">
        <h2>{t("p.vsNormal")}</h2>
        <p className="hint">{t("p.normalYear", { n: t.num(medTotal) })}</p>
        <ol className="bars dev">
          {years.map((x) => {
            const d = medTotal ? x.total / medTotal - 1 : 0;
            const w = (Math.abs(d) / maxDev) * 50;
            return (
              <li key={x.year}>
                <b>{x.year}</b>
                <span className="track">
                  {x.months === 12 && <u className={d >= 0 ? "pos" : "neg"} style={{ width: `${w}%`, left: d >= 0 ? "50%" : `${50 - w}%` }} />}
                </span>
                <s>{x.months < 12 ? t("p.partial") : `${d >= 0 ? "+" : "−"}${Math.abs(Math.round(d * 100))}%`}</s>
              </li>
            );
          })}
        </ol>
      </section>
      <section className="panel">
        <h2>{t("p.top")}</h2>
        <ol className="tops">
          {cal.top.map((x, i) => (
            <li key={`${x.year}-${x.month}`}><span><i>{i + 1}</i>{t.month(x.month)} {x.year}</span><s>{t.num(x.value)}</s></li>
          ))}
        </ol>
      </section>
    </div>
  );
}
