import { buildServer, configFromEnv } from './server';

const cfg = configFromEnv();
buildServer(cfg)
  .listen({ port: cfg.port, host: '0.0.0.0' })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
