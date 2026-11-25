/** Pure verdicts for `pnpm ops-check`. */

/**
 * The GoatCounter takeover guard: PASS only when the stats host answered (200, or a 302/303 to its
 * login) without the first-site form. A host that did not answer proves nothing: WARN, never PASS.
 */
export function statsSiteLevel(status: number, text: string): { level: 'PASS' | 'WARN' | 'FAIL'; detail: string } {
  if (text.includes('Create your first site')) return { level: 'FAIL', detail: 'offers "Create your first site": run db create site now' };
  if (status === 200 || status === 302 || status === 303) return { level: 'PASS', detail: `has its site (${status})` };
  return { level: 'WARN', detail: status ? `answered ${status}: the site is not proven` : `did not answer (${text}): the site is not proven` };
}
