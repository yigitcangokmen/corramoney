import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentSource, eventOf, initAnalytics, isLocalStats, sourceTagOf, track } from './analytics';

/** A storage like sessionStorage. */
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

/** Just enough DOM for initAnalytics: createElement, head.appendChild and attributes. */
function fakeDom(search = '') {
  const appended: any[] = [];
  const doc = {
    createElement: () => {
      const attrs: Record<string, string> = {};
      return { async: false, src: '', attrs, setAttribute: (k: string, v: string) => { attrs[k] = v; } };
    },
    head: { appendChild: (el: any) => appended.push(el) },
  };
  const win: any = { location: { search } };
  return { doc: doc as unknown as Document, win: win as Window & { goatcounter?: any }, appended };
}

const g = globalThis as any;
afterEach(() => {
  delete g.window;
  delete g.location;
});

describe('analytics', () => {
  it('AN1 sourceTagOf: S, B and U 1-99 only', () => {
    for (const t of ['U3', 'S12', 'B1', 'U99']) expect(sourceTagOf(`?utm_campaign=cdp&utm_source=${t}`)).toBe(t);
    for (const t of ['U0', 'U100', 'X1', 'GBUUVSY5KBG5JNQNTHSF7L5KJ7VKJ732JOS3KJXUALBEQSLHX4MGJEKO', 'U3;x', '', 'u3', 'U03']) {
      expect(sourceTagOf(`?utm_source=${encodeURIComponent(t)}`)).toBeNull();
    }
    expect(sourceTagOf('')).toBeNull();
  });

  it('AN2 eventOf carries the event name and the tag as referrer, nothing else', () => {
    expect(eventOf('sign', 'U3')).toEqual({ path: 'sign', event: true, referrer: 'U3' });
    // Untagged: an explicit '' (count.js 2.7.0 only falls back to document.referrer for null/undefined;
    // '' is then left out of the request and stored as an empty ref, so no foreign URL lands in the tag column).
    expect(eventOf('quote', null)).toEqual({ path: 'quote', event: true, referrer: '' });
    for (const e of ['wallet-connect', 'quote', 'sign'] as const) {
      for (const k of Object.keys(eventOf(e, 'B2'))) expect(['path', 'event', 'referrer']).toContain(k);
    }
  });

  it('AN3 track counts once; a missing or throwing goatcounter never throws', () => {
    const count = vi.fn();
    g.location = { search: '?utm_source=U3' };
    g.window = { goatcounter: { count }, sessionStorage: memory() };
    track('sign');
    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith({ path: 'sign', event: true, referrer: 'U3' });
    g.window = {};
    expect(() => track('quote')).not.toThrow();
    g.window = { goatcounter: { count: () => { throw new Error('blocked'); } } };
    expect(() => track('quote')).not.toThrow();
    delete g.window;
    expect(() => track('wallet-connect')).not.toThrow();
  });

  it('AN4 initAnalytics: nothing without an origin; one async script, settings before it loads', () => {
    const none = fakeDom();
    initAnalytics(undefined, none.doc, none.win);
    expect(none.appended).toHaveLength(0);
    expect(none.win.goatcounter).toBeUndefined();

    const prod = fakeDom('?utm_campaign=cdp&utm_source=S3');
    initAnalytics('https://stats.corra.money', prod.doc, prod.win);
    expect(prod.appended).toHaveLength(1);
    expect(prod.appended[0].async).toBe(true);
    expect(prod.appended[0].attrs['data-goatcounter']).toBe('https://stats.corra.money/count');
    expect(prod.appended[0].src).toBe('https://stats.corra.money/count.js');
    // S2-2: the browser runs count.js only if it is the pinned goatcounter:2.7.0 file.
    expect(prod.appended[0].integrity).toBe('sha384-ibA+WLRCY3W4rrf/Qi6Z02iu3FWDJOW41oKXAKzGUka17bnDTswba03X3emshpZS');
    expect(prod.appended[0].crossOrigin).toBe('anonymous');
    expect(prod.win.goatcounter.allow_local).toBe(false);
    expect(prod.win.goatcounter.no_events).toBe(true);
    expect(prod.win.goatcounter.path()).toBe('/');

    const local = fakeDom();
    initAnalytics('http://stats.localhost:8094', local.doc, local.win);
    expect(local.win.goatcounter.allow_local).toBe(true);
    for (const o of ['http://localhost:8094', 'http://127.0.0.1:8081', 'https://localhost']) expect(isLocalStats(o)).toBe(true);
    for (const o of ['https://stats.corra.money', 'http://localhost.evil.com', 'http://127.0.0.2']) expect(isLocalStats(o)).toBe(false);
  });

  it('AN5 currentSource keeps a URL tag for the tab; storage errors give the URL tag or null', () => {
    const s = memory();
    expect(currentSource('?utm_source=U2', s)).toBe('U2');
    expect(currentSource('', s)).toBe('U2');
    expect(currentSource('?utm_source=bad', s)).toBe('U2');
    const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(currentSource('?utm_source=S4', throwing)).toBe('S4');
    expect(currentSource('', throwing)).toBeNull();
    expect(currentSource('', undefined)).toBeNull();
  });

  it('AN6 the only counting calls are five track() calls with a literal event, and only analytics.ts names goatcounter', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n) ? [p] : [];
    });
    const calls: string[] = [];
    for (const f of files(src)) {
      const text = readFileSync(f, 'utf8');
      const rel = f.slice(src.length);
      if (rel !== 'logic/analytics.ts') expect(text.toLowerCase().includes('goatcounter'), rel).toBe(false);
      const imports = [...text.matchAll(/import\s+(.+?)\s+from\s+'\.{1,2}\/(?:logic\/)?analytics'/g)].map((m) => m[1]);
      for (const i of imports) expect(['{ track }', '{ initAnalytics }', '* as analytics'], `${rel}: ${i}`).toContain(i);
      // The analytics track(): `analytics.track(` anywhere, or a bare `track(` where `{ track }` is imported from it.
      const pattern = imports.includes('{ track }') ? /(?<![\w.])track\(([^)]*)\)/g : /\banalytics\.track\(([^)]*)\)/g;
      for (const m of text.matchAll(pattern)) {
        expect(m[1], `${rel}: ${m[0]}`).toMatch(/^'(wallet-connect|quote|sign)'$/);
        calls.push(`${rel} ${m[1]}`);
      }
    }
    expect(calls.sort()).toEqual([
      "logic/cashout.ts 'sign'", "logic/pool.ts 'sign'", "logic/remit.ts 'quote'", "logic/remit.ts 'sign'", "logic/wallet.ts 'wallet-connect'",
    ]);
  });
});
