// All deployment-specific settings come from environment variables.
// Nothing user-specific should ever be hard-coded in this repo.

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export const config = {
  port: num("PORT", 8080),
  dataDir: str("DATA_DIR", "./data"),
  /** Public URL of this app, used for links in notifications. */
  publicUrl: str("PUBLIC_URL", ""),
  /** Bearer token required for any write (adding items, discovery ingest). Required. */
  adminToken: str("ADMIN_TOKEN"),
  /** If true, anyone who can reach the app can view the dashboard and read the API. */
  publicRead: bool("PUBLIC_READ", true),

  /** Currency every price is converted to for comparison (ISO 4217). */
  baseCurrency: str("BASE_CURRENCY", "NZD").toUpperCase(),
  /** Fallback FX rates if the live lookup fails, e.g. "USD=1.70,AUD=1.10" (1 unit -> base). */
  fxFallback: str("FX_FALLBACK", ""),
  /** Live FX source (ECB rates via frankfurter, no key). Set to "" to disable. */
  fxUrl: process.env.FX_URL ?? "https://api.frankfurter.app/latest",

  changedetection: {
    url: str("CHANGEDETECTION_URL").replace(/\/+$/, ""),
    apiKey: str("CHANGEDETECTION_API_KEY"),
    /** Tag prefix that links a changedetection watch to an item, e.g. "pw:aw3426dw". */
    tagPrefix: str("CHANGEDETECTION_TAG_PREFIX", "pw:"),
    syncMinutes: num("SYNC_INTERVAL_MINUTES", 30),
  },

  pricespy: {
    enabled: bool("PRICESPY_ENABLED", true),
    baseUrl: str("PRICESPY_BASE_URL", "https://pricespy.co.nz").replace(/\/+$/, ""),
    intervalHours: num("PRICESPY_INTERVAL_HOURS", 6),
    /** Seconds between requests to PriceSpy. Be polite. */
    delaySeconds: num("PRICESPY_DELAY_SECONDS", 3),
  },

  ntfy: {
    url: str("NTFY_URL").replace(/\/+$/, ""),
    topic: str("NTFY_TOPIC", "pricewatch"),
    token: str("NTFY_TOKEN"),
  },

  alerts: {
    /** Alert when the best price drops this many percent below the 7-day median. */
    dropPercent: num("ALERT_DROP_PERCENT", 5),
    /** Also alert when a newly discovered seller beats the current best by this percent. */
    discoveryBeatPercent: num("ALERT_DISCOVERY_BEAT_PERCENT", 5),
  },

  userAgent: str("USER_AGENT", "pricewatch/0.1 (self-hosted personal price tracker; low volume)"),
};

export type Config = typeof config;

export function validateConfig(): string[] {
  const problems: string[] = [];
  if (!config.adminToken || config.adminToken.length < 16) {
    problems.push("ADMIN_TOKEN must be set to a random string of at least 16 characters.");
  }
  if (config.changedetection.url && !config.changedetection.apiKey) {
    problems.push("CHANGEDETECTION_API_KEY is required when CHANGEDETECTION_URL is set.");
  }
  return problems;
}
