import {
  Address,
  FeeBumpTransaction,
  Keypair,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { badRequest } from '../errors.js';

export interface VerifyPayTxOptions {
  contractId: string;
  paymentId: string;
  networkPassphrase: string;
  maxFee: number;
  /** Unix seconds; injectable for tests. */
  now?: number;
  /** Max allowed validity window in seconds (default 15 minutes). */
  maxValiditySec?: number;
}

export interface VerifiedPayTx {
  tx: Transaction;
  payer: string;
  hash: string;
}

const reject = (reason: string, message: string) => badRequest('INVALID_TRANSACTION', message, { reason });

function sameInvocation(a: xdr.InvokeContractArgs, b: xdr.InvokeContractArgs): boolean {
  return a.toXDR('base64') === b.toXDR('base64');
}

/**
 * Decodes a payer-signed envelope and proves it is exactly one invocation of
 * `<our contract>.pay(payer, <this payment id>)` with the payer as the
 * transaction source, before anything is submitted. The API never relays any
 * other transaction.
 */
export function verifyPayTransaction(signedXdr: string, opts: VerifyPayTxOptions): VerifiedPayTx {
  let parsed: Transaction | FeeBumpTransaction;
  try {
    parsed = TransactionBuilder.fromXDR(signedXdr, opts.networkPassphrase);
  } catch {
    throw reject('decode', 'signedXdr is not a valid transaction envelope');
  }
  if (parsed instanceof FeeBumpTransaction) {
    throw reject('fee_bump', 'Fee-bump transactions are not accepted');
  }
  const tx = parsed;

  if (tx.networkPassphrase !== opts.networkPassphrase) {
    throw reject('network', 'Transaction is for a different network');
  }
  if (tx.operations.length !== 1) {
    throw reject('operation_count', 'Transaction must contain exactly one operation');
  }
  const op = tx.operations[0];
  if (!op || op.type !== 'invokeHostFunction') {
    throw reject('operation_type', 'Operation must be invokeHostFunction');
  }
  if (op.source && op.source !== tx.source) {
    throw reject('operation_source', 'Operation source must be the transaction source');
  }
  const fn = op.func;
  if (fn.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    throw reject('host_function', 'Host function must be a contract invocation');
  }
  const invoke = fn.invokeContract();
  const contractId = Address.fromScAddress(invoke.contractAddress()).toString();
  if (contractId !== opts.contractId) {
    throw reject('contract', 'Transaction invokes a different contract');
  }
  const fnName = invoke.functionName().toString();
  if (fnName !== 'pay') {
    throw reject('function', 'Transaction must call pay');
  }
  const args = invoke.args();
  if (args.length !== 2) {
    throw reject('args', 'pay must have exactly two arguments');
  }
  const [payerArg, idArg] = args as [xdr.ScVal, xdr.ScVal];
  if (payerArg.switch() !== xdr.ScValType.scvAddress()) {
    throw reject('args', 'First argument must be the payer address');
  }
  const payer = Address.fromScVal(payerArg).toString();
  if (!StrKey.isValidEd25519PublicKey(payer)) {
    throw reject('payer', 'Payer must be a G... account');
  }
  if (idArg.switch() !== xdr.ScValType.scvBytes() || Buffer.from(idArg.bytes()).toString('hex') !== opts.paymentId) {
    throw reject('payment_id', 'Transaction pays a different payment');
  }
  if (tx.source !== payer) {
    throw reject('source', 'Transaction source must be the payer');
  }

  // Authorization entries may only authorize this exact pay invocation.
  for (const entry of op.auth ?? []) {
    const root = entry.rootInvocation().function();
    if (root.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
      throw reject('auth', 'Authorization entry is not a contract call');
    }
    if (!sameInvocation(root.contractFn(), invoke)) {
      throw reject('auth', 'Authorization entry authorizes a different invocation');
    }
    const creds = entry.credentials();
    if (creds.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
      const signer = Address.fromScAddress(creds.address().address()).toString();
      if (signer !== payer) throw reject('auth', 'Authorization entry is not signed by the payer');
    }
  }

  const fee = Number(tx.fee);
  if (!Number.isFinite(fee) || fee > opts.maxFee) {
    throw reject('fee', `Transaction fee exceeds the maximum of ${opts.maxFee} stroops`);
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!maxTime) throw reject('timebounds', 'Transaction must have an expiry (timebounds.maxTime)');
  if (maxTime < now) throw reject('expired', 'Transaction has expired');
  if (maxTime - now > (opts.maxValiditySec ?? 900)) {
    throw reject('timebounds', 'Transaction validity window is too long');
  }

  if (tx.signatures.length === 0) {
    throw reject('unsigned', 'Transaction is not signed');
  }
  const hash = tx.hash();
  const payerKey = Keypair.fromPublicKey(payer);
  const signedByPayer = tx.signatures.some(
    (sig) => sig.hint().equals(payerKey.signatureHint()) && payerKey.verify(hash, sig.signature()),
  );
  if (!signedByPayer) {
    throw reject('signature', 'Transaction is not signed by the payer');
  }
  return { tx, payer, hash: hash.toString('hex') };
}
