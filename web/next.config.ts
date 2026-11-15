import type { NextConfig } from "next";

// NEXT_PUBLIC_STATIC=1 builds the static site for GitHub Pages (see scripts/build-pages.mjs):
// no server, files served under NEXT_PUBLIC_BASE_PATH, and the app/api route files are left out
// (pageExtensions only picks up .tsx pages there) because the browser calls NASA FIRMS directly.
const isStatic = process.env.NEXT_PUBLIC_STATIC === "1";

const nextConfig: NextConfig = isStatic
  ? {
      output: "export",
      basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
      trailingSlash: true,
      images: { unoptimized: true },
      pageExtensions: ["tsx"],
    }
  : {
      cacheComponents: true,
      devIndicators: false,
      partialPrefetching: true,
    };

export default nextConfig;
