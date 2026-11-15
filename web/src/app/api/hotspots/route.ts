// Individual hotspots for one area and month from NASA FIRMS. The MAP_KEY stays on the server
// (FIRMS_MAP_KEY in web/.env.local). The static GitHub Pages build calls FIRMS from the browser instead.
import { FirmsError, getHotspots } from "@/lib/firms";

const STATUS = { nokey: 503, toolarge: 413, badrequest: 400, upstream: 502 } as const;

export async function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const [w, s, e, n, year, month] = ["w", "s", "e", "n", "year", "month"].map((k) => Number(p.get(k)));
  try {
    return Response.json(await getHotspots(process.env.FIRMS_MAP_KEY, w, s, e, n, year, month));
  } catch (err) {
    const code = err instanceof FirmsError ? err.code : "upstream";
    return Response.json({ error: code }, { status: STATUS[code] });
  }
}
