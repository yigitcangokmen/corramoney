import * as S from '@stellar/stellar-sdk';
import { FIAT, fiatAsset } from '@corra/shared';
import { createChannels, createHorizonGateway, createPoolChain, createSponsor, MAX_POOL_AMOUNT_RAW } from '@corra/stellar';
import { createCashOuts, createDeposits, createSaga } from '@corra/settlement-saga';
import { buildApp, LOCAL_SETUP_LIMITS } from './app';
import { fetchAnchorSigningKey } from './callback';
import { createClientDomainSigner } from './client-domain';
import { assertSponsorKey, loadConfig } from './config';
import { PostgresDepositStore } from './db/deposit-store';
import { createDbPool } from './db/pool';
import { PostgresPoolOpStore } from './db/pool-store';
import { migrate, PostgresSagaStore } from './db/store';
import { createPoolOps } from './pool-ops';
import { drainAndClose, startReconcileLoop } from './reconcile-loop';
import { createPrepareSetup } from './setup';

async function main() {
  const cfg = loadConfig();
  // Structured events from the saga and the deposits, into the app's log once it exists.
  let app: ReturnType<typeof buildApp>;
  const pool = createDbPool(cfg.databaseUrl, (e) => (app ? app.log.error({ evt: 'db.pool_error', error: e.message }) : console.error('db pool error', e.message)));
  await migrate(pool);

  const horizon = new S.Horizon.Server(cfg.horizonUrl, { allowHttp: cfg.horizonUrl.startsWith('http://') });
  const poolScope = cfg.pool
    ? { poolId: cfg.pool.pool, asset: cfg.pool.asset, maxAmountRaw: MAX_POOL_AMOUNT_RAW, maxResourceFee: cfg.maxSorobanResourceFee }
    : undefined;
  // The trustlines a setup may add: the sponsor and the channel accounts sign under the same scope.
  const setupTrust = { trustIssuer: cfg.corridorIssuer, trustCodes: Object.values(FIAT).map((f) => f.code), maxTrust: 2 };
  const sponsor = createSponsor(cfg.feeSponsorSecret, cfg.networkPassphrase, {
    ...setupTrust,
    pool: poolScope,
    // The recipient's SEP-24 withdrawal payment: only to the anchor's distribution account, in TESTPHP.
    cashOut: { destination: cfg.anchorDistribution, asset: fiatAsset('PHP') },
    channels: cfg.channelPublicKeys,
  });
  assertSponsorKey(sponsor.publicKey);
  const gateway = createHorizonGateway({ horizonUrl: cfg.horizonUrl, networkPassphrase: cfg.networkPassphrase, sponsor });
  const channels = createChannels(cfg.channelSecrets, {
    networkPassphrase: cfg.networkPassphrase, sequenceOf: gateway.accountSequence, allowed: cfg.channelPublicKeys,
    sponsor: sponsor.publicKey, trust: setupTrust,
  });
  const log = (line: { evt: string } & Record<string, unknown>) => app?.log.info(line);
  const sagaStore = new PostgresSagaStore(pool);
  const saga = createSaga({
    store: sagaStore,
    gateway,
    networkPassphrase: cfg.networkPassphrase,
    corridorIssuer: cfg.corridorIssuer,
    anchorDistribution: cfg.anchorDistribution,
    anchorId: cfg.anchorId,
    log,
  });
  const cashOuts = createCashOuts({
    store: sagaStore,
    gateway,
    networkPassphrase: cfg.networkPassphrase,
    anchorId: cfg.anchorId,
    anchorDistribution: cfg.anchorDistribution,
    asset: fiatAsset('PHP'),
    log,
  });
  const deposits = createDeposits({
    store: new PostgresDepositStore(pool),
    gateway,
    anchorId: cfg.anchorId,
    anchorDistribution: cfg.anchorDistribution,
    asset: fiatAsset('MXN'),
    log,
  });

  const poolOps = cfg.pool && poolScope ? createPoolOps({
    store: new PostgresPoolOpStore(pool, { code: cfg.pool.assetCode, issuer: cfg.pool.assetIssuer }),
    chain: createPoolChain({ rpcUrl: cfg.rpcUrl, networkPassphrase: cfg.networkPassphrase, sponsor }),
    scope: poolScope,
    asset: { code: cfg.pool.assetCode, issuer: cfg.pool.assetIssuer },
    sponsorPublicKey: sponsor.publicKey,
    isPaymentAccountOf: gateway.isPaymentAccountOf,
    networkPassphrase: cfg.networkPassphrase,
    log,
  }) : undefined;

  let anchorKey: string | undefined = cfg.anchorSigningKey;
  const anchorSigningKey = async () => (anchorKey ??= await fetchAnchorSigningKey(cfg.anchorHomeDomain));

  app = buildApp({
    saga,
    deposits,
    cashOuts,
    networkPassphrase: cfg.networkPassphrase,
    corsOrigins: cfg.corsOrigins,
    clientDomain: createClientDomainSigner(cfg.clientDomainSecret, cfg.networkPassphrase, cfg.clientDomain),
    anchorSigningKey,
    poolOps,
    log: true,
    limits: cfg.localSetupLimits ? LOCAL_SETUP_LIMITS : undefined,
    prepareSetup: createPrepareSetup({
      sponsor,
      channels,
      log,
      networkPassphrase: cfg.networkPassphrase,
      chain: {
        sponsorSequence: async () => (await horizon.loadAccount(sponsor.publicKey)).sequence,
        trustlines: (account) => horizon.loadAccount(account).then(
          (a) => (a.balances as any[]).filter((b) => b.asset_code && b.asset_issuer).map((b) => ({ code: b.asset_code, issuer: b.asset_issuer })),
          (e) => (e?.response?.status === 404 ? null : Promise.reject(e)),
        ),
        paymentAccountOf: gateway.paymentAccountOf,
      },
    }),
  });

  // Every pass still in flight, so shutdown lets them finish before the pool closes.
  const loop = startReconcileLoop(() => Promise.allSettled([
    saga.reconcileAll(cfg.reconcileIdleMs).catch((e) => app.log.error(e)),
    deposits.reconcileDeposits().catch((e) => app.log.error(e)),
    cashOuts.reconcile().catch((e) => app.log.error(e)),
    poolOps?.reconcile().catch((e) => app.log.error(e)),
  ]), cfg.reconcileEveryMs);

  // deploy/docker-compose.yml gives the orchestrator a stop_grace_period above both 15 s bounds.
  const shutdown = async () => {
    log({ evt: 'shutdown.start' });
    await drainAndClose(loop, () => app.close(), () => pool.end(), 15_000);
    log({ evt: 'shutdown.drained' });
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  app.log.info({ evt: 'setup.channels', count: channels.publicKeys.length, localSetupLimits: cfg.localSetupLimits });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
