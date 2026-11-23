import { describe, it, expect, vi } from 'vitest';
import { PennyBackendFeed } from '../PennyBackendFeed.js';
import type { WebSocketLike } from '../../adapters/WebSocketAdapter.js';
import type { FeedSubscriber, OHLCBar, Quote } from '@1penny/commons';

class MockWs implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}
  send(): void {}
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.onopen?.({});
  }
  push(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

function makeSubscriber() {
  const bars: { bar: OHLCBar; closed: boolean }[] = [];
  const states: string[] = [];
  const sub: FeedSubscriber = {
    bar: (bar, closed) => bars.push({ bar: { ...bar }, closed }),
    tick: () => {},
    connection: (s) => states.push(s),
    symbolInfo: () => {},
    error: () => {},
  };
  return { sub, bars, states };
}

describe('PennyBackendFeed', () => {
  it('multiplexes M1 and HTF (1h) subscriptions over one WS and preserves exact intra-minute delta volume across getBars reloads', async () => {
    const sockets: MockWs[] = [];
    const h1Start = Date.UTC(2026, 10, 1, 12, 0, 0);
    const m1At20 = h1Start + 20 * 60_000;

    let initVolume = 1000;
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('tf=1h')) {
        return new Response(
          JSON.stringify([
            { time: h1Start, open: 60000, high: 60500, low: 59900, close: 60200, volume: initVolume },
          ]),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify([
          { time: m1At20, open: 60200, high: 60250, low: 60180, close: 60210, volume: 10 },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const feed = new PennyBackendFeed({
      httpBase: 'https://api.example.com',
      tickerPollMs: 0,
      fetchFn,
      socketFactory: (url) => {
        const ws = new MockWs(url);
        sockets.push(ws);
        return ws;
      },
    });

    const controller = new AbortController();
    await feed.getBars({ symbol: 'BTC-USDT-SWAP', timeframe: '1h', countBack: 200, signal: controller.signal });
    await feed.getBars({ symbol: 'BTC-USDT-SWAP', timeframe: '1m', countBack: 200, signal: controller.signal });

    const h1 = makeSubscriber();
    const m1 = makeSubscriber();
    const unsubH1 = feed.subscribeBars({ symbol: 'BTC-USDT-SWAP', timeframe: '1h' }, h1.sub);
    const unsubM1 = feed.subscribeBars({ symbol: 'BTC-USDT-SWAP', timeframe: '1m' }, m1.sub);

    // Only one shared WebSocket opened for both charts
    expect(sockets).toHaveLength(1);
    const ws = sockets[0];
    ws.open();

    // Intra-minute M1 ticks at minute 12:20: volume 10 -> 18
    ws.push({
      type: 'candle',
      symbol: 'BTC-USDT-SWAP',
      candle: { time: m1At20, open: 60200, high: 60300, low: 60180, close: 60290, volume: 10, confirmed: false },
    });
    ws.push({
      type: 'candle',
      symbol: 'BTC-USDT-SWAP',
      candle: { time: m1At20, open: 60200, high: 60600, low: 60180, close: 60550, volume: 18, confirmed: false },
    });

    // H1 volume added 10 then +8 (= 1018)
    expect(h1.bars.at(-1)?.bar).toMatchObject({ high: 60600, close: 60550, volume: 1018 });
    expect(m1.bars).toHaveLength(2);

    // Now simulate mid-minute getBars reload (which already includes the 18 M1 volume -> 1018):
    // lastM1Volume MUST reset so the next M1 tick (volume = 25, or fresh minute) never subtracts stale 18!
    initVolume = 1018;
    await feed.getBars({ symbol: 'BTC-USDT-SWAP', timeframe: '1h', countBack: 200, signal: controller.signal });

    // Next minute 12:21 starts with volume = 5
    ws.push({
      type: 'candle',
      symbol: 'BTC-USDT-SWAP',
      candle: { time: m1At20 + 60_000, open: 60550, high: 60580, low: 60500, close: 60520, volume: 5, confirmed: false },
    });
    expect(h1.bars.at(-1)?.bar.volume).toBe(1023);

    // Transient server catch-up status (`connected: false`) must NOT trigger a client disconnect storm
    ws.push({ type: 'connection', connected: false, message: 'Recovering missing candles' });
    expect(h1.states).toEqual(['connected']);

    unsubH1();
    unsubM1();
    expect(ws.closed).toBe(true);
  });

  it('prevents slow /api/tickers HTTP response from overwriting newer WebSocket live price', async () => {
    const sockets: MockWs[] = [];
    let resolveHttp!: (res: Response) => void;

    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveHttp = resolve;
        }),
    ) as unknown as typeof fetch;

    const feed = new PennyBackendFeed({
      tickerPollMs: 0,
      fetchFn,
      socketFactory: (url) => {
        const ws = new MockWs(url);
        sockets.push(ws);
        return ws;
      },
    });

    const quotes: Quote[] = [];
    const unsub = feed.subscribeQuotes(['BTC-USDT-SWAP'], (batch) => quotes.push(...batch));
    const ws = sockets[0];
    ws.open();

    // Live WS candle arrives at 66,000 WHILE the HTTP /api/tickers request is still in-flight!
    ws.push({
      type: 'candle',
      symbol: 'BTC-USDT-SWAP',
      candle: { time: 1_700_000_000_000, open: 65900, high: 66000, low: 65900, close: 66000, volume: 3, confirmed: false },
    });

    // Stale HTTP response finally resolves with older last=65,500 and open24h=64,000
    resolveHttp(
      new Response(
        JSON.stringify([{ symbol: 'BTC-USDT-SWAP', last: 65500, open24h: 64000, high24h: 65800, low24h: 63900, volume24h: 9000 }]),
        { status: 200 },
      ),
    );
    await new Promise((r) => setTimeout(r, 10));

    // Latest quote keeps live 66,000 price and computes 24h change against 64,000 (+2,000)!
    const latest = quotes.at(-1)!;
    expect(latest.last).toBe(66000);
    expect(latest.change).toBe(2000);
    expect(latest.high).toBe(66000);

    unsub();
  });
});
