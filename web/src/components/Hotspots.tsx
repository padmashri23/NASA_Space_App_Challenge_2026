"use client";

import { useEffect, useState } from "react";
import { Area, Meta } from "@/lib/data";
import { MONTHS_LONG, fmt } from "@/lib/stats";
import { download, slug } from "@/lib/export";
import { FirmsError, MAX_LIST_AREA, Row, STATIC, browserKey, getHotspots, saveBrowserKey } from "@/lib/firms";
import type { Pick } from "./Rack";

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; rows: Row[]; truncated: boolean }
  | { kind: "problem"; message: string };

const MAX_AREA = MAX_LIST_AREA;
const SHOWN = 250;

/** On the static site the fire list and live check use a public NASA FIRMS key; visitors can use their own instead. */
function OwnKey() {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <details className="ownkey">
      <summary>Use your own NASA FIRMS key</summary>
      <p className="hint">
        If the fire list or the live check stop answering, NASA may be limiting this site&rsquo;s shared key. Get a free key at{" "}
        <a href="https://firms.modaps.eosdis.nasa.gov/api/map_key/" target="_blank" rel="noreferrer">firms.modaps.eosdis.nasa.gov/api/map_key</a>{" "}
        and paste it here. It is kept only in this browser.
      </p>
      <div className="row">
        <input aria-label="Your NASA FIRMS key" value={value} onChange={(e) => { setValue(e.target.value); setSaved(false); }} placeholder="32-character key" />
        <button type="button" className="btn line" onClick={() => { saveBrowserKey(value); setSaved(true); }}>Save key</button>
      </div>
      {saved && <p className="hint">{value ? "Saved. Load the list again." : "Cleared. The site's shared key is used again."}</p>}
    </details>
  );
}

export default function Hotspots({ meta, area, sel, modisEq }: { meta: Meta; area: Area; sel: Pick | null; modisEq: number | null }) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const size = (area.box.e - area.box.w) * (area.box.n - area.box.s);
  const tooLarge = size > MAX_AREA;
  const inProgress = !!sel && !!meta.partial && (sel.year - meta.origin_year) * 12 + sel.month === meta.partial.mon;
  const when = sel ? `${inProgress ? `1–${meta.partial!.day} ` : ""}${MONTHS_LONG[sel.month]} ${sel.year}` : "";

  useEffect(() => setState({ kind: "idle" }), [area, sel?.year, sel?.month]);

  const load = async () => {
    if (!sel) return;
    setState({ kind: "loading" });
    try {
      const { w, s, e, n } = area.box;
      let body: { rows?: Row[]; truncated?: boolean; error?: string };
      let okRes = true;
      if (STATIC) {
        try { body = await getHotspots(browserKey(), w, s, e, n, sel.year, sel.month + 1); }
        catch (err) { okRes = false; body = { error: err instanceof FirmsError ? err.code : "upstream" }; }
      } else {
        const res = await fetch(`/api/hotspots?w=${w}&s=${s}&e=${e}&n=${n}&year=${sel.year}&month=${sel.month + 1}`);
        body = await res.json();
        okRes = res.ok;
      }
      if (!okRes) {
        const message =
          body.error === "nokey"
            ? STATIC
              ? "This copy of the site has no NASA FIRMS key. Add your own free key below to load the fire list. Download data works without one."
              : "The fire list is switched off on this server because no NASA FIRMS key is set. Download data still works."
            : body.error === "toolarge"
              ? "This area is too large for a fire list. Draw a smaller area."
              : "NASA FIRMS did not answer. Wait a minute and load again.";
        setState({ kind: "problem", message });
        return;
      }
      setState({ kind: "ready", rows: body.rows ?? [], truncated: !!body.truncated });
    } catch {
      setState({ kind: "problem", message: "The fire list could not be loaded. Check your connection and try again." });
    }
  };

  const csv = (rows: Row[]) =>
    ["latitude,longitude,acq_date,acq_time_utc,satellite,instrument,confidence,frp_mw,daynight,firms_product"]
      .concat(rows.map((r) => [r.lat, r.lon, r.date, r.time, r.sat, r.inst, r.conf, r.frp, r.dn, r.product].join(",")))
      .join("\r\n") + "\r\n";

  const counts = state.kind === "ready"
    ? state.rows.reduce<Record<string, number>>((acc, r) => ((acc[r.inst === "MODIS" ? "MODIS" : `VIIRS ${r.sat}`] = (acc[r.inst === "MODIS" ? "MODIS" : `VIIRS ${r.sat}`] ?? 0) + 1), acc), {})
    : {};

  return (
    <section className="hotcol" aria-label="Hotspot list">
      <div className="headrow"><h2>Every fire detection{when ? `, ${when}` : ""}</h2></div>
      <p className="lead">
        Each row is one satellite detection inside your area during the month picked on the Calendar tab, straight from NASA FIRMS.
        These are the satellites&rsquo; own counts: the newer VIIRS sensors see smaller fires and have finer pixels, so they list more rows than
        MODIS. The calendar&rsquo;s converted figure for this month is <strong>{modisEq == null ? "not available" : fmt(modisEq)}</strong>.
      </p>
      <div className="row">
        <button type="button" className="btn" onClick={load} disabled={!sel || tooLarge || state.kind === "loading"}>
          {state.kind === "loading" ? "Asking NASA FIRMS…" : `Show fire detections for ${when}`}
        </button>
        {state.kind === "ready" && state.rows.length > 0 && (
          <button type="button" className="btn line"
            onClick={() => download(`burn-almanac_hotspots_${slug(area)}_${sel!.year}-${String(sel!.month + 1).padStart(2, "0")}.csv`, new Blob([csv(state.rows)], { type: "text/csv" }))}>
            Download these {fmt(state.rows.length)} as CSV
          </button>
        )}
      </div>
      {tooLarge && <p className="err">The list works for areas up to {MAX_AREA} square degrees (about the size of Portugal); this one is {Math.round(size)}. Draw a smaller area, or use Download data for monthly totals.</p>}
      {state.kind === "problem" && <p className="err" role="alert">{state.message}</p>}
      {state.kind === "ready" && (
        state.rows.length === 0 ? (
          <p className="state">NASA FIRMS has no fire detections for this area in {when}.</p>
        ) : (
          <>
            <p className="val">
              {Object.entries(counts).map(([k, v]) => `${k}: ${fmt(v)}`).join(" · ")}
              {state.truncated ? " · list cut at the server limit" : ""}
            </p>
            <div className="tablewrap tall">
              <table className="data">
                <thead>
                  <tr><th scope="col">Date</th><th scope="col">UTC</th><th scope="col">Latitude</th><th scope="col">Longitude</th><th scope="col">Sensor</th><th scope="col">Confidence</th><th scope="col">FRP, MW</th><th scope="col">Day/night</th></tr>
                </thead>
                <tbody>
                  {state.rows.slice(0, SHOWN).map((r, i) => (
                    <tr key={i}>
                      <td>{r.date}</td><td>{r.time}</td><td>{r.lat.toFixed(4)}</td><td>{r.lon.toFixed(4)}</td>
                      <td>{r.inst === "MODIS" ? `MODIS ${r.sat}` : `VIIRS ${r.sat}`}</td><td>{r.conf}</td><td>{r.frp.toFixed(1)}</td><td>{r.dn === "D" ? "Day" : "Night"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {state.rows.length > SHOWN && <p className="note">Showing the first {SHOWN} of {fmt(state.rows.length)}. The CSV has them all.</p>}
          </>
        )
      )}
      {state.kind === "idle" && !tooLarge && (
        <p className="note">To see another month, click it on the Calendar tab first. Data version {meta.generated}.</p>
      )}
      {STATIC && <OwnKey />}
    </section>
  );
}
