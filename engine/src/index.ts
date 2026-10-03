import { env } from "./env.ts";
import { createApp } from "./app.ts";
import { getPublicClient, chainState } from "./chain/client.ts";
import { addressBook } from "./chain/addresses.ts";

const app = createApp();

Bun.serve({
  port: env.PORT,
  fetch: app.fetch,
});

// Best-effort boot diagnostics — never block or crash startup.
void (async () => {
  const s = await chainState(getPublicClient(), env.CHAIN_ID);
  if (s.checked && !s.healthy) {
    console.error(
      `[chain] CHAIN ID MISMATCH: engine serves ${env.CHAIN_ID} but RPC reports ${s.observed}. Chain reads will answer { available: false }.`,
    );
  } else if (!s.checked) {
    console.warn(`[chain] RPC for chain ${env.CHAIN_ID} not reachable yet (${new URL(env.RPC_URL).host}); retried per request`);
  }
  const book = addressBook();
  console.log(book.deployed ? `[contracts] SPARE address book loaded from ${book.source}` : `[contracts] ${book.reason}`);
})();

if (env.START_WORKERS === "1") {
  import("./workers/index.ts").catch((err) => console.error("[workers] failed to start:", err));
}

console.log(`spare-engine listening on http://localhost:${env.PORT} (chain=${env.CHAIN_ID})`);
