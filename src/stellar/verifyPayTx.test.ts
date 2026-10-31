import { randomBytes } from 'node:crypto';
import {
  Account,
  Address,
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../errors.js';
import { buildPayTx, CONTRACT_ID } from '../../test/helpers.js';
import { addressToScVal, paymentIdToScVal } from './contract.js';
import { verifyPayTransaction } from './verifyPayTx.js';

const payer = Keypair.random();
const paymentId = randomBytes(32).toString('hex');
const opts = { contractId: CONTRACT_ID, paymentId, networkPassphrase: Networks.TESTNET, maxFee: 10_000_000 };

function signed(tx: ReturnType<typeof buildPayTx>, kp: Keypair = payer): string {
  tx.sign(kp);
  return tx.toXDR();
}

function reason(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).code).toBe('INVALID_TRANSACTION');
    return ((e as ApiError).details as { reason: string }).reason;
  }
  throw new Error('expected rejection');
}

describe('verifyPayTransaction', () => {
  it('accepts exactly one pay(payer, id) invocation of our contract signed by the payer', () => {
    const tx = buildPayTx({ payer: payer.publicKey(), paymentId });
    const res = verifyPayTransaction(signed(tx), opts);
    expect(res.payer).toBe(payer.publicKey());
    expect(res.hash).toBe(tx.hash().toString('hex'));
  });

  it('rejects garbage XDR', () => {
    expect(reason(() => verifyPayTransaction('not-xdr', opts))).toBe('decode');
  });

  it('rejects a transaction for a different contract', () => {
    const tx = buildPayTx({ payer: payer.publicKey(), paymentId, contractId: StrKey.encodeContract(randomBytes(32)) });
    expect(reason(() => verifyPayTransaction(signed(tx), opts))).toBe('contract');
  });

  it('rejects a different function on our contract', () => {
    for (const fn of ['settle', 'refund', 'reclaim', 'create_payment']) {
      const tx = buildPayTx({ payer: payer.publicKey(), paymentId, fn });
      expect(reason(() => verifyPayTransaction(signed(tx), opts))).toBe('function');
    }
  });

  it('rejects extra operations', () => {
    const tx = buildPayTx({ payer: payer.publicKey(), paymentId, extraOps: 1 });
    expect(reason(() => verifyPayTransaction(signed(tx), opts))).toBe('operation_count');
  });

  it('rejects a non-Soroban operation (e.g. a payment that drains the payer)', () => {
    const tx = new TransactionBuilder(new Account(payer.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: '1' }))
      .setTimeout(300)
      .build();
    expect(reason(() => verifyPayTransaction(signed(tx), opts))).toBe('operation_type');
  });

  it('rejects another payment id', () => {
    const tx = buildPayTx({ payer: payer.publicKey(), paymentId: randomBytes(32).toString('hex') });
    expect(reason(() => verifyPayTransaction(signed(tx), opts))).toBe('payment_id');
  });

  it('rejects wrong argument shapes', () => {
    const tooMany = buildPayTx({
      payer: payer.publicKey(),
      paymentId,
      args: [addressToScVal(payer.publicKey()), paymentIdToScVal(paymentId), xdr.ScVal.scvU32(1)],
    });
    expect(reason(() => verifyPayTransaction(signed(tooMany), opts))).toBe('args');
    const swapped = buildPayTx({ payer: payer.publicKey(), paymentId, args: [paymentIdToScVal(paymentId), addressToScVal(payer.publicKey())] });
    expect(reason(() => verifyPayTransaction(signed(swapped), opts))).toBe('args');
  });

  it('rejects a contract address as payer', () => {
    const c = StrKey.encodeContract(randomBytes(32));
    const tx = buildPayTx({ payer: payer.publicKey(), paymentId, args: [new Address(c).toScVal(), paymentIdToScVal(paymentId)] });
    expect(reason(() => verifyPayTransaction(signed(tx), opts))).toBe('payer');
  });

  it('rejects when the payer is not the transaction source', () => {
    const other = Keypair.random();
    const tx = buildPayTx({ payer: payer.publicKey(), paymentId, source: other.publicKey() });
    expect(reason(() => verifyPayTransaction(signed(tx, other), opts))).toBe('source');
  });

  it('rejects an oversized fee', () => {
    const tx = buildPayTx({ payer: payer.publicKey(), paymentId, fee: '10000001' });
    expect(reason(() => verifyPayTransaction(signed(tx), opts))).toBe('fee');
  });

  it('rejects unsigned and wrongly signed envelopes', () => {
    const unsigned = buildPayTx({ payer: payer.publicKey(), paymentId });
    expect(reason(() => verifyPayTransaction(unsigned.toXDR(), opts))).toBe('unsigned');
    const wrong = buildPayTx({ payer: payer.publicKey(), paymentId });
    expect(reason(() => verifyPayTransaction(signed(wrong, Keypair.random()), opts))).toBe('signature');
  });

  it('rejects expired and overly long-lived transactions', () => {
    const tx = buildPayTx({ payer: payer.publicKey(), paymentId });
    const xdrStr = signed(tx);
    const maxTime = Number(tx.timeBounds?.maxTime);
    expect(reason(() => verifyPayTransaction(xdrStr, { ...opts, now: maxTime + 1 }))).toBe('expired');
    const long = buildPayTx({ payer: payer.publicKey(), paymentId, timeoutSec: 86_400 });
    expect(reason(() => verifyPayTransaction(signed(long), opts))).toBe('timebounds');
  });

  it('rejects a transaction built for another network', () => {
    const tx = new TransactionBuilder(new Account(payer.publicKey(), '1'), { fee: '100', networkPassphrase: Networks.FUTURENET })
      .addOperation(new Contract(CONTRACT_ID).call('pay', addressToScVal(payer.publicKey()), paymentIdToScVal(paymentId)))
      .setTimeout(300)
      .build();
    tx.sign(payer);
    // Decoded under the testnet passphrase, the payer signature does not verify.
    expect(reason(() => verifyPayTransaction(tx.toXDR(), opts))).toBe('signature');
  });

  it('rejects fee-bump envelopes', () => {
    const inner = buildPayTx({ payer: payer.publicKey(), paymentId });
    inner.sign(payer);
    const bump = TransactionBuilder.buildFeeBumpTransaction(payer, '200000', inner, Networks.TESTNET);
    bump.sign(payer);
    expect(reason(() => verifyPayTransaction(bump.toXDR(), opts))).toBe('fee_bump');
  });

  it('rejects auth entries that authorize a different invocation', () => {
    const tx = buildPayTx({ payer: payer.publicKey(), paymentId });
    const env = tx.toEnvelope();
    const op = env.v1().tx().operations()[0] as xdr.Operation;
    const otherInvoke = new xdr.InvokeContractArgs({
      contractAddress: new Address(StrKey.encodeContract(randomBytes(32))).toScAddress(),
      functionName: 'transfer',
      args: [],
    });
    op.body().invokeHostFunctionOp().auth([
      new xdr.SorobanAuthorizationEntry({
        credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
        rootInvocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(otherInvoke),
          subInvocations: [],
        }),
      }),
    ]);
    const rebuilt = TransactionBuilder.fromXDR(env.toXDR('base64'), Networks.TESTNET);
    rebuilt.sign(payer);
    expect(reason(() => verifyPayTransaction(rebuilt.toXDR(), opts))).toBe('auth');
  });
});
