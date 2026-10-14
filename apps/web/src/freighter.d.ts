interface FreighterApi {
  requestAccess(): Promise<{ address: string } | string>;
  signTransaction(xdr: string, opts: { networkPassphrase: string }): Promise<{ signedTxXdr: string } | string>;
}

interface Window {
  freighterApi?: FreighterApi;
}
