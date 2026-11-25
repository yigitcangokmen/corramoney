/**
 * Cookie-less usage counts on Corra's own GoatCounter (stats.corra.money; stats.localhost:8094 on the
 * local stack): one page view per visit and three named events. Every hit is a count.js 2.7.0 request
 * carrying: p (path: '/' for the page view, the event name for an event), r (referrer: for the page
 * view the browser's document.referrer; for an event the participant tag, or '' which is left out),
 * t (the page title), q (location.search, so utm_campaign/utm_source ride along), s (screen width),
 * b (bot flag), e (event yes/no) and a random cache-buster. GoatCounter itself takes a utm_source in
 * q as the ref. Never an address, an amount, a hash, an id or an error text: track() takes nothing
 * but the event name.
 */
export type StatEvent = 'wallet-connect' | 'quote' | 'sign';

type GoatCounter = {
  path?: () => string;
  allow_local?: boolean;
  no_events?: boolean;
  count?: (o: { path: string; event: boolean; referrer?: string }) => void;
};

/**
 * Subresource integrity of count.js as arp242/goatcounter:2.7.0 serves it (the image both compose
 * files pin). The app builds the XDRs it hands to Freighter, so a changed count.js (a compromised
 * stats container) is refused by the browser instead of running on this origin. Upgrading the image
 * means a new hash here; `pnpm ops-check` compares it with what the stats host serves.
 */
export const COUNT_JS_SRI = 'sha384-ibA+WLRCY3W4rrf/Qi6Z02iu3FWDJOW41oKXAKzGUka17bnDTswba03X3emshpZS';

const TAG = /^[SBU][1-9][0-9]?$/;
const STORE_KEY = 'corra_src';

/** http(s)://localhost, *.localhost or 127.0.0.1, any port. */
export const isLocalStats = (origin: string): boolean => /^https?:\/\/(localhost|[a-z0-9-]+(\.[a-z0-9-]+)*\.localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);

/** ?utm_source= S1-S99 (interview), B1-B99 (builder demo), U1-U99 (user test); anything else null. */
export function sourceTagOf(search: string): string | null {
  const tag = new URLSearchParams(search).get('utm_source');
  return tag && TAG.test(tag) ? tag : null;
}

const tabStorage = (): Pick<Storage, 'getItem' | 'setItem'> | undefined => {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
};

/** Tag from the URL, else the one kept for this tab (sessionStorage 'corra_src'); storage errors -> null. */
export function currentSource(search: string = typeof location === 'undefined' ? '' : location.search,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = tabStorage()): string | null {
  const fromUrl = sourceTagOf(search);
  try {
    if (fromUrl) {
      storage?.setItem(STORE_KEY, fromUrl);
      return fromUrl;
    }
    const kept = storage?.getItem(STORE_KEY) ?? null;
    return kept && TAG.test(kept) ? kept : null;
  } catch {
    return fromUrl;
  }
}

/**
 * No-op without an origin. Sets win.goatcounter = { path: () => '/', allow_local: isLocalStats(origin), no_events: true }
 * and appends <script async data-goatcounter="<origin>/count" src="<origin>/count.js" integrity=COUNT_JS_SRI
 * crossorigin="anonymous"> (GoatCounter answers count.js with Access-Control-Allow-Origin: *). Never throws.
 * The page view is count.js's own: every visit counts as '/', the query (utm_campaign, utm_source) rides along.
 */
export function initAnalytics(origin: string | undefined, doc: Document, win: Window): void {
  if (!origin) return;
  try {
    currentSource(win.location?.search ?? '');
    (win as unknown as { goatcounter: GoatCounter }).goatcounter = { path: () => '/', allow_local: isLocalStats(origin), no_events: true };
    const s = doc.createElement('script');
    s.async = true;
    s.setAttribute('data-goatcounter', `${origin}/count`);
    s.src = `${origin}/count.js`;
    s.integrity = COUNT_JS_SRI;
    s.crossOrigin = 'anonymous';
    doc.head.appendChild(s);
  } catch {
    // Counting is never worth breaking the app for.
  }
}

/**
 * The event GoatCounter records: the name as its path, and the participant tag as its referrer. Untagged
 * events pass referrer '' on purpose: count.js falls back to document.referrer only for null/undefined.
 */
export function eventOf(e: StatEvent, source: string | null): { path: StatEvent; event: true; referrer: string } {
  return { path: e, event: true, referrer: source ?? '' };
}

/** window.goatcounter?.count(eventOf(e, currentSource())); swallows every error. */
export function track(e: StatEvent): void {
  try {
    const gc = (window as unknown as { goatcounter?: GoatCounter }).goatcounter;
    gc?.count?.(eventOf(e, currentSource()));
  } catch {
    // never breaks the flow it counts
  }
}
