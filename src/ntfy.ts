import { config } from "./config.ts";
import { log } from "./log.ts";

export interface Notice {
  title: string;
  message: string;
  click?: string;
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
}

export async function notify(n: Notice): Promise<void> {
  if (!config.ntfy.url) {
    log.info(`(ntfy not configured) ${n.title}: ${n.message}`);
    return;
  }
  const headers: Record<string, string> = {
    Title: encodeHeader(n.title),
    Priority: String(n.priority ?? 3),
  };
  if (n.tags?.length) headers.Tags = n.tags.join(",");
  if (n.click) headers.Click = n.click;
  if (config.ntfy.token) headers.Authorization = `Bearer ${config.ntfy.token}`;
  try {
    const res = await fetch(`${config.ntfy.url}/${encodeURIComponent(config.ntfy.topic)}`, {
      method: "POST",
      headers,
      body: n.message,
      redirect: "error", // a redirect (e.g. http->https) would silently drop the message
    });
    if (!res.ok) log.warn(`ntfy returned HTTP ${res.status}`);
  } catch (e) {
    log.warn(`ntfy failed: ${(e as Error).message}`);
  }
}

// HTTP headers must be latin-1; ntfy accepts RFC 2047 encoded-words for anything else.
function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}
