/**
 * The release gate's secret scan: every file git would ship (tracked, modified and untracked, not
 * ignored) checked for a standalone secret seed. Returns paths with line numbers, never the match.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { SEED } from './evidence';

/** `<path>:<line>` for every line of `files` that holds a seed-shaped string; images are skipped. */
export function seedHits(files: string[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!existsSync(f) || !statSync(f).isFile() || /\.(png|jpe?g|webp|gif|ico|woff2?|mp4|webm|pdf)$/i.test(f)) continue;
    readFileSync(f, 'latin1').split('\n').forEach((line, i) => {
      if (SEED.test(line)) out.push(`${f}:${i + 1}`);
    });
  }
  return out;
}
