"""Convert FIRMS all-countries zip archives into compact Parquet files.

data/raw/{sensor}_{year}_all_countries.zip  ->  data/parquet/{sensor}_{year}.parquet

Each output row is one hotspot with the country (taken from the per-country CSV
file name) attached. Nothing is filtered here; quality filters are applied in
harmonize.py so they stay visible and adjustable in one place.

Usage: python pipeline/ingest.py [--only modis] [--force]
"""
import argparse
import re
import shutil
import sys
import zipfile
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "parquet"
TMP = ROOT / "data" / "tmp"

ZIP_RE = re.compile(r"^(modis|viirs-snpp|viirs-jpss1)_(\d{4})_all_countries\.zip$")
SENSOR_CODE = {"modis": "MODIS", "viirs-snpp": "VIIRS_SNPP", "viirs-jpss1": "VIIRS_NOAA20"}


def convert(zpath: Path, sensor: str, year: int, force: bool) -> None:
    out = OUT / f"{SENSOR_CODE[sensor]}_{year}.parquet"
    if out.exists() and not force:
        print(f"skip {out.name}")
        return
    try:
        zf = zipfile.ZipFile(zpath)
    except zipfile.BadZipFile:
        print(f"BAD ZIP (incomplete download?) {zpath.name}", file=sys.stderr)
        return
    work = TMP / zpath.stem
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    zf.extractall(work)
    csvs = sorted(work.rglob("*.csv"))
    if not csvs:
        print(f"no csv in {zpath.name}", file=sys.stderr)
        return
    con = duckdb.connect()
    con.execute("SET preserve_insertion_order=false")
    con.execute("SET enable_progress_bar=false")
    glob = (work / "**" / "*.csv").as_posix()
    tmp_out = out.with_suffix(".parquet.part")
    # confidence is numeric for MODIS and l/n/h for VIIRS -> read as text.
    con.execute(
        f"""
        COPY (
          SELECT
            CAST(latitude AS FLOAT)  AS lat,
            CAST(longitude AS FLOAT) AS lon,
            CAST(acq_date AS DATE)   AS acq_date,
            CAST(acq_time AS SMALLINT) AS acq_time,
            CAST(satellite AS VARCHAR) AS satellite,
            CAST(confidence AS VARCHAR) AS confidence,
            CAST(frp AS FLOAT) AS frp,
            CAST(scan AS FLOAT) AS scan,
            CAST(track AS FLOAT) AS track,
            CAST(daynight AS VARCHAR) AS daynight,
            CAST(type AS TINYINT) AS type,
            replace(regexp_extract(replace(filename, '\\', '/'), '_\\d{{4}}_([^/]+)\\.csv$', 1), '_', ' ') AS country
          FROM read_csv('{glob}', union_by_name=true, filename=true, header=true,
                        all_varchar=true, ignore_errors=true)
        ) TO '{tmp_out.as_posix()}' (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 500000)
        """
    )
    n = con.execute(f"SELECT count(*) FROM read_parquet('{tmp_out.as_posix()}')").fetchone()[0]
    con.close()
    tmp_out.replace(out)
    shutil.rmtree(work, ignore_errors=True)
    print(f"wrote {out.name}: {n:,} hotspots")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", choices=list(SENSOR_CODE), default=None)
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)
    for z in sorted(RAW.glob("*.zip")):
        m = ZIP_RE.match(z.name)
        if not m:
            continue
        sensor, year = m.group(1), int(m.group(2))
        if args.only and sensor != args.only:
            continue
        convert(z, sensor, year, args.force)


if __name__ == "__main__":
    main()
