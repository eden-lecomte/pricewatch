#!/usr/bin/env node
// pw: minimal client for the pricewatch API, used by the discovery job.
// Reads PRICEWATCH_URL and PRICEWATCH_TOKEN from the environment so the
// commands Claude runs never contain variables or secrets.
//
//   pw items                          compact watchlist (JSON)
//   pw discoveries '<json>'           {"discoveries":[{itemId,text,url,price,currency,seller}]}
//   pw add-source <itemId> '<json>'   {"url","seller","country","watch":true}

const base = (process.env.PRICEWATCH_URL || "").replace(/\/+$/, "");
const token = process.env.PRICEWATCH_TOKEN || "";
if (!base || !token) fail("PRICEWATCH_URL and PRICEWATCH_TOKEN must be set");

function fail(msg) {
  console.error(`pw: ${msg}`);
  process.exit(1);
}

function parseJson(s, what) {
  try {
    return JSON.parse(s);
  } catch (e) {
    fail(`${what} is not valid JSON: ${e.message}`);
  }
}

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) fail(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const [cmd, a, b] = process.argv.slice(2);

if (cmd === "items") {
  const items = await call("GET", "/api/items");
  const compact = items.map((it) => ({
    id: it.id,
    name: it.name,
    query: it.query,
    category: it.category,
    priority: it.priority,
    notes: it.notes,
    allowUsed: it.allowUsed,
    best: it.best ? { seller: it.best.seller, total: it.best.total, inStock: it.best.inStock, url: it.best.url } : null,
    knownSellers: it.offers.map((o) => ({ seller: o.seller, url: o.url, total: o.total, inStock: o.inStock })),
    recentDiscoveries: it.discoveries.map((d) => d.text),
  }));
  console.log(JSON.stringify(compact, null, 1));
} else if (cmd === "discoveries" && a) {
  const body = parseJson(a, "discoveries");
  console.log(JSON.stringify(await call("POST", "/api/discoveries", body)));
} else if (cmd === "add-source" && a && b) {
  if (!/^[\w-]{1,40}$/.test(a)) fail("invalid item id");
  console.log(JSON.stringify(await call("POST", `/api/items/${a}/sources`, parseJson(b, "source"))));
} else {
  fail("usage: pw items | pw discoveries '<json>' | pw add-source <itemId> '<json>'");
}
