# Burn Almanac web app

The web app for Burn Almanac. See the [project README](../README.md) for what it does and how the data is made.

```bash
npm install
cp .env.local.example .env.local   # paste a free NASA FIRMS key
npm run dev                        # http://localhost:3000
npm run build && npm start         # production server
node scripts/build-pages.mjs       # static build for GitHub Pages (web/out)
```
