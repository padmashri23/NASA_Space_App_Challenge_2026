"""Fetch the current year from the NASA FIRMS area API and add it to the Parquet store.

The yearly country archives stop at the end of the last full year. This script pulls the
rest, worldwide, five days per request (the API maximum):
  standard processing (SP) wherever FIRMS has it, near-real-time (NRT) after that.

Writes  data/recent/{SOURCE}/{start}.csv   (raw, resumable)
then    data/parquet/{SENSOR}_{year}.parquet  (same schema as ingest.py)

NRT files carry no `type` column, so static heat sources (gas flares, volcanoes, industry)
cannot be dropped by flag. They are dropped by place instead: any 0.01 degree cell where the
2023-2025 archive flagged type 1, 2 or 3 at least three times is marked type 2.

The key is read from FIRMS_MAP_KEY or web/.env.local; it is never written anywhere else.
Usage: python pipeline/fetch_recent.py [--year 2026] [--until 2026-11-14]
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "recent"
PQ = ROOT / "data" / "parquet"
API = "https://firms.modaps.eosdis.nasa.gov/api"
SENSORS = {"MODIS": "MODIS", "VIIRS_SNPP": "VIIRS_SNPP", "VIIRS_NOAA20": "VIIRS_NOAA20"}
BUDGET = 4200  # stay under the 5000 transactions / 10 minutes limit


def key() -> str:
    k = os.environ.get("FIRMS_MAP_KEY")
    env = ROOT / "web" / ".env.local"
    if not k and env.exists():
        m = re.search(r"^FIRMS_MAP_KEY=(\w+)", env.read_text(encoding="utf-8"), re.M)
        k = m.group(1) if m else None
    if not k:
        sys.exit("No FIRMS_MAP_KEY (set it in the environment or web/.env.local).")
    return k


def get(url: str, timeout: int = 600) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "burn-almanac-pipeline"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def used(k: str) -> int:
    try:
        return int(json.loads(get(f"{API.replace('/api', '')}/mapserver/mapkey_status/?MAP_KEY={k}", 60))["current_transactions"])
    except Exception:
        return 0


def availability(k: str) -> dict[str, tuple[dt.date, dt.date]]:
    out = {}
    for line in get(f"{API}/data_availability/csv/{k}/ALL", 60).decode().splitlines()[1:]:
        p = line.split(",")
        if len(p) == 3:
            out[p[0]] = (dt.date.fromisoformat(p[1]), dt.date.fromisoformat(p[2]))
    return out


def plan(k: str, year: int, until: dt.date) -> list[tuple[str, str, dt.date, int]]:
    av = availability(k)
    jobs = []
    for sensor in SENSORS:
        day = dt.date(year, 1, 1)
        while day <= until:
            src = None
            for kind in ("SP", "NRT"):
                rng = av.get(f"{sensor}_{kind}")
                if rng and rng[0] <= day <= rng[1]:
                    src, last = f"{sensor}_{kind}", rng[1]
                    break
            if not src:
                day += dt.timedelta(days=1)
                continue
            n = min(5, (min(until, last) - day).days + 1)
            jobs.append((sensor, src, day, n))
            day += dt.timedelta(days=n)
    return jobs


def fetch(k: str, jobs: list) -> None:
    def one(job):
        sensor, src, day, n = job
        out = RAW / src / f"{day.isoformat()}_{n}.csv"
        if out.exists() and out.stat().st_size > 0:
            return
        out.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(6):
            while used(k) > BUDGET:
                time.sleep(30)
            try:
                body = get(f"{API}/area/csv/{k}/{src}/world/{n}/{day.isoformat()}")
                if not body.startswith(b"latitude"):
                    raise RuntimeError(body[:120].decode(errors="replace"))
                tmp = out.with_suffix(".part")
                tmp.write_bytes(body)
                tmp.replace(out)
                print(f"{src} {day} +{n}d {len(body) / 1e6:.1f} MB", flush=True)
                return
            except Exception as e:  # network hiccup or rate limit: back off and retry
                print(f"retry {src} {day}: {e}", flush=True)
                time.sleep(20 * (attempt + 1))
        print(f"FAILED {src} {day}", flush=True)

    with ThreadPoolExecutor(3) as pool:
        list(pool.map(one, jobs))


def convert(year: int) -> None:
    con = duckdb.connect()
    con.execute("SET enable_progress_bar=false")
    # Places that the archive itself flagged as non-vegetation heat sources.
    con.execute(f"""
        CREATE TABLE static AS
        SELECT CAST(floor(lat * 100) AS INTEGER) AS gy, CAST(floor(lon * 100) AS INTEGER) AS gx
        FROM read_parquet('{PQ.as_posix()}/*_202[345].parquet')
        WHERE type IN (1, 2, 3) GROUP BY ALL HAVING count(*) >= 3""")
    for sensor in SENSORS:
        files = sorted(RAW.glob(f"{sensor}_*/*.csv"))
        if not files:
            continue
        glob = [f.as_posix() for f in files]
        out = PQ / f"{sensor}_{year}.parquet"
        tmp = out.with_suffix(".part")
        con.execute(f"""
            COPY (
              WITH raw AS (
                SELECT * FROM read_csv({glob}, union_by_name=true, header=true, all_varchar=true, filename=true)
              )
              SELECT CAST(latitude AS FLOAT) AS lat, CAST(longitude AS FLOAT) AS lon,
                     CAST(acq_date AS DATE) AS acq_date, CAST(acq_time AS SMALLINT) AS acq_time,
                     CAST(satellite AS VARCHAR) AS satellite, CAST(confidence AS VARCHAR) AS confidence,
                     CAST(frp AS FLOAT) AS frp, CAST(scan AS FLOAT) AS scan, CAST(track AS FLOAT) AS track,
                     CAST(daynight AS VARCHAR) AS daynight,
                     CAST(CASE
                       WHEN type IS NOT NULL THEN CAST(type AS TINYINT)
                       WHEN s.gy IS NOT NULL THEN 2 ELSE 0 END AS TINYINT) AS type,
                     NULL::VARCHAR AS country
              FROM raw
              LEFT JOIN static s
                ON s.gy = CAST(floor(CAST(latitude AS FLOAT) * 100) AS INTEGER)
               AND s.gx = CAST(floor(CAST(longitude AS FLOAT) * 100) AS INTEGER)
              WHERE year(CAST(acq_date AS DATE)) = {year}
              QUALIFY row_number() OVER (PARTITION BY latitude, longitude, acq_date, acq_time, satellite ORDER BY filename) = 1
            ) TO '{tmp.as_posix()}' (FORMAT parquet, COMPRESSION zstd)""")
        n, d0, d1 = con.execute(f"SELECT count(*), min(acq_date), max(acq_date) FROM read_parquet('{tmp.as_posix()}')").fetchall()[0]
        tmp.replace(out)
        print(f"wrote {out.name}: {n:,} hotspots, {d0} to {d1}", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    today = dt.datetime.now(dt.timezone.utc).date()
    ap.add_argument("--year", type=int, default=today.year)
    ap.add_argument("--until", type=dt.date.fromisoformat, default=today - dt.timedelta(days=1))
    ap.add_argument("--convert-only", action="store_true")
    a = ap.parse_args()
    if not a.convert_only:
        k = key()
        jobs = plan(k, a.year, a.until)
        print(f"{len(jobs)} requests planned", flush=True)
        fetch(k, jobs)
    convert(a.year)


if __name__ == "__main__":
    main()
