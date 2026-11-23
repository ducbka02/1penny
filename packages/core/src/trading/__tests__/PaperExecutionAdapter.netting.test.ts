import { describe, it, expect } from 'vitest';
import type { FillEvent } from '@1penny/commons';
import { PaperExecutionAdapter } from '../PaperExecutionAdapter.js';

describe('PaperExecutionAdapter (netting & worst-case stepBar)', () => {
  it('nets same-side additions, reduces partially, and flips cleanly in netting mode', async () => {
    const adapter = new PaperExecutionAdapter({ markPrice: 100, mode: 'netting', feeBps: 0 });
    adapter.connect({});
    const fills: FillEvent[] = [];
    adapter.on<FillEvent>('fill', (e) => fills.push(e.data));

    await adapter.placeOrder({ side: 'buy', type: 'market', price: 100, quantity: 2 });
    adapter.setMarkPrice(110, 1000);
    await adapter.placeOrder({ side: 'buy', type: 'market', price: 110, quantity: 2 });

    expect(adapter.getPositions()).toHaveLength(1);
    expect(adapter.getPositions()[0]).toMatchObject({ side: 'buy', quantity: 4, entryPrice: 105 });

    // Partial close of 1 unit @ 125 -> +20 realized PnL, 3 units remain
    adapter.setMarkPrice(125, 2000);
    await adapter.placeOrder({ side: 'sell', type: 'market', price: 125, quantity: 1 });
    expect(adapter.getPositions()[0]).toMatchObject({ side: 'buy', quantity: 3, entryPrice: 105 });
    expect(fills.at(-1)?.pnl).toBe(20);

    // Flip with sell 5 @ 125 -> closes remaining 3 (+60 PnL) and opens short 2 @ 125
    await adapter.placeOrder({ side: 'sell', type: 'market', price: 125, quantity: 5 });
    expect(adapter.getPositions()).toHaveLength(1);
    expect(adapter.getPositions()[0]).toMatchObject({ side: 'sell', quantity: 2, entryPrice: 125 });
  });

  it('resolves intrabar SL/TP collisions conservatively via stepBar()', async () => {
    const adapter = new PaperExecutionAdapter({ markPrice: 100, mode: 'netting' });
    adapter.connect({});
    const fills: FillEvent[] = [];
    adapter.on<FillEvent>('fill', (e) => fills.push(e.data));

    await adapter.placeOrder({
      side: 'buy',
      type: 'market',
      price: 100,
      quantity: 1,
      stopLoss: 95,
      takeProfit: 110,
    });

    // Bar spans both 95 and 110 -> conservative stepBar visits low (95) before high (110) for net long
    adapter.stepBar({ time: 60_000, open: 100, high: 112, low: 94, close: 105, volume: 50 });

    expect(adapter.getPositions()).toHaveLength(0);
    expect(fills.at(-1)).toMatchObject({ reason: 'stopLoss', price: 95, pnl: -5, time: 60_000 });
  });
});
