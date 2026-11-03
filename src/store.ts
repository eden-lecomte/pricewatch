import { db, nowIso, type ItemRow, type ObservationRow, type SourceRow } from "./db.ts";
import { toBase } from "./fx.ts";
import { config } from "./config.ts";

/** Offers older than this are ignored when picking the best price. */
const STALE_MS = 3 * 24 * 3600 * 1000;

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "item";
}

export function getItem(id: string): ItemRow | undefined {
  return db.prepare("SELECT * FROM items WHERE id = ?").get(id) as ItemRow | undefined;
}

export function listItems(includeInactive = false): ItemRow[] {
  return db.prepare(`SELECT * FROM items ${includeInactive ? "" : "WHERE active = 1"} ORDER BY created_at`).all() as unknown as ItemRow[];
}

export function itemPricespyIds(item: ItemRow): string[] {
  try {
    const v = JSON.parse(item.pricespy_ids);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function sourcesFor(itemId: string): SourceRow[] {
  return db.prepare("SELECT * FROM sources WHERE item_id = ? AND active = 1").all(itemId) as unknown as SourceRow[];
}

export function upsertSource(s: Partial<SourceRow> & { item_id: string; kind: string; seller: string; ext_key: string | null }): SourceRow {
  if (s.ext_key) {
    const existing = db.prepare("SELECT * FROM sources WHERE item_id = ? AND kind = ? AND ext_key = ?")
      .get(s.item_id, s.kind, s.ext_key) as SourceRow | undefined;
    if (existing) {
      db.prepare("UPDATE sources SET seller = ?, url = COALESCE(?, url), active = 1 WHERE id = ?")
        .run(s.seller, s.url ?? null, existing.id);
      return { ...existing, seller: s.seller, url: s.url ?? existing.url, active: 1 };
    }
  }
  const r = db.prepare(`INSERT INTO sources (item_id, kind, seller, country, url, currency, shipping, import_fees, condition, cd_uuid, ext_key, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    s.item_id, s.kind, s.seller, s.country ?? "", s.url ?? "", (s.currency ?? config.baseCurrency).toUpperCase(),
    s.shipping ?? null, s.import_fees ?? null, s.condition ?? "new", s.cd_uuid ?? null, s.ext_key, s.note ?? "", nowIso(),
  );
  return db.prepare("SELECT * FROM sources WHERE id = ?").get(Number(r.lastInsertRowid)) as unknown as SourceRow;
}

export function recordObservation(src: SourceRow, o: { price: number | null; currency?: string; inStock: boolean | null; raw?: string }): void {
  const currency = (o.currency || src.currency || config.baseCurrency).toUpperCase();
  const base = toBase(o.price, currency);
  const total = base == null ? null : base + (src.shipping ?? 0) + (src.import_fees ?? 0);
  db.prepare("INSERT INTO observations (source_id, t, price, currency, in_stock, total_base, raw) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(src.id, nowIso(), o.price, currency, o.inStock == null ? null : o.inStock ? 1 : 0, total, o.raw ?? "");
}

export function latestObservation(sourceId: number): ObservationRow | undefined {
  return db.prepare("SELECT * FROM observations WHERE source_id = ? ORDER BY t DESC LIMIT 1").get(sourceId) as ObservationRow | undefined;
}

export interface Offer {
  sourceId: number;
  kind: string;
  seller: string;
  country: string;
  url: string;
  condition: string;
  price: number | null;
  currency: string;
  shipping: number | null;
  importFees: number | null;
  total: number | null;
  inStock: boolean | null;
  checkedAt: string | null;
  stale: boolean;
  raw: string;
  note: string;
}

export function offersFor(item: ItemRow): Offer[] {
  const now = Date.now();
  return sourcesFor(item.id).map((s) => {
    const o = latestObservation(s.id);
    return {
      sourceId: s.id,
      kind: s.kind,
      seller: s.seller,
      country: s.country,
      url: s.url,
      condition: s.condition,
      price: o?.price ?? null,
      currency: o?.currency ?? s.currency,
      shipping: s.shipping,
      importFees: s.import_fees,
      total: o?.total_base ?? null,
      inStock: o?.in_stock == null ? null : o.in_stock === 1,
      checkedAt: o?.t ?? null,
      stale: !o || now - Date.parse(o.t) > STALE_MS,
      raw: o && o.price == null ? o.raw.slice(0, 300) : "",
      note: s.note,
    };
  }).sort((a, b) => (a.total ?? Infinity) - (b.total ?? Infinity));
}

/** Cheapest fresh offer: in stock first, then unknown stock, then anything. Used/refurb only if allowed. */
export function bestOffer(item: ItemRow, offers = offersFor(item)): Offer | null {
  const eligible = offers.filter((o) => o.total != null && !o.stale && (item.allow_used || o.condition === "new"));
  return eligible.find((o) => o.inStock === true) ?? eligible.find((o) => o.inStock === null) ?? eligible[0] ?? null;
}

export function recordBest(item: ItemRow): void {
  const best = bestOffer(item);
  if (!best || best.total == null) return;
  const last = db.prepare("SELECT t, best FROM item_history WHERE item_id = ? ORDER BY t DESC LIMIT 1")
    .get(item.id) as { t: string; best: number } | undefined;
  // At most one point per hour unless the price changed.
  if (last && Date.now() - Date.parse(last.t) < 55 * 60 * 1000 && Math.abs(last.best - best.total) < 0.01) return;
  db.prepare("INSERT INTO item_history (item_id, t, best) VALUES (?, ?, ?)").run(item.id, nowIso(), best.total);
}

export function history(itemId: string, days = 90): { t: string; best: number }[] {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  return db.prepare("SELECT t, best FROM item_history WHERE item_id = ? AND t >= ? ORDER BY t").all(itemId, since) as unknown as { t: string; best: number }[];
}

/** Median of the best price over the 7 days before the last hour. Null until there are 3+ points. */
export function trend(itemId: string): number | null {
  const from = new Date(Date.now() - 7 * 864e5).toISOString();
  const to = new Date(Date.now() - 3600e3).toISOString();
  const vals = (db.prepare("SELECT best FROM item_history WHERE item_id = ? AND t >= ? AND t < ?").all(itemId, from, to) as { best: number }[])
    .map((r) => r.best).sort((a, b) => a - b);
  if (vals.length < 3) return null;
  const mid = vals.length >> 1;
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

export function addDiscovery(d: { item_id: string; origin: string; text: string; url?: string | null; price?: number | null; currency?: string | null; seller?: string | null }): boolean {
  // Skip exact repeats from the last 7 days.
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const dup = db.prepare("SELECT 1 FROM discoveries WHERE item_id = ? AND text = ? AND t >= ?").get(d.item_id, d.text, since);
  if (dup) return false;
  db.prepare("INSERT INTO discoveries (item_id, t, origin, text, url, price, currency, seller) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(d.item_id, nowIso(), d.origin, d.text.slice(0, 500), d.url ?? null, d.price ?? null, d.currency ?? null, d.seller ?? null);
  return true;
}

export function recentDiscoveries(itemId: string, limit = 8) {
  return db.prepare("SELECT t, origin, text, url, price, currency, seller FROM discoveries WHERE item_id = ? ORDER BY t DESC LIMIT ?").all(itemId, limit);
}

export function recentAlerts(itemId: string, limit = 5) {
  return db.prepare("SELECT kind, msg, total, seller, t FROM alerts WHERE item_id = ? ORDER BY t DESC LIMIT ?").all(itemId, limit) as { kind: string; msg: string; total: number | null; seller: string | null; t: string }[];
}

export function itemView(item: ItemRow) {
  const offers = offersFor(item);
  const best = bestOffer(item, offers);
  const tr = trend(item.id);
  return {
    id: item.id,
    name: item.name,
    query: item.query,
    category: item.category,
    priority: item.priority,
    target: item.target,
    notes: item.notes,
    allowUsed: Boolean(item.allow_used),
    pricespyIds: itemPricespyIds(item),
    best,
    trend: tr,
    vsTrendPct: best?.total != null && tr ? (best.total / tr - 1) * 100 : null,
    offers,
    history: history(item.id),
    alerts: recentAlerts(item.id),
    discoveries: recentDiscoveries(item.id),
  };
}
