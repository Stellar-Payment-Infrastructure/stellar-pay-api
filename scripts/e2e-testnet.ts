/**
 * End-to-end check against a running API on TESTNET:
 * create payment -> payer signs pay via the public endpoints -> indexer ->
 * signed webhook received by a local listener -> settle -> final status.
 *
 * Prerequisites: the API is running with a deployed contract, workers enabled
 * and WEBHOOK_ALLOW_INSECURE=true (so it can reach the local listener). A
 * merchant key from `pnpm seed`, and a funded testnet payer that holds the
 * configured token.
 *
 *   API_BASE_URL=http://localhost:3000 \
 *   STELLAR_PAY_API_KEY=<from pnpm seed> \
 *   PAYER_SECRET="$(stellar keys show payer)" \
 *   pnpm e2e:testnet
 *
 * Secrets are read from the environment and never printed.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { verifySignatureHeader } from '../src/webhooks/crypto.js';

const API = (process.env['API_BASE_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env['STELLAR_PAY_API_KEY'];
const PAYER_SECRET = process.env['PAYER_SECRET'];
const TIMEOUT_MS = Number(process.env['E2E_TIMEOUT_MS'] ?? 120_000);

function need(v: string | undefined, name: string): string {
  if (!v) throw new Error(`${name} is required`);
  return v;
}

async function call<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: { code: string; message: string } };
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json.error?.code ?? ''} ${json.error?.message ?? ''}`);
  return json;
}

async function until<T>(what: string, fn: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

async function main() {
  const auth = { authorization: `Bearer ${need(KEY, 'STELLAR_PAY_API_KEY')}` };
  const payer = Keypair.fromSecret(need(PAYER_SECRET, 'PAYER_SECRET'));

  // 1. local webhook listener
  const events: { type: string; verified: boolean }[] = [];
  let secret = '';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const verified = verifySignatureHeader(String(req.headers['stellar-pay-signature'] ?? ''), raw, secret);
      const evt = JSON.parse(raw) as { type: string };
      events.push({ type: evt.type, verified });
      console.log(`  webhook ${evt.type} (signature ${verified ? 'ok' : 'INVALID'})`);
      res.statusCode = 200;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const endpoint = await call<{ id: string; secret: string }>('POST', '/v1/webhook-endpoints', { url: `http://127.0.0.1:${port}/hook` }, auth);
  secret = endpoint.secret;
  console.log(`1. webhook endpoint ${endpoint.id} -> 127.0.0.1:${port}`);

  try {
    // 2. create
    const payment = await call<{ id: string; status: string; amount: string }>(
      'POST', '/v1/payments', { amount: process.env['E2E_AMOUNT'] ?? '1000000', reference: `e2e-${Date.now()}`, settleMode: 'manual' },
      { ...auth, 'idempotency-key': `e2e-${Date.now()}` },
    );
    console.log(`2. payment ${payment.id} ${payment.status}`);
    if (payment.status !== 'created') throw new Error('payment not confirmed on-chain');

    // 3. payer builds, signs and submits through the public endpoints
    const built = await call<{ transactionXdr: string; networkPassphrase: string }>('POST', `/v1/public/payments/${payment.id}/transaction`, { payer: payer.publicKey() });
    const tx = TransactionBuilder.fromXDR(built.transactionXdr, built.networkPassphrase);
    tx.sign(payer);
    const submitted = await call<{ transactionHash: string; status: string }>('POST', `/v1/public/payments/${payment.id}/submit`, { signedXdr: tx.toXDR() });
    console.log(`3. pay tx ${submitted.transactionHash} -> ${submitted.status}`);

    // 4. indexer + webhook
    await until('payment.paid webhook', async () => (events.some((e) => e.type === 'payment.paid') ? true : undefined));
    console.log('4. payment.paid webhook received');

    // 5. settle
    const settled = await call<{ status: string; fee: string | null }>('POST', `/v1/payments/${payment.id}/settle`, undefined, auth);
    console.log(`5. settle -> ${settled.status} (fee ${settled.fee})`);
    await until('payment.settled webhook', async () => (events.some((e) => e.type === 'payment.settled') ? true : undefined));
    const final = await call<{ status: string }>('GET', `/v1/payments/${payment.id}`, undefined, auth);
    if (final.status !== 'settled') throw new Error(`final status ${final.status}`);
    if (!events.every((e) => e.verified)) throw new Error('a webhook signature did not verify');
    console.log('E2E PASSED: created -> paid -> settled, webhooks signed and verified');
  } finally {
    await call('DELETE', `/v1/webhook-endpoints/${endpoint.id}`, undefined, auth).catch(() => undefined);
    server.close();
  }
}

main().catch((err: Error) => {
  console.error(`E2E FAILED: ${err.message}`);
  process.exit(1);
});
