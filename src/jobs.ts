import { config } from "./config.ts";
import { db, kvSet, nowIso, type ItemRow, type SourceRow } from "./db.ts";
import * as cd from "./changedetection.ts";
import * as ps from "./pricespy.ts";
import { notify } from "./ntfy.ts";
import { log } from "./log.ts";
import {
  addDiscovery, bestOffer, getItem, itemPricespyIds, listItems, recentAlerts, recordBest,
  recordObservation, trend, upsertSource,
} from "./store.ts";

const money = (n: number) => `${config.baseCurrency} ${Math.round(n).toLocaleString("en-NZ")}`;
const itemLink = (id: string) => (config.publicUrl ? `${config.publicUrl.replace(/\/+$/, "")}/#${id}` : undefined);

// ---------------------------------------------------------------- changedetection

/**
 * Link changedetection watches to items via tags named "<prefix><itemId>" (default "pw:<itemId>"),
 * then record the latest snapshot of every linked watch.
 */
export async function syncChangedetection(): Promise<void> {
  if (!cd.enabled()) return;
  const [watches, tags] = await Promise.all([cd.listWatches(), cd.listTags()]);
  const tagToItem = new Map<string, string>();
  for (const [uuid, t] of Object.entries(tags)) {
    if (t.title?.startsWith(config.changedetection.tagPrefix)) {
      tagToItem.set(uuid, t.title.slice(config.changedetection.tagPrefix.length).trim());
    }
  }

  // Watches linked from the dashboard (no tag needed), keyed by watch uuid.
  const linked = new Map<string, SourceRow[]>();
  for (const s of db.prepare("SELECT * FROM sources WHERE kind = 'changedetection' AND active = 1").all() as unknown as SourceRow[]) {
    if (!s.ext_key) continue;
    linked.set(s.ext_key, [...(linked.get(s.ext_key) ?? []), s]);
  }

  let recorded = 0;
  const unlinked: UnlinkedWatch[] = [];
  for (const [uuid, w] of Object.entries(watches)) {
    const tagged = (w.tags ?? []).map((t) => tagToItem.get(t)).filter((x): x is string => Boolean(x));
    const sources: SourceRow[] = [...(linked.get(uuid) ?? [])];
    for (const itemId of tagged) {
      if (sources.some((s) => s.item_id === itemId)) continue;
      const item = getItem(itemId);
      if (!item || !item.active) continue;
      sources.push(upsertSource({ item_id: itemId, kind: "changedetection", ext_key: uuid, cd_uuid: uuid, seller: sellerFromUrl(w.url), url: w.url }));
    }
    if (!sources.length) {
      unlinked.push({ uuid, url: w.url, title: w.title || w.page_title || w.url, paused: Boolean(w.paused), lastChecked: w.last_checked || null });
      continue;
    }
    for (const src of sources) {
      const item = getItem(src.item_id);
      if (!item || !item.active) continue;
      if (w.paused || !w.last_checked) continue;
      try {
        const snap = cd.parseSnapshot(await cd.latestSnapshot(uuid));
        const prev = lastStock(src);
        recordObservation(src, { price: snap.price, inStock: snap.inStock, raw: snap.raw });
        recorded++;
        if (prev === false && snap.inStock === true) await restockAlert(item, src, snap.price);
      } catch (e) {
        log.warn(`watch ${uuid}: ${(e as Error).message}`);
      }
    }
  }
  kvSet("cd.unlinked", unlinked);
  kvSet("lastSync.changedetection", nowIso());
  log.info(`changedetection sync: ${recorded} observations, ${unlinked.length} unlinked watches`);
}

export interface UnlinkedWatch {
  uuid: string;
  url: string;
  title: string;
  paused: boolean;
  lastChecked: number | null;
}

/** Record the latest snapshot for one watch right away (used after linking from the dashboard). */
export async function recordWatch(src: SourceRow): Promise<void> {
  if (!cd.enabled() || !src.ext_key) return;
  try {
    const snap = cd.parseSnapshot(await cd.latestSnapshot(src.ext_key));
    recordObservation(src, { price: snap.price, inStock: snap.inStock, raw: snap.raw });
  } catch (e) {
    log.warn(`watch ${src.ext_key}: ${(e as Error).message}`);
  }
}

function lastStock(src: SourceRow): boolean | null {
  const r = db.prepare("SELECT in_stock FROM observations WHERE source_id = ? ORDER BY t DESC LIMIT 1").get(src.id) as { in_stock: number | null } | undefined;
  return r?.in_stock == null ? null : r.in_stock === 1;
}

export function sellerFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host;
  } catch {
    return url.slice(0, 40);
  }
}

// ---------------------------------------------------------------- PriceSpy

export async function syncPriceSpy(): Promise<void> {
  if (!config.pricespy.enabled) return;
  let offers = 0;
  for (const item of listItems()) {
    for (const pid of itemPricespyIds(item)) {
      const product = await ps.fetchProduct(pid);
      if (product.error) {
        log.warn(`PriceSpy ${pid}: ${product.error}`);
        continue;
      }
      // The first time a product is imported every seller is "new"; only report sellers that appear later.
      const firstImport = !db.prepare("SELECT 1 FROM sources WHERE item_id = ? AND kind = 'pricespy' AND ext_key LIKE ?").get(item.id, `${pid}:%`);
      for (const o of product.offers) {
        const used = o.condition != null && o.condition.toLowerCase() !== "new";
        const key = `${pid}:${o.shopId}`;
        const isNew = !firstImport && !db.prepare("SELECT 1 FROM sources WHERE item_id = ? AND kind = 'pricespy' AND ext_key = ?").get(item.id, key);
        const label = product.name && itemPricespyIds(item).length > 1 ? `${o.seller} (${shortName(product.name)})` : o.seller;
        const src = upsertSource({
          item_id: item.id,
          kind: "pricespy",
          ext_key: key,
          seller: label,
          url: product.url,
          country: "NZ",
          currency: product.currency ?? config.baseCurrency,
          shipping: o.shipping,
          condition: used ? "used" : "new",
          note: o.listing,
        });
        recordObservation(src, { price: o.price, currency: product.currency ?? undefined, inStock: ps.stockToBool(o.stock) });
        offers++;
        if (isNew && o.price != null) await onNewSeller(item, label, o.price, product.url, ps.stockToBool(o.stock));
      }
    }
  }
  kvSet("lastSync.pricespy", nowIso());
  log.info(`PriceSpy sync: ${offers} offers`);
}

function shortName(name: string): string {
  return name.replace(/GeForce\s+/i, "").replace(/\s+\d+GB.*$/i, "").slice(0, 40);
}

async function onNewSeller(item: ItemRow, seller: string, price: number, url: string, inStock: boolean | null): Promise<void> {
  const stock = inStock === true ? "in stock" : inStock === false ? "out of stock" : "stock unknown";
  addDiscovery({ item_id: item.id, origin: "pricespy", text: `${seller} lists it at ${money(price)} (${stock})`, url, price, seller });
  const best = bestOffer(item);
  if (inStock !== false && best?.total != null && price < best.total * (1 - config.alerts.discoveryBeatPercent / 100)) {
    await raise(item, "discovery", `New seller ${seller} at ${money(price)} beats the best price (${money(best.total)})`, price, seller);
  }
}

// ---------------------------------------------------------------- alerts

async function restockAlert(item: ItemRow, src: SourceRow, price: number | null): Promise<void> {
  await raise(item, "restock", `Back in stock at ${src.seller}${price != null ? ` for ${money(price)}` : ""}`, price, src.seller);
}

/** Record an alert and push it, unless an equivalent one was sent in the last 7 days. */
async function raise(item: ItemRow, kind: string, msg: string, total: number | null, seller: string | null): Promise<void> {
  const since = Date.now() - 7 * 864e5;
  const dup = recentAlerts(item.id, 20).some((a) =>
    a.kind === kind && a.seller === seller && Date.parse(a.t) >= since &&
    (total == null || a.total == null || Math.abs(a.total - total) / total < 0.01));
  if (dup) return;
  db.prepare("INSERT INTO alerts (item_id, kind, msg, total, seller, t) VALUES (?, ?, ?, ?, ?, ?)")
    .run(item.id, kind, msg, total, seller, nowIso());
  await notify({
    title: `${item.name}`,
    message: msg,
    click: itemLink(item.id),
    priority: kind === "target" ? 5 : 4,
    tags: [kind === "restock" ? "package" : "moneybag"],
  });
}

/** After each sync: store the best price per item, then check target and trend-drop alerts. */
export async function evaluate(): Promise<void> {
  for (const item of listItems()) {
    recordBest(item);
    const best = bestOffer(item);
    if (!best || best.total == null) continue;
    if (item.target != null && best.total <= item.target) {
      await raise(item, "target", `${money(best.total)} at ${best.seller}: at or under your target of ${money(item.target)}`, best.total, best.seller);
    }
    const tr = trend(item.id);
    if (tr && best.total <= tr * (1 - config.alerts.dropPercent / 100)) {
      const pct = Math.round((1 - best.total / tr) * 100);
      await raise(item, "drop", `${money(best.total)} at ${best.seller}: ${pct}% under the 7-day trend (${money(tr)})`, best.total, best.seller);
    }
  }
}
