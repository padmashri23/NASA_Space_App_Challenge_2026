"""Harmonize MODIS and VIIRS hotspots into one MODIS-equivalent monthly record.

Reference unit: MODIS Collection 6.1 fire pixels (Terra + Aqua), type 0, confidence >= 30.

Method ("degrade, don't invent"):
  1. Degrade. VIIRS 375 m pixels are collapsed to distinct ~1 km cells per date
     (done in aggregate.py), so one fire front is not counted three to nine times.
  2. Calibrate. In the years both sensors flew with stable orbits, a local factor
       a(cell, day|night) = MODIS pixels / VIIRS 1 km cells
     is estimated on a 1 degree grid. It absorbs what resolution alone cannot:
     VIIRS sees smaller and cooler fires, and it has no morning overpass.
     Cells with little data borrow strength from their 5 degree block and then
     from the global ratio (empirical-Bayes shrinkage).
  3. Validate. Each calibration year is held out in turn, predicted from the
     other years, and compared with what MODIS actually recorded.
  4. Combine. harmonized = MODIS observed up to SWITCH_YEAR - 1, and the mean of
     the available VIIRS satellites' MODIS-equivalents from SWITCH_YEAR on
     (MODIS orbits have drifted since 2022 and the sensors are being retired).

Outputs: data/harmonized/monthly.parquet, calibration.parquet, validation.json
"""
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
AGG = (ROOT / "data" / "agg").as_posix()
PQ = (ROOT / "data" / "parquet").as_posix()
OUT = ROOT / "data" / "harmonized"

CAL = {"SNPP": (2012, 2021), "NOAA20": (2018, 2021)}
SWITCH_YEAR = 2022
K_CELL = 300.0    # prior weight, in VIIRS 1 km cells, pulling a cell towards its block
K_BLOCK = 2000.0  # prior weight pulling a 5 degree block towards the global ratio
MIN_DAYS = 25     # a satellite-month counts as observed only with data on this many days


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("SET enable_progress_bar=false")

    con.execute(f"""
        CREATE TABLE mod AS
        SELECT iy, ix, y, m, dn, sum(n_raw) AS n
        FROM read_parquet('{AGG}/MODIS_*.parquet') GROUP BY ALL""")
    con.execute(f"""
        CREATE TABLE vi AS
        SELECT 'SNPP' AS sat, iy, ix, y, m, dn, sum(n_cells) AS c, sum(n_raw) AS r
        FROM read_parquet('{AGG}/VIIRS_SNPP_*.parquet') GROUP BY ALL
        UNION ALL
        SELECT 'NOAA20', iy, ix, y, m, dn, sum(n_cells), sum(n_raw)
        FROM read_parquet('{AGG}/VIIRS_NOAA20_*.parquet') GROUP BY ALL""")

    # Which satellite-months are complete enough to use. The record's last month may be
    # partial; there a satellite needs data on all but one of the days the record covers.
    con.execute(f"""
        CREATE TABLE days AS
        SELECT 'SNPP' AS sat, year(acq_date) AS y, month(acq_date) AS m, count(DISTINCT acq_date) AS days, max(acq_date) AS last
        FROM read_parquet('{PQ}/VIIRS_SNPP_*.parquet') GROUP BY ALL
        UNION ALL
        SELECT 'NOAA20', year(acq_date), month(acq_date), count(DISTINCT acq_date), max(acq_date)
        FROM read_parquet('{PQ}/VIIRS_NOAA20_*.parquet') GROUP BY ALL""")
    record_end = con.execute("SELECT max(last) FROM days").fetchall()[0][0]
    con.execute(f"""
        CREATE TABLE avail AS
        SELECT sat, y, m, days FROM days
        WHERE days >= CASE WHEN y = {record_end.year} AND m = {record_end.month}
                           THEN greatest(1, {record_end.day} - 1) ELSE {MIN_DAYS} END""")

    cal_filter = " OR ".join(f"(sat = '{s}' AND y BETWEEN {a} AND {b})" for s, (a, b) in CAL.items())

    # Yearly sums per 1 degree cell and day/night over matched, usable months.
    con.execute(f"""
        CREATE TABLE t AS
        WITH v AS (
          SELECT vi.sat, iy // 4 AS cy, ix // 4 AS cx, dn, vi.y, sum(c) AS v
          FROM vi JOIN avail USING (sat, y, m) WHERE {cal_filter.replace('sat', 'vi.sat').replace(' y ', ' vi.y ')}
          GROUP BY ALL),
        mo AS (
          SELECT avail.sat, iy // 4 AS cy, ix // 4 AS cx, dn, mod.y, sum(n) AS mm
          FROM mod JOIN avail ON mod.y = avail.y AND mod.m = avail.m
          WHERE {cal_filter.replace('sat', 'avail.sat').replace(' y ', ' mod.y ')}
          GROUP BY ALL)
        SELECT coalesce(v.sat, mo.sat) AS sat, coalesce(v.cy, mo.cy) AS cy, coalesce(v.cx, mo.cx) AS cx,
               coalesce(v.dn, mo.dn) AS dn, coalesce(v.y, mo.y) AS y,
               coalesce(mm, 0)::DOUBLE AS mm, coalesce(v, 0)::DOUBLE AS v
        FROM v FULL OUTER JOIN mo USING (sat, cy, cx, dn, y)""")

    # Leave-one-year-out and full ratios at three levels.
    con.execute("""
        CREATE TABLE g AS
        SELECT sat, dn, y, mm, v, sum(mm) OVER w AS mt, sum(v) OVER w AS vt
        FROM (SELECT sat, dn, y, sum(mm) AS mm, sum(v) AS v FROM t GROUP BY ALL)
        WINDOW w AS (PARTITION BY sat, dn)""")
    con.execute("""
        CREATE TABLE b AS
        SELECT sat, gy, gx, dn, y, mm, v, sum(mm) OVER w AS mt, sum(v) OVER w AS vt
        FROM (SELECT sat, cy // 5 AS gy, cx // 5 AS gx, dn, y, sum(mm) AS mm, sum(v) AS v FROM t GROUP BY ALL)
        WINDOW w AS (PARTITION BY sat, gy, gx, dn)""")
    con.execute("""
        CREATE TABLE c AS
        SELECT sat, cy, cx, dn, y, mm, v, sum(mm) OVER w AS mt, sum(v) OVER w AS vt
        FROM t WINDOW w AS (PARTITION BY sat, cy, cx, dn)""")

    # Full (production) factors.
    con.execute(f"""
        CREATE TABLE gfull AS SELECT DISTINCT sat, dn, mt / nullif(vt, 0) AS rg FROM g;
        CREATE TABLE bfull AS
          SELECT DISTINCT b.sat, gy, gx, b.dn, (b.mt + {K_BLOCK} * rg) / (b.vt + {K_BLOCK}) AS rb
          FROM b JOIN gfull USING (sat, dn);
        CREATE TABLE cfull AS
          SELECT DISTINCT c.sat, cy, cx, c.dn, c.mt, c.vt, (c.mt + {K_CELL} * rb) / (c.vt + {K_CELL}) AS a
          FROM c JOIN bfull ON c.sat = bfull.sat AND c.dn = bfull.dn AND c.cy // 5 = bfull.gy AND c.cx // 5 = bfull.gx;
    """)
    # Leave-one-year-out factors (year y removed from every level).
    con.execute(f"""
        CREATE TABLE gl AS SELECT sat, dn, y, (mt - mm) / nullif(vt - v, 0) AS rg FROM g;
        CREATE TABLE bl AS
          SELECT b.sat, gy, gx, b.dn, b.y, ((b.mt - b.mm) + {K_BLOCK} * rg) / ((b.vt - b.v) + {K_BLOCK}) AS rb
          FROM b JOIN gl USING (sat, dn, y);
        CREATE TABLE cl AS
          SELECT c.sat, cy, cx, c.dn, c.y, ((c.mt - c.mm) + {K_CELL} * rb) / ((c.vt - c.v) + {K_CELL}) AS a
          FROM c JOIN bl ON c.sat = bl.sat AND c.dn = bl.dn AND c.y = bl.y AND c.cy // 5 = bl.gy AND c.cx // 5 = bl.gx;
    """)

    # ---------- validation: predict each held-out year ----------
    con.execute(f"""
        CREATE TABLE val AS
        WITH p AS (
          SELECT vi.sat, iy // 4 AS cy, ix // 4 AS cx, vi.y, vi.m,
                 sum(cl.a * c) AS pred, sum(gfull.rg * c) AS pred_global, sum(r) AS raw, sum(c) AS cells
          FROM vi JOIN avail USING (sat, y, m)
          JOIN cl ON cl.sat = vi.sat AND cl.cy = iy // 4 AND cl.cx = ix // 4 AND cl.dn = vi.dn AND cl.y = vi.y
          JOIN gfull ON gfull.sat = vi.sat AND gfull.dn = vi.dn
          WHERE {cal_filter.replace('sat', 'vi.sat').replace(' y ', ' vi.y ')}
          GROUP BY ALL),
        o AS (
          SELECT avail.sat, iy // 4 AS cy, ix // 4 AS cx, mod.y, mod.m, sum(n) AS obs
          FROM mod JOIN avail ON mod.y = avail.y AND mod.m = avail.m
          WHERE {cal_filter.replace('sat', 'avail.sat').replace(' y ', ' mod.y ')}
          GROUP BY ALL)
        SELECT coalesce(p.sat, o.sat) AS sat, coalesce(p.cy, o.cy) AS cy, coalesce(p.cx, o.cx) AS cx,
               coalesce(p.y, o.y) AS y, coalesce(p.m, o.m) AS m,
               coalesce(obs, 0)::DOUBLE AS obs, coalesce(pred, 0) AS pred, coalesce(pred_global, 0) AS pred_global,
               coalesce(raw, 0)::DOUBLE AS raw, coalesce(cells, 0)::DOUBLE AS cells
        FROM p FULL OUTER JOIN o USING (sat, cy, cx, y, m)""")

    def metrics(level_sql: str, min_obs: int) -> dict:
        out = {}
        rows = con.execute(f"""
            WITH a AS ({level_sql})
            SELECT sat, count(*) AS n,
                   median(abs(pred - obs) / obs) AS mape_local,
                   median(abs(pred_global - obs) / obs) AS mape_global,
                   median(abs(cells - obs) / obs) AS mape_degraded_only,
                   median(abs(raw - obs) / obs) AS mape_raw,
                   avg(CASE WHEN abs(pred - obs) / obs <= 0.25 THEN 1 ELSE 0 END) AS within25,
                   corr(ln(1 + pred), ln(1 + obs)) AS r_log,
                   median(raw / obs) AS raw_ratio
            FROM a WHERE obs >= {min_obs} GROUP BY sat ORDER BY sat""").fetchall()
        for sat, n, ml, mg, md, mr, w25, r, rr in rows:
            out[sat] = dict(n=n, median_abs_pct_error=round(ml * 100, 1), median_abs_pct_error_global_factor=round(mg * 100, 1),
                            median_abs_pct_error_degraded_only=round(md * 100, 1), median_abs_pct_error_raw_viirs=round(mr * 100, 1),
                            share_within_25pct=round(w25 * 100, 1), r_log=round(r, 3), raw_viirs_to_modis_ratio=round(rr, 2))
        return out

    cols = "sum(obs) AS obs, sum(pred) AS pred, sum(pred_global) AS pred_global, sum(raw) AS raw, sum(cells) AS cells"
    report = {
        "reference_unit": "MODIS C6.1 fire pixels (Terra + Aqua), type 0, confidence >= 30",
        "calibration_years": CAL, "switch_year": SWITCH_YEAR,
        "method": "leave-one-year-out: every calibration year predicted from the other years",
        "cell_1deg_month": metrics("SELECT * FROM val", 25),
        "block_5deg_month": metrics(f"SELECT sat, cy // 5 AS gy, cx // 5 AS gx, y, m, {cols} FROM val GROUP BY ALL", 100),
        "global_month": metrics(f"SELECT sat, y, m, {cols} FROM val GROUP BY ALL", 1000),
        "global_year": metrics(f"SELECT sat, y, {cols} FROM val GROUP BY ALL", 1000),
    }
    bias = con.execute("SELECT sat, sum(pred) / sum(obs) - 1, sum(raw) / sum(obs), sum(cells) / sum(obs) FROM val GROUP BY sat ORDER BY sat").fetchall()
    report["totals"] = {s: dict(bias_pct=round(b * 100, 2), raw_viirs_per_modis=round(r, 2), viirs_1km_cells_per_modis=round(c, 2)) for s, b, r, c in bias}
    report["global_factor"] = {f"{s}_{dn}": round(rg, 3) for s, dn, rg in con.execute("SELECT * FROM gfull ORDER BY 1, 2").fetchall()}
    report["yearly"] = [dict(sat=s, year=y, modis=int(o), viirs_equivalent=int(p), raw_viirs=int(r))
                        for s, y, o, p, r in con.execute("SELECT sat, y, sum(obs), sum(pred), sum(raw) FROM val GROUP BY ALL ORDER BY 1, 2").fetchall()]

    # ---------- production record ----------
    con.execute(f"""
        CREATE TABLE eq AS
        SELECT vi.sat, iy, ix, vi.y, vi.m,
               sum(coalesce(cfull.a, bfull.rb, gfull.rg) * c) AS eq, sum(r) AS raw
        FROM vi JOIN avail USING (sat, y, m)
        JOIN gfull ON gfull.sat = vi.sat AND gfull.dn = vi.dn
        LEFT JOIN bfull ON bfull.sat = vi.sat AND bfull.dn = vi.dn AND bfull.gy = iy // 20 AND bfull.gx = ix // 20
        LEFT JOIN cfull ON cfull.sat = vi.sat AND cfull.dn = vi.dn AND cfull.cy = iy // 4 AND cfull.cx = ix // 4
        GROUP BY ALL""")
    con.execute(f"""
        COPY (
          WITH mo AS (SELECT iy, ix, y, m, sum(n) AS modis FROM mod GROUP BY ALL),
          -- mean over the satellites usable that month; a satellite that saw nothing in a cell counts as zero
          nsat AS (SELECT y, m, count(*) AS k FROM avail GROUP BY ALL),
          ve AS (SELECT iy, ix, y, m, sum(eq) / any_value(k) AS viirs_eq, sum(raw) / any_value(k) AS viirs_raw,
                        max(CASE WHEN sat = 'SNPP' THEN eq END) AS snpp_eq, max(CASE WHEN sat = 'NOAA20' THEN eq END) AS noaa20_eq
                 FROM eq JOIN nsat USING (y, m) GROUP BY iy, ix, y, m)
          SELECT coalesce(mo.iy, ve.iy)::SMALLINT AS iy, coalesce(mo.ix, ve.ix)::SMALLINT AS ix,
                 coalesce(mo.y, ve.y)::SMALLINT AS y, coalesce(mo.m, ve.m)::TINYINT AS m,
                 coalesce(modis, 0)::INTEGER AS modis, viirs_eq::FLOAT AS viirs_eq, viirs_raw::FLOAT AS viirs_raw,
                 snpp_eq::FLOAT AS snpp_eq, noaa20_eq::FLOAT AS noaa20_eq
          FROM mo FULL OUTER JOIN ve USING (iy, ix, y, m)
        ) TO '{(OUT / 'monthly.parquet').as_posix()}' (FORMAT parquet, COMPRESSION zstd)""")
    con.execute(f"COPY cfull TO '{(OUT / 'calibration.parquet').as_posix()}' (FORMAT parquet)")
    # The factor actually applied to every satellite, 1 degree cell and day/night (cell, else block, else global).
    con.execute(f"""
        COPY (
          SELECT DISTINCT vi.sat, iy // 4 AS cy, ix // 4 AS cx, vi.dn, coalesce(cfull.a, bfull.rb, gfull.rg) AS a
          FROM vi
          JOIN gfull ON gfull.sat = vi.sat AND gfull.dn = vi.dn
          LEFT JOIN bfull ON bfull.sat = vi.sat AND bfull.dn = vi.dn AND bfull.gy = iy // 20 AND bfull.gx = ix // 20
          LEFT JOIN cfull ON cfull.sat = vi.sat AND cfull.dn = vi.dn AND cfull.cy = iy // 4 AND cfull.cx = ix // 4
        ) TO '{(OUT / 'factors.parquet').as_posix()}' (FORMAT parquet)""")
    report["record_end"] = record_end.isoformat()
    con.execute(f"COPY avail TO '{(OUT / 'availability.parquet').as_posix()}' (FORMAT parquet)")

    n = con.execute(f"SELECT count(*) FROM read_parquet('{(OUT / 'monthly.parquet').as_posix()}')").fetchall()[0][0]
    report["monthly_rows"] = n
    (OUT / "validation.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("totals", "global_factor", "cell_1deg_month", "block_5deg_month", "global_month", "global_year", "monthly_rows")}, indent=1))


if __name__ == "__main__":
    main()
