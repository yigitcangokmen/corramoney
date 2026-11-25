/**
 * Release gate: scans every file git would ship (`git ls-files -cmo --exclude-standard`: tracked,
 * modified and untracked, not ignored) for a standalone secret seed. Prints paths only; exit 1 on a hit.
 *
 *   pnpm secret-scan
 */
import { execFileSync } from 'node:child_process';
import { seedHits } from './lib/secret-scan';

const files = [...new Set(execFileSync('git', ['ls-files', '-cmo', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
const hits = seedHits(files);
for (const h of hits) console.error(`seed-shaped string: ${h}`);
console.log(`secret-scan: ${files.length} files, ${hits.length} hit(s)`);
if (hits.length) process.exit(1);
