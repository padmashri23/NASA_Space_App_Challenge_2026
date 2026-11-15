"use client";

import { Area, Meta, SatMetrics } from "@/lib/data";
import { Calendar, fmt } from "@/lib/stats";

function SeamChart({ cal }: { cal: Calendar }) {
  const o = cal.overlap;
  if (!o.length) return null;
  const W = 760, H = 200, L = 46, B = 24;
  const max = Math.max(1, ...o.map((p) => Math.max(p.modis, p.veq)));
  const x = (i: number) => L + (i / (o.length - 1 || 1)) * (W - L - 8);
  const y = (v: number) => H - B - (v / max) * (H - B - 10);
  const path = (key: "modis" | "veq") => o.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join("");
  const yearStarts = o.map((p, i) => ({ p, i })).filter(({ p, i }) => p.month === 0 || i === 0);
  return (
    <svg className="seamchart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label="Monthly fire detections in this area during the overlap years: MODIS as observed against the VIIRS-based MODIS-equivalent.">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W - 8} y1={y(max * f)} y2={y(max * f)} className="grid" />
          <text x={L - 6} y={y(max * f) + 4} textAnchor="end">{fmt(max * f)}</text>
        </g>
      ))}
      {yearStarts.map(({ p, i }) => <text key={i} x={x(i)} y={H - 6}>{p.year}</text>)}
      <path d={path("modis")} className="lm" />
      <path d={path("veq")} className="lv" />
    </svg>
  );
}

const SCALES: [keyof Meta["validation"], string][] = [
  ["global_year", "Whole world, one year"],
  ["global_month", "Whole world, one month"],
  ["block_5deg_month", "A 5° region, one month"],
  ["cell_1deg_month", "A 1° cell, one month"],
];

const clock = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.round((h % 1) * 60) % 60).padStart(2, "0")}`;

function Overpass({ meta }: { meta: Meta }) {
  const o = meta.overpass;
  if (!o?.Aqua || !o?.Terra) return null;
  const sats = ["Terra", "Aqua", "Suomi-NPP", "NOAA-20"].filter((k) => o[k]);
  const at = (sat: string, y: number) => o[sat].find((r) => r[0] === y)?.[1];
  const last = o.Aqua[o.Aqua.length - 1][0];
  const years = [2012, 2015, 2018].concat(Array.from({ length: last - 2019 }, (_, i) => 2020 + i)).filter((y) => at("Aqua", y) != null);
  const a0 = at("Aqua", meta.switch_year - 1), a1 = at("Aqua", last), t0 = at("Terra", meta.switch_year - 1), t1 = at("Terra", last);
  return (
    <section className="blk">
      <h2>Why the record changes sensor in {meta.switch_year}</h2>
      <p>
        A fire looks different at ten in the morning, at half past one and at three in the afternoon, so a sensor is only comparable with
        its own past while it keeps passing at the same time of day. The MODIS satellites stopped holding their orbits. Measured from
        the fire records themselves, Aqua&rsquo;s daytime pass moved from {a0 != null ? clock(a0) : "13:30"} local time in {meta.switch_year - 1} to{" "}
        {a1 != null ? clock(a1) : ""} in {last}, and Terra&rsquo;s from {t0 != null ? clock(t0) : "10:30"} to {t1 != null ? clock(t1) : ""}. VIIRS has stayed within a few minutes.
        From {meta.switch_year} on, a MODIS count is no longer taken the way earlier MODIS counts were, so the calendar carries on with VIIRS.
      </p>
      <div className="tablewrap">
        <table className="data">
          <thead><tr><th scope="col">Year</th>{sats.map((k) => <th key={k} scope="col">{k}</th>)}</tr></thead>
          <tbody>
            {years.map((y) => (
              <tr key={y}><th scope="row">{y}</th>{sats.map((k) => { const h = at(k, y); return <td key={k}>{h == null ? "" : clock(h)}</td>; })}</tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="note">Mean local solar time of daytime detections between 60°S and 60°N.</p>
    </section>
  );
}

export default function Method({ meta, cal, area }: { meta: Meta; cal: Calendar; area: Area }) {
  const v = meta.validation;
  const t = v.totals.SNPP;
  const os = cal.overlapStats;
  const yearly = v.yearly.filter((r) => r.sat === "SNPP");
  return (
    <article className="method">
      <section className="blk">
        <h2>What you are looking at</h2>
        <p>
          A fire detection (often called a hotspot) is one satellite pixel where active burning was seen as the satellite passed over.
          It is not a count of separate fires and not burned area. One large fire produces many detections; a small or short fire
          between passes, or one under thick cloud or smoke, produces none.
        </p>
        <p>
          Burn Almanac counts fire detections from NASA FIRMS and reports the whole record in one unit: the number of fire pixels the
          older MODIS satellites would have recorded. That keeps 2003 and 2026 comparable even though different satellites took them.
        </p>
      </section>

      <section className="blk">
        <h2>Why the two records cannot be compared directly</h2>
        <p>
          MODIS (Terra and Aqua) has watched since late 2000 with pixels about 1 km across. VIIRS (Suomi-NPP from 2012, NOAA-20 from
          2018) has 375 m pixels, sees smaller and cooler fires, and passes only in the early afternoon and after midnight, with no
          morning pass. Over the years both flew, VIIRS reported <strong>{t.raw_viirs_per_modis.toFixed(1)} times</strong> as many
          fire detections as MODIS for the same fires. Joining the two records as they come would look like burning quadrupled the day the
          sensor changed.
        </p>
      </section>

      <section className="blk">
        <h2>How the records are harmonized</h2>
        <ol className="steps">
          <li>
            <strong>Clean up.</strong> Keep vegetation fires only; leave out gas flares, volcanoes and factories, and drop detections the
            satellites themselves rate as low confidence.
          </li>
          <li>
            <strong>Match the pixel size.</strong> Collapse VIIRS pixels to the distinct 1 km cells that burned on each date, so one fire front is
            not counted several times. That alone brings the ratio down from {t.raw_viirs_per_modis.toFixed(1)} to{" "}
            {t.viirs_1km_cells_per_modis.toFixed(1)}.
          </li>
          <li>
            <strong>Calibrate.</strong> For every 1° cell, separately for day and night, measure how many MODIS pixels went with each
            VIIRS 1 km cell while both sensors flew on stable orbits ({v.calibration_years.SNPP[0]}–{v.calibration_years.SNPP[1]} for
            Suomi-NPP, {v.calibration_years.NOAA20[0]}–{v.calibration_years.NOAA20[1]} for NOAA-20). Cells with little data lean on
            their 5° neighbourhood. Worldwide the factor is {v.global_factor.SNPP_D.toFixed(2)} by day and{" "}
            {v.global_factor.SNPP_N.toFixed(2)} by night.
          </li>
          <li>
            <strong>Join.</strong> The calendar uses MODIS as observed up to {v.switch_year - 1} and the VIIRS-based equivalent from{" "}
            {v.switch_year}, when the MODIS orbits began to drift ahead of retirement. Where both VIIRS satellites are available their
            estimates are averaged.
          </li>
        </ol>
      </section>

      <Overpass meta={meta} />

      <section className="blk">
        <h2>How well it holds</h2>
        <p>
          Each calibration year was hidden in turn, predicted from the other years, and compared with what MODIS recorded. The table
          gives the typical (median) error at four scales. Overall bias is {t.bias_pct.toFixed(1)}% for Suomi-NPP and{" "}
          {v.totals.NOAA20.bias_pct.toFixed(1)}% for NOAA-20.
        </p>
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Scale</th>
                <th scope="col">VIIRS as delivered</th>
                <th scope="col">One global factor</th>
                <th scope="col">Burn Almanac, Suomi-NPP</th>
                <th scope="col">Burn Almanac, NOAA-20</th>
              </tr>
            </thead>
            <tbody>
              {SCALES.map(([key, label]) => {
                const m = v[key] as Record<string, SatMetrics>;
                return (
                  <tr key={key}>
                    <th scope="row">{label}</th>
                    <td>{Math.round(m.SNPP.median_abs_pct_error_raw_viirs)}%</td>
                    <td>{m.SNPP.median_abs_pct_error_global_factor.toFixed(1)}%</td>
                    <td><strong>{m.SNPP.median_abs_pct_error.toFixed(1)}%</strong></td>
                    <td><strong>{m.NOAA20.median_abs_pct_error.toFixed(1)}%</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="note">
          Read small areas and single months with that last row in mind: a difference under about 20% between two months in a small
          area is within the method&rsquo;s error.
        </p>
      </section>

      <section className="blk">
        <h2>The seam in {area.label}</h2>
        {os ? (
          <p>
            Across the overlap years the VIIRS-based count for this area is {os.biasPct >= 0 ? "+" : "−"}{Math.abs(os.biasPct).toFixed(1)}%
            against MODIS in total, and differs by a median of {os.medianAbsPct.toFixed(0)}% in the {os.n} months with meaningful burning
            (correlation {os.r.toFixed(2)}).
          </p>
        ) : (
          <p>Too few fire detections in this area during the overlap years to check the seam locally.</p>
        )}
        <SeamChart cal={cal} />
        <p className="keyline"><i className="lm" />MODIS as observed <i className="lv" />VIIRS, calibrated to MODIS units</p>
      </section>

      <section className="blk">
        <h2>The world, year by year</h2>
        <div className="tablewrap">
          <table className="data">
            <thead>
              <tr><th scope="col">Year</th><th scope="col">MODIS observed</th><th scope="col">VIIRS as delivered</th><th scope="col">VIIRS harmonized</th><th scope="col">Difference</th></tr>
            </thead>
            <tbody>
              {yearly.map((r) => (
                <tr key={r.year}>
                  <th scope="row">{r.year}</th>
                  <td>{fmt(r.modis)}</td>
                  <td>{fmt(r.raw_viirs)}</td>
                  <td>{fmt(r.viirs_equivalent)}</td>
                  <td>{((r.viirs_equivalent / r.modis - 1) * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">Suomi-NPP, each year predicted without using that year. Months where the satellite had gaps are left out of both columns.</p>
      </section>

      <section className="blk">
        <h2>Limits to keep in mind</h2>
        <ul className="limits">
          <li>Before July 2002 only Terra was flying, so 2000–2002 counts run low. The default period starts in 2003 for that reason.</li>
          <li>The grid is 0.25°, about 28 km at the equator. Areas smaller than a few cells are read off neighbouring land too.</li>
          <li>Cloud, smoke and the gaps between passes hide fires from every sensor; harmonizing cannot recover what neither saw.</li>
          <li>Burning that moves to a different time of day, for example to late afternoon after the VIIRS pass, shows up as a fall in detections even if as much is burned.</li>
          <li>The critical period comes from MODIS timing in {meta.clim_years[0]}–{meta.clim_years[1]}, in ten-day steps.</li>
          <li>
            Gas flares, volcanoes and other static heat sources are excluded by the FIRMS type flag. Near-real-time data carries no such
            flag, so for the newest months they are excluded by place: spots the 2023–2025 archive flagged at least three times.
          </li>
          {meta.partial && (
            <li>
              The latest month is still in progress. It holds days 1–{meta.partial.day} and is compared with the same days in earlier years,
              not with whole months.
            </li>
          )}
          <li>
            The current year comes from the FIRMS API: standard processing where NASA has released it, near-real-time after that.
            Near-real-time counts can still shift slightly when NASA reprocesses them.
          </li>
        </ul>
        <p className="note">Sources: {meta.sources.join("; ")}. Data version {meta.generated}.</p>
      </section>
    </article>
  );
}
