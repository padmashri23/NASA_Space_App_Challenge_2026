"use client";

import { useEffect, useState } from "react";
import { Area } from "@/lib/data";
import { T, useT } from "@/lib/i18n";
import { outlook } from "@/lib/outlook";
import { Calendar } from "@/lib/stats";
import { periodDates } from "./Side";
import { FirmsError, STATIC, browserKey, getLive } from "@/lib/firms";

type Live = { start: string; end: string; total: number; raw: number; days: { date: string; eq: number }[] };

/** Expected detections for a set of days from the area's typical ten-day profile (a normal year's total spread over it). */
function expectedFor(dek: Float64Array, normalYear: number, dates: string[]): number {
  const total = dek.reduce((a, b) => a + b, 0);
  if (!total || !normalYear) return 0;
  const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return dates.reduce((s, iso) => {
    const d = new Date(iso + "T00:00:00Z");
    const m = d.getUTCMonth(), k = Math.min(2, Math.floor((d.getUTCDate() - 1) / 10));
    const len = k < 2 ? 10 : DAYS[m] - 20;
    return s + (dek[m * 3 + k] / len / total) * normalYear;
  }, 0);
}

function verdictOf(ratio: number): [string, string] {
  if (ratio >= 2) return ["Well above normal", "up"];
  if (ratio >= 1.25) return ["Above normal", "up"];
  if (ratio > 0.8) return ["Near normal", "mid"];
  if (ratio > 0.4) return ["Below normal", "down"];
  return ["Well below normal", "down"];
}

/** "late October" in the reader's language, from the peak's ten-day index. */
function peakText(t: T, peakDek: number | null): string {
  if (peakDek == null) return "";
  return `${t(["early", "mid", "late"][peakDek % 3])} ${t.month(Math.floor(peakDek / 3))}`;
}

type Props = { cal: Calendar; dek: Float64Array; area: Area; recordEnd: string | null; factors: { D: number; N: number } };

export default function OutlookBand({ cal, dek, area, recordEnd, factors }: Props) {
  const t = useT();
  const asOf = recordEnd ? new Date(recordEnd + "T00:00:00Z") : null;
  const o = asOf ? outlook(cal, dek, asOf) : null;
  const [live, setLive] = useState<Live | null>(null);
  const [liveState, setLiveState] = useState<"loading" | "ready" | "off" | "error" | "toolarge">("loading");

  useEffect(() => {
    let dead = false;
    setLive(null);
    setLiveState("loading");
    const { w, s, e, n } = area.box;
    const show = (code: string) => setLiveState(code === "nokey" ? "off" : code === "toolarge" ? "toolarge" : "error");
    if (STATIC) {
      getLive(browserKey(), w, s, e, n, factors)
        .then((b) => { if (!dead) { setLive(b); setLiveState("ready"); } })
        .catch((err) => !dead && show(err instanceof FirmsError ? err.code : "upstream"));
    } else {
      fetch(`/api/live?w=${w}&s=${s}&e=${e}&n=${n}`)
        .then(async (r) => {
          const b = await r.json();
          if (dead) return;
          if (r.ok) { setLive(b); setLiveState("ready"); }
          else show(b.error);
        })
        .catch(() => !dead && setLiveState("error"));
    }
    return () => { dead = true; };
  }, [area, factors]);

  if (!o) return null;
  const date = (d: Date) => `${d.getUTCDate()} ${t.month(d.getUTCMonth())} ${d.getUTCFullYear()}`;
  const day = (iso: string) => { const d = new Date(iso + "T00:00:00Z"); return `${d.getUTCDate()} ${t.monthShort(d.getUTCMonth())}`; };
  const asOfLabel = asOf ? date(asOf) : "";
  const exp = live && o.normalYear ? expectedFor(dek, o.normalYear, live.days.map((d) => d.date)) : 0;
  const ratio = live && exp > 0 ? live.total / exp : null;
  const lv = ratio != null ? verdictOf(ratio) : null;
  const peak = peakText(t, o.peakDek);
  const [pFrom, pTo] = o.period ? periodDates(t, o.period) : ["", ""];

  return (
    <section className="outlook" aria-label={t("ol.season")}>
      <div className="ol">
        <h2>{t("ol.season")}</h2>
        {o.state === "none" || !o.period ? (
          <p className="ol-say">{t("ol.none")}</p>
        ) : o.state === "in" ? (
          <>
            <p className="ol-say"><b>{t("ol.in")}</b> ({pFrom} – {pTo})</p>
            <p className="hint">
              {o.seasonLeftShare != null && `${t("ol.left", { pct: Math.round(o.seasonLeftShare * 100), date: asOfLabel })} `}
              {t(o.peakPassed ? "ol.peakPassed" : "ol.peak", { peak })}
            </p>
          </>
        ) : (
          <>
            <p className="ol-say"><b>{t("ol.startsIn", { days: o.daysToStart ?? 0 })}</b> ({pFrom})</p>
            <p className="hint">
              {o.state === "after" ? `${t("ol.ended")} ` : ""}{t("ol.next", { from: pFrom, to: pTo, peak })}
            </p>
          </>
        )}
      </div>
      <div className="ol">
        <h2>{t("ol.next30")}</h2>
        <p className="ol-say"><b>{o.next30Expected != null ? t("ol.about", { n: t.num(o.next30Expected) }) : "–"}</b> {t("ol.det")}</p>
        <p className="hint">{t("ol.share", { pct: Math.round(o.next30Share * 100), date: asOfLabel, from: cal.years[0], to: cal.years[cal.years.length - 1] })}</p>
      </div>
      <div className="ol">
        <h2>{t("ol.live")}</h2>
        {liveState === "loading" && <p className="hint">{t("ol.asking")}</p>}
        {liveState === "off" && <p className="hint">{t(STATIC ? "ol.offStatic" : "ol.off")}</p>}
        {liveState === "toolarge" && <p className="hint">{t("ol.toolarge")}</p>}
        {liveState === "error" && <p className="hint">{t("ol.err")}</p>}
        {liveState === "ready" && live && (
          <>
            <p className="ol-say">
              <b>{t.num(live.total)}</b> {t("ol.det")}{lv && <>{". "}<span className={`ol-v ${lv[1]}`}>{t(`v.${lv[0]}`)}</span></>}
            </p>
            <p className="hint">{t("ol.liveNote", { from: day(live.start), to: day(live.end), exp: t.num(exp) })}</p>
          </>
        )}
      </div>
    </section>
  );
}
