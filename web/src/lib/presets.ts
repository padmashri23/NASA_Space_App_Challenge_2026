import type { Area } from "./data";

// Regions with well-known burning seasons, as plain boxes (west, south, east, north).
export const PRESETS: Area[] = [
  { label: "Punjab plains, India", box: { w: 73.8, s: 29.5, e: 77.0, n: 32.6 } },
  { label: "Mato Grosso, Brazil", box: { w: -61.6, s: -18.0, e: -50.2, n: -7.3 } },
  { label: "Paraná Delta, Argentina", box: { w: -60.8, s: -34.4, e: -58.3, n: -32.0 } },
  { label: "Central Kalimantan, Indonesia", box: { w: 110.7, s: -3.6, e: 115.9, n: 0.8 } },
  { label: "Top End, Australia", box: { w: 129.0, s: -16.5, e: 138.0, n: -11.0 } },
  { label: "Northern California, USA", box: { w: -124.4, s: 38.5, e: -119.5, n: 42.0 } },
  { label: "Miombo belt, Zambia", box: { w: 22.0, s: -18.1, e: 33.7, n: -8.2 } },
  { label: "Central Portugal", box: { w: -9.5, s: 39.0, e: -6.2, n: 42.2 } },
];
