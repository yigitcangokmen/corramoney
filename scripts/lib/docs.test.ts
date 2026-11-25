import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('DOC1 every route in app.ts is documented in docs/api.md', () => {
  const app = readFileSync('services/orchestrator/src/app.ts', 'utf8');
  const api = readFileSync('docs/api.md', 'utf8');
  const routes = [...app.matchAll(/app\.(get|post)(?:<[^(]*>)?\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  assert.ok(routes.length >= 20, `only ${routes.length} routes found in app.ts`);
  const missing = routes.filter((r) => !api.includes(r));
  assert.deepEqual(missing, []);
});

test('DOC2 the release checklist probes stats.corra.money/count.js with a GET (GoatCounter 2.7.0 answers HEAD with 405)', () => {
  const lines = readFileSync('docs/release-checklist.md', 'utf8').split('\n').filter((l) => l.includes('count.js') && /\bcurl\b/.test(l));
  assert.ok(lines.length >= 1, 'no count.js curl line in docs/release-checklist.md');
  for (const l of lines) assert.ok(!/curl\s+(-[a-zA-Z]*I\b|--head\b)/.test(l), `HEAD probe: ${l}`);
});
