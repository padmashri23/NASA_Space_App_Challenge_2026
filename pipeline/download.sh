#!/usr/bin/env bash
# Download FIRMS standard-processing country archives (global, all countries) 2000-2025.
# Usage: bash pipeline/download.sh  (resumable; skips complete files)
set -u
OUT="$(dirname "$0")/../data/raw"
mkdir -p "$OUT"
BASE=https://firms.modaps.eosdis.nasa.gov/data/country/zips
jobs=()
for y in $(seq 2000 2025); do jobs+=("modis_${y}_all_countries.zip"); done
for y in $(seq 2012 2025); do jobs+=("viirs-snpp_${y}_all_countries.zip"); done
for y in $(seq 2018 2025); do jobs+=("viirs-jpss1_${y}_all_countries.zip"); done
printf '%s\n' "${jobs[@]}" | xargs -P 4 -I{} sh -c '
  f="$1"; out="$2/$f"; url="$3/$f"
  want=$(curl -sI "$url" | tr -d "\r" | awk "tolower(\$1)==\"content-length:\"{print \$2}")
  have=$(stat -c %s "$out" 2>/dev/null || echo 0)
  if [ "$have" = "$want" ]; then echo "skip $f"; exit 0; fi
  curl -s --retry 5 --retry-delay 3 -C - -o "$out" "$url" && echo "done $f" || echo "FAIL $f"
' _ {} "$OUT" "$BASE"
echo ALL_DONE
