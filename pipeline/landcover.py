"""What was burning, and how hot: land-cover type and fire strength for every detection.

1. Downloads NASA's yearly MODIS land cover (MCD12Q1/MCD12C1 combined IGBP classes, 2001-2024) from
   NASA GIBS as a 0.05 degree world image and turns its class colours into four groups:
     0 cropland            IGBP 12 croplands, 14 cropland/natural mosaic
     1 forest              IGBP 1-5
     2 grass, savanna, shrub  IGBP 6-10
     3 other               wetlands, urban, snow, barren, water, unclassified
   Each fire uses the land cover of the year before it burned (the map of the burn year already shows the scar);
   years after 2024 use 2024.
2. Re-aggregates every hotspot file by 0.25 degree cell, month and group, and keeps fire radiative power.

Writes data/landcover/lc_{year}.npy and data/agg_lc/{SENSOR}_{year}.parquet
"""
import io
import re
import sys
import time
import urllib.request
from pathlib import Path

import duckdb
import numpy as np
import pyarrow as pa
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
LC = ROOT / "data" / "landcover"
PQ = ROOT / "data" / "parquet"
OUT = ROOT / "data" / "agg_lc"
WMS = ("https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0"
       "&LAYERS=MODIS_Combined_L3_IGBP_Land_Cover_Type_Annual&CRS=EPSG:4326&BBOX=-90,-180,90,180"
       "&WIDTH=7200&HEIGHT=3600&FORMAT=image/png&TIME={y}-01-01")
FIRST, LAST = 2001, 2024
# GIBS colour map MODIS_IGBP_Land_Cover_Type (v1.3), in IGBP class order 1..17 then unclassified.
COLOURS = [(33, 138, 33), (49, 204, 49), (152, 204, 49), (150, 250, 150), (141, 186, 141), (186, 141, 141),
           (245, 222, 179), (218, 235, 157), (255, 213, 0), (240, 185, 103), (71, 131, 181), (250, 239, 115),
           (255, 0, 0), (153, 147, 86), (255, 255, 255), (191, 191, 189), (134, 202, 227), (100, 100, 100)]
GROUP = {1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 2, 10: 2, 12: 0, 14: 0}

MODIS_OK = "type = 0 AND try_cast(confidence AS INTEGER) >= 30"
VIIRS_OK = "type = 0 AND lower(confidence) IN ('n', 'h', 'nominal', 'high')"


def download() -> None:
    LC.mkdir(parents=True, exist_ok=True)
    lut = np.full(256 ** 3, 3, dtype=np.uint8)
    for i, (r, g, b) in enumerate(COLOURS, start=1):
        lut[(r << 16) | (g << 8) | b] = GROUP.get(i, 3)
    for y in range(FIRST, LAST + 1):
        out = LC / f"lc_{y}.npy"
        if out.exists():
            continue
        for attempt in range(5):
            try:
                with urllib.request.urlopen(WMS.format(y=y), timeout=300) as r:
                    im = Image.open(io.BytesIO(r.read())).convert("RGB")
                break
            except Exception as e:
                print("retry", y, e, flush=True)
                time.sleep(10 * (attempt + 1))
        a = np.asarray(im, dtype=np.uint32)
        grp = lut[(a[..., 0] << 16) | (a[..., 1] << 8) | a[..., 2]]
        np.save(out, grp)
        print(f"land cover {y}: cropland {np.mean(grp == 0):.3f} forest {np.mean(grp == 1):.3f} grass {np.mean(grp == 2):.3f}", flush=True)


def enrich(force: bool) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("SET enable_progress_bar=false")
    maps = {}
    for f in sorted(PQ.glob("*.parquet")):
        m = re.match(r"^(MODIS|VIIRS_SNPP|VIIRS_NOAA20)_(\d{4})$", f.stem)
        if not m:
            continue
        out = OUT / f.name
        if out.exists() and not force:
            continue
        year = int(m.group(2))
        lcy = min(max(year - 1, FIRST), LAST)
        if lcy not in maps:
            maps[lcy] = np.load(LC / f"lc_{lcy}.npy")
        grid = maps[lcy]
        ok = MODIS_OK if m.group(1) == "MODIS" else VIIRS_OK
        t = con.execute(f"""
            SELECT lat, lon, acq_date, upper(daynight) AS dn, frp FROM read_parquet('{f.as_posix()}')
            WHERE {ok} AND lat BETWEEN -90 AND 89.999 AND lon BETWEEN -180 AND 179.999""").to_arrow_table()
        lat = t.column("lat").to_numpy(zero_copy_only=False)
        lon = t.column("lon").to_numpy(zero_copy_only=False)
        row = np.clip(((90 - lat) / 0.05).astype(np.int32), 0, 3599)
        col = np.clip(((lon + 180) / 0.05).astype(np.int32), 0, 7199)
        t = t.append_column("g", pa.array(grid[row, col]))
        con.register("t", t)
        tmp = out.with_suffix(".part")
        con.execute(f"""
            COPY (
              SELECT CAST(floor((lat + 90) * 4) AS SMALLINT) AS iy, CAST(floor((lon + 180) * 4) AS SMALLINT) AS ix,
                     CAST(year(acq_date) AS SMALLINT) AS y, CAST(month(acq_date) AS TINYINT) AS m, g,
                     count(*) AS n_raw,
                     count(DISTINCT (CAST(floor(lat * 100) AS INTEGER), CAST(floor(lon * 100) AS INTEGER), acq_date)) AS n_cells,
                     CAST(sum(frp) AS FLOAT) AS frp
              FROM t GROUP BY ALL
            ) TO '{tmp.as_posix()}' (FORMAT parquet, COMPRESSION zstd)""")
        con.unregister("t")
        tmp.replace(out)
        print(f"{out.name}: {len(lat):,} detections, land cover {lcy}", flush=True)


if __name__ == "__main__":
    download()
    enrich("--force" in sys.argv)
