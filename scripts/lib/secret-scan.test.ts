import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';
import { seedHits } from './secret-scan';

test('SS1 a standalone seed in any file is a hit (path:line only); base64 XDR runs are not (S2-1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'secret-scan-'));
  const seed = Keypair.random().secret();
  const leak = join(dir, 'untracked.ts');
  writeFileSync(leak, `const a = 1;\nconst k = '${seed}';\n`);
  const xdr = join(dir, 'tx.json');
  // An envelope's zero bytes read as a long run of A's inside base64, which the raw regex flagged.
  writeFileSync(xdr, JSON.stringify({ envelope_xdr: `AAAAAgAAAAB${'S'.padEnd(56, 'A')}QAAAAA==` }));
  const hits = seedHits([leak, xdr, join(dir, 'gone.ts')]);
  assert.deepEqual(hits, [`${leak}:2`]);
  assert.ok(!hits.join('\n').includes(seed));
  // C6-2: a seed in a URL path, after '+', before '/' or '=' is a hit too
  const shapes = join(dir, 'shapes.txt');
  writeFileSync(shapes, [`GET /keys/${seed}`, `a+${seed}`, `${seed}/b`, `${seed}=`].join('\n'));
  assert.deepEqual(seedHits([shapes]), [1, 2, 3, 4].map((n) => `${shapes}:${n}`));
});
