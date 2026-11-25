/**
 * Writes the month-2 block of EVIDENCE.md from evidence/2026-12/ (run files and manual.json):
 * every SOW 6.1 line with its stellar.expert links, ledgers and archive paths. Offline: it reads
 * only files. Only the text between the evidence-index markers changes.
 *
 *   pnpm evidence-index            write the block
 *   pnpm evidence-index --print    print it instead
 *   pnpm evidence-index --check    exit 1 with one line per problem: an item without evidence (the
 *                                  builder's D1.hosted, D3.ci and video may be pending unless --final),
 *                                  a cited hash not archived, a missing file, a claim the archived
 *                                  transaction contradicts, forbidden content (token=, a seed, > 2 MB),
 *                                  a pre-reset source written after the testnet reset
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { checkItems, EVIDENCE_ROOT, forbiddenIn, lateSources, readManual, renderBlock, replaceBlock, resolveItems, sourcesOnDisk } from './lib/evidence';

const args = process.argv.slice(2);
const MD = 'EVIDENCE.md';

function main() {
  const r = resolveItems();
  const manual = readManual();
  if (args.includes('--check')) {
    const problems = [...checkItems(r, EVIDENCE_ROOT, args.includes('--final')), ...forbiddenIn([MD, 'evidence/2026-10']), ...lateSources(sourcesOnDisk())];
    for (const v of r.values()) if (v.warning && v.primary) problems.push(`${v.primary.item}: ${v.warning} (warning)`);
    const failing = problems.filter((p) => !p.endsWith('(warning)'));
    for (const p of problems) console.log(p);
    if (failing.length) process.exit(1);
    console.log(`evidence-index --check: PASS${args.includes('--final') ? ' (final)' : ' (builder items may be pending)'}`);
    return;
  }
  const block = renderBlock(r, manual);
  if (args.includes('--print')) {
    console.log(block);
    return;
  }
  const md = readFileSync(MD, 'utf8');
  const next = replaceBlock(md, block);
  if (next === md) {
    console.log(`${MD}: the month-2 block is current`);
    return;
  }
  writeFileSync(MD, next);
  console.log(`wrote the month-2 block of ${MD}`);
}

main();
