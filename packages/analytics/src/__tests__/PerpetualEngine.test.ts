import { describe, it, expect } from 'vitest';
import type { OHLCBar } from '@1penny/commons';
import {
  PerpetualExecutionEngine,
  PerpetualReplaySession,
  runPerpetualBacktest,
  verifyPerpetualLedger,
} from '../PerpetualEngine.js';

function bar(time: number, open: number, high: number, low: number, close: number, volume = 100): OHLCBar {
  return { time, open, high, low, close, volume };
}

describe('PerpetualExecutionEngine', () => {
  it('blocks isolated margin withdrawal below initialMargin (leverage bypass) and prevents negative margin even with large unrealized profit', () => {
    const engine = new PerpetualExecutionEngine({
      initialBalance: 20_000,
      marginMode: 'isolated',
      leverage: 2,
      ctVal: 1,
      feeBps: 5,
    });

    // Open 100 contracts at 100 USDT = 10,000 notional -> 5,000 initial margin at 2x
    engine.initialize(bar(60_000, 100, 100, 100, 100));
    engine.placeOrder({ side: 'long', type: 'market', contracts: 100 });
    engine.step(bar(120_000, 100, 100, 100, 100));

    expect(engine.getPosition()?.margin).toBe(5000);

    // Case 1: Attempting to withdraw -4,950 USDT when flat PnL (would bypass 2x leverage to 200x) -> MUST throw
    expect(() => engine.adjustIsolatedMargin(-4950)).toThrow(/removable isolated margin/);

    // Case 2: Deposit +1,000 margin, then withdraw -800 -> allowed since 5,200 >= 5,000 IMR
    engine.adjustIsolatedMargin(1000);
    expect(engine.getPosition()?.margin).toBe(6000);
    engine.adjustIsolatedMargin(-800);
    expect(engine.getPosition()?.margin).toBe(5200);

    // Case 3: Price rallies to 120 (+2,000 unrealized profit -> IMR at 120 is 6,000).
    // Attempting to withdraw -6,500 to drive margin negative (-1,300) -> MUST throw!
    engine.step(bar(180_000, 100, 120, 100, 120));
    expect(() => engine.adjustIsolatedMargin(-6500)).toThrow(/removable isolated margin/);
    expect(engine.getPosition()!.margin).toBeGreaterThan(0);
  });

  it('enforces tier maxLever and tracks netting add, partial reduce, and one-order flip across episodes', () => {
    const engine = new PerpetualExecutionEngine({
      initialBalance: 50_000,
      marginMode: 'cross',
      leverage: 25,
      ctVal: 1,
      feeBps: 0,
      marginTiers: [
        { minSz: 0, maxSz: 500, mmr: 0.005, imr: 0.02, maxLever: 50 },
        { minSz: 500, maxSz: 10_000, mmr: 0.02, imr: 0.05, maxLever: 20 },
      ],
    });

    engine.initialize(bar(0, 10, 10, 10, 10));
    // 600 contracts falls in tier 2 (maxLever 20 < 25) -> rejected
    expect(() => engine.placeOrder({ side: 'long', type: 'market', contracts: 600 })).toThrow(/exceeds tier maximum/);

    // Open 100 long @ 10, add 100 long @ 12 -> avg entry 11 (200 contracts)
    engine.placeOrder({ side: 'long', type: 'market', contracts: 100 });
    engine.step(bar(60_000, 10, 10, 10, 10));
    engine.placeOrder({ side: 'long', type: 'market', contracts: 100 });
    engine.step(bar(120_000, 12, 12, 12, 12));
    expect(engine.getPosition()).toMatchObject({ side: 'long', contracts: 200, entryPrice: 11, episodeId: 1 });

    // Flip with 250 short @ 15 -> closes 200 long (+800 PnL, episode 1 closed) and opens 50 short @ 15 (episode 2)
    engine.placeOrder({ side: 'short', type: 'market', contracts: 250 });
    engine.step(bar(180_000, 15, 15, 15, 15));

    expect(engine.getPosition()).toMatchObject({ side: 'short', contracts: 50, entryPrice: 15, episodeId: 2 });
    const res = engine.getResult();
    expect(res.episodes).toHaveLength(2);
    expect(res.episodes[0]).toMatchObject({ id: 1, closedAt: 180_000, grossPnl: 800, netPnl: 800 });
    expect(res.verification.valid).toBe(true);
  });

  it('picks conservative worst-case intrabar path and flags ambiguous=true when SL and TP both cross in one bar', () => {
    const engine = new PerpetualExecutionEngine({
      initialBalance: 10_000,
      marginMode: 'isolated',
      leverage: 5,
      ctVal: 1,
      feeBps: 5,
    });

    engine.initialize(bar(0, 100, 100, 100, 100));
    engine.placeOrder({
      side: 'long',
      type: 'market',
      contracts: 10,
      stopLoss: 95,
      takeProfit: 108,
    });
    engine.step(bar(60_000, 100, 101, 99, 100));
    expect(engine.getPosition()?.contracts).toBe(10);

    // Next bar spans [94, 110]: [O,H,L,C] hits TP (108), while [O,L,H,C] hits SL (95).
    // Engine MUST choose worst-case (SL at 95) and mark fill + episode ambiguous=true!
    engine.step(bar(120_000, 100, 110, 94, 102));

    expect(engine.getPosition()).toBeNull();
    const res = engine.getResult();
    const exitFill = res.fills.at(-1)!;
    expect(exitFill.reason).toBe('stopLoss');
    expect(exitFill.price).toBe(95);
    expect(exitFill.ambiguous).toBe(true);
    expect(res.episodes[0].ambiguous).toBe(true);
    expect(res.verification.valid).toBe(true);
  });

  it('applies funding rates, isolated limited-liability deficit credit on gap crash, and passes ledger verification', () => {
    const tFunding = 120_000;
    const engine = new PerpetualExecutionEngine({
      initialBalance: 1_000,
      marginMode: 'isolated',
      leverage: 10,
      ctVal: 1,
      feeBps: 10,
      fundingRates: { [tFunding]: 0.001 }, // +0.1% funding (longs pay)
    });

    engine.initialize(bar(0, 100, 100, 100, 100));
    // 5 contracts @ 100 = 500 notional, 50 isolated margin
    engine.placeOrder({ side: 'long', type: 'market', contracts: 5 });
    engine.step(bar(60_000, 100, 100, 100, 100));

    // Step through funding bar at mark=100 -> long pays 5 * 100 * 0.001 = 0.5 USDT
    engine.step(bar(tFunding, 100, 100, 100, 100));
    expect(engine.getResult().fundingPayments).toHaveLength(1);
    expect(engine.getResult().fundingPayments[0].amount).toBe(-0.5);

    // Severe gap down open at 50 (below liquidation price ~90.45):
    // gross loss would exceed 50 isolated margin if filled at 50; liquidation fills at liqPrice,
    // and if closed via gap stop/close below bankruptcy, isolatedDeficitCredit caps loss!
    engine.closePosition(50, 180_000, 'gap-crash');
    const res = engine.getResult();
    const crashFill = res.fills.at(-1)!;
    expect(crashFill.isolatedDeficitCredit).toBeGreaterThan(0);
    // Account balance never drops below initialBalance - openFee - funding - initialMargin (1000 - 0.5 - 0.5 - 50 = 949)
    expect(res.finalBalance).toBeCloseTo(949, 6);
    expect(verifyPerpetualLedger(res).valid).toBe(true);
  });

  it('guarantees 100% bar-for-bar parity between runPerpetualBacktest and PerpetualReplaySession (including initial bar)', () => {
    const series: OHLCBar[] = [
      bar(0, 100, 102, 99, 101),
      bar(60_000, 101, 105, 100, 104),
      bar(120_000, 104, 106, 98, 99),
      bar(180_000, 99, 103, 97, 102),
      bar(240_000, 102, 108, 101, 107),
    ];

    const makeStrategy = () => {
      const closes: number[] = [];
      return (ctx: Parameters<Parameters<typeof runPerpetualBacktest>[1]>[0]) => {
        // Must receive bars[0] (`index === 0`) on BOTH Backtest and Replay!
        closes.push(ctx.bar.close);
        if (closes.length === 2 && !ctx.position) {
          ctx.placeOrder({ side: 'long', type: 'market', contracts: 2, stopLoss: 96, takeProfit: 106 });
        }
      };
    };

    const opts = { initialBalance: 5_000, marginMode: 'isolated' as const, leverage: 5, feeBps: 5 };
    const batch = runPerpetualBacktest(series, makeStrategy(), opts);

    const replay = new PerpetualReplaySession(series, opts, makeStrategy());
    replay.stepMany(series.length);
    const stepped = replay.engine.getResult();

    expect(stepped.finalBalance).toBe(batch.finalBalance);
    expect(stepped.finalEquity).toBe(batch.finalEquity);
    expect(stepped.fills).toEqual(batch.fills);
    expect(stepped.equityCurve).toEqual(batch.equityCurve);
    expect(stepped.verification.valid).toBe(true);
  });
});
