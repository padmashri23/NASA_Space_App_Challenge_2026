"""Measure when each satellite actually passes over, year by year.

Mean local solar time of daytime detections (UTC + longitude / 15), from the hotspot
records themselves. It shows the MODIS orbits drifting after 2021 while VIIRS holds
steady, which is why the harmonized record switches to VIIRS in 2022.

Writes data/harmonized/overpass.json and patches web/public/data/meta.json if present.
"""
import json
from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent
PQ = (ROOT / "data" / "parquet").as_posix()
OUT = ROOT / "data" / "harmonized" / "overpass.json"
META = ROOT / "web" / "public" / "data" / "meta.json"

Q = """
SELECT year(acq_date) AS y, {sat} AS sat,
       avg(((acq_time // 100) * 60 + acq_time % 100) / 60.0 + lon / 15.0
           - 24 * floor((((acq_time // 100) * 60 + acq_time % 100) / 60.0 + lon / 15.0) / 24)) AS h
FROM read_parquet('{glob}')
WHERE upper(daynight) = 'D' AND type = 0 AND abs(lat) < 60
GROUP BY ALL HAVING count(*) > 50000 ORDER BY 2, 1
"""


def main() -> None:
    con = duckdb.connect()
    con.execute("SET enable_progress_bar=false")
    rows = con.execute(Q.format(sat="satellite", glob=f"{PQ}/MODIS_*.parquet")).fetchall()
    rows += con.execute(Q.format(sat="'Suomi-NPP'", glob=f"{PQ}/VIIRS_SNPP_*.parquet")).fetchall()
    rows += con.execute(Q.format(sat="'NOAA-20'", glob=f"{PQ}/VIIRS_NOAA20_*.parquet")).fetchall()
    out: dict[str, list] = {}
    for y, sat, h in rows:
        out.setdefault(str(sat), []).append([int(y), round(float(h), 3)])
    OUT.write_text(json.dumps(out), encoding="utf-8")
    if META.exists():
        meta = json.loads(META.read_text(encoding="utf-8"))
        meta["overpass"] = out
        META.write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    for sat, v in out.items():
        print(sat, v[0], "...", v[-1])


if __name__ == "__main__":
    main()
