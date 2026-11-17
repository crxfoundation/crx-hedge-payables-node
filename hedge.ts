// Hedge a US importer's BRL and MXN payables with CRX NDFs, through the public CRX REST API.
// The default run is read-only. --quote requests quotes; --accept requests quotes and books them.
import { readFileSync } from 'node:fs';
import { Wallet, keccak256, toUtf8Bytes } from 'ethers';

const API = 'https://api.crxfx.com';
const CHAIN = 'ethereum';
const MIN_USD = 100;
const SIDE = 'sell'; // sell USD forward, receive the invoice currency at a fixed rate
const WAIT_MS = 300_000;
// The importer's payables. "usd" is the notional in USD, the base currency of each pair.
const PAYABLES = [
  { pair: 'USD/BRL', usd: 25_000, days: 30, what: 'BRL invoice, Sao Paulo supplier' },
  { pair: 'USD/MXN', usd: 10_000, days: 60, what: 'MXN invoice, Monterrey supplier' },
];
// The Trade struct a taker signs to accept a quote (OpenAPI schema TradeTypedData).
const TRADE_FIELDS = [
  ['summary', 'string'], ['pair', 'string'], ['side', 'string'], ['notionalE6', 'uint256'], ['rateE6', 'uint64'],
  ['premiumBps', 'int16'], ['maturity', 'uint40'], ['pairC', 'bytes32'], ['ownLegId', 'bytes32'],
  ['ownNonce', 'uint64'], ['ownSalt', 'bytes32'],
].map(([name, type]) => ({ name, type }));
const TRADE_TYPE = `Trade(${TRADE_FIELDS.map((f) => `${f.type} ${f.name}`).join(',')})`;

type Rfq = { chain: string; pair: string; side: string; notional: string; expiry: number };

const fail = (code: string, message: string, details?: any) => Object.assign(new Error(message), { code, details });

const say = (label: string, text: string) => console.log(label.padEnd(15) + text);
const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 16:00 UTC on the due day, moved to Monday when the due day falls on a weekend.
function settles(days: number): number {
  const t = new Date(Date.now() + days * 86_400_000);
  t.setUTCHours(16, 0, 0, 0);
  while (t.getUTCDay() === 0 || t.getUTCDay() === 6) t.setUTCDate(t.getUTCDate() + 1);
  return t.getTime();
}

// A decimal string times 10^6, exact.
function e6(s: string): bigint {
  const [i, f = ''] = s.split('.');
  if (f.length > 6) throw fail('bad_request', `${s} has more than 6 decimals`);
  return BigInt(i + f.padEnd(6, '0'));
}

// A decimal string with trailing zeros cut; `group` puts a space between thousands.
function plain(s: string, group: boolean): string {
  let [i, f = ''] = s.split('.');
  f = f.replace(/0+$/, '');
  if (group) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return f ? `${i}.${f}` : i;
}

function loadKey(): Wallet | null {
  const file = process.env.CRX_WALLET_PK_FILE;
  const pk = process.env.CRX_WALLET_PK || (file ? readFileSync(file, 'utf8').trim() : '');
  return pk ? new Wallet(pk.startsWith('0x') ? pk : `0x${pk}`) : null;
}

// One API call. With a wallet, it adds the signed headers: an EIP-191 signature of the CRX-REST-LOGIN message.
async function api(method: string, path: string, body?: object, wallet?: Wallet | null): Promise<any> {
  const text = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = body === undefined ? {} : { 'content-type': 'application/json' };
  if (wallet) {
    const addr = wallet.address.toLowerCase();
    const ts = String(Date.now());
    const msg = ['CRX-REST-LOGIN', 'Audience: crx-gateway', `Method: ${method}`, `Path: ${path.split('?')[0]}`,
      `Custody: ${addr}`, `Signer: ${addr}`, `Timestamp: ${ts}`, `Body: ${keccak256(toUtf8Bytes(text))}`].join('\n');
    Object.assign(headers, { 'x-crx-address': addr, 'x-crx-ts': ts, 'x-crx-sig': await wallet.signMessage(msg) });
  }
  const res = await fetch(API + path, {
    method, headers, body: body === undefined ? undefined : text, signal: AbortSignal.timeout(30_000),
  });
  const out: any = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(out.code ?? `http_${res.status}`, out.message ?? out.error ?? res.statusText, out.details);
  return out;
}

// Build our own Trade from our request and the quote, check the served template against it, then sign ours.
async function signTrade(td: any, req: Rfq, rate: string, rfq: any, chain: any, wallet: Wallet): Promise<string> {
  const [base, quote] = req.pair.split('/');
  const domain = { name: 'CRX', version: 'rulebook-1.0', chainId: chain.chain_id, verifyingContract: chain.core };
  const s = td.message;
  const own: Record<string, any> = {
    summary: `${req.side} ${plain(req.notional, true)} ${base} vs ${quote} at ${plain(rate, false)} ${quote} per ${base}, `
      + `matures ${iso(req.expiry)}, upfront none`,
    pair: req.pair, side: req.side, notionalE6: e6(req.notional), rateE6: e6(rate), premiumBps: 0,
    maturity: Math.floor(req.expiry / 1000), pairC: s.pairC, ownLegId: s.ownLegId, ownNonce: s.ownNonce, ownSalt: s.ownSalt,
  };
  const served = (td.types?.Trade ?? []).map((f: any) => `${f.type} ${f.name}`).join(',');
  const checks: [string, boolean][] = [
    ['domain', td.domain.name === domain.name && td.domain.version === domain.version
      && Number(td.domain.chainId) === domain.chainId && String(td.domain.verifyingContract).toLowerCase() === chain.core.toLowerCase()],
    ['type', td.primaryType === 'Trade' && `Trade(${served})` === TRADE_TYPE],
    ['terms', TRADE_FIELDS.every(({ name, type }) => (type === 'string' || type === 'bytes32'
      ? String(s[name]).toLowerCase() === String(own[name]).toLowerCase() : BigInt(s[name]) === BigInt(own[name])))],
    ['leg id', BigInt(`0x${String(s.ownLegId).slice(-16)}`) === BigInt(rfq.quote_expiry_max)],
    ['nonce', BigInt(s.ownNonce) <= BigInt(Date.now() + 86_400_000)],
  ];
  const bad = checks.find(([, ok]) => !ok);
  if (bad) throw fail('refused_to_sign', `the served trade fails the ${bad[0]} check; nothing signed`);
  return wallet.signTypedData(domain, { Trade: TRADE_FIELDS }, own);
}

// Accept the quote, then read GET /trades until the trade opens or is refused.
async function accept(req: Rfq, rfq: any, q: any, chain: any, wallet: Wallet): Promise<string> {
  let tpl = q.trade_template
    ?? (await api('GET', `/rfqs/${rfq.rfq_id}/accept-check?quote_id=${q.quote_id}`, undefined, wallet)).trade_template;
  for (let attempt = 0; ; attempt++) {
    const sig = await signTrade(tpl.typed_data, req, q.rate, rfq, chain, wallet);
    try {
      await api('POST', `/rfqs/${rfq.rfq_id}/accept`, { quote_id: q.quote_id, sig }, wallet);
      break;
    } catch (e: any) {
      if (e.code !== 'trade_stale' || attempt > 0 || !e.details?.trade_template) throw e;
      tpl = e.details.trade_template; // sign the new template once
    }
  }
  const until = Date.now() + WAIT_MS;
  let after = 0;
  while (Date.now() < until) {
    const page = await api('GET', `/trades?after=${after}&limit=1000`, undefined, wallet);
    for (const e of page.trades) {
      if (e.data?.rfq_id !== rfq.rfq_id) continue;
      if (e.type === 'trade.opened') return e.data.provisional ? 'open, provisional' : e.data.final ? 'open, final' : 'open';
      if (e.type === 'trade.refused') return 'refused';
    }
    after = page.seq;
    if (page.trades.length < 1000) await sleep(5_000);
  }
  return 'pending';
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--quote') && argv.includes('--accept')) return console.error('Pass --quote or --accept, not both.'), 2;
  const run = argv.includes('--accept') ? 'accept' : argv.includes('--quote') ? 'quote' : 'read-only';
  say('CRX', `payables hedge: ${run}`);
  let chain: any;
  let markets: Map<string, any>;
  try {
    const h = await api('GET', '/health');
    chain = h.chains.find((x: any) => x.key === CHAIN);
    say('GET /health', `${h.status}, healthy ${h.healthy === true}, chain ${chain.key} ${chain.chain_id}, core ${chain.core}`);
    markets = new Map((await api('GET', `/markets?chain=${CHAIN}`)).markets.map((m: any) => [m.pair, m]));
  } catch (e: any) {
    say('Error', `${e.code ?? 'bad_answer'}: ${e.message}`);
    return 1;
  }
  for (const p of PAYABLES) {
    const m = markets.get(p.pair);
    if (!m) { say('GET /markets', `${p.pair} not offered`); continue; }
    const nb = m.session.next_boundary;
    const state = m.session.open ? 'open' : nb?.kind === 'open' ? `closed, opens ${iso(nb.at)}` : 'closed';
    say('GET /markets', `${m.pair} ${state}, notional ${m.notional.min} to ${m.notional.max} USD`);
  }

  let wallet: Wallet | null = null; // the read-only calls load no key
  try { if (run !== 'read-only') wallet = loadKey(); } catch (e: any) { say('Error', `config: ${e.message}`); return 2; }
  if (run !== 'read-only' && !wallet) {
    say('Error', 'config: set CRX_WALLET_PK or CRX_WALLET_PK_FILE to the account wallet key');
    return 2;
  }
  let quotes = 0, trades = 0, errors = 0;
  for (const p of PAYABLES) {
    say('Payable', `${p.pair} ${p.usd} USD due in ${p.days} d, ${p.what}`);
    if (p.usd < MIN_USD) {
      say('Error', `below_min: the notional is under ${MIN_USD} USD`);
      errors++;
      continue;
    }
    const req: Rfq = { chain: CHAIN, pair: p.pair, side: SIDE, notional: String(p.usd), expiry: settles(p.days) };
    const terms = `${SIDE} ${p.usd} ${p.pair}, settles ${iso(req.expiry)}`;
    if (run === 'read-only') { say('POST /rfqs', `${terms}, not sent`); continue; }
    say('POST /rfqs', terms);
    try {
      const rfq = await api('POST', '/rfqs', req, wallet);
      const q = rfq.quote;
      if (!q) throw fail(rfq.outcome ?? 'no_quote', rfq.message ?? 'no quote');
      quotes++;
      say('Quote', `${q.rate} ${p.pair.slice(4)} per USD, accept by ${iso(rfq.closes_at)}`);
      if (run === 'accept') {
        const status = await accept(req, rfq, q, chain, wallet!);
        say('Trade', status);
        if (status.startsWith('open')) trades++;
      }
    } catch (e: any) {
      say('Error', `${e.code ?? 'network'}: ${e.message}`);
      errors++;
    }
  }
  if (run === 'read-only') say('Done', 'read-only, nothing sent. Set CRX_WALLET_PK, then run with --quote or --accept.');
  else say('Done', `quotes ${quotes}, trades ${trades}, errors ${errors}`);
  return errors ? 1 : 0;
}

process.exitCode = await main();
