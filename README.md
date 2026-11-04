# pricewatch

A small self-hosted price tracker for a personal shopping list. It combines:

- **[changedetection.io](https://github.com/dgtlmoon/changedetection.io)** for checking specific product pages (price + stock),
- **PriceSpy** product pages for seeing every retailer that sells a product (works with pricespy.co.nz, pricespy.co.uk and the other PriceSpy/Prisjakt sites),
- an optional daily **Claude** job that searches for sellers and deals the other two miss (specialist stores, Amazon, second-hand marketplaces),

and shows the result in one dashboard with delivered prices, price history, a 7-day trend and [ntfy](https://ntfy.sh) push alerts.

No accounts, no tracking, no third-party requests from the dashboard. One SQLite file holds all data.

## How it works

```
changedetection.io ──(API, every 30 min)──▶ pricewatch ──▶ dashboard + ntfy alerts
PriceSpy pages ─────(every 6 h)───────────▶     ▲
Claude discovery ───(daily, optional)───────────┘  (reports new sellers through the API)
```

- **Items** are the things you want to buy. Each item can have:
  - PriceSpy product IDs (the number in `product.php?p=…`), read every few hours. Every seller listed there becomes an offer.
  - changedetection watches. Untagged watches appear on the dashboard (when unlocked) under **New changedetection watches**, where you pick the item each one belongs to. Alternatively tag the watch `pw:<item-id>` (prefix configurable) and it links itself. Use the "Re-stock & Price detection" processor so snapshots contain the price.
  - manual seller pages with a price you enter (e.g. an overseas store with known shipping and import fees).
- **Best price** = cheapest fresh offer that is in stock (falling back to unknown stock), converted to `BASE_CURRENCY` with live ECB rates, plus shipping and import fees.
- **Alerts** (ntfy): best price at or under your target, best price 5%+ under the 7-day median, a new seller that beats the current best, and back-in-stock. Repeats are suppressed for 7 days.

## Run it

```bash
cp .env.example .env
# set ADMIN_TOKEN (openssl rand -hex 24) and any optional integrations
docker compose up -d --build
```

Open `http://<host>:8080`, click **Edit**, enter the admin token, and add an item.

Without Docker: Node 22.18+ runs the TypeScript source directly.

```bash
npm install
ADMIN_TOKEN=... npm start
```

### Unraid

Build the image (or use the compose file with the Compose Manager plugin), then:

| Setting | Value |
|---|---|
| Port | container `8080` → any free host port |
| Path | container `/data` → `/mnt/user/appdata/pricewatch` |
| Variables | as in `.env.example` (at least `ADMIN_TOKEN`) |
| Extra Parameters | `--user 99:100` (matches Unraid's usual appdata owner) |

The image runs as a non-root user (uid 1000) by default, so the `/data` folder must be writable by whichever user it runs as. Either add `--user 99:100` as above, or `chown -R 1000:1000` the appdata folder. Otherwise it exits with "Cannot open …/pricewatch.db".

If the container has Unraid's Tailscale integration enabled, Tailscale replaces the container's DNS, so other containers can't be reached by name. Use their IP or host port in `CHANGEDETECTION_URL`, or add `--accept-dns=false` to the Tailscale extra parameters.

If `NTFY_URL` sits behind a reverse proxy that redirects HTTP to HTTPS, use the `https://` URL. Redirected POSTs lose their body, so messages would silently disappear (pricewatch refuses redirects and logs a warning instead).

## Configuration

All configuration is environment variables; see [`.env.example`](.env.example). Nothing deployment-specific belongs in the repo.

| Variable | Default | Purpose |
|---|---|---|
| `ADMIN_TOKEN` | (required) | Bearer token for every write and for the discovery job |
| `PUBLIC_READ` | `true` | Let anyone who can reach the app view prices |
| `BASE_CURRENCY` | `NZD` | Currency for comparisons |
| `CHANGEDETECTION_URL` / `_API_KEY` | | Enable changedetection sync |
| `PRICESPY_BASE_URL` | `https://pricespy.co.nz` | Which PriceSpy site to read |
| `NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` | | Enable push alerts |
| `ALERT_DROP_PERCENT` | `5` | Trend-drop threshold |

## API

All responses are JSON. Writes need `Authorization: Bearer $ADMIN_TOKEN`.

| Method | Path | |
|---|---|---|
| GET | `/api/health` | Sync times, FX rates |
| GET | `/api/items` | Every item with offers, best price, trend, history, alerts and discoveries |
| POST | `/api/items` | `{name, query, category, priority: "buy"\|"bargain", target, pricespyIds, allowUsed, notes}` |
| PATCH / DELETE | `/api/items/:id` | Edit / remove |
| POST | `/api/items/:id/sources` | `{url, seller, country, watch: true}` creates a tagged changedetection watch; without `watch`, add `price, currency, shipping, importFees, inStock` for a manual offer |
| GET | `/api/watches/unlinked` | changedetection watches not linked to an item (admin) |
| POST | `/api/watches/:uuid/link` | `{itemId}` links a watch to an item |
| DELETE | `/api/sources/:id` | Stop using a seller page (remove the `pw:` tag too, if it has one) |
| POST | `/api/discoveries` | `{discoveries: [{itemId, text, url, price, currency, seller}]}` |
| POST | `/api/sync` | Run the changedetection and PriceSpy syncs now |

## Discovery job (optional)

`discovery/` contains a container that runs [Claude Code](https://docs.claude.com/en/docs/claude-code) headless once a day. It reads the watchlist, searches the web for sellers that aren't known yet (respecting robots.txt and never using logged-in sites), and posts findings to `/api/discoveries`. It can only use web search, web fetch and a small `pw` helper (`discovery/pw.mjs`) that reads the API address and token from the environment, so the token never appears in any command Claude runs.

```bash
claude setup-token          # on any machine with Claude Code; copy the token
# put it in .env as CLAUDE_CODE_OAUTH_TOKEN, then:
docker compose --profile discovery up -d --build
```

It uses your Claude subscription's normal usage limits. Run once by hand with `docker compose run --rm discovery /discovery/run.sh --once`.

## Being a good citizen

- PriceSpy is read one product page at a time with a delay (`PRICESPY_DELAY_SECONDS`), identifying itself with an honest user agent. Search and click-out URLs, which robots.txt disallows, are never requested.
- Sites that block automated requests are left alone; there is no user-agent spoofing or proxy rotation. Keep check intervals modest.
- Check each site's terms before tracking it.

## Development

```bash
npm install
npm run typecheck
npm test
```

## License

MIT
