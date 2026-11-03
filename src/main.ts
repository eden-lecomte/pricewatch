import { config, validateConfig } from "./config.ts";
import { refreshRates } from "./fx.ts";
import { evaluate, syncChangedetection, syncPriceSpy } from "./jobs.ts";
import { onSyncRequest, startServer } from "./server.ts";
import { log } from "./log.ts";

const problems = validateConfig();
if (problems.length) {
  for (const p of problems) log.error(p);
  process.exit(1);
}

let chain: Promise<void> = Promise.resolve();
/** Queue jobs so only one runs at a time, then re-evaluate alerts. */
function queue(name: string, fn: () => Promise<void>): Promise<void> {
  chain = chain.then(async () => {
    try {
      await fn();
      await evaluate();
    } catch (e) {
      log.error(`${name}: ${(e as Error).message}`);
    }
  });
  return chain;
}

function every(minutes: number, name: string, fn: () => Promise<void>): void {
  if (minutes > 0) setInterval(() => void queue(name, fn), minutes * 60_000);
}

startServer();
onSyncRequest(async () => {
  await queue("changedetection", syncChangedetection);
  await queue("pricespy", syncPriceSpy);
});

void queue("fx", refreshRates);
void queue("changedetection", syncChangedetection);
void queue("pricespy", syncPriceSpy);

every(12 * 60, "fx", refreshRates);
every(config.changedetection.syncMinutes, "changedetection", syncChangedetection);
every(config.pricespy.intervalHours * 60, "pricespy", syncPriceSpy);
