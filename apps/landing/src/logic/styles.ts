import type { CSSProperties } from 'react';

const CAMEL = (p: string) =>
  p.startsWith('--') ? p : p.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export function css(decl?: string | null): CSSProperties {
  const out: Record<string, string> = {};
  if (!decl) return out as CSSProperties;
  let depth = 0, buf = '';
  const parts: string[] = [];
  for (const ch of decl) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ';' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf);
  for (const p of parts) {
    const i = p.indexOf(':');
    if (i < 0) continue;
    const k = p.slice(0, i).trim();
    const val = p.slice(i + 1).trim();
    if (!k || !val) continue;
    out[CAMEL(k)] = val;
  }
  return out as CSSProperties;
}
