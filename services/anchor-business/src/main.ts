import { buildServer, configFromEnv, createHorizonPayoutChain, createPayoutPoller, createPlatformClient, POLL_MS } from './server';

const cfg = configFromEnv();
const platform = createPlatformClient(cfg.platformApi);
const app = buildServer(cfg, { platform });
app
  .listen({ port: cfg.port, host: '0.0.0.0' })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

// The withdrawal payout poller: one tick at a time; an error is logged, never thrown.
const poller = createPayoutPoller({ cfg, platform, chain: createHorizonPayoutChain(cfg.horizonUrl), log: (o) => app.log.info(o) });
let running = false;
setInterval(() => {
  if (running) return;
  running = true;
  poller.tick().catch((e) => app.log.error(e)).finally(() => { running = false; });
}, POLL_MS);
