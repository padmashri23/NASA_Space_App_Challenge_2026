"""Write the harmonized record as static files the web app reads directly.

web/public/data/
  meta.json                 calendar axis, tile index, validation figures, country index
  tiles/t_{ty}_{tx}.bin.gz  10 degree tiles of the 0.25 degree monthly record + 10-day seasonal profile
  countries.bin.gz          grid cells belonging to each country (Uint32 cell ids)
  clim_annual.png, clim_m01..12.png   Web-Mercator overview images (mean hotspots per cell)

Tile layout (little endian):
  'BAT1' | uint32 n | uint32 n2
  cell  Uint16[n]   local cell = (iy % 40) * 40 + (ix % 40)
  mon   Uint16[n]   months since January ORIGIN_YEAR
  modis Uint16[n]   MODIS observed pixels
  veq   Uint16[n]   VIIRS MODIS-equivalent x VEQ_SCALE
  cell2 Uint16[n2] | dekad Uint16[n2] (0..35) | count Uint32[n2]   MODIS seasonal profile, summed over CLIM years
  'BAT3' (current) has header 'BAT3' | n | n2 | n3 | n5 and, after the BAT2 sections:
  share  Uint8[3n] (padded to 4 bytes)   per cell-month row: share of detections on cropland, forest,
                                         grass/savanna/shrub, each x255 (the rest is other land)
  cell5 Uint16[n5] | year Uint16[n5] | frp Float32[n5] | count Uint32[n5]
                                         VIIRS fire radiative power (MW, summed) and detections per cell-year, 2012 on
  'BAT2' adds, after uint32 n3 in the header:
  cell3 Uint16[n3] | year Uint16[n3] (years since ORIGIN_YEAR) | value Uint16[n3] (x VEQ_SCALE)
    harmonized hotspots in days 1..D of the record's last month, for every earlier year,
    so a month in progress is compared with the same days in past years.
"""
import gzip
import json
import math
import struct
import calendar
from datetime import datetime, timezone
from pathlib import Path

import duckdb
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
H = ROOT / "data" / "harmonized"
PQ = (ROOT / "data" / "parquet").as_posix()
AGG = (ROOT / "data" / "agg").as_posix()
OUT = ROOT / "web" / "public" / "data"
ORIGIN_YEAR = 2000
VEQ_SCALE = 8
CLIM = (2003, 2021)  # both MODIS instruments flying, orbits stable
# Dark-map ramp: more fire is brighter (dark red to pale yellow), monotonic in lightness for colour-blind readers.
RAMP = [(74, 29, 22), (126, 36, 22), (192, 50, 30), (236, 106, 28), (245, 181, 42), (255, 240, 168)]
LAT_S, LAT_N = -60.0, 75.0


def main() -> None:
    (OUT / "tiles").mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    con.execute("SET enable_progress_bar=false")
    mp = (H / "monthly.parquet").as_posix()
    con.execute(f"""
        CREATE TABLE mo AS
        SELECT iy, ix, (y - {ORIGIN_YEAR}) * 12 + (m - 1) AS mon, modis,
               coalesce(viirs_eq, 0) AS veq
        FROM read_parquet('{mp}') WHERE iy BETWEEN 0 AND 719 AND ix BETWEEN 0 AND 1439""")
    con.execute(f"""
        CREATE TABLE dek AS
        SELECT CAST(floor((lat + 90) * 4) AS INTEGER) AS iy, CAST(floor((lon + 180) * 4) AS INTEGER) AS ix,
               (month(acq_date) - 1) * 3 + least(2, (day(acq_date) - 1) // 10) AS d, count(*) AS n
        FROM read_parquet('{PQ}/MODIS_*.parquet')
        WHERE type = 0 AND try_cast(confidence AS INTEGER) >= 30 AND year(acq_date) BETWEEN {CLIM[0]} AND {CLIM[1]}
          AND lat BETWEEN -90 AND 89.999 AND lon BETWEEN -180 AND 179.999
        GROUP BY ALL""")

    # ---- month to date: the record's last month may be partial ----
    val0 = json.loads((H / "validation.json").read_text(encoding="utf-8"))
    end = datetime.strptime(val0["record_end"], "%Y-%m-%d").date() if val0.get("record_end") else None
    partial = None
    con.execute("CREATE TABLE mtd (iy INTEGER, ix INTEGER, y INTEGER, v DOUBLE)")
    if end and end.day < calendar.monthrange(end.year, end.month)[1]:
        M, D, sw = end.month, end.day, val0["switch_year"]
        partial = dict(mon=(end.year - ORIGIN_YEAR) * 12 + M - 1, day=D, days_in_month=calendar.monthrange(end.year, M)[1])
        cell = "CAST(floor((lat + 90) * 4) AS INTEGER) AS iy, CAST(floor((lon + 180) * 4) AS INTEGER) AS ix"
        sel = f"month(acq_date) = {M} AND day(acq_date) <= {D} AND lat BETWEEN -90 AND 89.999 AND lon BETWEEN -180 AND 179.999"
        con.execute(f"""
            INSERT INTO mtd
            SELECT {cell}, year(acq_date), count(*) FROM read_parquet('{PQ}/MODIS_*.parquet')
            WHERE type = 0 AND try_cast(confidence AS INTEGER) >= 30 AND {sel} AND year(acq_date) < {sw}
            GROUP BY ALL""")
        fac = (H / "factors.parquet").as_posix()
        avp = (H / "availability.parquet").as_posix()
        con.execute(f"""
            INSERT INTO mtd
            WITH c AS (
              SELECT 'SNPP' AS sat, {cell}, year(acq_date) AS y, upper(daynight) AS dn,
                     count(DISTINCT (CAST(floor(lat * 100) AS INTEGER), CAST(floor(lon * 100) AS INTEGER), acq_date)) AS c
              FROM read_parquet('{PQ}/VIIRS_SNPP_*.parquet')
              WHERE type = 0 AND lower(confidence) IN ('n', 'h') AND {sel} AND year(acq_date) BETWEEN {sw} AND {end.year - 1} GROUP BY ALL
              UNION ALL
              SELECT 'NOAA20', {cell}, year(acq_date), upper(daynight),
                     count(DISTINCT (CAST(floor(lat * 100) AS INTEGER), CAST(floor(lon * 100) AS INTEGER), acq_date))
              FROM read_parquet('{PQ}/VIIRS_NOAA20_*.parquet')
              WHERE type = 0 AND lower(confidence) IN ('n', 'h') AND {sel} AND year(acq_date) BETWEEN {sw} AND {end.year - 1} GROUP BY ALL),
            k AS (SELECT y, count(*) AS k FROM read_parquet('{avp}') WHERE m = {M} GROUP BY y)
            SELECT c.iy, c.ix, c.y, sum(c.c * f.a) / any_value(k.k)
            FROM c JOIN read_parquet('{avp}') av ON av.sat = c.sat AND av.y = c.y AND av.m = {M}
            JOIN k ON k.y = c.y
            JOIN read_parquet('{fac}') f ON f.sat = c.sat AND f.cy = c.iy // 4 AND f.cx = c.ix // 4 AND f.dn = c.dn
            GROUP BY c.iy, c.ix, c.y""")
        print("month to date:", partial, con.execute("SELECT count(*), sum(v) FROM mtd").fetchall()[0])

    # ---- what was burning: land-cover shares per cell-month, from the sensor the record uses that month ----
    lc = (ROOT / "data" / "agg_lc").as_posix()
    sw = val0["switch_year"]
    con.execute(f"""
        CREATE TABLE share AS
        WITH src AS (
          SELECT iy, ix, y, m, g, n_raw::DOUBLE AS n FROM read_parquet('{lc}/MODIS_*.parquet') WHERE y < {sw}
          UNION ALL
          SELECT iy, ix, y, m, g, n_cells::DOUBLE FROM read_parquet('{lc}/VIIRS_*.parquet') WHERE y >= {sw}),
        t AS (SELECT iy, ix, (y - {ORIGIN_YEAR}) * 12 + (m - 1) AS mon, g, sum(n) AS n FROM src GROUP BY ALL)
        SELECT iy, ix, mon,
               round(255 * sum(n) FILTER (WHERE g = 0) / sum(n))::UTINYINT AS s0,
               round(255 * sum(n) FILTER (WHERE g = 1) / sum(n))::UTINYINT AS s1,
               round(255 * sum(n) FILTER (WHERE g = 2) / sum(n))::UTINYINT AS s2
        FROM t GROUP BY ALL""")
    # ---- how hot: VIIRS fire radiative power per cell-year ----
    con.execute(f"""
        CREATE TABLE frp AS
        SELECT iy, ix, y, sum(frp)::DOUBLE AS frp, sum(n_raw)::BIGINT AS n
        FROM read_parquet('{lc}/VIIRS_*.parquet') GROUP BY ALL""")
    print("shares", con.execute("SELECT count(*) FROM share").fetchall()[0][0], "frp rows", con.execute("SELECT count(*) FROM frp").fetchall()[0][0])

    last_mon = con.execute("SELECT max(mon) FROM mo").fetchall()[0][0]
    n_months = last_mon + 1
    av = con.execute(f"SELECT DISTINCT (y - {ORIGIN_YEAR}) * 12 + (m - 1) FROM read_parquet('{(H / 'availability.parquet').as_posix()}')").fetchall()
    viirs_valid = [0] * n_months
    for (i,) in av:
        if 0 <= i < n_months:
            viirs_valid[i] = 1
    modis_first = con.execute("SELECT min(mon) FROM mo WHERE modis > 0").fetchall()[0][0]
    clipped = con.execute(f"SELECT count(*) FILTER (WHERE modis > 65535), count(*) FILTER (WHERE veq * {VEQ_SCALE} > 65535), max(modis), max(veq) FROM mo").fetchall()[0]
    print("clipped modis/veq rows, max modis, max veq:", clipped)

    tiles = []
    keys = con.execute("SELECT DISTINCT iy // 40, ix // 40 FROM mo ORDER BY 1, 2").fetchall()
    total = 0
    for ty, tx in keys:
        a = con.execute(f"""SELECT (iy % 40) * 40 + (ix % 40), mon, least(modis, 65535), least(round(veq * {VEQ_SCALE}), 65535)
                            FROM mo WHERE iy // 40 = {ty} AND ix // 40 = {tx} ORDER BY 1, 2""").fetchnumpy()
        cols = [np.asarray(v).astype("<u2") for v in a.values()]
        d = con.execute(f"""SELECT (iy % 40) * 40 + (ix % 40), d, n FROM dek
                            WHERE iy // 40 = {ty} AND ix // 40 = {tx} ORDER BY 1, 2""").fetchnumpy()
        dv = list(d.values())
        t3 = con.execute(f"""SELECT (iy % 40) * 40 + (ix % 40), y - {ORIGIN_YEAR}, least(round(v * {VEQ_SCALE}), 65535) FROM mtd
                             WHERE iy // 40 = {ty} AND ix // 40 = {tx} AND v > 0 ORDER BY 1, 2""").fetchnumpy()
        v3 = [np.asarray(v).astype("<u2") for v in t3.values()]
        sh = con.execute(f"""SELECT coalesce(s0, 0), coalesce(s1, 0), coalesce(s2, 0)
                             FROM mo LEFT JOIN share USING (iy, ix, mon)
                             WHERE iy // 40 = {ty} AND ix // 40 = {tx} ORDER BY (iy % 40) * 40 + (ix % 40), mon""").fetchnumpy()
        shares = np.stack([np.asarray(v).astype(np.uint8) for v in sh.values()], axis=1).reshape(-1)
        f5 = con.execute(f"""SELECT (iy % 40) * 40 + (ix % 40), y - {ORIGIN_YEAR}, frp, n FROM frp
                             WHERE iy // 40 = {ty} AND ix // 40 = {tx} AND n > 0 ORDER BY 1, 2""").fetchnumpy()
        v5 = list(f5.values())
        n, n2, n3, n5 = len(cols[0]), len(dv[0]), len(v3[0]), len(v5[0])
        buf = b"BAT3" + struct.pack("<IIII", n, n2, n3, n5) + b"".join(c.tobytes() for c in cols)
        buf += np.asarray(dv[0]).astype("<u2").tobytes() + np.asarray(dv[1]).astype("<u2").tobytes() + np.asarray(dv[2]).astype("<u4").tobytes()
        buf += b"".join(c.tobytes() for c in v3)
        buf += b"\0" * (-len(buf) % 4)
        buf += shares.tobytes()
        buf += b"\0" * (-len(buf) % 4)
        buf += np.asarray(v5[0]).astype("<u2").tobytes() + np.asarray(v5[1]).astype("<u2").tobytes()
        buf += np.asarray(v5[2]).astype("<f4").tobytes() + np.asarray(v5[3]).astype("<u4").tobytes()
        gz = gzip.compress(buf, 9)
        (OUT / "tiles" / f"t_{ty}_{tx}.bin.gz").write_bytes(gz)
        tiles.append([int(ty), int(tx), len(gz), int(n)])
        total += len(gz)
    print(f"{len(tiles)} tiles, {total / 1e6:.1f} MB gzip")

    # ---- countries: each cell goes to the country with most hotspots in it ----
    rows = con.execute(f"""
        WITH c AS (SELECT country, iy, ix, sum(n_raw) AS n FROM read_parquet('{AGG}/MODIS_*.parquet')
                   WHERE country IS NOT NULL AND country <> '' GROUP BY ALL)
        SELECT country, iy::INTEGER * 1440 + ix AS cell FROM c
        QUALIFY row_number() OVER (PARTITION BY iy, ix ORDER BY n DESC) = 1 ORDER BY 1, 2""").fetchall()
    index, flat, cur, start = [], [], None, 0
    for name, cell in rows:
        if name != cur:
            if cur is not None:
                index.append([cur, start, len(flat) - start])
            cur, start = name, len(flat)
        flat.append(cell)
    if cur is not None:
        index.append([cur, start, len(flat) - start])
    (OUT / "countries.bin.gz").write_bytes(gzip.compress(np.asarray(flat, dtype="<u4").tobytes(), 9))
    print(f"{len(index)} countries, {len(flat):,} cells")

    # ---- overview images in Web Mercator ----
    def merc(lat: float) -> float:
        return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

    y0, y1 = merc(LAT_S), merc(LAT_N)
    w = 1440
    h = round(w * (y1 - y0) / (2 * math.pi))
    ys = y1 - (np.arange(h) + 0.5) / h * (y1 - y0)
    lat = np.degrees(2 * np.arctan(np.exp(ys)) - math.pi / 2)
    row_iy = np.clip(np.floor((lat + 90) * 4).astype(int), 0, 719)
    years = CLIM[1] - CLIM[0] + 1

    def image(where: str, breaks: list, name: str) -> None:
        g = np.zeros((720, 1440), dtype=np.float64)
        r = con.execute(f"SELECT iy, ix, sum(modis) / {years}.0 FROM mo WHERE mon BETWEEN {(CLIM[0] - ORIGIN_YEAR) * 12} AND {(CLIM[1] - ORIGIN_YEAR) * 12 + 11} {where} GROUP BY ALL").fetchnumpy()
        v = list(r.values())
        g[np.asarray(v[0]), np.asarray(v[1])] = np.asarray(v[2])
        cls = np.zeros(g.shape, dtype=int)
        for b in breaks:
            cls += g >= b
        rgba = np.zeros((720, 1440, 4), dtype=np.uint8)
        for k, col in enumerate(RAMP, start=1):
            rgba[cls == k] = (*col, 225)
        Image.fromarray(rgba[row_iy]).save(OUT / name, optimize=True)

    annual_breaks = [0.5, 3, 12, 50, 150, 500]
    month_breaks = [0.2, 1, 4, 15, 50, 150]
    image("", annual_breaks, "clim_annual.png")
    for m in range(12):
        image(f"AND mon % 12 = {m}", month_breaks, f"clim_m{m + 1:02d}.png")

    val = json.loads((H / "validation.json").read_text(encoding="utf-8"))
    meta = dict(
        generated=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        origin_year=ORIGIN_YEAR, n_months=n_months, partial=partial, modis_first_month=int(modis_first),
        switch_year=val["switch_year"], veq_scale=VEQ_SCALE, viirs_valid=viirs_valid,
        clim_years=list(CLIM), grid_deg=0.25, tile_deg=10,
        tiles=tiles, countries=index,
        overview=dict(bounds=[-180, LAT_S, 180, LAT_N], annual_breaks=annual_breaks, month_breaks=month_breaks,
                      ramp=["#%02X%02X%02X" % c for c in RAMP]),
        validation=val,
        sources=["NASA FIRMS MODIS Collection 6.1 (Terra, Aqua), standard processing",
                 "NASA FIRMS VIIRS 375 m (Suomi-NPP, NOAA-20), standard processing"],
    )
    op = H / "overpass.json"
    if op.exists():
        meta["overpass"] = json.loads(op.read_text(encoding="utf-8"))
    (OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    print("meta.json written; months:", n_months, "last:", ORIGIN_YEAR + last_mon // 12, last_mon % 12 + 1)


if __name__ == "__main__":
    main()
