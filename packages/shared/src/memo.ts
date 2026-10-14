/**
 * The SEP-24 deposit memo that ties an anchor's cash-in payment to exactly one saga.
 * A hash memo (base64, as SEP-24 and Horizon carry it) of sha256(paymentId). Without it, a
 * sender with two pending payments would let one deposit settle whichever saga looked first.
 */
export async function cashInMemo(paymentId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(paymentId));
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin);
}
