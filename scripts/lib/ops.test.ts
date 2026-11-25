import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statsSiteLevel } from './ops';

test('OP1 stats site: PASS only for an answer without the first-site form (S2-4)', () => {
  assert.equal(statsSiteLevel(200, '<html>dashboard</html>').level, 'PASS');
  assert.equal(statsSiteLevel(303, '').level, 'PASS');
  assert.equal(statsSiteLevel(302, '').level, 'PASS');
  assert.equal(statsSiteLevel(200, 'Create your first site and user').level, 'FAIL');
  // unreachable (http() gives status 0 and the error text) or an error status proves nothing
  assert.equal(statsSiteLevel(0, 'fetch failed').level, 'WARN');
  assert.match(statsSiteLevel(0, 'fetch failed').detail, /fetch failed/);
  assert.equal(statsSiteLevel(502, 'Bad Gateway').level, 'WARN');
  assert.equal(statsSiteLevel(404, '').level, 'WARN');
});
