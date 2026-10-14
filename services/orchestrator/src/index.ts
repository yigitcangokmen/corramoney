import pg from 'pg';
import * as S from '@stellar/stellar-sdk';
import { FIAT, fiatAsset } from '@corra/shared';
import { buildSponsoredSetup, createHorizonGateway, createSponsor } from '@corra/stellar';
import { createMockPayout, createSaga } from '@corra/settlement-saga';
import { buildApp } from './app';
import { fetchAnchorSigningKey } from './callback';
import { createClientDomainSigner } from './client-domain';
import { loadConfig } from './config';
import { migrate, PostgresSagaStore } from './db/store';

async function main() {
  const cfg = loadConfig();
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl });
  await migrate(pool);

  const horizon = new S.Horizon.Server(cfg.horizonUrl, { allowHttp: cfg.horizonUrl.startsWith('http://') });
  const sponsor = createSponsor(cfg.feeSponsorSecret, cfg.networkPassphrase, {
    trustIssuer: cfg.corridorIssuer,
    trustCodes: Object.values(FIAT).map((f) => f.code),
    maxTrust: 2,
  });
  const gateway = createHorizonGateway({ horizonUrl: cfg.horizonUrl, networkPassphrase: cfg.networkPassphrase, sponsor });
  const saga = createSaga({
    store: new PostgresSagaStore(pool),
    gateway,
    networkPassphrase: cfg.networkPassphrase,
    corridorIssuer: cfg.corridorIssuer,
    anchorDistribution: cfg.anchorDistribution,
    anchorId: cfg.anchorId,
    // Phase 1: the cash-out leg is a mock; a licensed anchor's payout API replaces it in Phase 2.
    payout: createMockPayout(),
  });

  let anchorKey: string | undefined = cfg.anchorSigningKey;
  const anchorSigningKey = async () => (anchorKey ??= await fetchAnchorSigningKey(cfg.anchorHomeDomain));

  const app = buildApp({
    saga,
    networkPassphrase: cfg.networkPassphrase,
    corsOrigins: cfg.corsOrigins,
    clientDomain: createClientDomainSigner(cfg.clientDomainSecret, cfg.networkPassphrase, cfg.clientDomain),
    anchorSigningKey,
    log: true,
    async prepareSetup(account, trust) {
      const [sp, exists] = await Promise.all([
        horizon.loadAccount(sponsor.publicKey),
        horizon.loadAccount(account).then(() => true, (e) => (e?.response?.status === 404 ? false : Promise.reject(e))),
      ]);
      const tx = buildSponsoredSetup({
        networkPassphrase: cfg.networkPassphrase,
        sponsor: sponsor.publicKey,
        sponsorSequence: sp.sequence,
        account,
        accountExists: exists,
        trust: trust.map(fiatAsset),
        now: Math.floor(Date.now() / 1000),
      });
      return sponsor.signSetup(tx.toXDR());
    },
  });

  const timer = setInterval(() => {
    saga.reconcileAll(cfg.reconcileIdleMs).catch((e) => app.log.error(e));
  }, cfg.reconcileEveryMs);

  const shutdown = async () => {
    clearInterval(timer);
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
