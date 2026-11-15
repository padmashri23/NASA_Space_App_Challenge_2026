"use client";

import { Fragment, KeyboardEvent, useRef } from "react";
import { Calendar, MONTHS, MONTHS_LONG, anomalyClass, classOf, compact, fmt } from "@/lib/stats";
import { rangeLabel } from "@/lib/export";
import { useT } from "@/lib/i18n";

export type Pick = { year: number; month: number };
export type RackMode = "count" | "anomaly";

type Props = { cal: Calendar; mode: RackMode; sel: Pick | null; onPick: (p: Pick) => void; switchYear: number };

const STEP: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };

export default function Rack({ cal, mode, sel, onPick, switchYear }: Props) {
  const t = useT();
  const body = useRef<HTMLTableSectionElement>(null);
  const rows = cal.years.map((year, i) => ({ year, i })).reverse();
  const showSeam = cal.years.includes(switchYear) && cal.years.includes(switchYear - 1);
  const os = cal.overlapStats;
  const stop = sel ?? cal.cur; // the one card in the tab order; arrow keys reach the rest

  const onKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    const t = e.target as HTMLElement;
    const d = STEP[e.key];
    if (!d || !t.dataset.r) return;
    e.preventDefault();
    let r = Number(t.dataset.r), m = Number(t.dataset.m);
    for (let i = 0; i < 40; i++) {
      r += d[0];
      m += d[1];
      if (r < 0 || r >= rows.length || m < 0 || m > 11) return;
      const next = body.current?.querySelector<HTMLButtonElement>(`button[data-r="${r}"][data-m="${m}"]`);
      if (next) return next.focus();
    }
  };

  return (
    <div className="rackwrap">
      <table className="rack">
        <thead>
          <tr>
            <th scope="col"><span className="sr">Year</span></th>
            {MONTHS.map((m, i) => (
              <th key={m} scope="col" abbr={t.month(i)} className={sel?.month === i ? "on" : undefined}>{t.monthShort(i)}</th>
            ))}
          </tr>
        </thead>
        <tbody ref={body} onKeyDown={onKey}>
          <tr className="medrow">
            <th scope="row" title="The median: half of the years had more, half had less"><span className="full">{t("cal.normal")}</span><span className="cmp">{t("cal.normalShort")}</span></th>
            {cal.med.map((v, m) => (
              <td key={m}>
                <span className={`card flat k${classOf(v, cal.breaks)}`}>
                  <span className="full">{v >= 99999.5 ? compact(v) : fmt(v)}</span>
                  <span className="cmp">{compact(v)}</span>
                </span>
              </td>
            ))}
          </tr>
          {rows.map(({ year, i }, r) => (
            <Fragment key={year}>
              {showSeam && year === switchYear - 1 && (
                <tr className="seam">
                  <td colSpan={13}>
                    <div>
                      <span>
                        <span className="full">
                          {t("cal.above")}
                          {os ? ` (${t("cal.within", { pct: Math.round(os.medianAbsPct) })})` : ""}
                        </span>
                        <span className="cmp">{t("cal.aboveShort")}{os ? ` (±${Math.round(os.medianAbsPct)}%)` : ""}</span>
                      </span>
                      <span>
                        <span className="full">{t("cal.below")}</span>
                        <span className="cmp">{t("cal.belowShort")}</span>
                      </span>
                    </div>
                  </td>
                </tr>
              )}
              <tr>
                <th scope="row" className={sel?.year === year ? "on" : undefined}>{year}</th>
                {MONTHS.map((_, m) => {
                  const v = cal.val[i][m];
                  if (v == null) return <td key={m}><span className="card none" role="img" aria-label={`${MONTHS_LONG[m]} ${year}: no data`} /></td>;
                  const pct = cal.pct[i][m];
                  const mark = cal.mark[i][m];
                  const isSel = sel?.year === year && sel.month === m;
                  const isNow = cal.cur?.year === year && cal.cur.month === m;
                  const part = cal.partial && cal.partial.year === year && cal.partial.month === m ? cal.partial : null;
                  const cls = mode === "count" ? `k${classOf(v, cal.breaks)}` : anomalyClass(pct);
                  const label =
                    `${MONTHS_LONG[m]} ${year}${part ? `, days 1–${part.day} only` : ""}: ${fmt(v)} fire detections` +
                    (pct != null ? `, ${Math.round(pct)}% of ${part ? `normal for those days` : `a normal ${MONTHS_LONG[m]}`}` : "") +
                    (mark === "hi" ? ", among the highest for this month" : mark === "lo" ? ", among the lowest for this month" : "");
                  return (
                    <td key={m}>
                      <button
                        type="button"
                        className={`card ${cls}${mark ? ` ${mark}` : ""}${isSel ? " sel" : ""}${isNow ? " now" : ""}${part ? " part" : ""}`}
                        aria-pressed={isSel}
                        aria-label={label}
                        title={label}
                        data-r={r}
                        data-m={m}
                        tabIndex={!stop || (stop.year === year && stop.month === m) ? 0 : -1}
                        onClick={() => onPick({ year, month: m })}
                      >
                        {mode === "count" ? (
                          <>
                            <span className="full">{v >= 99999.5 ? compact(v) : t.num(v)}</span>
                            <span className="cmp">{compact(v)}</span>
                          </>
                        ) : (
                          <span>{pct == null ? "–" : Math.round(pct) >= 1000 ? `${Math.round(pct / 100)}×` : Math.round(pct)}</span>
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>

      <div className="legend">
        {mode === "count" ? (
          <ul className="keys" aria-label="Colour key: fire detections per month">
            <li className="cap">{t("cal.keyCount")}</li>
            <li><i className="sw k0" />0</li>
            {cal.breaks.map((b, k) => (
              <li key={b}>
                <i className={`sw k${k + 1}`} />
                {rangeLabel(cal.breaks, k)}
              </li>
            ))}
          </ul>
        ) : (
          <ul className="keys" aria-label="Colour key: percent of normal for that month">
            <li className="cap">{t("cal.keyPct")}</li>
            <li><i className="sw dm3" />25% or less</li>
            <li><i className="sw dm2" />26–50%</li>
            <li><i className="sw dm1" />51–80%</li>
            <li><i className="sw d0" />{t("cal.near")}</li>
            <li><i className="sw dp1" />125–199%</li>
            <li><i className="sw dp2" />200–399%</li>
            <li><i className="sw dp3" />400%+</li>
          </ul>
        )}
        <ul className="keys marks" aria-label="Marks">
          <li><i className="sw mk hi" />{t("cal.hi")}</li>
          <li><i className="sw mk lo" />{t("cal.lo")}</li>
          <li><i className="sw mk now" />{t("cal.now")}</li>
          {cal.partial && <li><i className="sw mk part" />{t("cal.part", { day: cal.partial.day, month: t.month(cal.partial.month) })}</li>}
        </ul>
      </div>
    </div>
  );
}
