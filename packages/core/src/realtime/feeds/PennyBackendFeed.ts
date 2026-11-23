import type {
  BarsRequest,
  BarsSubscription,
  DataFeed,
  FeedSubscriber,
  OHLCBar,
  Quote,
  SymbolInfo,
  TimeFrame,
} from '@1penny/commons';
import { timeframeBucketStart, timeframeToMs } from '@1penny/commons';
import type { WebSocketFactory, WebSocketLike } from '../adapters/WebSocketAdapter.js';
import { isObject, toFiniteNumber } from '../adapters/parseUtils.js';

export interface PennyBackendFeedOptions {
  /** HTTP base URL for `/api/candles` and `/api/tickers` (default `''` = same origin). */
  httpBase?: string;
  /** WebSocket URL for `/ws/market` (derived from `httpBase` or `location` when omitted). */
  wsUrl?: string;
  /** Candles endpoint path, default `'/api/candles'`. */
  candlesPath?: string;
  /** Tickers endpoint path, default `'/api/tickers'`. */
  tickersPath?: string;
  /** Poll interval in ms for UTC-day ticker baselines, default `15_000` (`0` disables polling). */
  tickerPollMs?: number;
  /** Optional known symbol catalog for `resolveSymbol` / `searchSymbols`. */
  symbols?: readonly SymbolInfo[];
  /** Time zone used for HTF bucket alignment (default `'UTC'`). */
  timeZone?: string;
  /** Optional WebSocket factory for tests or custom transports. */
  socketFactory?: WebSocketFactory;
  /** Optional `fetch` implementation for tests or custom auth headers. */
  fetchFn?: typeof fetch;
}

interface ActiveSub {
  symbol: string;
  timeframe: TimeFrame;
  subscriber: FeedSubscriber;
  /** Current HTF bucket bar maintained from incoming M1 frames. */
  htfBar: OHLCBar | null;
  /** Accumulated intra-minute M1 volume already folded into `htfBar` for `currentM1Time`. */
  lastM1Time: number | null;
  lastM1Volume: number;
}

interface TickerBaseline {
  open24h: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  lastPrice: number;
  /** Monotonic sequence or timestamp of latest WS update so stale HTTP polls never overwrite live price. */
  liveUpdatedAt: number;
}

/**
 * `DataFeed` tailored for a centralized market-data backend (`/api/candles`,
 * `/api/tickers`, and `/ws/market` pushing M1 live/confirmed candles):
 *
 * - Multiplexes any number of chart subscriptions over one shared WebSocket.
 * - Aggregates M1 live frames into higher timeframes (`5m`, `15m`, `1h`, `4h`,
 *   `1d`, `1w`) using exact per-minute delta volume, resetting `lastM1Volume`
 *   cleanly whenever `getBars` reloads history so intra-minute volume never drifts.
 * - Routes late `confirmed: true` frames of a just-closed M1 candle without
 *   dropping final OHLCV or triggering false reconnect storms.
 * - Merges periodic `/api/tickers` baselines with live WS prices without stale
 *   HTTP responses overwriting newer live ticks.
 */
export class PennyBackendFeed implements DataFeed {
  readonly name = '1penny-backend';
  readonly pagesBack = true;

  private readonly httpBase: string;
  private readonly wsUrlOption?: string;
  private readonly candlesPath: string;
  private readonly tickersPath: string;
  private readonly tickerPollMs: number;
  private readonly symbols: readonly SymbolInfo[];
  private readonly timeZone: string;
  private readonly socketFactory?: WebSocketFactory;
  private readonly fetchImpl: typeof fetch;

  private ws: WebSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly subs = new Set<ActiveSub>();
  /** Latest history bar loaded by `(symbol|timeframe)` so `subscribeBars` seeds HTF state without volume drift. */
  private readonly latestLoadedBar = new Map<string, OHLCBar>();

  private readonly quoteListeners = new Set<{ symbols: Set<string>; cb: (quotes: Quote[]) => void }>();
  private readonly tickerState = new Map<string, TickerBaseline>();
  private tickerPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PennyBackendFeedOptions = {}) {
    this.httpBase = (options.httpBase ?? '').replace(/\/+$/, '');
    this.wsUrlOption = options.wsUrl;
    this.candlesPath = options.candlesPath ?? '/api/candles';
    this.tickersPath = options.tickersPath ?? '/api/tickers';
    this.tickerPollMs = options.tickerPollMs ?? 15_000;
    this.symbols = options.symbols ?? [];
    this.timeZone = options.timeZone ?? 'UTC';
    this.socketFactory = options.socketFactory;
    this.fetchImpl = options.fetchFn ?? fetch;
  }

  async getBars(request: BarsRequest): Promise<OHLCBar[]> {
    const { symbol, timeframe, countBack, before, signal } = request;
    const params = new URLSearchParams({
      symbol,
      tf: timeframe,
      limit: String(Math.max(1, Math.floor(countBack))),
    });
    if (before !== undefined) {
      params.set('before', String(Math.floor(before)));
    }
    const url = `${this.httpBase}${this.candlesPath}?${params.toString()}`;
    const res = await this.fetchImpl(url, { signal });
    if (!res.ok) {
      throw new Error(`Backend candles HTTP ${res.status}`);
    }
    const payload: unknown = await res.json();
    const bars = parseBackendBars(payload);

    // Seed/reset intra-minute delta tracking on initial load (`before === undefined`)
    if (before === undefined && bars.length > 0) {
      const newest = { ...bars[bars.length - 1] };
      const key = `${symbol}|${timeframe}`;
      this.latestLoadedBar.set(key, newest);
      for (const sub of this.subs) {
        if (sub.symbol === symbol && sub.timeframe === timeframe) {
          sub.htfBar = { ...newest };
          sub.lastM1Time = null;
          sub.lastM1Volume = 0;
        }
      }
    }
    return bars;
  }

  subscribeBars(request: BarsSubscription, subscriber: FeedSubscriber): () => void {
    const seeded = this.latestLoadedBar.get(`${request.symbol}|${request.timeframe}`);
    const entry: ActiveSub = {
      symbol: request.symbol,
      timeframe: request.timeframe,
      subscriber,
      htfBar: seeded ? { ...seeded } : null,
      lastM1Time: null,
      lastM1Volume: 0,
    };
    this.subs.add(entry);
    this.ensureSocket();

    return () => {
      this.subs.delete(entry);
      this.maybeCloseSocket();
    };
  }

  async resolveSymbol(symbol: string): Promise<SymbolInfo | null> {
    const found = this.symbols.find((s) => s.symbol === symbol);
    if (found) return found;
    return {
      symbol,
      description: symbol,
      exchange: '1Penny',
      type: symbol.endsWith('-SWAP') ? 'futures' : 'crypto',
      timeZone: this.timeZone,
    };
  }

  subscribeQuotes(symbols: readonly string[], onQuotes: (quotes: Quote[]) => void): () => void {
    const wanted = new Set(symbols.map((s) => s.trim()).filter(Boolean));
    if (wanted.size === 0) return () => {};

    const listener = { symbols: wanted, cb: onQuotes };
    this.quoteListeners.add(listener);
    this.ensureSocket();
    void this.pollTickers();
    if (this.tickerPollMs > 0 && !this.tickerPollTimer) {
      this.tickerPollTimer = setInterval(() => {
        void this.pollTickers();
      }, this.tickerPollMs);
    }

    return () => {
      this.quoteListeners.delete(listener);
      if (this.quoteListeners.size === 0 && this.tickerPollTimer) {
        clearInterval(this.tickerPollTimer);
        this.tickerPollTimer = null;
      }
      this.maybeCloseSocket();
    };
  }

  dispose(): void {
    this.subs.clear();
    this.quoteListeners.clear();
    if (this.tickerPollTimer) {
      clearInterval(this.tickerPollTimer);
      this.tickerPollTimer = null;
    }
    this.closeSocket();
  }

  private resolveWsUrl(): string {
    if (this.wsUrlOption) return this.wsUrlOption;
    if (this.httpBase.startsWith('https://')) return `${this.httpBase.replace(/^https:/, 'wss:')}/ws/market`;
    if (this.httpBase.startsWith('http://')) return `${this.httpBase.replace(/^http:/, 'ws:')}/ws/market`;
    if (typeof location !== 'undefined') {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}/ws/market`;
    }
    return 'ws://localhost:8000/ws/market';
  }

  private ensureSocket(): void {
    if (this.ws || this.reconnectTimer) return;
    if (this.subs.size === 0 && this.quoteListeners.size === 0) return;

    let socket: WebSocketLike;
    try {
      const url = this.resolveWsUrl();
      if (this.socketFactory) {
        socket = this.socketFactory(url);
      } else {
        const Ctor = (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
        if (!Ctor) throw new Error('No WebSocket implementation available');
        socket = new Ctor(url);
      }
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws = socket;
    socket.onopen = () => {
      this.reconnectAttempts = 0;
      for (const sub of this.subs) {
        sub.subscriber.connection('connected');
      }
    };
    socket.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.handleSocketMessage(msg);
    };
    socket.onerror = () => {
      // Handled uniformly by onclose reconnect
    };
    socket.onclose = () => {
      this.ws = null;
      for (const sub of this.subs) {
        sub.subscriber.connection('disconnected');
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || (this.subs.size === 0 && this.quoteListeners.size === 0)) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureSocket();
    }, delay);
  }

  private maybeCloseSocket(): void {
    if (this.subs.size === 0 && this.quoteListeners.size === 0) {
      this.closeSocket();
    }
  }

  private closeSocket(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      const sock = this.ws;
      sock.onopen = null;
      sock.onmessage = null;
      sock.onerror = null;
      sock.onclose = null;
      sock.close();
      this.ws = null;
    }
  }

  private handleSocketMessage(msg: unknown): void {
    if (!isObject(msg)) return;
    const type = msg.type;

    if (type === 'snapshot' && isObject(msg.candles)) {
      for (const [symbol, rawCandle] of Object.entries(msg.candles)) {
        const parsed = parseLiveM1Candle(rawCandle);
        if (parsed) this.dispatchM1Candle(symbol, parsed.bar, parsed.confirmed);
      }
      return;
    }

    if (type === 'candle' && typeof msg.symbol === 'string') {
      const parsed = parseLiveM1Candle(msg.candle);
      if (parsed) this.dispatchM1Candle(msg.symbol, parsed.bar, parsed.confirmed);
      return;
    }

    // Do NOT propagate transient `connected: false` status blips during server catch-up as
    // hard disconnects (prevents global resetData / thundering herd across open charts).
    if (type === 'connection' && msg.connected === true) {
      for (const sub of this.subs) {
        sub.subscriber.connection('connected');
      }
    }
  }

  private dispatchM1Candle(symbol: string, m1: OHLCBar, confirmed: boolean): void {
    // 1. Update live quote listeners immediately without waiting for HTTP poll
    this.applyLivePriceToQuotes(symbol, m1.close);

    // 2. Deliver to matching chart subscriptions (1m direct or HTF delta-folded)
    for (const sub of this.subs) {
      if (sub.symbol !== symbol) continue;
      const tfMs = timeframeToMs(sub.timeframe);
      if (!Number.isFinite(tfMs) || tfMs <= 60_000) {
        sub.subscriber.bar({ ...m1 }, confirmed);
        continue;
      }
      this.foldIntoHtf(sub, m1, confirmed, tfMs);
    }
  }

  private foldIntoHtf(sub: ActiveSub, m1: OHLCBar, confirmed: boolean, tfMs: number): void {
    const bucketTime = timeframeBucketStart(m1.time, sub.timeframe, { timeZone: this.timeZone });
    const current = sub.htfBar;

    if (!current || bucketTime > current.time) {
      // A new HTF bucket opened: finalize previous HTF bar if present
      if (current && bucketTime > current.time) {
        sub.subscriber.bar({ ...current }, true);
      }
      const next: OHLCBar = {
        time: bucketTime,
        open: m1.open,
        high: m1.high,
        low: m1.low,
        close: m1.close,
        volume: m1.volume,
      };
      sub.htfBar = next;
      sub.lastM1Time = m1.time;
      sub.lastM1Volume = m1.volume;
      const isLastMinuteOfBucket = confirmed && m1.time + 60_000 >= bucketTime + tfMs;
      sub.subscriber.bar({ ...next }, isLastMinuteOfBucket);
      return;
    }

    if (bucketTime < current.time) {
      // Late M1 confirmation belonging to the previous HTF bucket: ignore stale forming,
      // or let next history sync reconcile without corrupting current HTF bucket.
      return;
    }

    // Same HTF bucket: compute exact intra-minute delta volume
    const prevVol = sub.lastM1Time === m1.time ? sub.lastM1Volume : 0;
    const deltaVol = Math.max(0, m1.volume - prevVol);
    const updated: OHLCBar = {
      time: current.time,
      open: current.open,
      high: Math.max(current.high, m1.high),
      low: Math.min(current.low, m1.low),
      close: m1.close,
      volume: current.volume + deltaVol,
    };
    sub.htfBar = updated;
    sub.lastM1Time = m1.time;
    sub.lastM1Volume = m1.volume;

    const isLastMinuteOfBucket = confirmed && m1.time + 60_000 >= bucketTime + tfMs;
    sub.subscriber.bar({ ...updated }, isLastMinuteOfBucket);
  }

  private async pollTickers(): Promise<void> {
    if (this.quoteListeners.size === 0) return;
    const pollStartedAt = Date.now();
    try {
      const res = await this.fetchImpl(`${this.httpBase}${this.tickersPath}`);
      if (!res.ok) return;
      const body: unknown = await res.json();
      const rows = Array.isArray(body) ? body : isObject(body) && Array.isArray(body.tickers) ? body.tickers : [];
      const changed = new Map<string, Quote>();

      for (const raw of rows) {
        if (!isObject(raw) || typeof raw.symbol !== 'string') continue;
        const price = toFiniteNumber(raw.last ?? raw.price);
        if (price === null) continue;
        const open24h = toFiniteNumber(raw.open24h ?? raw.open);
        const high24h = toFiniteNumber(raw.high24h ?? raw.high);
        const low24h = toFiniteNumber(raw.low24h ?? raw.low);
        const volume24h = toFiniteNumber(raw.volume24h ?? raw.volume);

        const prev = this.tickerState.get(raw.symbol);
        // Never overwrite a newer WS live price with an HTTP response that started earlier!
        const effectivePrice = prev && prev.liveUpdatedAt >= pollStartedAt ? prev.lastPrice : price;
        const state: TickerBaseline = {
          open24h,
          high24h: high24h !== null ? Math.max(high24h, effectivePrice) : null,
          low24h: low24h !== null ? Math.min(low24h, effectivePrice) : null,
          volume24h,
          lastPrice: effectivePrice,
          liveUpdatedAt: prev?.liveUpdatedAt ?? 0,
        };
        this.tickerState.set(raw.symbol, state);
        changed.set(raw.symbol, buildQuote(raw.symbol, state));
      }

      if (changed.size > 0) this.notifyQuoteListeners(changed);
    } catch {
      // Next poll or WS tick continues seamlessly
    }
  }

  private applyLivePriceToQuotes(symbol: string, price: number): void {
    if (this.quoteListeners.size === 0) return;
    const prev = this.tickerState.get(symbol);
    const state: TickerBaseline = {
      open24h: prev?.open24h ?? null,
      high24h: prev?.high24h !== null && prev?.high24h !== undefined ? Math.max(prev.high24h, price) : null,
      low24h: prev?.low24h !== null && prev?.low24h !== undefined ? Math.min(prev.low24h, price) : null,
      volume24h: prev?.volume24h ?? null,
      lastPrice: price,
      liveUpdatedAt: Date.now(),
    };
    this.tickerState.set(symbol, state);
    this.notifyQuoteListeners(new Map([[symbol, buildQuote(symbol, state)]]));
  }

  private notifyQuoteListeners(updates: Map<string, Quote>): void {
    for (const listener of this.quoteListeners) {
      const batch: Quote[] = [];
      for (const [sym, q] of updates) {
        if (listener.symbols.has(sym)) batch.push(q);
      }
      if (batch.length > 0) listener.cb(batch);
    }
  }
}

export function createPennyBackendFeed(options: PennyBackendFeedOptions = {}): PennyBackendFeed {
  return new PennyBackendFeed(options);
}

function buildQuote(symbol: string, state: TickerBaseline): Quote {
  const change = state.open24h !== null ? state.lastPrice - state.open24h : undefined;
  const changePercent =
    state.open24h !== null && state.open24h > 0 ? ((state.lastPrice - state.open24h) / state.open24h) * 100 : undefined;
  return {
    symbol,
    last: state.lastPrice,
    ...(state.open24h !== null ? { open: state.open24h } : {}),
    ...(change !== undefined ? { change } : {}),
    ...(changePercent !== undefined ? { changePercent } : {}),
    ...(state.high24h !== null ? { high: state.high24h } : {}),
    ...(state.low24h !== null ? { low: state.low24h } : {}),
    ...(state.volume24h !== null ? { volume: state.volume24h } : {}),
  };
}

function parseBackendBars(payload: unknown): OHLCBar[] {
  const list = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.candles)
      ? payload.candles
      : isObject(payload) && Array.isArray(payload.bars)
        ? payload.bars
        : [];
  const out: OHLCBar[] = [];
  for (const item of list) {
    const parsed = parseBarObject(item);
    if (parsed) out.push(parsed);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function parseBarObject(raw: unknown): OHLCBar | null {
  if (!isObject(raw)) return null;
  const time = toFiniteNumber(raw.time);
  const open = toFiniteNumber(raw.open);
  const high = toFiniteNumber(raw.high);
  const low = toFiniteNumber(raw.low);
  const close = toFiniteNumber(raw.close);
  const volume = toFiniteNumber(raw.volume ?? 0);
  if (
    time === null ||
    open === null ||
    high === null ||
    low === null ||
    close === null ||
    volume === null
  ) {
    return null;
  }
  return { time, open, high, low, close, volume };
}

function parseLiveM1Candle(raw: unknown): { bar: OHLCBar; confirmed: boolean } | null {
  const bar = parseBarObject(raw);
  if (!bar || !isObject(raw)) return null;
  const confirmed = Boolean(raw.confirmed ?? raw.closed);
  return { bar, confirmed };
}
