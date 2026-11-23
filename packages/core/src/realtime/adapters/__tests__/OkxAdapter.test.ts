import { describe, it, expect, vi } from 'vitest';
import {
  OkxAdapter,
  fetchOkxCandles,
  okxBarInterval,
  okxWsChannel,
  parseOkxWsMessage,
  parseOkxRestCandles,
} from '../OkxAdapter.js';
import { StreamManager } from '../../StreamManager.js';
import type { WebSocketLike } from '../WebSocketAdapter.js';

class MockWs implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.({});
  }

  push(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('OkxAdapter', () => {
  it('maps Spot and SWAP intervals to OKX V5 bar and candle channel tokens', () => {
    expect(okxBarInterval('1m')).toBe('1m');
    expect(okxBarInterval('4h')).toBe('4H');
    expect(okxBarInterval('1d')).toBe('1Dutc');
    expect(okxWsChannel('1m')).toBe('candle1m');
    expect(okxWsChannel('1h')).toBe('candle1H');
    expect(okxWsChannel('1w')).toBe('candle1Wutc');
  });

  it('parses OKX descending kline tuples into ascending OHLCBars with selectable volume column', () => {
    const body = {
      code: '0',
      data: [
        ['1700000120000', '36100', '36200', '36050', '36180', '250', '2.5', '90450', '0'],
        ['1700000060000', '36000', '36150', '35980', '36100', '400', '4.0', '144400', '1'],
      ],
    };
    const contracts = parseOkxRestCandles(body, 'contracts');
    expect(contracts).toEqual([
      { time: 1700000060000, open: 36000, high: 36150, low: 35980, close: 36100, volume: 400 },
      { time: 1700000120000, open: 36100, high: 36200, low: 36050, close: 36180, volume: 250 },
    ]);
    const base = parseOkxRestCandles(body, 'base');
    expect(base[0].volume).toBe(4);
  });

  it('pages >300 candles in chunks and falls back from /market/candles to /market/history-candles', async () => {
    const t0 = 1_700_000_000_000;
    const calls: string[] = [];

    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/market/candles') && !url.includes('after=')) {
        // First recent page: 300 bars ending at t0 + 499 * 60_000
        const rows = Array.from({ length: 300 }, (_, idx) => {
          const time = t0 + (499 - idx) * 60_000;
          return [String(time), '100', '101', '99', '100', '10', '0.1', '10', '1'];
        });
        return new Response(JSON.stringify({ code: '0', data: rows }), { status: 200 });
      }
      if (url.includes('/market/candles') && url.includes('after=')) {
        // Simulate end of recent /market/candles window -> returns empty so fallback triggers
        return new Response(JSON.stringify({ code: '0', data: [] }), { status: 200 });
      }
      if (url.includes('/market/history-candles')) {
        // Archive serves remaining 200 older bars
        const rows = Array.from({ length: 200 }, (_, idx) => {
          const time = t0 + (199 - idx) * 60_000;
          return [String(time), '95', '96', '94', '95', '5', '0.05', '5', '1'];
        });
        return new Response(JSON.stringify({ code: '0', data: rows }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const bars = await fetchOkxCandles({
      restBase: 'https://www.okx.com',
      symbol: 'BTC-USDT-SWAP',
      timeframe: '1m',
      limit: 500,
      fetchFn,
      nowMs: t0 + 500 * 60_000,
    });

    expect(bars).toHaveLength(500);
    expect(bars[0].time).toBe(t0);
    expect(bars[499].time).toBe(t0 + 499 * 60_000);
    expect(calls.some((u) => u.includes('/api/v5/market/candles'))).toBe(true);
    expect(calls.some((u) => u.includes('/api/v5/market/history-candles'))).toBe(true);
  });

  it('routes late confirm="1" frame as barCorrection after T+1m confirm="0" arrives first, updating previousClose', async () => {
    const sockets: MockWs[] = [];
    const t0 = Date.UTC(2026, 10, 1, 12, 0, 0);
    const fetchFn = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: '0',
          data: [[String(t0 - 60_000), '100', '101', '99', '100', '10', '1', '100', '1']],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;

    const adapter = new OkxAdapter({
      fetchFn,
      socketFactory: (url) => {
        const ws = new MockWs(url);
        sockets.push(ws);
        return ws;
      },
    });

    const stream = new StreamManager();
    const closedBars: number[] = [];
    const corrections: { time: number; close: number }[] = [];
    const priceChanges: { price: number; previousClose: number | null }[] = [];

    stream.on('barClose', (b) => closedBars.push(b.close));
    stream.on('barCorrection', (b) => corrections.push({ time: b.time, close: b.close }));
    stream.on('priceChange', (p) => priceChanges.push(p));

    await stream.connect({ adapter, symbol: 'BTC-USDT-SWAP', timeframe: '1m', historyLimit: 1 });
    const ws = sockets[0];
    ws.open();

    // 1. Forming bar for 12:00 (confirm = "0", close = 102)
    ws.push({
      arg: { channel: 'candle1m', instId: 'BTC-USDT-SWAP' },
      data: [[String(t0), '100', '103', '99', '102', '12', '1.2', '120', '0']],
    });

    // 2. First frame of 12:01 arrives BEFORE 12:00 confirm="1" (race at minute boundary!)
    ws.push({
      arg: { channel: 'candle1m', instId: 'BTC-USDT-SWAP' },
      data: [[String(t0 + 60_000), '102', '104', '102', '104', '2', '0.2', '20', '0']],
    });

    // 12:00 rolled over provisionally without fabricating a fake barClose, advancing previousClose to 102
    expect(closedBars).toEqual([]);
    expect(priceChanges.at(-1)).toEqual({ price: 104, previousClose: 102 });

    // 3. 30ms later, OKX delivers the true final confirm="1" for 12:00 with close = 103.5!
    ws.push({
      arg: { channel: 'candle1m', instId: 'BTC-USDT-SWAP' },
      data: [[String(t0), '100', '103.5', '99', '103.5', '15', '1.5', '150', '1']],
    });

    expect(corrections).toEqual([{ time: t0, close: 103.5 }]);

    // 4. Next tick on 12:01 measures priceChange against the corrected 12:00 close (103.5)!
    ws.push({
      arg: { channel: 'candle1m', instId: 'BTC-USDT-SWAP' },
      data: [[String(t0 + 60_000), '102', '105', '102', '105', '4', '0.4', '40', '0']],
    });
    expect(priceChanges.at(-1)).toEqual({ price: 105, previousClose: 103.5 });

    stream.dispose();
    adapter.dispose();
  });

  it('isolates per-symbol errors in subscribeQuotes and resolves SWAP instruments', async () => {
    const sockets: MockWs[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/public/instruments')) {
        return new Response(
          JSON.stringify({
            code: '0',
            data: [
              {
                instId: 'BTC-USDT-SWAP',
                instType: 'SWAP',
                state: 'live',
                ctVal: '0.01',
                settleCcy: 'USDT',
                tickSz: '0.1',
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          code: '0',
          data: [
            { instId: 'BTC-USDT-SWAP', last: '65000', open24h: '64000', high24h: '65500', low24h: '63800', vol24h: '12000' },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const adapter = new OkxAdapter({
      fetchFn,
      socketFactory: (url) => {
        const ws = new MockWs(url);
        sockets.push(ws);
        return ws;
      },
    });

    const info = await adapter.resolveSymbol!('BTC-USDT-SWAP');
    expect(info).toMatchObject({
      symbol: 'BTC-USDT-SWAP',
      exchange: 'OKX',
      type: 'futures',
      minTick: 0.1,
      pricePrecision: 1,
    });

    const received: unknown[] = [];
    const stop = adapter.subscribeQuotes(['BTC-USDT-SWAP', 'BAD-SYMBOL-SWAP'], (q) => received.push(...q));
    const ws = sockets[0];
    ws.open();

    // OKX sends an error frame for BAD-SYMBOL-SWAP — healthy BTC-USDT-SWAP must keep streaming
    ws.push({ event: 'error', code: '60018', msg: 'Instrument does not exist' });
    ws.push({
      arg: { channel: 'tickers', instId: 'BTC-USDT-SWAP' },
      data: [{ instId: 'BTC-USDT-SWAP', last: '65200', open24h: '64000', high24h: '65500', low24h: '63800', vol24h: '12500' }],
    });

    expect(ws.closed).toBe(false);
    expect(received.some((q) => (q as { last: number }).last === 65200)).toBe(true);
    expect(parseOkxWsMessage({ event: 'error', msg: 'bad' })).toBeNull();
    stop();
  });
});
