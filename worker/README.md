# Live bus feed relay (Cloudflare Worker, free plan)

GRT's GTFS-Realtime feed doesn't send a CORS header, so browsers can't read it
directly. This Worker fetches it and passes it on with the right header.

1. Sign in at https://dash.cloudflare.com (free account is fine).
2. **Workers & Pages → Create → Create Worker** (start from "Hello World").
3. Name it `kw-trip-planner` → **Deploy**.
4. **Edit code**, replace everything with `feed-proxy.js`, then **Deploy**.
5. Copy the Worker address, e.g. `https://kw-trip-planner.randyharris1999.workers.dev` (deployed via Workers Builds from this repo — `wrangler.toml`),
   and check `…/vehicles` downloads a small file.
6. Put that address in `js/config.js` → `realtime.liveBase` (or test first with
   `?feed=<address>` on the app URL).

Free plan: 100,000 requests/day. One phone polling every 15 s uses ~240 requests/hour.
