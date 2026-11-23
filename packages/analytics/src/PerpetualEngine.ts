import type { DataSeries, OHLCBar } from '@1penny/commons';
import { computeRiskMetrics } from './RiskMetrics.js';
import type { ClosedTrade, EquityPoint, RiskMetrics, Side } from './types.js';

export type MarginMode = 'cross' | 'isolated';

export interface MarginTier {
  /** Minimum contract size for this tier (inclusive). */
  minSz: number;
  /** Maximum contract size for this tier (inclusive, `Infinity` for top tier). */
  maxSz: number;
  /** Maintenance margin ratio (e.g. `0.004` = 0.4%). */
  mmr: number;
  /** Initial margin ratio (e.g. `0.01` = 1%). */
  imr: number;
  /** Maximum allowed leverage in this tier (e.g. `100`). */
  maxLever: number;
}

export const DEFAULT_MARGIN_TIERS: readonly MarginTier[] = [
  { minSz: 0, maxSz: 10_000, mmr: 0.004, imr: 0.01, maxLever: 100 },
  { minSz: 10_000, maxSz: 100_000, mmr: 0.008, imr: 0.02, maxLever: 50 },
  { minSz: 100_000, maxSz: Infinity, mmr: 0.015, imr: 0.05, maxLever: 20 },
];

export interface PerpetualOrderInput {
  id?: string;
  side: Side;
  type: 'market' | 'limit' | 'stop';
  contracts: number;
  price?: number;
  stopLoss?: number;
  takeProfit?: number;
  reduceOnly?: boolean;
  tag?: string;
}

export interface PerpetualPendingOrder extends PerpetualOrderInput {
  id: string;
  placedAt: number;
  reservedMargin: number;
}

export interface PerpetualPosition {
  side: Side;
  contracts: number;
  entryPrice: number;
  /** Assigned isolated margin (equals `initialMargin` at open + manual adjustments in `isolated` mode). */
  margin: number;
  marginAdjustments: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: number;
  episodeId: number;
}

export type PerpetualFillReason =
  | 'market'
  | 'limit'
  | 'stop'
  | 'stopLoss'
  | 'takeProfit'
  | 'liquidation'
  | 'close';

export interface PerpetualFill {
  id: number;
  orderId: string;
  episodeId: number;
  time: number;
  side: Side;
  contracts: number;
  price: number;
  fee: number;
  realizedPnl: number;
  isolatedDeficitCredit: number;
  reason: PerpetualFillReason;
  /** True when intrabar OHLC paths disagreed on trigger order or outcome and conservative worst-case was chosen. */
  ambiguous: boolean;
  tag?: string;
}

export interface FundingPayment {
  time: number;
  rate: number;
  markPrice: number;
  contracts: number;
  side: Side;
  /** Positive = credited to account, negative = debited from account. */
  amount: number;
  episodeId: number;
}

export interface MarginAdjustmentRecord {
  seq: number;
  time: number;
  amount: number;
  positionMargin: number;
  availableCash: number;
}

export interface PerpetualEpisode {
  id: number;
  side: Side;
  openedAt: number;
  closedAt: number | null;
  maxContracts: number;
  entryPrice: number;
  exitPrice: number | null;
  grossPnl: number;
  fees: number;
  funding: number;
  isolatedDeficitCredit: number;
  netPnl: number;
  liquidated: boolean;
  ambiguous: boolean;
}

export interface MarginRequirements {
  notional: number;
  tier: MarginTier;
  initialMargin: number;
  maintenanceMargin: number;
  liquidationFee: number;
}

export interface PerpetualEngineOptions {
  initialBalance: number;
  marginMode?: MarginMode;
  leverage?: number;
  /** Contract multiplier in base asset (e.g. `0.01` BTC per contract on OKX BTC-USDT-SWAP). Default `1`. */
  ctVal?: number;
  /** Taker/maker fee in basis points (e.g. `5` = 0.05%). Default `5`. */
  feeBps?: number;
  /** Adverse slippage in basis points applied to market/stop/SL fills. Default `0`. */
  slippageBps?: number;
  marginTiers?: readonly MarginTier[];
  /** Timestamp (ms) -> funding rate fraction (e.g. `0.0001` = +0.01%). */
  fundingRates?: ReadonlyMap<number, number> | Readonly<Record<number, number>>;
}

export interface PerpetualStrategyContext {
  bar: OHLCBar;
  index: number;
  position: Readonly<PerpetualPosition> | null;
  pendingOrders: ReadonlyArray<PerpetualPendingOrder>;
  balance: number;
  equity: number;
  availableCash: number;
  placeOrder: (order: PerpetualOrderInput) => string;
  cancelOrder: (orderId: string) => boolean;
  closePosition: (tag?: string) => void;
  updateStops: (stops: { stopLoss?: number | null; takeProfit?: number | null }) => void;
  adjustIsolatedMargin: (amount: number) => MarginAdjustmentRecord;
}

export type PerpetualStrategyFn = (ctx: PerpetualStrategyContext) => void;

export interface LedgerVerification {
  valid: boolean;
  expectedBalance: number;
  actualBalance: number;
  drift: number;
}

export interface PerpetualRunResult {
  initialBalance: number;
  finalBalance: number;
  finalEquity: number;
  fills: ReadonlyArray<PerpetualFill>;
  fundingPayments: ReadonlyArray<FundingPayment>;
  marginAdjustments: ReadonlyArray<MarginAdjustmentRecord>;
  episodes: ReadonlyArray<PerpetualEpisode>;
  trades: ReadonlyArray<ClosedTrade>;
  equityCurve: ReadonlyArray<EquityPoint>;
  metrics: RiskMetrics;
  verification: LedgerVerification;
}

const SCALE = 1e8;
function round8(value: number): number {
  return Math.round((value + Number.EPSILON) * SCALE) / SCALE;
}

function lookupFunding(
  source: PerpetualEngineOptions['fundingRates'],
  time: number,
): number | undefined {
  if (!source) return undefined;
  if (source instanceof Map) return source.get(time);
  return (source as Record<number, number>)[time];
}

export function marginRequirements(params: {
  contracts: number;
  markPrice: number;
  ctVal: number;
  leverage: number;
  tiers: readonly MarginTier[];
  feeBps: number;
}): MarginRequirements {
  const { contracts, markPrice, ctVal, leverage, tiers, feeBps } = params;
  const qty = Math.abs(contracts);
  const notional = round8(qty * ctVal * markPrice);
  const tier =
    tiers.find((t) => qty >= t.minSz && qty <= t.maxSz) ??
    tiers[tiers.length - 1] ??
    DEFAULT_MARGIN_TIERS[0];
  const effectiveImr = Math.max(1 / leverage, tier.imr);
  return {
    notional,
    tier,
    initialMargin: round8(notional * effectiveImr),
    maintenanceMargin: round8(notional * tier.mmr),
    liquidationFee: round8(notional * (feeBps / 10_000)),
  };
}

interface EngineState {
  balance: number;
  position: PerpetualPosition | null;
  pendingOrders: PerpetualPendingOrder[];
  fills: PerpetualFill[];
  fundingPayments: FundingPayment[];
  marginAdjustments: MarginAdjustmentRecord[];
  episodes: PerpetualEpisode[];
  trades: ClosedTrade[];
  equityCurve: EquityPoint[];
  realizedPnl: number;
  lastPrice: number;
  cursor: number;
  orderSeq: number;
  fillSeq: number;
  episodeSeq: number;
  marginSeq: number;
}

function cloneState(s: EngineState): EngineState {
  return {
    ...s,
    position: s.position ? { ...s.position } : null,
    pendingOrders: s.pendingOrders.map((o) => ({ ...o })),
    fills: s.fills.map((f) => ({ ...f })),
    fundingPayments: s.fundingPayments.map((f) => ({ ...f })),
    marginAdjustments: s.marginAdjustments.map((m) => ({ ...m })),
    episodes: s.episodes.map((e) => ({ ...e })),
    trades: s.trades.map((t) => ({ ...t })),
    equityCurve: s.equityCurve.map((p) => ({ ...p })),
  };
}

/**
 * Stateful Perpetual Swap execution engine supporting both interactive bar-by-bar
 * Strategy Replay (`PerpetualReplaySession`) and batch Backtesting (`runPerpetualBacktest`)
 * with 100% initial-bar parity, Cross/Isolated Margin Tiers, intrabar worst-case
 * OHLC path evaluation, funding settlement, and independent ledger verification.
 */
export class PerpetualExecutionEngine {
  readonly initialBalance: number;
  readonly marginMode: MarginMode;
  readonly leverage: number;
  readonly ctVal: number;
  readonly feeBps: number;
  readonly slippageBps: number;
  readonly tiers: readonly MarginTier[];
  private readonly fundingRates?: PerpetualEngineOptions['fundingRates'];
  private state: EngineState;

  constructor(options: PerpetualEngineOptions) {
    if (!(options.initialBalance > 0)) throw new Error('initialBalance must be > 0');
    const leverage = options.leverage ?? 10;
    if (!(leverage >= 1)) throw new Error('leverage must be >= 1');
    this.initialBalance = round8(options.initialBalance);
    this.marginMode = options.marginMode ?? 'isolated';
    this.leverage = leverage;
    this.ctVal = options.ctVal ?? 1;
    this.feeBps = options.feeBps ?? 5;
    this.slippageBps = options.slippageBps ?? 0;
    this.tiers = options.marginTiers?.length ? options.marginTiers : DEFAULT_MARGIN_TIERS;
    this.fundingRates = options.fundingRates;

    const topMaxLever = Math.max(...this.tiers.map((t) => t.maxLever));
    if (this.leverage > topMaxLever) {
      throw new Error(`Leverage ${this.leverage}x exceeds maximum tier leverage ${topMaxLever}x`);
    }

    this.state = {
      balance: this.initialBalance,
      position: null,
      pendingOrders: [],
      fills: [],
      fundingPayments: [],
      marginAdjustments: [],
      episodes: [],
      trades: [],
      equityCurve: [],
      realizedPnl: 0,
      lastPrice: 0,
      cursor: 0,
      orderSeq: 0,
      fillSeq: 0,
      episodeSeq: 0,
      marginSeq: 0,
    };
  }

  getBalance(): number {
    return this.state.balance;
  }

  getPosition(): Readonly<PerpetualPosition> | null {
    return this.state.position ? { ...this.state.position } : null;
  }

  getPendingOrders(): ReadonlyArray<PerpetualPendingOrder> {
    return this.state.pendingOrders;
  }

  unrealizedPnl(price = this.state.lastPrice): number {
    const pos = this.state.position;
    if (!pos) return 0;
    const dir = pos.side === 'long' ? 1 : -1;
    const raw = round8((price - pos.entryPrice) * pos.contracts * this.ctVal * dir);
    if (this.marginMode === 'isolated') {
      return Math.max(raw, -pos.margin);
    }
    return raw;
  }

  rawUnrealizedPnl(price = this.state.lastPrice): number {
    const pos = this.state.position;
    if (!pos) return 0;
    const dir = pos.side === 'long' ? 1 : -1;
    return round8((price - pos.entryPrice) * pos.contracts * this.ctVal * dir);
  }

  equity(price = this.state.lastPrice): number {
    return round8(this.state.balance + this.unrealizedPnl(price));
  }

  availableCash(price = this.state.lastPrice): number {
    const reserved = this.state.pendingOrders.reduce((acc, o) => acc + o.reservedMargin, 0);
    if (this.marginMode === 'isolated') {
      const posMargin = this.state.position ? this.state.position.margin : 0;
      return Math.max(0, round8(this.state.balance - posMargin - reserved));
    }
    const posReq = this.state.position
      ? marginRequirements({
          contracts: this.state.position.contracts,
          markPrice: price || this.state.position.entryPrice,
          ctVal: this.ctVal,
          leverage: this.leverage,
          tiers: this.tiers,
          feeBps: this.feeBps,
        }).initialMargin
      : 0;
    return Math.max(0, round8(this.equity(price) - posReq - reserved));
  }

  /**
   * Initialize the engine on the starting bar (`bars[0]`) and optionally run
   * the strategy hook immediately so Replay and Backtest share identical warm-up.
   */
  initialize(firstBar: OHLCBar, index = 0, strategy?: PerpetualStrategyFn): void {
    this.state.cursor = firstBar.time;
    this.state.lastPrice = firstBar.close;
    this.recordEquityPoint(firstBar.time, firstBar.close);
    if (strategy) {
      strategy(this.makeContext(firstBar, index));
    }
  }

  /**
   * Advance one bar:
   * 1. Evaluate intrabar `[O,H,L,C]` and `[O,L,H,C]` monotonically; pick conservative worst-case on conflict.
   * 2. Apply funding if scheduled at `bar.time`.
   * 3. Record equity curve at `bar.close`.
   * 4. Run optional `strategy` hook for next-bar decisions.
   */
  step(bar: OHLCBar, index = 0, strategy?: PerpetualStrategyFn): void {
    this.state.cursor = bar.time;

    const hasIntrabarTriggers =
      this.state.pendingOrders.length > 0 || this.state.position !== null;

    if (hasIntrabarTriggers && bar.high > bar.low) {
      const branchA = cloneState(this.state);
      const branchB = cloneState(this.state);

      this.simulatePath(branchA, [bar.open, bar.high, bar.low, bar.close], bar.time);
      this.simulatePath(branchB, [bar.open, bar.low, bar.high, bar.close], bar.time);

      const eqA = this.computeStateEquity(branchA, bar.close);
      const eqB = this.computeStateEquity(branchB, bar.close);
      const fillsDiffer = this.fillsDiffer(branchA.fills, branchB.fills, this.state.fills.length);

      const chosen = eqA <= eqB ? branchA : branchB;
      if (fillsDiffer) {
        for (let i = this.state.fills.length; i < chosen.fills.length; i++) {
          chosen.fills[i].ambiguous = true;
          const ep = chosen.episodes.find((e) => e.id === chosen.fills[i].episodeId);
          if (ep) ep.ambiguous = true;
        }
      }
      this.state = chosen;
    } else {
      this.simulatePath(this.state, [bar.open, bar.close], bar.time);
    }

    this.state.lastPrice = bar.close;
    this.applyFundingIfDue(bar.time, bar.close);
    this.recordEquityPoint(bar.time, bar.close);

    if (strategy) {
      strategy(this.makeContext(bar, index));
    }
  }

  placeOrder(input: PerpetualOrderInput, placedAt = this.state.cursor): string {
    if (!(input.contracts > 0) || !Number.isFinite(input.contracts)) {
      throw new Error('Order contracts must be a positive finite number');
    }
    if ((input.type === 'limit' || input.type === 'stop') && !(input.price && input.price > 0)) {
      throw new Error(`${input.type} order requires a positive price`);
    }

    const refPrice = input.price ?? this.state.lastPrice;
    if (!(refPrice > 0)) throw new Error('Cannot validate order without a positive market price');

    const req = marginRequirements({
      contracts: input.contracts,
      markPrice: refPrice,
      ctVal: this.ctVal,
      leverage: this.leverage,
      tiers: this.tiers,
      feeBps: this.feeBps,
    });
    if (this.leverage > req.tier.maxLever) {
      throw new Error(`Leverage ${this.leverage}x exceeds tier maximum ${req.tier.maxLever}x`);
    }

    const reducesExisting =
      this.state.position !== null &&
      this.state.position.side !== input.side &&
      input.contracts <= this.state.position.contracts;

    if (input.reduceOnly && !reducesExisting) {
      throw new Error('Reduce-only order exceeds or does not oppose current position');
    }

    const estFee = req.liquidationFee;
    const neededMargin = reducesExisting ? 0 : round8(req.initialMargin + estFee);
    if (neededMargin > this.availableCash(this.state.lastPrice)) {
      throw new Error('Insufficient available cash for initial margin and estimated fee');
    }

    const id = input.id ?? `ord-${++this.state.orderSeq}`;
    this.state.pendingOrders.push({
      ...input,
      id,
      placedAt,
      reservedMargin: reducesExisting ? 0 : req.initialMargin,
    });
    return id;
  }

  cancelOrder(orderId: string): boolean {
    const before = this.state.pendingOrders.length;
    this.state.pendingOrders = this.state.pendingOrders.filter((o) => o.id !== orderId);
    return this.state.pendingOrders.length < before;
  }

  closePosition(price = this.state.lastPrice, time = this.state.cursor, tag?: string): void {
    const pos = this.state.position;
    if (!pos) return;
    const closeSide: Side = pos.side === 'long' ? 'short' : 'long';
    const execPrice = this.applySlippage(price, closeSide);
    this.executeFill(this.state, {
      orderId: `close-${++this.state.orderSeq}`,
      time,
      side: closeSide,
      contracts: pos.contracts,
      price: execPrice,
      reason: 'close',
      tag,
    });
  }

  updateStops(stops: { stopLoss?: number | null; takeProfit?: number | null }): void {
    const pos = this.state.position;
    if (!pos) throw new Error('No active position to update stops on');
    if (stops.stopLoss !== undefined) {
      pos.stopLoss = stops.stopLoss === null ? undefined : stops.stopLoss;
    }
    if (stops.takeProfit !== undefined) {
      pos.takeProfit = stops.takeProfit === null ? undefined : stops.takeProfit;
    }
  }

  /**
   * Deposit (`amount > 0`) or withdraw (`amount < 0`) isolated margin on an open position.
   *
   * Security invariant: withdrawals CANNOT reduce margin below `initialMargin` (nor below
   * `initialMargin - min(0, unrealizedPnl)` when underwater), preventing both leverage-cap
   * bypass and negative-margin limited-liability exploits.
   */
  adjustIsolatedMargin(amount: number): MarginAdjustmentRecord {
    if (this.marginMode !== 'isolated' || !this.state.position) {
      throw new Error('Isolated margin adjustment requires an active isolated position');
    }
    const delta = round8(amount);
    if (!Number.isFinite(delta) || delta === 0) {
      throw new Error('Margin adjustment must be a non-zero finite amount');
    }
    if (delta > 0 && delta > this.availableCash(this.state.lastPrice)) {
      throw new Error('Insufficient available cash to add isolated margin');
    }

    const pos = this.state.position;
    const updated = round8(pos.margin + delta);
    const req = marginRequirements({
      contracts: pos.contracts,
      markPrice: this.state.lastPrice,
      ctVal: this.ctVal,
      leverage: this.leverage,
      tiers: this.tiers,
      feeBps: this.feeBps,
    });
    const rawPnl = this.rawUnrealizedPnl(this.state.lastPrice);

    if (delta < 0) {
      const minRequiredMargin = round8(
        Math.max(req.initialMargin, req.initialMargin - Math.min(0, rawPnl)),
      );
      if (updated < minRequiredMargin) {
        throw new Error('Margin withdrawal exceeds removable isolated margin');
      }
    }
    if (updated + rawPnl <= req.maintenanceMargin + req.liquidationFee) {
      throw new Error('Margin adjustment would breach maintenance margin requirements');
    }

    pos.margin = updated;
    pos.marginAdjustments = round8(pos.marginAdjustments + delta);
    const rec: MarginAdjustmentRecord = {
      seq: ++this.state.marginSeq,
      time: this.state.cursor,
      amount: delta,
      positionMargin: pos.margin,
      availableCash: this.availableCash(this.state.lastPrice),
    };
    this.state.marginAdjustments.push(rec);
    return rec;
  }

  getResult(): PerpetualRunResult {
    const finalEquity = this.equity(this.state.lastPrice);
    const resultWithoutVerify = {
      initialBalance: this.initialBalance,
      finalBalance: this.state.balance,
      finalEquity,
      fills: this.state.fills,
      fundingPayments: this.state.fundingPayments,
      marginAdjustments: this.state.marginAdjustments,
      episodes: this.state.episodes,
      trades: this.state.trades,
      equityCurve: this.state.equityCurve,
      metrics: computeRiskMetrics(this.initialBalance, this.state.equityCurve, this.state.trades),
    };
    return {
      ...resultWithoutVerify,
      verification: verifyPerpetualLedger(resultWithoutVerify),
    };
  }

  // --- Internal simulation ---

  private simulatePath(s: EngineState, waypoints: readonly number[], time: number): void {
    let prev = waypoints[0];
    this.evaluatePoint(s, prev, prev, time);
    for (let i = 1; i < waypoints.length; i++) {
      const next = waypoints[i];
      this.evaluateSegment(s, prev, next, time);
      prev = next;
    }
  }

  private evaluatePoint(s: EngineState, fromPrice: number, toPrice: number, time: number): void {
    this.evaluateSegment(s, fromPrice, toPrice, time);
  }

  private evaluateSegment(s: EngineState, p0: number, p1: number, time: number): void {
    const low = Math.min(p0, p1);
    const high = Math.max(p0, p1);

    // 1. Check liquidation first along segment `[p0 -> p1]`
    if (s.position) {
      const liqPrice = this.liquidationPrice(s, s.position);
      if (liqPrice !== null && liqPrice >= low && liqPrice <= high) {
        const closeSide: Side = s.position.side === 'long' ? 'short' : 'long';
        this.executeFill(s, {
          orderId: `liq-${++s.orderSeq}`,
          time,
          side: closeSide,
          contracts: s.position.contracts,
          price: liqPrice,
          reason: 'liquidation',
        });
        // Cancel remaining pending orders on liquidation
        s.pendingOrders = [];
        return;
      }
    }

    // 2. Check position SL / TP along `[p0 -> p1]` in travel order
    if (s.position) {
      const sl = s.position.stopLoss;
      const tp = s.position.takeProfit;
      const hitSl =
        sl !== undefined &&
        (s.position.side === 'long' ? low <= sl : high >= sl);
      const hitTp =
        tp !== undefined &&
        (s.position.side === 'long' ? high >= tp : low <= tp);

      if (hitSl || hitTp) {
        // Along a monotonic segment p0 -> p1, at most one opposing level is crossed unless both lie on p0;
        // if both hit on the same point, conservative worst-case chooses SL.
        const useSl = hitSl && (!hitTp || Math.abs(p0 - sl!) <= Math.abs(p0 - tp!));
        const rawTrigger = useSl ? sl! : tp!;
        const closeSide: Side = s.position.side === 'long' ? 'short' : 'long';
        const execPrice = useSl ? this.applySlippage(rawTrigger, closeSide) : rawTrigger;
        this.executeFill(s, {
          orderId: `${useSl ? 'sl' : 'tp'}-${++s.orderSeq}`,
          time,
          side: closeSide,
          contracts: s.position.contracts,
          price: execPrice,
          reason: useSl ? 'stopLoss' : 'takeProfit',
        });
      }
    }

    // 3. Check pending orders
    if (s.pendingOrders.length === 0) return;
    const remaining: PerpetualPendingOrder[] = [];
    for (const order of s.pendingOrders) {
      let fillPrice: number | null = null;
      if (order.type === 'market') {
        fillPrice = this.applySlippage(p0, order.side);
      } else if (order.type === 'limit' && order.price !== undefined) {
        if (order.side === 'long' && low <= order.price) {
          fillPrice = Math.min(order.price, p0);
        } else if (order.side === 'short' && high >= order.price) {
          fillPrice = Math.max(order.price, p0);
        }
      } else if (order.type === 'stop' && order.price !== undefined) {
        if (order.side === 'long' && high >= order.price) {
          fillPrice = this.applySlippage(Math.max(order.price, p0), order.side);
        } else if (order.side === 'short' && low <= order.price) {
          fillPrice = this.applySlippage(Math.min(order.price, p0), order.side);
        }
      }

      if (fillPrice === null) {
        remaining.push(order);
        continue;
      }

      if (order.reduceOnly) {
        if (!s.position || s.position.side === order.side) continue;
        order.contracts = Math.min(order.contracts, s.position.contracts);
      }

      this.executeFill(s, {
        orderId: order.id,
        time,
        side: order.side,
        contracts: order.contracts,
        price: fillPrice,
        reason: order.type,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        tag: order.tag,
      });
    }
    s.pendingOrders = remaining;
  }

  private liquidationPrice(s: EngineState, pos: PerpetualPosition): number | null {
    const req = marginRequirements({
      contracts: pos.contracts,
      markPrice: pos.entryPrice,
      ctVal: this.ctVal,
      leverage: this.leverage,
      tiers: this.tiers,
      feeBps: this.feeBps,
    });
    const mmrPlusFee = req.tier.mmr + this.feeBps / 10_000;
    const dir = pos.side === 'long' ? 1 : -1;
    const buffer = this.marginMode === 'isolated' ? pos.margin : s.balance;
    // Solve: buffer + (P - entry) * qty * ctVal * dir = P * qty * ctVal * mmrPlusFee
    // => P * qty * ctVal * (dir - mmrPlusFee) = entry * qty * ctVal * dir - buffer
    const denom = pos.contracts * this.ctVal * (dir - mmrPlusFee);
    if (denom === 0) return null;
    const raw = (pos.entryPrice * pos.contracts * this.ctVal * dir - buffer) / denom;
    return raw > 0 && Number.isFinite(raw) ? round8(raw) : null;
  }

  private executeFill(
    s: EngineState,
    params: {
      orderId: string;
      time: number;
      side: Side;
      contracts: number;
      price: number;
      reason: PerpetualFillReason;
      stopLoss?: number;
      takeProfit?: number;
      tag?: string;
    },
  ): void {
    const fee = round8(params.contracts * this.ctVal * params.price * (this.feeBps / 10_000));
    const current = s.position;

    // Case 1: Opening from flat
    if (!current) {
      const epId = ++s.episodeSeq;
      const req = marginRequirements({
        contracts: params.contracts,
        markPrice: params.price,
        ctVal: this.ctVal,
        leverage: this.leverage,
        tiers: this.tiers,
        feeBps: this.feeBps,
      });
      s.balance = round8(s.balance - fee);
      s.position = {
        side: params.side,
        contracts: params.contracts,
        entryPrice: params.price,
        margin: req.initialMargin,
        marginAdjustments: 0,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
        openedAt: params.time,
        episodeId: epId,
      };
      s.episodes.push({
        id: epId,
        side: params.side,
        openedAt: params.time,
        closedAt: null,
        maxContracts: params.contracts,
        entryPrice: params.price,
        exitPrice: null,
        grossPnl: 0,
        fees: fee,
        funding: 0,
        isolatedDeficitCredit: 0,
        netPnl: round8(-fee),
        liquidated: false,
        ambiguous: false,
      });
      s.fills.push({
        id: ++s.fillSeq,
        orderId: params.orderId,
        episodeId: epId,
        time: params.time,
        side: params.side,
        contracts: params.contracts,
        price: params.price,
        fee,
        realizedPnl: 0,
        isolatedDeficitCredit: 0,
        reason: params.reason,
        ambiguous: false,
        tag: params.tag,
      });
      return;
    }

    // Case 2: Adding to same-side position
    if (current.side === params.side) {
      const totalContracts = round8(current.contracts + params.contracts);
      const weightedEntry = round8(
        (current.entryPrice * current.contracts + params.price * params.contracts) / totalContracts,
      );
      const addReq = marginRequirements({
        contracts: params.contracts,
        markPrice: params.price,
        ctVal: this.ctVal,
        leverage: this.leverage,
        tiers: this.tiers,
        feeBps: this.feeBps,
      });
      s.balance = round8(s.balance - fee);
      current.contracts = totalContracts;
      current.entryPrice = weightedEntry;
      current.margin = round8(current.margin + addReq.initialMargin);
      if (params.stopLoss !== undefined) current.stopLoss = params.stopLoss;
      if (params.takeProfit !== undefined) current.takeProfit = params.takeProfit;

      const ep = s.episodes.find((e) => e.id === current.episodeId);
      if (ep) {
        ep.maxContracts = Math.max(ep.maxContracts, totalContracts);
        ep.entryPrice = weightedEntry;
        ep.fees = round8(ep.fees + fee);
        ep.netPnl = round8(ep.grossPnl - ep.fees + ep.funding + ep.isolatedDeficitCredit);
      }
      s.fills.push({
        id: ++s.fillSeq,
        orderId: params.orderId,
        episodeId: current.episodeId,
        time: params.time,
        side: params.side,
        contracts: params.contracts,
        price: params.price,
        fee,
        realizedPnl: 0,
        isolatedDeficitCredit: 0,
        reason: params.reason,
        ambiguous: false,
        tag: params.tag,
      });
      return;
    }

    // Case 3: Reducing, closing, or flipping an opposing position
    const closedContracts = Math.min(current.contracts, params.contracts);
    const flipContracts = round8(params.contracts - closedContracts);
    const closeShare = closedContracts / current.contracts;
    const feeClose = round8(fee * (closedContracts / params.contracts));
    const feeOpen = round8(fee - feeClose);

    const dir = current.side === 'long' ? 1 : -1;
    const grossPnl = round8((params.price - current.entryPrice) * closedContracts * this.ctVal * dir);
    const releasedMargin = round8(current.margin * closeShare);

    let deficitCredit = 0;
    if (this.marginMode === 'isolated' && releasedMargin + grossPnl - feeClose < 0) {
      deficitCredit = round8(-(releasedMargin + grossPnl - feeClose));
    }

    s.balance = round8(s.balance + grossPnl - feeClose + deficitCredit);
    s.realizedPnl = round8(s.realizedPnl + grossPnl);

    const ep = s.episodes.find((e) => e.id === current.episodeId);
    if (ep) {
      ep.grossPnl = round8(ep.grossPnl + grossPnl);
      ep.fees = round8(ep.fees + feeClose);
      ep.isolatedDeficitCredit = round8(ep.isolatedDeficitCredit + deficitCredit);
      ep.netPnl = round8(ep.grossPnl - ep.fees + ep.funding + ep.isolatedDeficitCredit);
      if (params.reason === 'liquidation') ep.liquidated = true;
    }

    s.trades.push({
      entryTime: current.openedAt,
      exitTime: params.time,
      side: current.side,
      quantity: closedContracts,
      entryPrice: current.entryPrice,
      exitPrice: params.price,
      pnl: round8(grossPnl - feeClose + deficitCredit),
      pnlPct: (params.price / current.entryPrice - 1) * dir,
      commission: feeClose,
      tag: params.tag,
    });

    s.fills.push({
      id: ++s.fillSeq,
      orderId: params.orderId,
      episodeId: current.episodeId,
      time: params.time,
      side: params.side,
      contracts: closedContracts,
      price: params.price,
      fee: feeClose,
      realizedPnl: grossPnl,
      isolatedDeficitCredit: deficitCredit,
      reason: params.reason,
      ambiguous: false,
      tag: params.tag,
    });

    const remainingContracts = round8(current.contracts - closedContracts);
    if (remainingContracts > 0) {
      current.contracts = remainingContracts;
      current.margin = round8(current.margin - releasedMargin);
      return;
    }

    // Current episode is now flat
    if (ep) {
      ep.closedAt = params.time;
      ep.exitPrice = params.price;
    }
    s.position = null;

    // If order flipped into opposite side, open new episode with remaining contracts
    if (flipContracts > 0) {
      const newEpId = ++s.episodeSeq;
      const flipReq = marginRequirements({
        contracts: flipContracts,
        markPrice: params.price,
        ctVal: this.ctVal,
        leverage: this.leverage,
        tiers: this.tiers,
        feeBps: this.feeBps,
      });
      s.balance = round8(s.balance - feeOpen);
      s.position = {
        side: params.side,
        contracts: flipContracts,
        entryPrice: params.price,
        margin: flipReq.initialMargin,
        marginAdjustments: 0,
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
        openedAt: params.time,
        episodeId: newEpId,
      };
      s.episodes.push({
        id: newEpId,
        side: params.side,
        openedAt: params.time,
        closedAt: null,
        maxContracts: flipContracts,
        entryPrice: params.price,
        exitPrice: null,
        grossPnl: 0,
        fees: feeOpen,
        funding: 0,
        isolatedDeficitCredit: 0,
        netPnl: round8(-feeOpen),
        liquidated: false,
        ambiguous: false,
      });
      s.fills.push({
        id: ++s.fillSeq,
        orderId: params.orderId,
        episodeId: newEpId,
        time: params.time,
        side: params.side,
        contracts: flipContracts,
        price: params.price,
        fee: feeOpen,
        realizedPnl: 0,
        isolatedDeficitCredit: 0,
        reason: params.reason,
        ambiguous: false,
        tag: params.tag,
      });
    }
  }

  private applyFundingIfDue(time: number, markPrice: number): void {
    const pos = this.state.position;
    if (!pos) return;
    const rate = lookupFunding(this.fundingRates, time);
    if (rate === undefined || rate === 0) return;

    const dir = pos.side === 'long' ? 1 : -1;
    // Positive funding rate: longs pay (-), shorts receive (+)
    const amount = round8(-dir * pos.contracts * this.ctVal * markPrice * rate);
    this.state.balance = round8(this.state.balance + amount);
    this.state.fundingPayments.push({
      time,
      rate,
      markPrice,
      contracts: pos.contracts,
      side: pos.side,
      amount,
      episodeId: pos.episodeId,
    });
    const ep = this.state.episodes.find((e) => e.id === pos.episodeId);
    if (ep) {
      ep.funding = round8(ep.funding + amount);
      ep.netPnl = round8(ep.grossPnl - ep.fees + ep.funding + ep.isolatedDeficitCredit);
    }
  }

  private recordEquityPoint(time: number, price: number): void {
    const pos = this.state.position;
    const dir = pos ? (pos.side === 'long' ? 1 : -1) : 0;
    const positionValue = pos ? round8(pos.contracts * this.ctVal * price * dir) : 0;
    const unrealizedPnl = this.unrealizedPnl(price);
    this.state.equityCurve.push({
      time,
      equity: round8(this.state.balance + unrealizedPnl),
      cash: this.state.balance,
      positionValue,
      unrealizedPnl,
      realizedPnl: this.state.realizedPnl,
    });
  }

  private computeStateEquity(s: EngineState, price: number): number {
    if (!s.position) return s.balance;
    const dir = s.position.side === 'long' ? 1 : -1;
    const raw = round8((price - s.position.entryPrice) * s.position.contracts * this.ctVal * dir);
    const pnl = this.marginMode === 'isolated' ? Math.max(raw, -s.position.margin) : raw;
    return round8(s.balance + pnl);
  }

  private fillsDiffer(a: readonly PerpetualFill[], b: readonly PerpetualFill[], fromIndex: number): boolean {
    if (a.length !== b.length) return true;
    for (let i = fromIndex; i < a.length; i++) {
      if (
        a[i].reason !== b[i].reason ||
        a[i].side !== b[i].side ||
        Math.abs(a[i].price - b[i].price) > 1e-8 ||
        Math.abs(a[i].contracts - b[i].contracts) > 1e-8
      ) {
        return true;
      }
    }
    return false;
  }

  private applySlippage(price: number, side: Side): number {
    if (this.slippageBps <= 0) return round8(price);
    const factor = 1 + (side === 'long' ? 1 : -1) * (this.slippageBps / 10_000);
    return round8(price * factor);
  }

  private makeContext(bar: OHLCBar, index: number): PerpetualStrategyContext {
    return {
      bar,
      index,
      position: this.getPosition(),
      pendingOrders: this.getPendingOrders(),
      balance: this.state.balance,
      equity: this.equity(bar.close),
      availableCash: this.availableCash(bar.close),
      placeOrder: (order) => this.placeOrder(order, bar.time),
      cancelOrder: (id) => this.cancelOrder(id),
      closePosition: (tag) => this.closePosition(bar.close, bar.time, tag),
      updateStops: (stops) => this.updateStops(stops),
      adjustIsolatedMargin: (amount) => this.adjustIsolatedMargin(amount),
    };
  }
}

/**
 * Independent ledger verifier: recomputes final cash balance strictly from
 * `initialBalance`, fill PnL, fees, funding payments, and isolated deficit credits.
 */
export function verifyPerpetualLedger(result: {
  initialBalance: number;
  finalBalance: number;
  fills: ReadonlyArray<PerpetualFill>;
  fundingPayments: ReadonlyArray<FundingPayment>;
}): LedgerVerification {
  let expected = result.initialBalance;
  for (const f of result.fills) {
    expected = round8(expected + f.realizedPnl - f.fee + f.isolatedDeficitCredit);
  }
  for (const fp of result.fundingPayments) {
    expected = round8(expected + fp.amount);
  }
  const drift = Math.abs(expected - result.finalBalance);
  return {
    valid: drift <= 1e-6,
    expectedBalance: expected,
    actualBalance: result.finalBalance,
    drift,
  };
}

/**
 * Batch Perpetual Backtest runner. Runs `strategy` on `data[0]` during initialization
 * and steps sequentially through `data[1..N-1]` — matching `PerpetualReplaySession` bar-for-bar.
 */
export function runPerpetualBacktest(
  data: DataSeries,
  strategy: PerpetualStrategyFn,
  options: PerpetualEngineOptions,
): PerpetualRunResult {
  if (data.length < 2) throw new Error('runPerpetualBacktest requires at least 2 bars');
  const engine = new PerpetualExecutionEngine(options);
  engine.initialize(data[0], 0, strategy);
  for (let i = 1; i < data.length; i++) {
    const isLast = i === data.length - 1;
    engine.step(data[i], i, isLast ? undefined : strategy);
  }
  return engine.getResult();
}

/**
 * Interactive Replay Session wrapper over `PerpetualExecutionEngine` guaranteeing
 * 100% execution and indicator-warmup parity with `runPerpetualBacktest`.
 */
export class PerpetualReplaySession {
  readonly engine: PerpetualExecutionEngine;
  private readonly data: DataSeries;
  private readonly strategy?: PerpetualStrategyFn;
  private index = 0;

  constructor(data: DataSeries, options: PerpetualEngineOptions, strategy?: PerpetualStrategyFn) {
    if (data.length < 2) throw new Error('PerpetualReplaySession requires at least 2 bars');
    this.data = data;
    this.strategy = strategy;
    this.engine = new PerpetualExecutionEngine(options);
    // Identical initial-bar seeding as runPerpetualBacktest!
    this.engine.initialize(data[0], 0, strategy);
  }

  getCursorIndex(): number {
    return this.index;
  }

  isComplete(): boolean {
    return this.index >= this.data.length - 1;
  }

  stepNext(): boolean {
    if (this.isComplete()) return false;
    this.index++;
    const isLast = this.index === this.data.length - 1;
    this.engine.step(this.data[this.index], this.index, isLast ? undefined : this.strategy);
    return true;
  }

  stepMany(count: number): number {
    let moved = 0;
    const target = Math.max(0, Math.floor(count));
    while (moved < target && this.stepNext()) moved++;
    return moved;
  }
}
