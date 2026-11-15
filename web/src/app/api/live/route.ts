// Last 7 complete days of fire detections for an area, live from NASA FIRMS (VIIRS NOAA-20, near real time),
// in the calendar's MODIS-equivalent units. The MAP_KEY stays on the server (FIRMS_MAP_KEY in web/.env.local).
import { readFile } from "node:fs/promises";
import path from "node:path";
import { FirmsError, getLive } from "@/lib/firms";

const STATUS = { nokey: 503, toolarge: 413, badrequest: 400, upstream: 502 } as const;
let factors: { D: number; N: number } | null = null;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const [w, s, e, n] = ["w", "s", "e", "n"].map((k) => Number(p.get(k)));
  try {
    if (!factors) {
      const meta = JSON.parse(await readFile(path.join(process.cwd(), "public", "data", "meta.json"), "utf-8"));
      factors = { D: meta.validation.global_factor.NOAA20_D, N: meta.validation.global_factor.NOAA20_N };
    }
    return Response.json(await getLive(process.env.FIRMS_MAP_KEY, w, s, e, n, factors));
  } catch (err) {
    const code = err instanceof FirmsError ? err.code : "upstream";
    return Response.json({ error: code }, { status: STATUS[code] });
  }
}
