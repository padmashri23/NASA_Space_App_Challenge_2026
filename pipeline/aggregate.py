"""Aggregate hotspot Parquet files to a 0.25 degree grid by month and day/night.

data/parquet/{SENSOR}_{year}.parquet  ->  data/agg/{SENSOR}_{year}.parquet

Quality screen (the same rule for archive and near-real-time data):
  MODIS  : type = 0 (presumed vegetation fire), confidence >= 30
  VIIRS  : type = 0, confidence nominal or high

Two counts are kept per grid cell, month and day/night:
  n_raw   : number of fire pixels as delivered by the sensor
  n_cells : number of distinct ~1 km cells (0.01 degree) that burned on a given
            date. For VIIRS this is the "degrade to MODIS scale" step: several
            375 m pixels over one fire front collapse into the 1 km cells a
            MODIS pixel would have covered.

Grid: iy = floor((lat + 90) * 4), ix = floor((lon + 180) * 4)  (GFED-style 0.25 degree).
"""
import argparse
import re
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data" / "parquet"
OUT = ROOT / "data" / "agg"

MODIS_OK = "type = 0 AND try_cast(confidence AS INTEGER) >= 30"
VIIRS_OK = "type = 0 AND lower(confidence) IN ('n', 'h', 'nominal', 'high')"


def run(force: bool) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("SET enable_progress_bar=false")
    for f in sorted(SRC.glob("*.parquet")):
        m = re.match(r"^(MODIS|VIIRS_SNPP|VIIRS_NOAA20)_(\d{4})$", f.stem)
        if not m:
            continue
        out = OUT / f.name
        if out.exists() and not force:
            continue
        ok = MODIS_OK if m.group(1) == "MODIS" else VIIRS_OK
        tmp = out.with_suffix(".part")
        con.execute(
            f"""
            COPY (
              SELECT
                CAST(floor((lat + 90) * 4) AS SMALLINT)  AS iy,
                CAST(floor((lon + 180) * 4) AS SMALLINT) AS ix,
                CAST(year(acq_date) AS SMALLINT)  AS y,
                CAST(month(acq_date) AS TINYINT)  AS m,
                upper(daynight) AS dn,
                country,
                count(*) AS n_raw,
                count(DISTINCT (CAST(floor(lat * 100) AS INTEGER), CAST(floor(lon * 100) AS INTEGER), acq_date)) AS n_cells,
                CAST(sum(frp) AS FLOAT) AS frp
              FROM read_parquet('{f.as_posix()}')
              WHERE {ok} AND lat BETWEEN -90 AND 89.999 AND lon BETWEEN -180 AND 179.999
              GROUP BY ALL
            ) TO '{tmp.as_posix()}' (FORMAT parquet, COMPRESSION zstd)
            """
        )
        n, raw = con.execute(f"SELECT count(*), sum(n_raw) FROM read_parquet('{tmp.as_posix()}')").fetchall()[0]
        tmp.replace(out)
        print(f"{out.name}: {n:,} cell-months, {raw:,} hotspots kept", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    run(ap.parse_args().force)
