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

export const chip = 'font-family:var(--mono); font-size:12px; padding:var(--sp-2) var(--sp-3);' +
  'background:var(--surface); color:var(--muted); border:1px solid var(--line);' +
  'border-radius:var(--r-xs); cursor:pointer;';

export const cta = (ok: boolean) =>
  'width:100%; margin-top:var(--sp-5); font-size:15px; font-weight:600;' +
  'padding:var(--sp-4); border:none; border-radius:var(--r-sm); line-height:1.2;' +
  (ok ? 'background:var(--brand); color:var(--on); cursor:pointer;'
      : 'background:var(--n-100); color:var(--n-400); cursor:not-allowed;');

export const flat = (ok: boolean) =>
  'font-size:14.5px; font-weight:600; padding:var(--sp-3) var(--sp-4);' +
  'border-radius:var(--r-sm); cursor:pointer; line-height:1.2;' +
  (ok ? 'background:var(--brand); color:var(--on); border:none;'
      : 'background:var(--surface); color:var(--text); border:1px solid var(--line-strong);');

export const hint = (a: number, ok: boolean, min: number) =>
  a === 0 ? 'Min \u20BA50 \u00B7 Max \u20BA3,000'
  : ok ? 'Min \u20BA50 \u00B7 Max \u20BA3,000'
  : a < min ? 'Minimum \u20BA50' : 'Maximum \u20BA3,000';
