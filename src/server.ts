import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.ts";
import { db, kvGet, kvSet, nowIso } from "./db.ts";
import { getRates } from "./fx.ts";
import * as cd from "./changedetection.ts";
import { log } from "./log.ts";
import { addDiscovery, getItem, itemView, listItems, recordObservation, slugify, upsertSource } from "./store.ts";
import { recordWatch, sellerFromUrl, type UnlinkedWatch } from "./jobs.ts";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const MAX_BODY = 64 * 1024;

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], body: any) => Promise<void> | void;
interface Route { method: string; pattern: RegExp; write: boolean; handler: Handler }

let syncHandler: (() => Promise<void>) | null = null;
export function onSyncRequest(fn: () => Promise<void>): void {
  syncHandler = fn;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(config.adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

// ----- validation helpers
const s = (v: unknown, max = 500): string => (typeof v === "string" ? v.trim().slice(0, max) : "");
const n = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const httpUrl = (v: unknown): string => {
  const u = s(v, 2000);
  if (!u) return "";
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:" ? p.toString() : "";
  } catch {
    return "";
  }
};
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).replace(/\D/g, "")).filter(Boolean).slice(0, 30) : []);

function requireItem(id: string) {
  const item = getItem(id);
  if (!item) throw new HttpError(404, "No such item");
  return item;
}

const routes: Route[] = [
  {
    method: "GET", pattern: /^\/api\/health$/, write: false,
    handler: (_q, res) => send(res, 200, {
      ok: true,
      baseCurrency: config.baseCurrency,
      lastSync: { changedetection: kvGet("lastSync.changedetection", null), pricespy: kvGet("lastSync.pricespy", null) },
      fx: getRates(),
      changedetection: cd.enabled(),
      pricespy: config.pricespy.enabled,
    }),
  },
  {
    method: "GET", pattern: /^\/api\/items$/, write: false,
    handler: (_q, res) => send(res, 200, listItems().map(itemView)),
  },
  {
    method: "GET", pattern: /^\/api\/items\/([\w-]+)$/, write: false,
    handler: (_q, res, [id]) => send(res, 200, itemView(requireItem(id))),
  },
  {
    method: "POST", pattern: /^\/api\/items$/, write: true,
    handler: (_q, res, _p, b) => {
      const name = s(b.name, 120);
      const query = s(b.query, 200) || name;
      if (!name) throw new HttpError(400, "name is required");
      let id = s(b.id, 40) ? slugify(s(b.id, 40)) : slugify(query);
      if (getItem(id)) id = `${id}-${Date.now().toString(36).slice(-4)}`;
      db.prepare(`INSERT INTO items (id, name, query, category, priority, target, notes, pricespy_ids, allow_used, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).run(
        id, name, query, s(b.category, 30) || "other", b.priority === "bargain" ? "bargain" : "buy",
        n(b.target), s(b.notes, 1000), JSON.stringify(ids(b.pricespyIds)), b.allowUsed ? 1 : 0, nowIso());
      send(res, 201, itemView(requireItem(id)));
    },
  },
  {
    method: "PATCH", pattern: /^\/api\/items\/([\w-]+)$/, write: true,
    handler: (_q, res, [id], b) => {
      const item = requireItem(id);
      db.prepare(`UPDATE items SET name = ?, query = ?, category = ?, priority = ?, target = ?, notes = ?, pricespy_ids = ?, allow_used = ?, active = ? WHERE id = ?`).run(
        "name" in b ? s(b.name, 120) || item.name : item.name,
        "query" in b ? s(b.query, 200) || item.query : item.query,
        "category" in b ? s(b.category, 30) || "other" : item.category,
        "priority" in b ? (b.priority === "bargain" ? "bargain" : "buy") : item.priority,
        "target" in b ? n(b.target) : item.target,
        "notes" in b ? s(b.notes, 1000) : item.notes,
        "pricespyIds" in b ? JSON.stringify(ids(b.pricespyIds)) : item.pricespy_ids,
        "allowUsed" in b ? (b.allowUsed ? 1 : 0) : item.allow_used,
        "active" in b ? (b.active ? 1 : 0) : item.active,
        id);
      send(res, 200, itemView(requireItem(id)));
    },
  },
  {
    method: "DELETE", pattern: /^\/api\/items\/([\w-]+)$/, write: true,
    handler: (_q, res, [id]) => {
      requireItem(id);
      db.prepare("DELETE FROM items WHERE id = ?").run(id);
      send(res, 200, { deleted: id });
    },
  },
  {
    // Add a seller page. With watch=true (and changedetection configured) a tagged watch is created;
    // otherwise it is stored as a manual source, optionally with a price observation.
    method: "POST", pattern: /^\/api\/items\/([\w-]+)\/sources$/, write: true,
    handler: async (_q, res, [id], b) => {
      const item = requireItem(id);
      const url = httpUrl(b.url);
      if (!url) throw new HttpError(400, "url must be an http(s) URL");
      if (b.watch && cd.enabled()) {
        const uuid = await cd.createWatch(url, `${item.name} - ${s(b.seller, 60) || sellerFromUrl(url)}`, `${config.changedetection.tagPrefix}${id}`);
        send(res, 201, { watch: uuid, note: "Watch created; it is linked on the next sync." });
        return;
      }
      const src = upsertSource({
        item_id: id, kind: "manual", ext_key: url, url,
        seller: s(b.seller, 80) || sellerFromUrl(url), country: s(b.country, 8).toUpperCase(),
        currency: s(b.currency, 3).toUpperCase() || config.baseCurrency,
        shipping: n(b.shipping), import_fees: n(b.importFees),
        condition: b.condition === "used" ? "used" : "new", note: s(b.note, 300),
      });
      if (n(b.price) != null) {
        recordObservation(src, { price: n(b.price), currency: src.currency, inStock: typeof b.inStock === "boolean" ? b.inStock : null, raw: "manual" });
      }
      send(res, 201, { source: src.id });
    },
  },
  {
    // Discovery ingest, used by the Claude discovery job (or anything else with the admin token).
    method: "POST", pattern: /^\/api\/discoveries$/, write: true,
    handler: (_q, res, _p, b) => {
      const list: any[] = Array.isArray(b) ? b : Array.isArray(b.discoveries) ? b.discoveries : [b];
      let added = 0;
      for (const d of list.slice(0, 50)) {
        const item = getItem(s(d.itemId, 40));
        const text = s(d.text, 500);
        if (!item || !text) continue;
        if (addDiscovery({ item_id: item.id, origin: s(d.origin, 20) || "claude", text, url: httpUrl(d.url) || null, price: n(d.price), currency: s(d.currency, 3).toUpperCase() || null, seller: s(d.seller, 80) || null })) added++;
      }
      send(res, 201, { added });
    },
  },
  {
    // changedetection watches not linked to any item yet (refreshed on every sync).
    method: "GET", pattern: /^\/api\/watches\/unlinked$/, write: true,
    handler: (_q, res) => send(res, 200, kvGet<UnlinkedWatch[]>("cd.unlinked", [])),
  },
  {
    // Link a changedetection watch to an item without needing a tag.
    method: "POST", pattern: /^\/api\/watches\/([0-9a-f-]{8,64})\/link$/, write: true,
    handler: async (_q, res, [uuid], b) => {
      const item = requireItem(s(b.itemId, 40));
      const unlinked = kvGet<UnlinkedWatch[]>("cd.unlinked", []);
      const w = unlinked.find((x) => x.uuid === uuid);
      if (!w) throw new HttpError(404, "Unknown or already linked watch. Run a sync and try again.");
      const src = upsertSource({ item_id: item.id, kind: "changedetection", ext_key: uuid, cd_uuid: uuid, url: w.url, seller: s(b.seller, 80) || sellerFromUrl(w.url) });
      kvSet("cd.unlinked", unlinked.filter((x) => x.uuid !== uuid));
      await recordWatch(src);
      send(res, 200, { source: src.id });
    },
  },
  {
    // Stop using a seller page for an item. Watches linked by a pw: tag come back unless the tag is removed.
    method: "DELETE", pattern: /^\/api\/sources\/(\d+)$/, write: true,
    handler: (_q, res, [id]) => {
      const r = db.prepare("UPDATE sources SET active = 0 WHERE id = ?").run(Number(id));
      if (!r.changes) throw new HttpError(404, "No such source");
      send(res, 200, { removed: Number(id) });
    },
  },
  {
    // Lets the dashboard check a token without side effects.
    method: "POST", pattern: /^\/api\/auth$/, write: true,
    handler: (_q, res) => send(res, 200, { ok: true }),
  },
  {
    method: "POST", pattern: /^\/api\/sync$/, write: true,
    handler: (_q, res) => {
      if (syncHandler) void syncHandler();
      send(res, 202, { started: Boolean(syncHandler) });
    },
  },
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
};

async function serveStatic(path: string, res: ServerResponse): Promise<void> {
  const rel = normalize(path === "/" ? "/index.html" : path).replace(/^([/\\])+/, "");
  if (rel.includes("..")) return send(res, 404, { error: "Not found" });
  try {
    const body = await readFile(join(PUBLIC_DIR, rel));
    res.writeHead(200, {
      "Content-Type": MIME[extname(rel)] ?? "application/octet-stream",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(body);
  } catch {
    send(res, 404, { error: "Not found" });
  }
}

export function startServer(): void {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (!url.pathname.startsWith("/api/")) {
        if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });
        if (!config.publicRead && url.pathname !== "/" && url.pathname !== "/index.html" && !url.pathname.match(/\.(js|css|svg|ico)$/)) {
          return send(res, 404, { error: "Not found" });
        }
        return await serveStatic(url.pathname, res);
      }
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (!route) return send(res, 404, { error: "Not found" });
      const needsAuth = route.write || (!config.publicRead && url.pathname !== "/api/health");
      if (needsAuth && !authorized(req)) return send(res, 401, { error: "Admin token required" });
      const params = route.pattern.exec(url.pathname)!.slice(1);
      const body = route.write ? await readBody(req) : {};
      await route.handler(req, res, params, body);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : e instanceof cd.ChangedetectionError ? 502 : 500;
      if (status === 502) log.warn(`${req.method} ${url.pathname}: ${(e as Error).message}`);
      if (status === 500) log.error(`${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      send(res, status, { error: status === 500 ? "Internal error" : (e as Error).message });
    }
  });
  server.listen(config.port, () => log.info(`pricewatch listening on :${config.port}`));
}
