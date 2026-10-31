import { Keypair } from '@stellar/stellar-sdk';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { runIndexerBatch } from '../src/indexer/indexer.js';
import { runDispatcherBatch } from '../src/webhooks/dispatcher.js';
import { createSender } from '../src/webhooks/http.js';
import { buildPayTx, createHarness, idem, OPERATOR, seedMerchant, TEST_ENC_KEY, TEST_PEPPER } from './helpers.js';

describe('logs never contain secrets', () => {
  it('exercises every code path and greps the logs for secret material', async () => {
    const h = await createHarness();
    try {
      const { auth, key } = await seedMerchant(h.db);
      const hook = await request(h.app).post('/v1/webhook-endpoints').set(auth).send({ url: 'https://merchant.example/hook' });
      const webhookSecret = hook.body.secret as string;
      const minted = await request(h.app).post('/v1/api-keys').set(auth).send({ scopes: ['payments:read'] });
      const p = await request(h.app).post('/v1/payments').set(auth).set(idem()).send({ amount: '10' });
      const payer = Keypair.random();
      const tx = buildPayTx({ payer: payer.publicKey(), paymentId: p.body.id as string });
      tx.sign(payer);
      await request(h.app).post(`/v1/public/payments/${p.body.id as string}/submit`).send({ signedXdr: tx.toXDR() });
      await request(h.app).get('/v1/payments').set('Authorization', `Bearer ${key}x`); // failed auth path
      await request(h.app).get('/nope').set(auth);
      await runIndexerBatch({ config: h.config, db: h.db, chain: h.chain, logger: h.logger });
      await runDispatcherBatch({ config: h.config, db: h.db, logger: h.logger, send: createSender({ policy: { allowInsecure: false }, timeoutMs: 100 }) });
      h.logger.info({ config: h.config }, 'config dump attempt');
      h.logger.info({ headers: { authorization: `Bearer ${key}` }, secret: webhookSecret }, 'redaction check');

      const text = h.logs.join('\n');
      expect(h.logs.length).toBeGreaterThan(5);
      for (const secret of [key, minted.body.key as string, webhookSecret, OPERATOR.secret(), TEST_PEPPER, TEST_ENC_KEY, payer.secret()]) {
        expect(text).not.toContain(secret);
      }
      // No Stellar secret seed of any kind.
      expect(text).not.toMatch(/\bS[A-Z2-7]{55}\b/);
      expect(text).not.toMatch(/sk_test_[A-Za-z0-9_-]{20,}/);
    } finally {
      await h.close();
    }
  });
});
