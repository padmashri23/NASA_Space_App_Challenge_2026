// Builds the static site for GitHub Pages into web/out.
// Usage: node scripts/build-pages.mjs [basePath] [--with-key]   (default base path /NASA_Space_App_Challenge_2026)
// By default no NASA FIRMS key is included: the fire list and the live 7-day check then ask visitors for their own key.
// --with-key bakes FIRMS_MAP_KEY (environment or web/.env.local) into the public bundle, where anyone can read it.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const basePath = args.find((a) => !a.startsWith("--")) ?? "/NASA_Space_App_Challenge_2026";
let key = "";
if (args.includes("--with-key")) {
  key = process.env.FIRMS_MAP_KEY ?? "";
  if (!key && existsSync(".env.local")) key = (readFileSync(".env.local", "utf-8").match(/^FIRMS_MAP_KEY=(\w+)/m) ?? [])[1] ?? "";
}

const env = { ...process.env, NEXT_PUBLIC_STATIC: "1", NEXT_PUBLIC_BASE_PATH: basePath, NEXT_PUBLIC_FIRMS_KEY: key };
const r = spawnSync("npx", ["next", "build"], { stdio: "inherit", env, shell: true });
if (r.status !== 0) process.exit(r.status ?? 1);
writeFileSync("out/.nojekyll", "");
console.log(`Static site in web/out (base path ${basePath}, FIRMS key ${key ? "included" : "not included"}).`);
