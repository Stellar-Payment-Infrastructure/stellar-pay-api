/**
 * Opt-in checks against the real Soroban testnet RPC (read-only):
 *   INTEGRATION=1 PAY_CONTRACT_ID=C... pnpm test test/integration.testnet.test.ts
 * Skipped by default so CI and offline runs stay deterministic.
 */
import { Keypair } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { TESTNET_PASSPHRASE } from '../src/config.js';
import { RpcChainClient } from '../src/stellar/chain.js';

const enabled = process.env['INTEGRATION'] === '1' && !!process.env['PAY_CONTRACT_ID'];

describe.skipIf(!enabled)('testnet RPC (INTEGRATION=1)', () => {
  const client = () =>
    RpcChainClient.fromUrl(process.env['SOROBAN_RPC_URL'] ?? 'https://soroban-testnet.stellar.org', {
      contractId: process.env['PAY_CONTRACT_ID'] as string,
      networkPassphrase: TESTNET_PASSPHRASE,
      // Read-only calls only; a throwaway key is enough as simulation source only if funded,
      // so prefer the real operator public key when provided.
      operatorSecret: process.env['OPERATOR_SECRET'] ?? Keypair.random().secret(),
    });

  it('reads the latest ledger and contract events', async () => {
    const c = client();
    const latest = await c.getLatestLedger();
    expect(latest).toBeGreaterThan(0);
    const page = await c.getEvents({ startLedger: Math.max(1, latest - 1000) }, 20);
    expect(Array.isArray(page.events)).toBe(true);
  });

  it('returns null for an unknown payment id', async () => {
    if (!process.env['OPERATOR_SECRET']) return; // simulation needs an existing source account
    expect(await client().getPayment('00'.repeat(32))).toBeNull();
  });
});
