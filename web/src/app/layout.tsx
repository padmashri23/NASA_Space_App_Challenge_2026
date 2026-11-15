import type { Metadata, Viewport } from "next";
import { Noto_Sans_Devanagari, Overpass, Overpass_Mono } from "next/font/google";
import "./globals.css";

// Overpass is an open-source take on Highway Gothic, the lettering of road and park signs.
const sans = Overpass({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Overpass_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });
// Overpass has no Devanagari letters; Hindi falls back to Noto Sans Devanagari.
const deva = Noto_Sans_Devanagari({ subsets: ["devanagari"], weight: ["400", "600", "800", "900"], variable: "--font-deva", display: "swap" });

export const metadata: Metadata = {
  title: "Burn Almanac: fire activity calendar",
  description:
    "One satellite fire record from 2003 to today. MODIS and VIIRS fire detections from NASA FIRMS, harmonized into a monthly calendar for any area.",
};

export const viewport: Viewport = { themeColor: "#111315", colorScheme: "dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} ${deva.variable}`}>
      <body>{children}</body>
    </html>
  );
}
