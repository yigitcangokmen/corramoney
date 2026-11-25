/**
 * CI job `no-server-side-signing`. Reads every server-reachable module and fails on:
 *   1. a key being loaded, derived or used to sign outside the three allowed modules (sponsor,
 *      client_domain, channel accounts), and a raw signing primitive or library imported anywhere
 *   2. a seed-shaped string (S + 55 base32 chars) anywhere in server code
 *   3. the fee-and-sponsor secret flowing anywhere except into createSponsor(), the channel
 *      secrets anywhere except into createChannels(), and the pool admin secret anywhere at all
 *      (it is script-only)
 *   4. the allowed modules signing more call sites, or loading more keys, than their documented scope,
 *      and createSponsor/createChannels/createClientDomainSigner used anywhere but once each in
 *      services/orchestrator/src/index.ts (a renamed re-export counts as a use)
 *   5. in index.ts, a secret named other than as `cfg.<field>` straight into its factory, or cfg taken as a whole
 *   6. the setup signers (`.signSetup`) or the channel lease (`.acquire`) driven from outside setup.ts, or the
 *      Channels type named outside the setup module, its wiring, its definition and the package barrel
 *   7. outside setup.ts and the allowed modules, a call through a computed property (`ch[k]()`, `(0, ch[k])()`,
 *      `ch[k].call(...)`/`.apply`/`.bind`, `Reflect.apply(ch[k], ...)`), which could reach a signer under a name the
 *      scan never sees. A syntactic limit: an alias (`const f = ch[k]; f()`) is not followed (J-u6-R1).
 * A signer imported by name from the Stellar SDK, and Keypair, StrKey or a signer re-exported (renamed or not),
 * fails, since the scan cannot follow a new name into another module.
 * Raw signing libraries and node:crypto signing members are caught in imports, re-exports,
 * import('<lit>') and require('<lit>') (createRequire included).
 * Signing calls are seen as methods (`tx.sign(...)`, `S.authorizeEntry(...)`), as element-access
 * calls (`kp['sign'](...)`) and as bare named-import calls of the Soroban auth signers, under their
 * own name or an alias (`authorizeEntry(...)`, `import { authorizeEntry as ae }` then `ae(...)`).
 * A signer taken as a value (`const f = S.authorizeEntry`, `const { authorizeEntry: ae } = S`,
 * `const f = authorizeEntry`) counts as a signing site, and a destructured, imported or variable
 * alias of Keypair (`const { Keypair: K } = S`, `const K = S['Keypair']`) is held to the key-load rule.
 * A key load is also `new Keypair(...)` and `StrKey.decodeEd25519SecretSeed(...)` (or an alias of either), and a
 * loader taken as a value (`.map(S.Keypair.fromSecret)`, `const f = Keypair.fromSecret`, `.call`, `Keypair['fromSecret']`,
 * `const { fromSecret } = Keypair`). A namespace or default import of crypto counts as importing every member, and
 * `process.env[<computed>]` outside config.ts and index.ts fails, so a secret's name cannot be spelled in pieces.
 * It asserts a scope, not an absolute: CAP-15 fee-bumps (around one sender-signed path payment or
 * one user-signed, validated pool `submit`), CAP-33 sponsorship, a channel account as the
 * transaction source of a sponsored setup that creates an account, and the SEP-10 client_domain
 * co-signature make a bounded set of server signatures unavoidable.
 * Their runtime refusals are covered by the unit tests this job also runs.
 */
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
// Directories can be passed as arguments, e.g. to prove the job fails on a fixture.
const SCOPE = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['services/orchestrator/src', 'packages/stellar/src', 'packages/settlement-saga/src', 'packages/shared/src'];

/** module -> how many signing call sites and key loads it may contain, and why. */
const ALLOWED_SIGNERS: Record<string, { calls: number; loads: number; why: string }> = {
  'packages/stellar/src/sponsor.ts': { calls: 2, loads: 1, why: 'fee-bump envelope (one path payment, one recipient cash-out payment to the anchor distribution, or one validated pool submit) + verified sponsorship sandwich' },
  'services/orchestrator/src/client-domain.ts': { calls: 1, loads: 1, why: 'SEP-10 client_domain co-signature on a sequence-0 challenge' },
  'packages/stellar/src/channels.ts': { calls: 1, loads: 1, why: 'channel account as transaction source of a sponsored setup that creates an account' },
};
const KEY_LOADERS = new Set(['fromSecret', 'fromRawEd25519Seed', 'random', 'master']);
const SIGNERS = new Set(['sign', 'signDecorated', 'signPayloadDecorated', 'signHashX', 'signTransaction', 'signAuthEntry',
  'authorizeEntry', 'authorizeInvocation', 'basicNodeSigner']);
/** Soroban auth signers that are also called bare, as named imports. */
const SOROBAN_SIGNERS = new Set(['authorizeEntry', 'authorizeInvocation', 'signAuthEntry', 'basicNodeSigner']);
const SEED = /S[A-Z2-7]{55}/;
/** Named imports of node's crypto that sign or make signing keys; randomBytes, createHmac, randomUUID and subtle.digest stay allowed. */
const RAW_CRYPTO = new Set(['sign', 'createSign', 'createPrivateKey', 'generateKeyPair', 'generateKeyPairSync']);
/** Signing libraries no server module may import, re-export or require, look-alike packages included. */
const RAW_SIGNING_LIBS = /^(tweetnacl|@noble\/(ed25519|curves)|libsodium-wrappers|sodium-|@stablelib\/(ed25519|nacl)|ed25519-hd-key)/;
const isCrypto = (module: string) => module === 'crypto' || module === 'node:crypto';
/** The factories that turn a secret into a signer: each is called once, in the orchestrator's index.ts. */
const FACTORIES = new Set(['createChannels', 'createSponsor', 'createClientDomainSigner']);
const FACTORY_HOME = 'services/orchestrator/src/index.ts';
/** The only modules that may name the fee-sponsor or channel secrets. */
const SECRET_HOMES = /^services\/orchestrator\/src\/(config|index)\.ts$/;
/** In index.ts each secret is named once, as `cfg.<field>`, the first argument of its factory (matched by suffix so a fixture can stand in). */
const INDEX_FILE = /(^|\/)services\/orchestrator\/src\/index\.ts$/;
const SECRET_FLOWS = [
  { names: ['feeSponsorSecret', 'FEE_SPONSOR_SECRET'], field: 'feeSponsorSecret', factory: 'createSponsor', what: 'fee-sponsor secret' },
  { names: ['channelSecrets', 'CHANNEL_SECRETS'], field: 'channelSecrets', factory: 'createChannels', what: 'channel secrets' },
];
/** The setup signers (sponsor and channel) and the channel lease are driven only from the setup module. */
const SETUP_HOME = 'services/orchestrator/src/setup.ts';
const SETUP_MEMBERS = new Set(['signSetup', 'acquire']);
/** Modules that may name the Channels type: the setup module, its wiring, its definition and the package barrel. */
const CHANNELS_HOMES = new Set([SETUP_HOME, FACTORY_HOME, 'packages/stellar/src/channels.ts', 'packages/stellar/src/index.ts']);
/** An expression without the parentheses, comma operands, `!` and `as` around its value. */
function unwrap(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) e = e.right;
    else return e;
  }
}
/** `x[k]` with a key that is not a literal. */
const isComputed = (e: ts.Expression) => ts.isElementAccessExpression(e)
  && !ts.isStringLiteralLike(e.argumentExpression) && !ts.isNumericLiteral(e.argumentExpression);
/** The package barrel may re-export the factories under their own names. */
const FACTORY_BARREL = 'packages/stellar/src/index.ts';
const isStellarSdk = (module: string) => /^(@stellar\/stellar-(sdk|base)|stellar-sdk|stellar-base)(\/|$)/.test(module);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const violations: string[] = [];
const scanned: string[] = [];
const signCalls: Record<string, number> = {};
const keyLoads: Record<string, number> = {};
const sponsorSecretUses: string[] = [];
const channelSecretUses: string[] = [];
const factorySites: Record<string, string[]> = {};

for (const dir of SCOPE) {
  for (const abs of files(resolve(ROOT, dir))) {
    const rel = relative(ROOT, abs);
    scanned.push(rel);
    const src = ts.createSourceFile(rel, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true);
    const at = (n: ts.Node) => `${rel}:${src.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
    const signs = (n: ts.Node, what: string) => {
      if (!ALLOWED_SIGNERS[rel]) violations.push(`${at(n)} signs outside the allowed modules: ${what}`);
      else signCalls[rel] = (signCalls[rel] ?? 0) + 1;
    };
    const loads = (n: ts.Node, what: string) => {
      if (!ALLOWED_SIGNERS[rel]) violations.push(`${at(n)} loads a key: ${what}`);
      else keyLoads[rel] = (keyLoads[rel] ?? 0) + 1;
    };
    // local name -> the Soroban signer it imports, so `import { authorizeEntry as ae }` then `ae()` is a signer call.
    const aliases = new Map<string, string>();
    // local names bound to Keypair: `import { Keypair as K }`, `const { Keypair: K } = S`, `const K = S.Keypair`, `const K = S['Keypair']`.
    const keypairs = new Set<string>();
    // local names bound to StrKey, the same ways.
    const strkeys = new Set<string>();
    // local name -> the factory it imports, so `import { createChannels as cc }` then `cc()` is a factory site.
    const factoryAliases = new Map<string, string>();
    // local names bound to a namespace or default import of crypto.
    const cryptoAliases = new Set<string>();
    // index.ts only: how many times each secret is passed as `cfg.<field>` straight into its factory.
    const indexFlows: Record<string, number> = {};
    /** A module pulled in by import, re-export, import() or require(); `names` are the crypto members taken, '*' for all. */
    const rawModule = (n: ts.Node, module: string, names: string[] | '*') => {
      if (RAW_SIGNING_LIBS.test(module)) violations.push(`${at(n)} imports a raw signing library: ${module}`);
      if (!isCrypto(module)) return;
      if (names === '*') violations.push(`${at(n)} imports a raw signing primitive: * from ${module}`);
      else for (const name of names) if (RAW_CRYPTO.has(name)) violations.push(`${at(n)} imports a raw signing primitive: ${name} from ${module}`);
    };
    /** A signer or Keypair/StrKey from the SDK passed on to another module, where the scan would not know its new name. */
    const sdkReexport = (n: ts.Node, module: string, names: string[] | '*') => {
      if (!isStellarSdk(module)) return;
      if (names === '*') { violations.push(`${at(n)} re-exports * from ${module} (Keypair and the signers included)`); return; }
      for (const name of names) {
        if (name === 'Keypair' || name === 'StrKey') violations.push(`${at(n)} re-exports ${name} from ${module}`);
        else if (SIGNERS.has(name)) violations.push(`${at(n)} re-exports a raw signing primitive: ${name} from ${module}`);
      }
    };
    for (const st of src.statements) {
      if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
        const c = st.exportClause;
        const names = c && ts.isNamedExports(c) ? c.elements.map((el) => (el.propertyName ?? el.name).text) : '*';
        rawModule(st, st.moduleSpecifier.text, names);
        sdkReexport(st, st.moduleSpecifier.text, names);
        continue;
      }
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const module = st.moduleSpecifier.text;
      const named = st.importClause?.namedBindings;
      // A namespace or default import of crypto takes every member, signing ones included.
      const whole = st.importClause?.name ?? (named && ts.isNamespaceImport(named) ? named.name : undefined);
      if (whole) {
        if (isCrypto(module)) cryptoAliases.add(whole.text);
        rawModule(st, module, '*');
      }
      if (!named || !ts.isNamedImports(named)) {
        if (!whole) rawModule(st, module, []);
        continue;
      }
      rawModule(st, module, named.elements.map((el) => (el.propertyName ?? el.name).text));
      for (const el of named.elements) {
        const imported = (el.propertyName ?? el.name).text;
        // Any signer imported by name is called bare (`import { sign } from '@stellar/stellar-sdk'` then `sign(...)`).
        if (SIGNERS.has(imported)) aliases.set(el.name.text, imported);
        if (SIGNERS.has(imported) && isStellarSdk(module) && !ALLOWED_SIGNERS[rel]) {
          violations.push(`${at(el)} imports a raw signing primitive: ${imported} from ${module}`);
        }
        if (FACTORIES.has(imported)) factoryAliases.set(el.name.text, imported);
        if (imported === 'Keypair') keypairs.add(el.name.text);
        if (imported === 'StrKey') strkeys.add(el.name.text);
      }
    }
    // local names bound to createRequire(...), whose calls are require() calls.
    const requires = new Set(['require']);
    const bindingKey = (el: ts.BindingElement) => {
      const p = el.propertyName ?? el.name;
      return ts.isIdentifier(p) || ts.isStringLiteralLike(p) ? p.text
        : ts.isComputedPropertyName(p) && ts.isStringLiteralLike(p.expression) ? p.expression.text : undefined;
    };
    const collect = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isCallExpression(n.initializer) &&
        /(^|\.)createRequire$/.test(n.initializer.expression.getText(src))) requires.add(n.name.text);
      for (const [name, set] of [['Keypair', keypairs], ['StrKey', strkeys]] as const) {
        if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && ts.isIdentifier(n.name) && bindingKey(n) === name) set.add(n.name.text);
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (new RegExp(`(^|\\.)${name}$`).test(n.initializer.getText(src)) ||
          (ts.isElementAccessExpression(n.initializer) && ts.isStringLiteralLike(n.initializer.argumentExpression) &&
            n.initializer.argumentExpression.text === name))) set.add(n.name.text);
      }
      ts.forEachChild(n, collect);
    };
    collect(src);
    const isCallee = (n: ts.Node) => ts.isCallExpression(n.parent) && n.parent.expression === n;
    /** `target.name` loads a key: a Keypair loader or the StrKey seed decoder, under any alias. */
    const isKeyLoader = (target: string, name: string) =>
      (KEY_LOADERS.has(name) && (/Keypair$/.test(target) || keypairs.has(target))) ||
      (name === 'decodeEd25519SecretSeed' && (/StrKey$/.test(target) || strkeys.has(target)));

    const visit = (n: ts.Node) => {
      if (ts.isStringLiteralLike(n) && SEED.test(n.text)) violations.push(`${at(n)} seed-shaped string literal`);

      // import('<lit>') and require('<lit>'): the crypto members taken by destructuring or member access.
      if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0]) &&
        (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && requires.has(n.expression.text)))) {
        let user: ts.Node = n;
        while (ts.isAwaitExpression(user.parent) || ts.isParenthesizedExpression(user.parent)) user = user.parent;
        const p = user.parent;
        const names = ts.isVariableDeclaration(p) && p.initializer === user && ts.isObjectBindingPattern(p.name)
          ? p.name.elements.map((el) => bindingKey(el) ?? '*')
          : ts.isPropertyAccessExpression(p) ? [p.name.text]
          : ts.isElementAccessExpression(p) && ts.isStringLiteralLike(p.argumentExpression) ? [p.argumentExpression.text]
          : '*';
        rawModule(n, n.arguments[0].text, Array.isArray(names) && names.includes('*') ? '*' : names);
      }

      // A secret-to-signer factory called or taken as a value: only index.ts may.
      if (ts.isIdentifier(n) && (FACTORIES.has(n.text) || factoryAliases.has(n.text))) {
        const p = n.parent;
        // A re-export passes the factory on under a name the scan would not follow (`export { createChannels as cc }`):
        // only the package barrel may re-export, and only under the factory's own name.
        const barrelExport = ts.isExportSpecifier(p) && rel === FACTORY_BARREL && !p.propertyName;
        const declaration = (ts.isFunctionDeclaration(p) && p.name === n) || ts.isImportSpecifier(p) || barrelExport ||
          ts.isTypeQueryNode(p) || ts.isQualifiedName(p);
        const name = factoryAliases.get(n.text) ?? n.text;
        if (!declaration) (factorySites[name] ??= []).push(at(n));
      }
      if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && FACTORIES.has(n.argumentExpression.text)) {
        (factorySites[n.argumentExpression.text] ??= []).push(at(n));
      }

      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const name = n.expression.name.text;
        const target = n.expression.expression.getText(src);
        if (KEY_LOADERS.has(name) && (/Keypair$/.test(target) || keypairs.has(target))) loads(n, `${target}.${name}()`);
        if (name === 'decodeEd25519SecretSeed' && (/StrKey$/.test(target) || strkeys.has(target))) loads(n, `${target}.${name}()`);
        if (SIGNERS.has(name)) signs(n, `.${name}()`);
      }

      // A key loader taken as a value (`.map(S.Keypair.fromSecret)`, `const f = Keypair.fromSecret`, `.call`/`.bind`),
      // as an element access (`Keypair['fromSecret']`) or destructured (`const { fromSecret } = Keypair`).
      if (ts.isPropertyAccessExpression(n) && !isCallee(n) && isKeyLoader(n.expression.getText(src), n.name.text)) {
        loads(n, `${n.expression.getText(src)}.${n.name.text} taken as a value`);
      }
      if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) &&
        isKeyLoader(n.expression.getText(src), n.argumentExpression.text)) {
        loads(n, `${n.expression.getText(src)}['${n.argumentExpression.text}']`);
      }
      if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && ts.isVariableDeclaration(n.parent.parent) &&
        n.parent.parent.initializer && isKeyLoader(n.parent.parent.initializer.getText(src), bindingKey(n) ?? '')) {
        loads(n, `{ ${bindingKey(n)} } destructured from ${n.parent.parent.initializer.getText(src)}`);
      }

      // A crypto member taken off a namespace or default import (also flagged at the import).
      if (ts.isPropertyAccessExpression(n) && cryptoAliases.has(n.expression.getText(src)) && RAW_CRYPTO.has(n.name.text)) {
        violations.push(`${at(n)} uses a raw signing primitive: ${n.expression.getText(src)}.${n.name.text}`);
      }

      // An env lookup by a computed name could spell a secret's name in pieces: only config.ts and index.ts may.
      if (ts.isElementAccessExpression(n) && /(^|\.)env$/.test(n.expression.getText(src)) &&
        !ts.isStringLiteralLike(n.argumentExpression) && !SECRET_HOMES.test(rel)) {
        violations.push(`${at(n)} reads the environment by a computed name (only config.ts and index.ts may)`);
      }

      if (ts.isNewExpression(n)) {
        const ctor = n.expression.getText(src);
        if (/(^|\.)Keypair$/.test(ctor) || keypairs.has(ctor)) loads(n, `new ${ctor}()`);
      }

      if (ts.isCallExpression(n) && ts.isElementAccessExpression(n.expression) &&
        ts.isStringLiteralLike(n.expression.argumentExpression) && SIGNERS.has(n.expression.argumentExpression.text)) {
        signs(n, `['${n.expression.argumentExpression.text}']()`);
      }
      // `ch[k]()` names no member the scan can check: outside the setup module and the allowed signers, only named calls.
      // Also `(ch[k])()`, `(0, ch[k])()`, `ch[k].call/.apply/.bind(...)`, a computed member passed to any
      // `.call/.apply/.bind` or `Reflect.apply/construct` (`Function.prototype.call.call(K[m], K, s)`, S3-1) and
      // `new X[k](...)`. A syntactic limit (judge decision J-u6-R1): an alias, `const f = ch[k]; f()`, is not followed.
      if ((ts.isCallExpression(n) || ts.isNewExpression(n)) && rel !== SETUP_HOME && !ALLOWED_SIGNERS[rel]) {
        const callee = unwrap(n.expression);
        const relay = ts.isCallExpression(n) && (/\.(call|apply|bind)$/.test(callee.getText(src)) || /^Reflect\.(apply|construct)$/.test(callee.getText(src)));
        const through = isComputed(callee)
          || (ts.isPropertyAccessExpression(callee) && ['call', 'apply', 'bind'].includes(callee.name.text) && isComputed(unwrap(callee.expression)))
          || (relay && (n.arguments ?? []).some((a) => isComputed(unwrap(a))));
        if (through) violations.push(`${at(n)} a call through a computed property can hide a signer; use a named call`);
      }

      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const name = n.expression.text;
        if (SOROBAN_SIGNERS.has(name) || aliases.get(name) === name) signs(n, `${name}()`);
        else if (aliases.has(name)) signs(n, `${name}() (alias of ${aliases.get(name)})`);
      }

      // A local Keypair, StrKey or signer binding passed on to another module (`export { Keypair as KP }`, `export const K = S.Keypair`).
      if (ts.isExportSpecifier(n) && !n.parent.parent.moduleSpecifier) {
        const local = (n.propertyName ?? n.name).text;
        if (keypairs.has(local) || strkeys.has(local)) violations.push(`${at(n)} re-exports ${local} (a Keypair or StrKey binding)`);
        else if (aliases.has(local)) violations.push(`${at(n)} re-exports a raw signing primitive: ${local} (${aliases.get(local)})`);
      }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && (keypairs.has(n.name.text) || strkeys.has(n.name.text)) &&
        ts.isVariableStatement(n.parent.parent) && n.parent.parent.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        violations.push(`${at(n)} re-exports ${n.name.text} (a Keypair or StrKey binding)`);
      }

      // The setup signers and the channel lease are driven only from setup.ts, so no other module can relay an XDR to them.
      const member = ts.isPropertyAccessExpression(n) ? n.name.text
        : ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) ? n.argumentExpression.text
        : ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) ? bindingKey(n) : undefined;
      if (member && SETUP_MEMBERS.has(member) && rel !== SETUP_HOME) {
        violations.push(`${at(n)} uses .${member} outside ${SETUP_HOME} (the setup signers are driven only from the setup module)`);
      }
      if (ts.isIdentifier(n) && n.text === 'Channels' && !CHANNELS_HOMES.has(rel)) {
        violations.push(`${at(n)} references the Channels signer outside the setup module and its wiring`);
      }

      // A signer taken as a value, to be called under another name.
      if (ts.isPropertyAccessExpression(n) && SIGNERS.has(n.name.text) && !isCallee(n)) signs(n, `.${n.name.text} taken as a value`);
      if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && SIGNERS.has(n.argumentExpression.text) && !isCallee(n)) {
        signs(n, `['${n.argumentExpression.text}'] taken as a value`);
      }
      if (ts.isBindingElement(n) && ts.isObjectBindingPattern(n.parent) && SIGNERS.has(bindingKey(n) ?? '')) {
        signs(n, `{ ${bindingKey(n)} } destructured`);
      }
      if (ts.isIdentifier(n) && (SOROBAN_SIGNERS.has(n.text) || aliases.has(n.text)) && !isCallee(n)) {
        const p = n.parent as any;
        const declared = (p.name === n || p.propertyName === n) && !ts.isShorthandPropertyAssignment(p);
        if (!declared && !ts.isTypeQueryNode(p) && !ts.isQualifiedName(p)) signs(n, `${n.text} taken as a value`);
      }

      if (ts.isIdentifier(n) && /^(feeSponsorSecret|FEE_SPONSOR_SECRET)$/.test(n.text)) sponsorSecretUses.push(at(n));
      if (ts.isIdentifier(n) && /^(channelSecrets|CHANNEL_SECRETS)$/.test(n.text)) channelSecretUses.push(at(n));

      if (INDEX_FILE.test(rel)) {
        // Each secret is named once, as `cfg.<field>` in first-argument position of its factory; any other
        // identifier (destructuring, shorthand, an alias's property) or string ('cfg["channelSecrets"]') fails.
        for (const flow of SECRET_FLOWS) {
          if (ts.isStringLiteralLike(n) && flow.names.some((s) => n.text.includes(s))) {
            violations.push(`${at(n)} names the ${flow.what} in a string (only cfg.${flow.field} into ${flow.factory}() may)`);
          }
          if (!ts.isIdentifier(n) || !flow.names.includes(n.text)) continue;
          const p = n.parent;
          const ok = n.text === flow.field && ts.isPropertyAccessExpression(p) && p.name === n && ts.isIdentifier(p.expression) &&
            p.expression.text === 'cfg' && ts.isCallExpression(p.parent) && p.parent.arguments[0] === p &&
            ts.isIdentifier(p.parent.expression) && p.parent.expression.text === flow.factory;
          if (ok) indexFlows[flow.field] = (indexFlows[flow.field] ?? 0) + 1;
          else violations.push(`${at(n)} names the ${flow.what} outside ${flow.factory}(cfg.${flow.field})`);
        }
        // cfg is read only member by member, so no secret leaves it unnamed (Object.values(cfg), { ...cfg }, an alias).
        if (ts.isIdentifier(n) && n.text === 'cfg') {
          const p = n.parent;
          const declared = ts.isVariableDeclaration(p) && p.name === n && !!p.initializer && ts.isCallExpression(p.initializer) &&
            ts.isIdentifier(p.initializer.expression) && p.initializer.expression.text === 'loadConfig';
          if (!declared && !(ts.isPropertyAccessExpression(p) && p.expression === n)) {
            violations.push(`${at(n)} takes cfg as a whole (only cfg.<field> reads are allowed)`);
          }
        }
        // The config is loaded once, into cfg.
        if (ts.isIdentifier(n) && n.text === 'loadConfig' && !ts.isImportSpecifier(n.parent)) {
          const d = n.parent.parent;
          if (!(ts.isCallExpression(n.parent) && n.parent.expression === n && ts.isVariableDeclaration(d) &&
            ts.isIdentifier(d.name) && d.name.text === 'cfg')) violations.push(`${at(n)} uses loadConfig() other than as const cfg = loadConfig()`);
        }
      } else if (ts.isIdentifier(n) && n.text === 'loadConfig' && !/(^|\/)services\/orchestrator\/src\/config\.ts$/.test(rel)) {
        violations.push(`${at(n)} uses loadConfig() (only services/orchestrator/src/index.ts may)`);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);

    const text = src.getFullText();
    if (/FEE_SPONSOR_SECRET|feeSponsorSecret/.test(text) && !SECRET_HOMES.test(rel)) {
      violations.push(`${rel} touches the fee-sponsor secret (only config.ts and index.ts may)`);
    }
    if (/CHANNEL_SECRETS|channelSecrets/.test(text) && !SECRET_HOMES.test(rel)) {
      violations.push(`${rel} touches the channel secrets (only config.ts and index.ts may)`);
    }
    if (/POOL_ADMIN_SECRET|poolAdminSecret/.test(text)) violations.push(`${rel} touches the pool admin secret (script-only)`);
    if (INDEX_FILE.test(rel)) {
      for (const flow of SECRET_FLOWS) {
        const found = indexFlows[flow.field] ?? 0;
        if (found !== 1) violations.push(`${rel} must pass cfg.${flow.field} to ${flow.factory}() exactly once (found ${found})`);
      }
    }
  }
}

for (const [name, sites] of Object.entries(factorySites)) {
  for (const site of sites) if (!site.startsWith(`${FACTORY_HOME}:`)) violations.push(`${site} uses ${name}() (only ${FACTORY_HOME} may)`);
}

// Only for the real scope: a fixture run must fail on the fixture's own violations alone.
if (!process.argv.slice(2).length) {
  for (const name of FACTORIES) {
    const n = (factorySites[name] ?? []).filter((site) => site.startsWith(`${FACTORY_HOME}:`)).length;
    if (n !== 1) violations.push(`${FACTORY_HOME} uses ${name}() ${n} times, its documented scope is 1`);
  }
  for (const [mod, rule] of Object.entries(ALLOWED_SIGNERS)) {
    const found = signCalls[mod] ?? 0;
    if (found !== rule.calls) violations.push(`${mod} has ${found} signing call sites, its documented scope is ${rule.calls}`);
    const n = keyLoads[mod] ?? 0;
    if (n !== rule.loads) violations.push(`${mod} has ${n} key loads, its documented scope is ${rule.loads}`);
  }
}

console.log('no-server-side-signing');
console.log(`  scope: ${SCOPE.join(', ')} (${scanned.length} modules, tests excluded)`);
console.log('  allowed server signatures:');
for (const [mod, rule] of Object.entries(ALLOWED_SIGNERS)) console.log(`    ${mod}: ${rule.calls} call site(s), ${rule.loads} key load(s), ${rule.why}`);
console.log(`  fee-sponsor secret references: ${sponsorSecretUses.join(', ') || 'none'}`);
console.log(`  channel secret references: ${channelSecretUses.join(', ') || 'none'}`);
console.log(`  secret-to-signer factory uses: ${Object.values(factorySites).flat().join(', ') || 'none'}`);

if (violations.length) {
  console.error(`\nFAILED: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log('\nPASSED: no user key is loaded, derived or signed with anywhere in server code.');
