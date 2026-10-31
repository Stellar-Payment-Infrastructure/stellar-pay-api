import {
  type Account,
  BASE_FEE,
  Contract,
  Keypair,
  rpc,
  type Transaction,
  TransactionBuilder,
  type xdr,
} from '@stellar/stellar-sdk';
import {
  ApiError,
  ChainTimeoutError,
  PAY_TOKEN_ERRORS,
  PAYOUT_TOKEN_ERRORS,
  parseContractErrorCode,
  RpcUnavailableError,
  SimulationError,
  SubmitError,
} from '../errors.js';
import {
  addressToScVal,
  bytes32ToScVal,
  decodePayment,
  i128ToScVal,
  type OnChainPayment,
  paymentIdToScVal,
  settleModeToScVal,
  type SettleMode,
} from './contract.js';

export interface ChainEvent {
  id: string;
  ledger: number;
  txHash: string;
  contractId: string;
  topics: xdr.ScVal[];
  value: xdr.ScVal;
  inSuccessfulContractCall: boolean;
}

export interface EventsPage {
  events: ChainEvent[];
  cursor: string;
  latestLedger: number;
  oldestLedger: number;
}

export interface CreatePaymentArgs {
  paymentId: string;
  merchant: string;
  amount: bigint;
  referenceHash: string;
  settleMode: SettleMode;
}

/** Everything the API needs from the chain. Implemented over Soroban RPC; faked in tests. */
export interface ChainClient {
  readonly contractId: string;
  readonly networkPassphrase: string;
  /** Address that authorizes this API's payments (the `operator` on-chain). */
  readonly operatorAddress: string;
  createPayment(args: CreatePaymentArgs): Promise<{ txHash: string }>;
  settle(paymentId: string): Promise<{ txHash: string }>;
  cancel(paymentId: string): Promise<{ txHash: string }>;
  refund(paymentId: string): Promise<{ txHash: string }>;
  /** Builds and simulates an unsigned, prepared pay transaction with the payer as source. */
  buildPayTransaction(payer: string, paymentId: string): Promise<{ xdr: string; validUntil: number }>;
  /** Submits an already-verified transaction and waits for its result. */
  submitTransaction(tx: Transaction): Promise<{ txHash: string }>;
  getPayment(paymentId: string): Promise<OnChainPayment | null>;
  getEvents(from: { cursor: string } | { startLedger: number }, limit: number): Promise<EventsPage>;
  getLatestLedger(): Promise<number>;
}

/** The subset of `rpc.Server` used here (lets tests inject a stub). */
export type RpcLike = Pick<
  rpc.Server,
  'getAccount' | 'simulateTransaction' | 'sendTransaction' | 'getTransaction' | 'getEvents' | 'getLatestLedger'
>;

export interface RpcChainClientOptions {
  rpc: RpcLike;
  contractId: string;
  networkPassphrase: string;
  operatorSecret: string;
  /** How long to wait for a submitted transaction (ms). */
  confirmTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Validity window of payer transactions (seconds). */
  payTxTimeoutSec?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RpcChainClient implements ChainClient {
  readonly contractId: string;
  readonly networkPassphrase: string;
  private readonly rpc: RpcLike;
  private readonly contract: Contract;
  private readonly operator: Keypair;
  private readonly confirmTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly payTxTimeoutSec: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Serializes operator transactions so they never race on the sequence number. */
  private operatorQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: RpcChainClientOptions) {
    this.rpc = opts.rpc;
    this.contractId = opts.contractId;
    this.networkPassphrase = opts.networkPassphrase;
    this.contract = new Contract(opts.contractId);
    this.operator = Keypair.fromSecret(opts.operatorSecret);
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 60_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.payTxTimeoutSec = opts.payTxTimeoutSec ?? 300;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  static fromUrl(url: string, opts: Omit<RpcChainClientOptions, 'rpc'>): RpcChainClient {
    return new RpcChainClient({ ...opts, rpc: new rpc.Server(url, { allowHttp: url.startsWith('http://') }) });
  }

  get operatorAddress(): string {
    return this.operator.publicKey();
  }

  createPayment(a: CreatePaymentArgs): Promise<{ txHash: string }> {
    return this.invokeAsOperator('create_payment', [
      addressToScVal(this.operator.publicKey()),
      addressToScVal(a.merchant),
      paymentIdToScVal(a.paymentId),
      i128ToScVal(a.amount),
      bytes32ToScVal(a.referenceHash),
      settleModeToScVal(a.settleMode),
    ]);
  }

  settle(paymentId: string) {
    return this.invokeAsOperator('settle', [paymentIdToScVal(paymentId)], PAYOUT_TOKEN_ERRORS);
  }

  cancel(paymentId: string) {
    return this.invokeAsOperator('cancel', [paymentIdToScVal(paymentId)]);
  }

  refund(paymentId: string) {
    return this.invokeAsOperator('refund', [paymentIdToScVal(paymentId)], PAYOUT_TOKEN_ERRORS);
  }

  async buildPayTransaction(payer: string, paymentId: string): Promise<{ xdr: string; validUntil: number }> {
    let account: Account;
    try {
      account = await this.rpc.getAccount(payer);
    } catch (err) {
      if (isNotFound(err)) {
        throw new ApiError(400, 'PAYER_ACCOUNT_NOT_FOUND', 'Payer account does not exist on this network');
      }
      throw new RpcUnavailableError();
    }
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
      .addOperation(this.contract.call('pay', addressToScVal(payer), paymentIdToScVal(paymentId)))
      .setTimeout(this.payTxTimeoutSec)
      .build();
    const prepared = await this.simulateAndAssemble(tx, PAY_TOKEN_ERRORS);
    return { xdr: prepared.toXDR(), validUntil: Number(prepared.timeBounds?.maxTime ?? 0) };
  }

  async submitTransaction(tx: Transaction): Promise<{ txHash: string }> {
    return this.sendAndConfirm(tx);
  }

  async getPayment(paymentId: string): Promise<OnChainPayment | null> {
    const account = await this.loadOperatorAccount();
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
      .addOperation(this.contract.call('get_payment', paymentIdToScVal(paymentId)))
      .setTimeout(30)
      .build();
    const sim = await this.simulate(tx);
    if (rpc.Api.isSimulationError(sim)) {
      if (parseContractErrorCode(sim.error) === 3) return null;
      throw new SimulationError(parseContractErrorCode(sim.error), sim.error);
    }
    const retval = sim.result?.retval;
    if (!retval) throw new SubmitError('get_payment returned no value');
    return decodePayment(retval);
  }

  async getEvents(from: { cursor: string } | { startLedger: number }, limit: number): Promise<EventsPage> {
    const filters: rpc.Api.EventFilter[] = [{ type: 'contract', contractIds: [this.contractId] }];
    let res: rpc.Api.GetEventsResponse;
    try {
      res = await this.rpc.getEvents('cursor' in from ? { filters, cursor: from.cursor, limit } : { filters, startLedger: from.startLedger, limit });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ledger range|oldest ledger|startLedger must be|out of range/i.test(msg)) {
        throw new EventsOutOfRetentionError();
      }
      throw new RpcUnavailableError();
    }
    return {
      cursor: res.cursor,
      latestLedger: res.latestLedger,
      oldestLedger: res.oldestLedger,
      events: res.events.map((e) => ({
        id: e.id,
        ledger: e.ledger,
        txHash: e.txHash,
        contractId: e.contractId?.contractId() ?? '',
        topics: e.topic,
        value: e.value,
        inSuccessfulContractCall: e.inSuccessfulContractCall,
      })),
    };
  }

  async getLatestLedger(): Promise<number> {
    try {
      return (await this.rpc.getLatestLedger()).sequence;
    } catch {
      throw new RpcUnavailableError();
    }
  }

  // --------------------------------------------------------------- internals

  private invokeAsOperator(fn: string, args: xdr.ScVal[], errorOverrides: Record<number, string> = {}): Promise<{ txHash: string }> {
    const run = async () => {
      const account = await this.loadOperatorAccount();
      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
        .addOperation(this.contract.call(fn, ...args))
        .setTimeout(60)
        .build();
      const prepared = await this.simulateAndAssemble(tx, errorOverrides);
      prepared.sign(this.operator);
      return this.sendAndConfirm(prepared);
    };
    const next = this.operatorQueue.then(run, run);
    this.operatorQueue = next.catch(() => undefined);
    return next;
  }

  private async loadOperatorAccount(): Promise<Account> {
    try {
      return await this.rpc.getAccount(this.operator.publicKey());
    } catch {
      throw new RpcUnavailableError();
    }
  }

  private async simulate(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse> {
    try {
      return await this.rpc.simulateTransaction(tx);
    } catch {
      throw new RpcUnavailableError();
    }
  }

  private async simulateAndAssemble(tx: Transaction, errorOverrides: Record<number, string> = {}): Promise<Transaction> {
    const sim = await this.simulate(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new SimulationError(parseContractErrorCode(sim.error), sim.error, errorOverrides);
    }
    if (rpc.Api.isSimulationRestore(sim)) {
      throw new ApiError(409, 'ENTRY_ARCHIVED', 'A ledger entry needs to be restored before this call');
    }
    return rpc.assembleTransaction(tx, sim).build();
  }

  private async sendAndConfirm(tx: Transaction): Promise<{ txHash: string }> {
    let sent: rpc.Api.SendTransactionResponse;
    try {
      sent = await this.rpc.sendTransaction(tx);
    } catch {
      // The request may or may not have reached the network: outcome unknown.
      throw new ChainTimeoutError(tx.hash().toString('hex'));
    }
    if (sent.status === 'ERROR') {
      throw new SubmitError('Transaction was rejected', {
        txHash: sent.hash,
        result: sent.errorResult?.result().switch().name,
      });
    }
    if (sent.status === 'TRY_AGAIN_LATER') {
      throw new SubmitError('Network is busy; try again', { txHash: sent.hash, retryable: true });
    }
    const deadline = Date.now() + this.confirmTimeoutMs;
    for (;;) {
      let res: rpc.Api.GetTransactionResponse | undefined;
      try {
        res = await this.rpc.getTransaction(sent.hash);
      } catch {
        res = undefined; // transient; keep polling until the deadline
      }
      if (res?.status === rpc.Api.GetTransactionStatus.SUCCESS) return { txHash: sent.hash };
      if (res?.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new SubmitError('Transaction failed on-chain', { txHash: sent.hash });
      }
      if (Date.now() >= deadline) throw new ChainTimeoutError(sent.hash);
      await this.sleep(this.pollIntervalMs);
    }
  }
}

/** The requested cursor/ledger is older than the RPC's event retention window. */
export class EventsOutOfRetentionError extends Error {
  constructor() {
    super('requested events are outside the RPC retention window');
    this.name = 'EventsOutOfRetentionError';
  }
}

function isNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not found/i.test(msg);
}
