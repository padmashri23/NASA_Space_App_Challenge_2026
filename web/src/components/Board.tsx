"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Area, Box, FIRE_TYPES, Meta, Series, aggregate, loadCountry, loadMeta } from "@/lib/data";
import { PRESETS } from "@/lib/presets";
import { MONTHS_LONG, assess, buildCalendar, fmt } from "@/lib/stats";
import { calendarCsv, calendarPng, download, slug } from "@/lib/export";
import Rack, { Pick } from "./Rack";
import { Panels, Status } from "./Side";
import MapPanel from "./MapPanel";
import Method from "./Method";
import Hotspots from "./Hotspots";
import OutlookBand from "./Outlook";
import { STORIES, Story } from "@/lib/stories";
import { LANGS, Lang, LangContext, makeT } from "@/lib/i18n";

type Tab = "calendar" | "anomalies" | "hotspots" | "method";
const TABS: [Tab, string][] = [["calendar", "tab.calendar"], ["anomalies", "tab.anomalies"], ["hotspots", "tab.hotspots"], ["method", "tab.method"]];
const FIRST_FULL_YEAR = 2003; // first year with both MODIS instruments all year

const lat = (v: number) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? "N" : "S"}`;
const lon = (v: number) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? "E" : "W"}`;

function validBox(b: Box): string | null {
  if ([b.w, b.s, b.e, b.n].some((v) => !Number.isFinite(v))) return "Enter a number in all four boxes.";
  if (b.s < -90 || b.n > 90 || b.w < -180 || b.e > 180) return "Latitude runs from −90 to 90 and longitude from −180 to 180.";
  if (b.n <= b.s) return "North must be greater than south.";
  if (b.e <= b.w) return "East must be greater than west.";
  return null;
}

export default function Board() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [area, setArea] = useState<Area>(PRESETS[0]);
  const [series, setSeries] = useState<Series | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [years, setYears] = useState<[number, number] | null>(null);
  const [tab, setTab] = useState<Tab>("calendar");
  const [picked, setPicked] = useState<Pick | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [coordsOpen, setCoordsOpen] = useState(false);
  const [fields, setFields] = useState({ n: "", s: "", w: "", e: "" });
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [story, setStory] = useState<Story | null>(null);
  const [fireType, setFireType] = useState<number | null>(null);
  const [lang, setLang] = useState<Lang>("en");
  const t = useMemo(() => makeT(lang), [lang]);
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("burn-almanac-lang") as Lang | null;
      if (saved && LANGS.some(([l]) => l === saved)) setLang(saved);
    } catch { /* storage unavailable: stay in English */ }
  }, []);
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  const chooseLang = (l: Lang) => {
    setLang(l);
    try { window.localStorage.setItem("burn-almanac-lang", l); } catch { /* ignore */ }
  };
  const pendingPick = useRef<Pick | null>(null);

  const lastYear = meta ? meta.origin_year + Math.floor((meta.n_months - 1) / 12) : 0;
  const recordEnd = meta ? { year: lastYear, month: (meta.n_months - 1) % 12 } : null;

  // Load the record index, then restore the area, period and view from the address bar.
  useEffect(() => {
    let dead = false;
    loadMeta()
      .then(async (m) => {
        if (dead) return;
        const last = m.origin_year + Math.floor((m.n_months - 1) / 12);
        const h = new URLSearchParams(window.location.hash.slice(1));
        const y = h.get("years")?.split("-").map(Number);
        setYears(y && y.length === 2 && y[0] >= m.origin_year && y[1] <= last && y[1] - y[0] >= 1 ? [y[0], y[1]] : [FIRST_FULL_YEAR, last]);
        const view = h.get("view");
        if (view && TABS.some(([id]) => id === view)) setTab(view as Tab);
        const country = h.get("country");
        const b = h.get("box")?.split(",").map(Number);
        if (country) {
          const a = await loadCountry(m, country);
          if (a && !dead) setArea(a);
        } else if (b && b.length === 4) {
          const box = { w: b[0], s: b[1], e: b[2], n: b[3] };
          if (!validBox(box)) setArea({ label: h.get("name") || "Your area", box });
        }
        setMeta(m);
      })
      .catch(() => !dead && setError("The fire record could not be loaded. Check your connection and try again."));
    return () => { dead = true; };
  }, [attempt]);

  useEffect(() => {
    if (!meta) return;
    let dead = false;
    setBusy(true);
    setError(null);
    aggregate(meta, area)
      .then((s) => {
        if (dead) return;
        setSeries(s);
        setPicked(pendingPick.current);
        pendingPick.current = null;
        setBusy(false);
      })
      .catch(() => !dead && (setError("Part of the record for this area could not be loaded. Try again."), setBusy(false)));
    return () => { dead = true; };
  }, [meta, area, attempt]);

  useEffect(() => {
    const b = area.box;
    setFields({ n: b.n.toFixed(2), s: b.s.toFixed(2), w: b.w.toFixed(2), e: b.e.toFixed(2) });
    setFieldError(null);
  }, [area]);

  useEffect(() => {
    if (!meta || !years) return;
    const h = new URLSearchParams();
    if (area.cells) h.set("country", area.label);
    else {
      h.set("box", [area.box.w, area.box.s, area.box.e, area.box.n].map((v) => +v.toFixed(3)).join(","));
      h.set("name", area.label);
    }
    h.set("years", years.join("-"));
    if (tab !== "calendar") h.set("view", tab);
    window.history.replaceState(null, "", `#${h.toString()}`);
  }, [meta, area, years, tab]);

  const cal = useMemo(() => (meta && series && years ? buildCalendar(meta, series, years[0], years[1]) : null), [meta, series, years]);
  // The calendar and lower panels can show one fire type; the status band and outlook always use all fires.
  const typeCal = useMemo(() => {
    if (!meta || !series || !years || fireType == null || !series.hasTypes) return cal;
    const t = series.byType[fireType];
    return buildCalendar(meta, { ...series, modis: t.modis, veq: t.veq }, years[0], years[1], true);
  }, [meta, series, years, fireType, cal]);
  const sel = picked && cal?.years.includes(picked.year) ? picked : cal?.cur ?? null;
  const a = cal && sel ? assess(cal, sel.year, sel.month) : null;
  const mode = tab === "anomalies" ? "anomaly" : "count";
  const liveFactors = useMemo(
    () => ({ D: meta?.validation.global_factor.NOAA20_D ?? 0.42, N: meta?.validation.global_factor.NOAA20_N ?? 0.2 }),
    [meta],
  );

  const applyFields = () => {
    const box = { n: parseFloat(fields.n), s: parseFloat(fields.s), w: parseFloat(fields.w), e: parseFloat(fields.e) };
    const problem = validBox(box);
    setFieldError(problem);
    if (!problem) {
      setStory(null);
      setArea({ label: "Your area", box });
      setCoordsOpen(false);
    }
  };

  const openStory = async (st: Story) => {
    if (!meta) return;
    const next = st.area.country ? await loadCountry(meta, st.area.country) : PRESETS.find((p) => p.label === st.area.preset) ?? null;
    if (!next) return;
    const last = meta.origin_year + Math.floor((meta.n_months - 1) / 12);
    setYears([st.years[0], Math.min(st.years[1], last)]);
    setTab(st.tab);
    setStory(st);
    if (next.label === area.label) setPicked(st.pick);
    else {
      pendingPick.current = st.pick;
      setArea(next);
    }
  };

  const chooseArea = async (value: string) => {
    setStory(null);
    if (value.startsWith("country:") && meta) {
      const c = await loadCountry(meta, value.slice(8));
      if (c) setArea(c);
    } else {
      const p = PRESETS.find((x) => x.label === value);
      if (p) setArea(p);
    }
  };

  const areaValue = area.cells ? `country:${area.label}` : PRESETS.some((p) => p.label === area.label) ? area.label : "custom";
  const fileStem = `burn-almanac_${slug(area)}_${years?.join("-") ?? ""}`;
  const ready = !!(meta && cal && series && !busy);

  const yearSelect = (which: 0 | 1) =>
    meta && years ? (
      <select aria-label={which === 0 ? "From year" : "To year"} value={years[which]}
        onChange={(e) => {
          const v = +e.target.value;
          setYears(which === 0 ? [v, Math.max(years[1], v + 1)] : [Math.min(years[0], v - 1), v]);
        }}>
        {Array.from({ length: lastYear - meta.origin_year - 1 }, (_, i) => meta.origin_year + 1 + which + i).map((y) => <option key={y}>{y}</option>)}
      </select>
    ) : <select aria-label={which === 0 ? "From year" : "To year"} disabled><option>…</option></select>;

  const map = meta ? (
    <section className="mapcol" aria-label="Map">
      <div className="headrow">
        <h2>{t("map.title")}{sel ? `: ${a?.toDay ? `1–${a.toDay} ` : ""}${t.month(sel.month)} ${sel.year}` : ""}</h2>
        <button type="button" className="btn line small" aria-pressed={drawing} onClick={() => setDrawing(!drawing)}>
          {drawing ? t("map.cancel") : t("map.draw")}
        </button>
      </div>
      <MapPanel meta={meta} area={area} sel={sel} drawing={drawing} onDrawn={(box) => { setDrawing(false); setStory(null); setArea({ label: "Your drawn area", box }); }} />
      <div className="mapkey">
        <span>{t("map.fewer")}</span>
        <ul aria-label="Map key: fire detections per square">
          {meta.overview.month_breaks.map((b, k) =>
            k < 5 ? (
              <li key={b}><i className={`sq k${k + 1}`} style={{ width: 8 + k * 2.5, height: 8 + k * 2.5 }} />{k === 0 ? "<1" : b}</li>
            ) : (
              <li key={b} className="end"><span><i className={`sq k${k + 1}`} style={{ width: 8 + k * 2.5, height: 8 + k * 2.5, marginRight: 6 }} />{b}+</span><span>{t("map.more")}</span></li>
            ),
          )}
        </ul>
      </div>
      <p className="hint">
        {t("map.hint")}
      </p>
      <p className="credit">
        {t("map.credit")}
      </p>
    </section>
  ) : <section className="mapcol"><div className="map" /></section>;

  return (
    <LangContext.Provider value={t}>
    <div className="board">
      <header className="top">
        <h1>Burn Almanac</h1>
        <nav className="tabs" aria-label="Views">
          {TABS.map(([id, key]) => (
            <button key={id} type="button" aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}>{t(key)}</button>
          ))}
        </nav>
        <div className="actions">
          <button type="button" className="btn ghost" disabled={!ready} onClick={() => window.print()}>
            {t("btn.print")}
          </button>
          <button type="button" className="btn ghost" disabled={!ready}
            onClick={() => meta && cal && calendarPng(meta, cal, area, mode).then((b) => download(`${fileStem}${mode === "anomaly" ? "_compare" : ""}.png`, b))}>
            {t("btn.image")}
          </button>
          <button type="button" className="btn" disabled={!ready}
            onClick={() => meta && cal && series && download(`${fileStem}.csv`, new Blob([calendarCsv(meta, cal, area, series)], { type: "text/csv" }))}>
            {t("btn.data")}
          </button>
        </div>
      </header>

      <div className="controls" id="area">
        <label className="field area">
          <span>{t("ctl.area")}</span>
          <select value={areaValue} onChange={(e) => chooseArea(e.target.value)}>
            {areaValue === "custom" && <option value="custom">{area.label}</option>}
            <optgroup label={t("ctl.regions")}>
              {PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
            </optgroup>
            <optgroup label={t("ctl.countries")}>
              {meta?.countries.map(([name]) => <option key={name} value={`country:${name}`}>{name}</option>)}
            </optgroup>
          </select>
        </label>
        <button type="button" className="btn line" aria-expanded={coordsOpen} aria-controls="coords" onClick={() => setCoordsOpen(!coordsOpen)}>
          {t("ctl.coords")}
        </button>
        <div className="field years">
          <span id="period">{t("ctl.years")}</span>
          <div className="pair" role="group" aria-labelledby="period">{yearSelect(0)}<em>{t("ctl.to")}</em>{yearSelect(1)}</div>
        </div>
        <label className="field lang">
          <span>{t("ctl.language")}</span>
          <select value={lang} onChange={(e) => chooseLang(e.target.value as Lang)}>
            {LANGS.map(([l, name]) => <option key={l} value={l}>{name}</option>)}
          </select>
        </label>
        <p className="where">
          {lat(area.box.s)} to {lat(area.box.n)}, {lon(area.box.w)} to {lon(area.box.e)}
          {ready && cal && <><br />{t("ctl.where", { n: t.num(cal.grand), from: cal.years[0], to: cal.years[cal.years.length - 1] })}</>}
        </p>
        <div className="stories" role="group" aria-label="Stories">
          <span>{t("story.try")}</span>
          {STORIES.map((st) => (
            <button key={st.id} type="button" className="chip" aria-pressed={story?.id === st.id} disabled={!meta} onClick={() => openStory(st)}>
              {st.title}
            </button>
          ))}
        </div>
        {coordsOpen && (
          <div className="coords" id="coords">
            {(["n", "s", "w", "e"] as const).map((k) => (
              <label className="field" key={k}>
                <span>{t({ n: "north", s: "south", w: "west", e: "east" }[k])}</span>
                <input inputMode="decimal" value={fields[k]} aria-invalid={!!fieldError}
                  onChange={(e) => setFields({ ...fields, [k]: e.target.value })}
                  onKeyDown={(e) => e.key === "Enter" && applyFields()} />
              </label>
            ))}
            <button type="button" className="btn" onClick={applyFields}>{t("ctl.use")}</button>
            {fieldError && <p className="err" role="alert">{fieldError}</p>}
            <p className="hint">{t("ctl.coordshint")}</p>
          </div>
        )}
      </div>

      {tab === "method" ? (
        <main className="solo">
          {lang !== "en" && <p className="hint langnote">{t("english")}</p>}
          {meta && cal ? <Method meta={meta} cal={cal} area={area} /> : <p className="state">{error ?? "Reading the record…"}</p>}
        </main>
      ) : tab === "hotspots" ? (
        <main className="work">
          {meta && <Hotspots meta={meta} area={area} sel={sel} modisEq={a?.value ?? null} />}
          {map}
        </main>
      ) : error ? (
        <main className="solo">
          <p className="state" role="alert">{error}</p>
          <button type="button" className="btn" onClick={() => setAttempt(attempt + 1)}>Try again</button>
        </main>
      ) : !ready || !cal || !meta || !series ? (
        <main className="solo"><p className="state" aria-live="polite">{t("loading", { area: area.label })}</p></main>
      ) : (
        <>
          <div className="printhead">
            Burn Almanac report: {area.label}, {cal.years[0]}–{cal.years[cal.years.length - 1]}. Data from NASA FIRMS, to {meta.validation.record_end ?? `${MONTHS_LONG[recordEnd!.month]} ${recordEnd!.year}`}.
            Printed {new Date().toISOString().slice(0, 10)}.
          </div>
          {story && cal && (
            <section className="storyband" aria-live="polite">
              <div>
                <h2>{story.title}</h2>
                <p>{story.text(cal)}</p>
                {lang !== "en" && <p className="hint">{t("story.english")}</p>}
              </div>
              <button type="button" className="btn line small" onClick={() => setStory(null)}>{t("story.close")}</button>
            </section>
          )}
          <Status cal={cal} a={a} area={area} recordEnd={recordEnd} />
          <OutlookBand cal={cal} dek={series.dek} area={area} recordEnd={meta.validation.record_end ?? null} factors={liveFactors} />
          <main className="work">
            <section className="rackcol" aria-label={mode === "count" ? "Fire detections each month" : "Each month compared with normal"}>
              <div className="headrow">
                <h2>{t(mode === "count" ? "cal.title" : "cal.titleA")}</h2>
                <p className="hint">{t("cal.hint")}</p>
              </div>
              {series.hasTypes && (
                <div className="types" role="group" aria-label="Which fires to show in the calendar">
                  <button type="button" className="chip" aria-pressed={fireType == null} onClick={() => setFireType(null)}>{t("type.all")}</button>
                  {FIRE_TYPES.map((label, g) => (
                    <button key={label} type="button" className="chip" aria-pressed={fireType === g} onClick={() => setFireType(g)}>{t(`type.${g}`)}</button>
                  ))}
                </div>
              )}
              {fireType != null && (
                <p className="hint typenote">{t("type.note", { type: t(`type.${fireType}`).toLowerCase() })}</p>
              )}
              {cal.grand < 1 ? (
                <p className="state">
                  No fires were detected in this area in {cal.years[0]}–{cal.years[cal.years.length - 1]}. Try a larger area, or pick a region from the Area list.
                </p>
              ) : (
                <Rack cal={typeCal ?? cal} mode={mode} sel={sel} onPick={setPicked} switchYear={meta.switch_year} />
              )}
            </section>
            {map}
          </main>
          <Panels cal={typeCal ?? cal} allCal={cal} mode={mode} dek={series.dek} climYears={meta.clim_years} series={series} meta={meta} fireType={fireType} />
        </>
      )}

      <footer className="foot">
        <p>{t("foot")}</p>
      </footer>
    </div>
    </LangContext.Provider>
  );
}
