// Minimal client for the changedetection.io REST API (v1).
import { config } from "./config.ts";

export interface CdWatchSummary {
  url: string;
  title: string | null;
  page_title: string | null;
  tags: string[]; // tag UUIDs
  last_checked: number;
  last_changed: number;
  last_error: string | false;
  paused?: boolean;
}

export interface Snapshot {
  inStock: boolean | null;
  price: number | null;
  raw: string;
}

export function enabled(): boolean {
  return Boolean(config.changedetection.url && config.changedetection.apiKey);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.changedetection.url}/api/v1${path}`, {
    ...init,
    headers: {
      "x-api-key": config.changedetection.apiKey,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`changedetection ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const listWatches = () => api<Record<string, CdWatchSummary>>("/watch");

export const listTags = () => api<Record<string, { title: string }>>("/tags");

export async function latestSnapshot(uuid: string): Promise<string> {
  const res = await fetch(`${config.changedetection.url}/api/v1/watch/${uuid}/history/latest`, {
    headers: { "x-api-key": config.changedetection.apiKey },
  });
  if (!res.ok) throw new Error(`snapshot ${uuid}: HTTP ${res.status}`);
  return res.text();
}

/** Create a watch. `tag` is a comma-separated list of tag names. */
export async function createWatch(url: string, title: string, tag: string): Promise<string | null> {
  const body = await api<{ uuid?: string } | string>("/watch", {
    method: "POST",
    body: JSON.stringify({ url, title, tag, processor: "restock_diff" }),
  });
  return typeof body === "object" && body && "uuid" in body ? (body.uuid ?? null) : null;
}

/**
 * Parse a snapshot. The "Re-stock & Price detection" processor stores a line like
 * "In Stock: True - Price: 2899.0". Text-mode watches return arbitrary text.
 */
export function parseSnapshot(raw: string): Snapshot {
  const text = raw.trim();
  const stock = /In Stock:\s*(True|False)/i.exec(text);
  const price = /Price:\s*([0-9][0-9,]*(?:\.[0-9]+)?)/i.exec(text);
  return {
    inStock: stock ? stock[1].toLowerCase() === "true" : null,
    price: price ? Number(price[1].replace(/,/g, "")) : null,
    raw: text.slice(0, 2000),
  };
}
