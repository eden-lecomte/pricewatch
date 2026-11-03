import { config } from "./config.ts";
import { kvGet, kvSet, nowIso } from "./db.ts";
import { log } from "./log.ts";

/** Rates map: 1 unit of currency X = rates[X] units of the base currency. */
export type Rates = Record<string, number>;

function parseFallback(s: string): Rates {
  const out: Rates = {};
  for (const part of s.split(",")) {
    const [k, v] = part.split("=").map((x) => x.trim());
    const n = Number(v);
    if (k && Number.isFinite(n) && n > 0) out[k.toUpperCase()] = n;
  }
  return out;
}

export function getRates(): { rates: Rates; updatedAt: string | null; source: string } {
  const stored = kvGet<{ rates: Rates; updatedAt: string } | null>("fx", null);
  const fallback = parseFallback(config.fxFallback);
  return {
    rates: { ...fallback, ...(stored?.rates ?? {}), [config.baseCurrency]: 1 },
    updatedAt: stored?.updatedAt ?? null,
    source: stored ? "live" : Object.keys(fallback).length ? "fallback" : "none",
  };
}

export async function refreshRates(): Promise<void> {
  if (!config.fxUrl) return;
  const url = `${config.fxUrl}?from=${encodeURIComponent(config.baseCurrency)}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": config.userAgent } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { rates?: Record<string, number> };
    const rates: Rates = {};
    // The API returns "1 base = r units of X"; invert to "1 X = 1/r base".
    for (const [cur, r] of Object.entries(body.rates ?? {})) {
      if (typeof r === "number" && r > 0) rates[cur.toUpperCase()] = 1 / r;
    }
    kvSet("fx", { rates, updatedAt: nowIso() });
    log.info(`FX rates updated (${Object.keys(rates).length} currencies)`);
  } catch (e) {
    log.warn(`FX refresh failed: ${(e as Error).message}`);
  }
}

/** Convert an amount in `currency` to the base currency. Returns null if no rate is known. */
export function toBase(amount: number | null, currency: string): number | null {
  if (amount == null) return null;
  const cur = (currency || config.baseCurrency).toUpperCase();
  const rate = getRates().rates[cur];
  return rate ? amount * rate : null;
}
