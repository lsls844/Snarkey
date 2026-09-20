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

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+/, "").replace(/^api\/?/, "").replace(/\/+$/, "");

  if (path === "balance") {
    try { return await handleBalance(url); }
    catch (err) { return json({ error: "balance_failed", detail: String(err?.message || err) }, 502); }
  }

  if (path === "sell") {
    if (request.method !== "POST") return json({ error: "use_post" }, 405);
    try { return await handleSell(request); }
    catch (err) { return json({ error: "sell_failed", detail: String(err?.message || err) }, 500); }
  }

  if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);

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


/* ────────────────────────── sell requests ──────────────────────────
 * A visitor asking to cash keys out. Nothing here moves money — it
 * records the request and pings you, and you send the USDC by hand.
 *
 * Every request lands in the Vercel logs (Project → Logs), so this
 * works with no setup at all. Set SELL_WEBHOOK in Vercel's environment
 * variables to a Discord or Slack webhook URL and you get pinged too.
 */
async function handleSell(request) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: "bad_json" }, 400);

  const address = String(body.address || "");
  const keys = Number(body.keys);
  const usd = Number(body.usd);

  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return json({ error: "bad_address" }, 400);
  if (!Number.isInteger(keys) || keys < 1) return json({ error: "bad_keys" }, 400);
  if (!Number.isFinite(usd) || usd <= 0) return json({ error: "bad_amount" }, 400);

  /* The exact USDC to send back, with the key count encoded in the last four
     micro-digits — sending precisely this amount is what removes the keys. */
  const payoutUnits = BigInt(Math.ceil(usd * 100)) * BigInt(KEY_ENCODING_BASE) + BigInt(keys);
  const exactAmount = (Number(payoutUnits) / 1e6).toFixed(6);

  const ref = "PO-" + Date.now().toString(36).toUpperCase().slice(-6);
  const record = {
    ref,
    address,
    keys,
    keyPrice: Number(body.keyPrice) || null,
    gross: Number(body.gross) || null,
    fee: Number(body.fee) || null,
    payoutUsd: usd,
    sendExactly: exactAmount,
    sendExactlyUnits: payoutUnits.toString(),
    floorZec: Number(body.floorZec) || null,
    zecUsd: Number(body.zecUsd) || null,
    at: new Date().toISOString(),
  };

  // Shows up in Vercel → your project → Logs
  console.log("SELL_REQUEST " + JSON.stringify(record));

  const hook = process.env.SELL_WEBHOOK;
  if (hook) {
    const text =
      "**Payout requested** `" + ref + "`\n" +
      "Send **exactly " + exactAmount + " USDC** to `" + address + "`\n" +
      keys + " keys @ $" + (record.keyPrice ?? 0).toFixed(2) + "\n" +
      "_Send this exact amount — the last digits carry the key count and are what clear the balance._";
    try {
      await fetch(hook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text, text }), // Discord uses content, Slack uses text
      });
    } catch (e) {
      console.error("WEBHOOK_FAILED " + String(e?.message || e));
    }
  }

  return json({ ok: true, ref, payoutUsd: usd, sendExactly: exactAmount, address });
}


/* ─────────────────────── on-chain key ledger ───────────────────────
 * There is no database. Every USDC payment into the vault wallet is a
 * permanent Transfer log, so the chain itself is the ledger.
 *
 * The key count rides along inside the payment amount. USDC has six
 * decimals; the site rounds the price up to the nearest whole cent and
 * writes the key count into the four micro-unit digits underneath:
 *
 *     18 keys at $10.30  ->  $185.40  ->  185400018 units
 *                                                 ^^^^ = 18 keys
 *
 * So the number of keys bought is recoverable exactly, forever, with no
 * storage and no trust — and it costs the buyer under a cent.
 */
const CHAIN_RPC = process.env.CHAIN_RPC || "https://rpc.mainnet.chain.robinhood.com";
const USDC_ADDR = (process.env.USDC_ADDRESS || "0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8").toLowerCase();
const VAULT_ADDR = (process.env.VAULT_WALLET || "0xf87057c0bf24510140bB2b49B4045F3a04479474").toLowerCase();
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FROM_BLOCK = process.env.FROM_BLOCK || "0x0";
const KEY_ENCODING_BASE = 10000; // last 4 micro-digits carry the key count

async function rpc(method, params) {
  const r = await fetch(CHAIN_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + j.error.message);
  return j.result;
}

const pad32 = (addr) => "0x" + "0".repeat(24) + addr.replace(/^0x/, "").toLowerCase();

async function handleBalance(url) {
  const address = String(url.searchParams.get("address") || "").toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address)) return json({ error: "bad_address" }, 400);

  const range = { fromBlock: FROM_BLOCK, toBlock: "latest", address: USDC_ADDR };

  /* Buys are transfers in; payouts are transfers back out. Both carry their
     key count in the same four micro-digits, so the balance is just the
     difference — no database, and clearing a browser changes nothing. */
  const [inLogs, outLogs] = await Promise.all([
    rpc("eth_getLogs", [{ ...range, topics: [TRANSFER_TOPIC, pad32(address), pad32(VAULT_ADDR)] }]),
    rpc("eth_getLogs", [{ ...range, topics: [TRANSFER_TOPIC, pad32(VAULT_ADDR), pad32(address)] }]),
  ]);

  const decode = (l, dir) => {
    const units = BigInt(l.data);
    const keys = Number(units % BigInt(KEY_ENCODING_BASE));
    const usd = Number(units - BigInt(keys)) / 1e6;
    return {
      dir,
      tx: l.transactionHash,
      block: parseInt(l.blockNumber, 16),
      usd: Math.round(usd * 100) / 100,
      keys,
      pricePaid: keys ? Math.round((usd / keys) * 10000) / 10000 : null,
    };
  };

  const bought = (inLogs || []).map((l) => decode(l, "buy"));
  const paidOut = (outLogs || []).map((l) => decode(l, "payout"));

  const keysBought = bought.reduce((a, d) => a + d.keys, 0);
  const keysRedeemed = paidOut.reduce((a, d) => a + d.keys, 0);
  const spent = bought.reduce((a, d) => a + d.usd, 0);
  const received = paidOut.reduce((a, d) => a + d.usd, 0);
  const keys = Math.max(0, keysBought - keysRedeemed);

  return json({
    address,
    vault: VAULT_ADDR,
    keys,
    keysBought,
    keysRedeemed,
    spentUsd: Math.round(spent * 100) / 100,
    receivedUsd: Math.round(received * 100) / 100,
    avgCost: keysBought ? Math.round((spent / keysBought) * 100) / 100 : null,
    history: [...bought, ...paidOut].sort((a, b) => b.block - a.block),
    at: new Date().toISOString(),
  }, 200, 5);
}
