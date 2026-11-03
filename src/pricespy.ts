// Polite PriceSpy reader. Reads public product pages only (robots.txt disallows
// /search and /go-to-shop, so those are never requested). One request at a time,
// with a configurable delay between requests.
import { config } from "./config.ts";

export interface PriceSpyOffer {
  shopId: string;
  seller: string;
  price: number | null;
  stock: string | null;
  condition: string | null;
  shipping: number | null;
  listing: string;
}

export interface PriceSpyProduct {
  id: string;
  url: string;
  http: number;
  name: string | null;
  lowPrice: number | null;
  currency: string | null;
  offers: PriceSpyOffer[];
  error?: string;
}

let lastRequest = 0;

async function politeGet(url: string): Promise<{ status: number; body: string }> {
  const wait = config.pricespy.delaySeconds * 1000 - (Date.now() - lastRequest);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const res = await fetch(url, { headers: { "User-Agent": config.userAgent, Accept: "text/html" } });
  return { status: res.status, body: res.ok ? await res.text() : "" };
}

export function productUrl(id: string): string {
  return `${config.pricespy.baseUrl}/product.php?p=${encodeURIComponent(id)}`;
}

/** Extract product + offers from a PriceSpy product page. Exported for tests. */
export function parseProductPage(id: string, html: string): Omit<PriceSpyProduct, "http" | "url"> {
  const out: Omit<PriceSpyProduct, "http" | "url"> = { id, name: null, lowPrice: null, currency: null, offers: [] };

  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g)) {
    try {
      const d = JSON.parse(m[1]);
      if (d && d["@type"] === "Product") {
        out.name = d.name ?? null;
        const o = d.offers ?? {};
        out.lowPrice = typeof o.lowPrice === "number" ? o.lowPrice : null;
        out.currency = o.priceCurrency ?? null;
      }
    } catch {
      /* ignore malformed blocks */
    }
  }

  // Offer rows are embedded as escaped JSON in the page's streamed React payload.
  const unescaped = html.replace(/\\"/g, '"');
  const seen = new Set<string>();
  const re = /"offerRows":\[/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(unescaped))) {
    const arr = extractJsonArray(unescaped, m.index + m[0].length - 1);
    if (!arr) continue;
    for (const r of arr as Record<string, unknown>[]) {
      if (!r || typeof r !== "object") continue;
      const rowId = String(r.id ?? "");
      if (!rowId || seen.has(rowId)) continue;
      seen.add(rowId);
      const priceObj = r.price as { amount?: number } | number | undefined;
      const price = typeof priceObj === "object" ? (priceObj?.amount ?? null) : (priceObj ?? null);
      let shipping: number | null = null;
      const ship = r.shipping as { nodes?: { price?: { amount?: number } }[] } | string | undefined;
      if (ship && typeof ship === "object" && Array.isArray(ship.nodes)) {
        const costs = ship.nodes.map((n) => n?.price?.amount).filter((c): c is number => typeof c === "number");
        shipping = costs.length ? Math.min(...costs) : null;
      }
      const shop = r.shop as { name?: string } | undefined;
      out.offers.push({
        shopId: String(r.shopId ?? rowId.split("-")[0]),
        seller: shop?.name ?? "Unknown shop",
        price: typeof price === "number" ? price : null,
        stock: typeof r.stockStatus === "string" ? r.stockStatus : null,
        condition: typeof r.condition === "string" ? r.condition : null,
        shipping,
        listing: String(r.name ?? "").slice(0, 160),
      });
    }
  }
  out.offers.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  return out;
}

/** Find the JSON array that starts at `start` (a "[") and parse it. */
function extractJsonArray(s: string, start: number): unknown[] | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function fetchProduct(id: string): Promise<PriceSpyProduct> {
  const url = productUrl(id);
  try {
    const { status, body } = await politeGet(url);
    if (status !== 200) return { id, url, http: status, name: null, lowPrice: null, currency: null, offers: [], error: `HTTP ${status}` };
    return { ...parseProductPage(id, body), url, http: status };
  } catch (e) {
    return { id, url, http: 0, name: null, lowPrice: null, currency: null, offers: [], error: (e as Error).message };
  }
}

export function stockToBool(stock: string | null): boolean | null {
  if (!stock) return null;
  const s = stock.toLowerCase().replace(/[^a-z]/g, "");
  if (s === "instock") return true;
  if (s === "outofstock" || s === "soldout") return false;
  return null;
}
