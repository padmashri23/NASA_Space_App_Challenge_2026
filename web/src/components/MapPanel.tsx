"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";
import type { GeoJSONSource, Map as MlMap, Popup, StyleSpecification } from "maplibre-gl";
import { Area, Box, Meta, monthCells } from "@/lib/data";
import { fmt } from "@/lib/stats";
import { useT } from "@/lib/i18n";
import type { Pick } from "./Rack";

const EMPTY = { type: "FeatureCollection" as const, features: [] };
const BASE = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/data`;
// NASA GIBS (Global Imagery Browse Services), Web Mercator tiles.
const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";

// NASA Blue Marble relief, darkened and desaturated so fire colours stand out, with NASA's border and place-name
// overlays on top. Under it, a plain outline map served by the app itself (Natural Earth) shows if GIBS is slow.
const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    land: { type: "geojson", data: `${BASE}/land.geojson` },
    borders: { type: "geojson", data: `${BASE}/borders.geojson` },
    base: { type: "raster", tiles: [`${GIBS}/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`], tileSize: 256, maxzoom: 8 },
    features: { type: "raster", tiles: [`${GIBS}/Reference_Features/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png`], tileSize: 256, maxzoom: 9 },
    labels: { type: "raster", tiles: [`${GIBS}/Reference_Labels/default/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png`], tileSize: 256, maxzoom: 9 },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": "#0B0D0F" } },
    { id: "land", type: "fill", source: "land", paint: { "fill-color": "#1B1F23" } },
    { id: "borders", type: "line", source: "borders", paint: { "line-color": "#3B4148", "line-width": 0.7 } },
    { id: "base", type: "raster", source: "base", paint: { "raster-fade-duration": 0, "raster-saturation": -0.75, "raster-brightness-max": 0.48, "raster-contrast": 0.1 } },
  ],
};

function ring(b: Box) {
  return [[[b.w, b.s], [b.e, b.s], [b.e, b.n], [b.w, b.n], [b.w, b.s]]];
}

function boxFeature(b: Box) {
  return { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: ring(b) } }] };
}

/** The whole world with the chosen area cut out: dims everything except the area. */
function maskFeature(b: Box) {
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  const hole = [[b.w, b.s], [b.w, b.n], [b.e, b.n], [b.e, b.s], [b.w, b.s]];
  return { type: "FeatureCollection" as const, features: [{ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [world, hole] } }] };
}

type Props = {
  meta: Meta;
  area: Area;
  sel: Pick | null;
  drawing: boolean;
  onDrawn: (b: Box) => void;
};

export default function MapPanel({ meta, area, sel, drawing, onDrawn }: Props) {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const drawingRef = useRef(drawing);
  const onDrawnRef = useRef(onDrawn);
  const selRef = useRef(sel);
  drawingRef.current = drawing;
  onDrawnRef.current = onDrawn;
  selRef.current = sel;

  useEffect(() => {
    let cancelled = false;
    let map: MlMap | undefined;
    let popup: Popup | undefined;
    import("maplibre-gl").then(({ default: ml }) => {
      if (cancelled || !el.current) return;
      map = new ml.Map({
        container: el.current, style: STYLE, center: [75.4, 31], zoom: 4.5,
        attributionControl: false, dragRotate: false, preserveDrawingBuffer: true, pitchWithRotate: false, maxZoom: 10,
      });
      mapRef.current = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
      map.on("error", (ev) => { if (ev.error?.name !== "AbortError" && !String(ev.error?.message).includes("gibs.earthdata")) console.warn(ev.error); });

      map.on("style.load", () => {
        if (!map || map.getSource("mask")) return;
        // The chosen area stays lit; the rest of the world dims.
        map.addSource("mask", { type: "geojson", data: EMPTY });
        map.addLayer({ id: "mask", type: "fill", source: "mask", paint: { "fill-color": "#000000", "fill-opacity": 0.7 } });
        map.addSource("cells", { type: "geojson", data: EMPTY });
        const ramp = meta.overview.ramp;
        map.addLayer({
          id: "cells", type: "fill", source: "cells",
          paint: { "fill-color": ["match", ["get", "k"], 1, ramp[0], 2, ramp[1], 3, ramp[2], 4, ramp[3], 5, ramp[4], 6, ramp[5], "#2A2F35"] },
        });
        map.addSource("aoi", { type: "geojson", data: EMPTY });
        map.addLayer({ id: "features", type: "raster", source: "features", paint: { "raster-opacity": 0.55, "raster-fade-duration": 0 } });
        map.addLayer({ id: "aoi", type: "line", source: "aoi", paint: { "line-color": "#F4F4F0", "line-width": 2, "line-dasharray": [3, 2] } });
        map.addLayer({ id: "labels", type: "raster", source: "labels", paint: { "raster-opacity": 0.9, "raster-fade-duration": 0 } });
        map.addSource("draw", { type: "geojson", data: EMPTY });
        map.addLayer({ id: "draw-fill", type: "fill", source: "draw", paint: { "fill-color": "#F5C518", "fill-opacity": 0.2 } });
        map.addLayer({ id: "draw", type: "line", source: "draw", paint: { "line-color": "#F5C518", "line-width": 2 } });

        // The number behind each square, on hover or tap.
        popup = new ml.Popup({ closeButton: false, closeOnClick: false, className: "cellpop", offset: 10 });
        const show = (ev: { lngLat: { lng: number; lat: number }; features?: { properties: Record<string, unknown> }[] }) => {
          const f = ev.features?.[0];
          const s = selRef.current;
          if (!f || !s || !map || drawingRef.current) return;
          const v = Number(f.properties.v);
          popup!.setLngLat(ev.lngLat)
            .setHTML(`<b>${v < 1 && v > 0 ? "&lt;1" : tRef.current.num(v)}</b> ${tRef.current("ol.det")}<br><span>${tRef.current.month(s.month)} ${s.year}</span>`)
            .addTo(map);
        };
        map.on("mousemove", "cells", show);
        map.on("click", "cells", show);
        map.on("mouseleave", "cells", () => popup?.remove());
        setReady(true);
      });

      // Drag out a rectangle while "Draw on map" is on, by mouse or by one finger.
      type LL = { lng: number; lat: number };
      let start: LL | null = null;
      let last: LL | null = null;
      const box = (a: LL, b: LL): Box => ({
        w: Math.min(a.lng, b.lng), e: Math.max(a.lng, b.lng), s: Math.min(a.lat, b.lat), n: Math.max(a.lat, b.lat),
      });
      const begin = (ev: { lngLat: LL; preventDefault: () => void }) => {
        if (!drawingRef.current || !map) return;
        ev.preventDefault();
        popup?.remove();
        start = last = ev.lngLat;
        map.dragPan.disable();
      };
      const move = (ev: { lngLat: LL }) => {
        if (!start || !map) return;
        last = ev.lngLat;
        (map.getSource("draw") as GeoJSONSource).setData(boxFeature(box(start, last)));
      };
      const end = () => {
        if (!start || !last || !map) return;
        const b = box(start, last);
        start = last = null;
        map.dragPan.enable();
        (map.getSource("draw") as GeoJSONSource).setData(EMPTY);
        if (b.e - b.w > 0.05 && b.n - b.s > 0.05) onDrawnRef.current(b);
      };
      map.on("mousedown", begin);
      map.on("mousemove", move);
      map.on("mouseup", end);
      map.on("touchstart", (ev) => { if (ev.points.length === 1) begin(ev); });
      map.on("touchmove", (ev) => { if (start) { ev.preventDefault(); move(ev); } });
      map.on("touchend", end);
      map.on("touchcancel", end);
    }).catch(() => setFailed(true));
    return () => {
      cancelled = true;
      map?.remove();
      mapRef.current = null;
    };
  }, [meta]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.getCanvas().style.cursor = drawing ? "crosshair" : "";
  }, [drawing, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.resize(); // the frame may have settled after the map was created
    (map.getSource("aoi") as GeoJSONSource).setData(boxFeature(area.box));
    (map.getSource("mask") as GeoJSONSource).setData(maskFeature(area.box));
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const { w, s, e, n } = area.box;
    map.fitBounds([[w, Math.max(s, -84)], [e, Math.min(n, 84)]], { padding: 40, duration: still ? 0 : 500 });
  }, [area, ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    let stale = false;
    (map.getSource("mask") as GeoJSONSource).setData(maskFeature(area.box));
    if (!sel) {
      (map.getSource("cells") as GeoJSONSource).setData(EMPTY);
      return;
    }
    const mon = (sel.year - meta.origin_year) * 12 + sel.month;
    monthCells(meta, area, mon).then((cells) => {
      if (stale) return;
      const br = meta.overview.month_breaks;
      const features = cells.filter((c) => c.v > 0).map(({ iy, ix, v }) => {
        let k = 0;
        for (const x of br) if (v >= x) k++;
        // Bigger squares for more fires, so the map reads without relying on colour.
        const size = 0.25 * Math.min(0.86, 0.36 + 0.09 * k), pad = (0.25 - size) / 2;
        const b: Box = { w: ix / 4 - 180 + pad, s: iy / 4 - 90 + pad, e: ix / 4 - 180 + pad + size, n: iy / 4 - 90 + pad + size };
        return { type: "Feature" as const, properties: { k: Math.max(1, k), v: Math.round(v * 10) / 10 }, geometry: { type: "Polygon" as const, coordinates: ring(b) } };
      });
      (map.getSource("cells") as GeoJSONSource).setData({ type: "FeatureCollection", features });
    });
    return () => { stale = true; };
  }, [meta, area, sel, ready]);

  return (
    <div className={`map${drawing ? " drawing" : ""}`}>
      <div ref={el} className="mapgl" role="application" aria-label="Map of the selected area. Use Enter coordinates above to set the area from the keyboard." />
      {!ready && !failed && <p className="mapmsg">{t("map.loading")}</p>}
      {failed && <p className="mapmsg">The map could not start in this browser. The calendar still works; set the area with Enter coordinates.</p>}
      {drawing && ready && <p className="maphint">{t("map.dragHint")}</p>}
    </div>
  );
}
