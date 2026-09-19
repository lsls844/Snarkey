/**
 * snarkey.xyz — Zilkroad market proxy (Vercel Edge Function)
 *
 * Zilkroad's API is public but sends no Access-Control-Allow-Origin header,
 * so the browser can't call it directly. This proxies it from your own domain.
 * Because it runs at /api on the same origin as the site, CORS never applies.
 *
 * Routes (all GET):
 *   /api/summary      everything the site needs, aggregated, in one call
 *   /api/stats        passthrough
 *   /api/rate         passthrough
 *   /api/listings     passthrough (~1,600 rows — prefer /api/summary)
 *   /api/sales        passthrough, ?limit=N
 *   /api/tokens       passthrough (trait table, large)
 *   /api/art/123      artwork PNG
 *   /api/health       upstream reachability
 *
 * Caching is handled by Vercel's CDN via s-maxage, so upstream sees roughly
 * one request per 15 seconds no matter how many visitors you have.
 */

export const config = { runtime: "edge" };

const UPSTREAM = "https://zilkroad.com/api";
const TTL = 15;          // seconds, matches Zilkroad's own cache-control
const ART_TTL = 86400;   // artwork never changes

const PASSTHROUGH = {
  stats: "/market/stats",
  rate: "/market/rate",
  listings: "/market/listings",
  sales: "/market/sales",
  tokens: "/market/tokens",
};

const BANDS = [
  [0, 1], [1, 1.25], [1.25, 1.5], [1.5, 2],
  [2, 3], [3, 5], [5, 10], [10, Infinity],
];

export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, "").replace(/^api\/?/, "").replace(/\/+$/, "");

  try {
    if (path === "" || path === "health") {
      return json({ ok: true, upstream: UPSTREAM, ttl: TTL, at: new Date().toISOString() });
    }

    if (path === "summary") return json(await buildSummary(), 200, TTL);

    const art = path.match(/^art\/(\d{1,5})$/);
    if (art) return await serveArt(art[1]);

    if (PASSTHROUGH[path]) {
      const qs = url.searchParams.toString();
      return json(await upstream(PASSTHROUGH[path] + (qs ? "?" + qs : "")), 200, TTL);
    }

    return json({ error: "not_found", path }, 404);
  } catch (err) {
    return json({ error: "upstream_failed", detail: String((err && err.message) || err) }, 502);
  }
}

/* ────────────────────────────── aggregation ────────────────────────────── */

async function buildSummary() {
  const [stats, rate, listings, sales] = await Promise.all([
    upstream("/market/stats"),
    upstream("/market/rate"),
    upstream("/market/listings"),
    upstream("/market/sales?limit=40"),
  ]);

  const zecUsd = Number(rate.zecUsd) || 0;
  const floorZec = Number(stats.floorZec) || 0;

  const asks = (listings.listings || [])
    .map((l) => ({ id: l.snark && l.snark.tokenNumber, zec: Number(l.priceZec) }))
    .filter((a) => a.id != null && Number.isFinite(a.zec))
    .sort((a, b) => a.zec - b.zec);

  const prices = asks.map((a) => a.zec);
  const vol24 = Number(stats.volume24hZec) || 0;
  const volAll = Number(stats.volumeTotalZec) || 0;
  const mcap = Number(stats.marketCapZec) || 0;

  return {
    at: new Date().toISOString(),
    source: "zilkroad.com",
    rate: { zecUsd, stale: !!rate.stale, source: rate.source || null },
    floor: {
      zec: floorZec,
      usd: round(floorZec * zecUsd, 2),
      keyUsd: round((floorZec * zecUsd) / 100, 4), // 1 key = 1% of the floor
    },
    volume: {
      day: { zec: vol24, usd: Math.round(vol24 * zecUsd) },
      total: { zec: volAll, usd: Math.round(volAll * zecUsd) },
    },
    sales: { day: stats.sales24h || 0, total: stats.salesTotal || 0 },
    supply: stats.supply || 0,
    marketCap: { zec: mcap, usd: Math.round(mcap * zecUsd) },
    listings: {
      count: asks.length,
      pctOfSupply: stats.supply ? round((asks.length / stats.supply) * 100, 1) : null,
      medianZec: median(prices),
      depth: BANDS.map(([lo, hi]) => ({
        from: lo,
        to: hi === Infinity ? null : hi,
        count: prices.filter((p) => p >= lo && p < hi).length,
      })),
      cheapest: asks.slice(0, 10).map((a) => ({
        id: a.id,
        zec: a.zec,
        usd: Math.round(a.zec * zecUsd),
        vsFloorPct: floorZec ? round((a.zec / floorZec - 1) * 100, 1) : null,
      })),
    },
    recentSales: (sales.sales || []).slice(0, 30).map((s) => ({
      id: s.id,
      zec: Number(s.price),
      usd: Math.round(Number(s.price) * zecUsd),
      via: s.via,
      time: s.time,
      agoMin: Math.max(0, Math.round((Date.now() - new Date(s.time).getTime()) / 60000)),
    })),
  };
}

/* ────────────────────────────── helpers ────────────────────────────── */

async function upstream(path) {
  const res = await fetch(UPSTREAM + path, {
    headers: { accept: "application/json", "user-agent": "snarkey-proxy/1.0" },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

async function serveArt(id) {
  const res = await fetch(`${UPSTREAM}/art/${id}`);
  if (!res.ok) return json({ error: "art_not_found", id }, res.status);
  return new Response(res.body, {
    status: 200,
    headers: {
      "content-type": res.headers.get("content-type") || "image/png",
      "cache-control": `public, max-age=${ART_TTL}, s-maxage=${ART_TTL}, immutable`,
      ...cors(),
    },
  });
}

function json(data, status = 200, ttl = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": ttl
        ? `public, max-age=0, s-maxage=${ttl}, stale-while-revalidate=${ttl * 3}`
        : "no-store",
      ...cors(),
    },
  });
}

/* Same-origin in production, so this is only here so you can hit the API
   from a local file or another tool while testing. Public read-only data. */
function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function median(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : round((sorted[m - 1] + sorted[m]) / 2, 4);
}

function round(n, d) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}
