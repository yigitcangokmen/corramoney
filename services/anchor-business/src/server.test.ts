import { createHmac } from 'node:crypto';
import * as S from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { buildServer, verifyInteractiveJwt } from './server';

const SECRET = 'test-interactive-secret-0123456789abcdef';
const ISSUER = S.Keypair.random().publicKey();
const ASSET = `stellar:TESTMXN:${ISSUER}`;
const now = () => Math.floor(Date.now() / 1000);

function jwt(claims: object, secret = SECRET, alg = 'HS256') {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${b64({ alg, typ: 'JWT' })}.${b64(claims)}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}

const app = buildServer(
  {
    platformApi: 'http://platform.invalid', jwtSecret: SECRET, horizonUrl: 'https://horizon.invalid',
    networkPassphrase: S.Networks.TESTNET, distributionSecret: S.Keypair.random().secret(),
    assetCode: 'TESTMXN', assetIssuer: ISSUER,
  },
  { logger: false },
);

describe('verifyInteractiveJwt', () => {
  it('accepts a live token signed with the platform secret', () => {
    expect(verifyInteractiveJwt(jwt({ jti: 'tx1', exp: now() + 60 }), SECRET, now()).jti).toBe('tx1');
  });

  it('rejects a wrong secret, an expired token, a missing transaction id and alg confusion', () => {
    expect(() => verifyInteractiveJwt(jwt({ jti: 'tx1', exp: now() + 60 }, 'other-secret'), SECRET, now())).toThrow(/bad signature/);
    expect(() => verifyInteractiveJwt(jwt({ jti: 'tx1', exp: now() - 1 }), SECRET, now())).toThrow(/expired/);
    expect(() => verifyInteractiveJwt(jwt({ exp: now() + 60 }), SECRET, now())).toThrow(/transaction id/);
    expect(() => verifyInteractiveJwt(jwt({ jti: 'tx1', exp: now() + 60 }, SECRET, 'none'), SECRET, now())).toThrow(/alg/);
  });

  it('the simulate endpoint refuses to move funds without a valid session', async () => {
    const r = await app.inject({ method: 'POST', url: '/sep24/simulate', payload: { token: jwt({ jti: 'x', exp: now() + 60 }, 'forged'), amount: '10' } });
    expect(r.statusCode).toBe(401);
  });
});

describe('SEP-38 /rate callback', () => {
  it('prices MXN <-> TESTMXN at 1:1 with no fee, firm quotes carry id and expiry', async () => {
    const ind = await app.inject({ url: `/rate?type=indicative&sell_asset=iso4217:MXN&buy_asset=${ASSET}&sell_amount=100` });
    expect(ind.json().rate).toEqual({ price: '1', sell_amount: '100', buy_amount: '100', fee: { total: '0', asset: 'iso4217:MXN' } });
    const firm = (await app.inject({ url: `/rate?type=firm&sell_asset=${ASSET}&buy_asset=iso4217:MXN&buy_amount=5.5` })).json().rate;
    expect(firm.buy_amount).toBe('5.5');
    expect(firm.id).toBeTruthy();
    expect(Date.parse(firm.expires_at)).toBeGreaterThan(Date.now());
  });

  it('refuses unknown pairs and ambiguous amounts', async () => {
    expect((await app.inject({ url: `/rate?type=firm&sell_asset=iso4217:USD&buy_asset=${ASSET}&sell_amount=1` })).statusCode).toBe(422);
    expect((await app.inject({ url: `/rate?type=firm&sell_asset=iso4217:MXN&buy_asset=${ASSET}&sell_amount=1&buy_amount=1` })).statusCode).toBe(400);
  });
});

describe('/sep24/simulate is bound to the platform record (audit regression)', () => {
  it('pays only the amount the deposit requested, and only once', async () => {
    const { createServer } = await import('node:http');
    const txs: Record<string, object> = {
      open: { status: 'incomplete', amount_expected: { amount: '334.2600000', asset: ASSET } },
      done: { status: 'completed', amount_expected: { amount: '10.0000000', asset: ASSET } },
    };
    const platform = createServer((req, res) => {
      const id = String(req.url).split('/').pop()!;
      res.writeHead(txs[id] ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(txs[id] ?? {}));
    });
    await new Promise<void>((r) => platform.listen(0, '127.0.0.1', r));
    const port = (platform.address() as { port: number }).port;
    const bound = buildServer(
      {
        platformApi: `http://127.0.0.1:${port}`, jwtSecret: SECRET, horizonUrl: 'https://horizon.invalid',
        networkPassphrase: S.Networks.TESTNET, distributionSecret: S.Keypair.random().secret(),
        assetCode: 'TESTMXN', assetIssuer: ISSUER,
      },
      { logger: false },
    );
    const sim = (jti: string, amount: string) =>
      bound.inject({ method: 'POST', url: '/sep24/simulate', payload: { token: jwt({ jti, exp: now() + 60 }), amount } });
    try {
      const more = await sim('open', '1000000');
      expect(more.statusCode).toBe(400);
      expect(more.json().error).toMatch(/requested deposit/);
      expect((await sim('done', '10')).statusCode).toBe(409);
    } finally {
      platform.close();
    }
  });
});
