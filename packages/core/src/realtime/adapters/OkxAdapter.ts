import type {
  OHLCBar,
  Quote,
  SymbolInfo,
  SymbolSearchOptions,
  TimeFrame,
} from '@1penny/commons';
import { rankSymbols, stepDecimals, timeframeToMs } from '@1penny/commons';
import { WebSocketAdapter, type WebSocketFactory, type WsParseResult } from './WebSocketAdapter.js';
import { isObject, toFiniteNumber } from './parseUtils.js';

export type OkxInstType = 'SPOT' | 'SWAP' | 'FUTURES';
export type OkxVolumeField = 'contracts' | 'base' | 'quote';

const REST_BAR_MAP: Partial<Record<TimeFrame, string>> = {
  '1s': '1s',
  '1m': '1m',
  '3m': '3m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1H',
  '2h': '2H',
  '4h': '4H',
  '6h': '6Hutc',
  '12h': '12Hutc',
  '1d': '1Dutc',
  '3d': '3Dutc',
  '1w': '1Wutc',
  '1M': '1Mutc',
};

const WS_CHANNEL_MAP: Partial<Record<TimeFrame, string>> = {
  '1s': 'candle1s',
  '1m': 'candle1m',
  '3m': 'candle3m',
  '5m': 'candle5m',
  '15m': 'candle15m',
  '30m': 'candle30m',
  '1h': 'candle1H',
  '2h': 'candle2H',
  '4h': 'candle4H',
  '6h': 'candle6Hutc',
  '12h': 'candle12Hutc',
  '1d': 'candle1Dutc',
  '3d': 'candle3Dutc',
  '1w': 'candle1Wutc',
  '1M': 'candle1Mutc',
};

/** Maximum klines OKX V5 returns in a single REST call. */
export const OKX_MAX_CANDLES = 300;
/** Recent window (in bars) reliably served by `/api/v5/market/candles` before switching to `/history-candles`. */
const RECENT_WINDOW_BARS = 1400;
/** Maximum multi-page hops for one `fetchHistory` / `fetchHistoryBefore` call. */
const MAX_PAGE_HOPS = 10;

export function okxBarInterval(timeframe: TimeFrame): string {
  return REST_BAR_MAP[timeframe] ?? '1m';
}

export function okxWsChannel(timeframe: TimeFrame): string {
  return WS_CHANNEL_MAP[timeframe] ?? 'candle1m';
}

export interface OkxAdapterOptions {
  /** REST base URL, default `https://www.okx.com`. */
  restBase?: string;
  /** Business WebSocket URL (for `candle*` streams), default `wss://ws.okx.com:8443/ws/v5/business`. */
  wsBusinessBase?: string;
  /** Public WebSocket URL (for `tickers` streams), default `wss://ws.okx.com:8443/ws/v5/public`. */
  wsPublicBase?: string;
  /** Instrument families to include in symbol search / quotes, default `['SWAP', 'SPOT']`. */
  instTypes?: readonly OkxInstType[];
  /** Which volume column to read from OKX tuples (`[ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]`), default `'contracts'`. */
  volumeField?: OkxVolumeField;
  /** Optional custom WebSocket factory (for tests or proxies). */
  socketFactory?: WebSocketFactory;
  /** Optional custom `fetch` implementation (for tests or proxies). */
  fetchFn?: typeof fetch;
}

function volumeIndex(field: OkxVolumeField): number {
  if (field === 'base') return 6;
  if (field === 'quote') return 7;
  return 5;
}

function inferInstType(symbol: string): OkxInstType {
  const upper = symbol.toUpperCase();
  if (upper.endsWith('-SWAP')) return 'SWAP';
  if (/-\d{6}$/.test(upper)) return 'FUTURES';
  return 'SPOT';
}

/**
 * OKX V5 public adapter (Spot, Perpetual Swap, Futures — no API key required).
 *
 * Key guarantees:
 * - Smart routing between `/api/v5/market/candles` (low-latency recent window,
 *   includes just-closed bars immediately) and `/api/v5/market/history-candles`
 *   (deep archive when paging back).
 * - Multi-page batching when `limit > 300` (OKX caps single responses at 300).
 * - Preserves late `confirm="1"` frames when the first `confirm="0"` tick of
 *   minute `T+1m` arrives milliseconds earlier (routed as `barCorrection` via
 *   `NewestBar` + `TickAggregator`).
 * - Per-symbol error isolation on multi-symbol quote streams.
 */
export class OkxAdapter extends WebSocketAdapter {
  private readonly restBase: string;
  private readonly wsPublicBase: string;
  private readonly instTypes: readonly OkxInstType[];
  private readonly volField: OkxVolumeField;
  private readonly fetchImpl: typeof fetch;
  private readonly wsFactory?: WebSocketFactory;
  private instrumentsCache: Promise<SymbolInfo[]> | null = null;

  constructor(options: OkxAdapterOptions = {}) {
    const restBase = (options.restBase ?? 'https://www.okx.com').replace(/\/+$/, '');
    const wsBusinessBase = options.wsBusinessBase ?? 'wss://ws.okx.com:8443/ws/v5/business';
    const wsPublicBase = options.wsPublicBase ?? 'wss://ws.okx.com:8443/ws/v5/public';
    const instTypes = options.instTypes?.length ? options.instTypes : (['SWAP', 'SPOT'] as const);
    const volField = options.volumeField ?? 'contracts';
    const fetchImpl = options.fetchFn ?? fetch;

    super({
      name: 'okx',
      wsUrl: () => wsBusinessBase,
      supportedTimeframes: Object.keys(REST_BAR_MAP) as TimeFrame[],
      socketFactory: options.socketFactory,
      subscribeMessage: (c) => ({
        op: 'subscribe',
        args: [{ channel: okxWsChannel(c.timeframe), instId: c.symbol }],
      }),
      unsubscribeMessage: (c) => ({
        op: 'unsubscribe',
        args: [{ channel: okxWsChannel(c.timeframe), instId: c.symbol }],
      }),
      parseMessage: (raw, cfg) => parseOkxWsMessage(raw, cfg.symbol, volField),
      fetchHistory: (symbol, timeframe, limit) =>
        fetchOkxCandles({ restBase, symbol, timeframe, limit, volumeField: volField, fetchFn: fetchImpl }),
      fetchHistoryBefore: (symbol, timeframe, before, limit) =>
        fetchOkxCandles({ restBase, symbol, timeframe, limit, before, volumeField: volField, fetchFn: fetchImpl }),
      searchSymbols: (query, searchOpts) => this.searchOkxSymbols(query, searchOpts),
      resolveSymbol: (symbol) => this.resolveOkxSymbol(symbol),
    });

    this.restBase = restBase;
    this.wsPublicBase = wsPublicBase;
    this.instTypes = instTypes;
    this.volField = volField;
    this.fetchImpl = fetchImpl;
    this.wsFactory = options.socketFactory;
  }

  private async loadInstruments(): Promise<SymbolInfo[]> {
    if (!this.instrumentsCache) {
      this.instrumentsCache = (async () => {
        const results = await Promise.allSettled(
          this.instTypes.map(async (instType) => {
            const res = await this.fetchImpl(`${this.restBase}/api/v5/public/instruments?instType=${instType}`);
            if (!res.ok) throw new Error(`OKX instruments ${instType} HTTP ${res.status}`);
            const body: unknown = await res.json();
            return parseOkxInstruments(body);
          }),
        );
        const merged: SymbolInfo[] = [];
        let anySucceeded = false;
        for (const r of results) {
          if (r.status === 'fulfilled') {
            anySucceeded = true;
            merged.push(...r.value);
          }
        }
        if (!anySucceeded) throw new Error('Failed to load OKX instruments');
        return merged;
      })();
      this.instrumentsCache.catch(() => {
        this.instrumentsCache = null;
      });
    }
    return this.instrumentsCache;
  }

  private async searchOkxSymbols(query: string, options?: SymbolSearchOptions): Promise<SymbolInfo[]> {
    const list = await this.loadInstruments();
    return rankSymbols(list, query, options?.limit ?? 50);
  }

  private async resolveOkxSymbol(symbol: string): Promise<SymbolInfo | null> {
    if (this.instrumentsCache) {
      const cached = await this.instrumentsCache.catch(() => null);
      const hit = cached?.find((s) => s.symbol === symbol);
      if (hit) return hit;
    }
    const instType = inferInstType(symbol);
    const res = await this.fetchImpl(
      `${this.restBase}/api/v5/public/instruments?instType=${instType}&instId=${encodeURIComponent(symbol)}`,
    );
    if (!res.ok) return null;
    const list = parseOkxInstruments(await res.json());
    return list[0] ?? null;
  }

  /**
   * Live quotes for multiple OKX symbols with per-symbol isolation:
   * an unknown or halted symbol never blocks or disconnects healthy symbols.
   */
  subscribeQuotes(symbols: readonly string[], onQuotes: (quotes: Quote[]) => void): () => void {
    const wanted = [...new Set(symbols.map((s) => s.trim().toUpperCase()))].filter((s) => /^[A-Z0-9-]{3,40}$/.test(s));
    if (wanted.length === 0) return () => {};

    let stopped = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let ws: ReturnType<WebSocketFactory> | null = null;
    const streamed = new Set<string>();
    const wantedSet = new Set(wanted);

    // Group wanted symbols by inferred instType for initial REST snapshots
    const groups = new Map<OkxInstType, string[]>();
    for (const sym of wanted) {
      const kind = inferInstType(sym);
      const arr = groups.get(kind) ?? [];
      arr.push(sym);
      groups.set(kind, arr);
    }

    for (const [instType] of groups) {
      this.fetchImpl(`${this.restBase}/api/v5/market/tickers?instType=${instType}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((body: unknown) => {
          if (stopped || !isObject(body) || !Array.isArray(body.data)) return;
          const quotes: Quote[] = [];
          for (const raw of body.data) {
            const q = parseOkxTicker(raw, this.volField);
            if (q && wantedSet.has(q.symbol) && !streamed.has(q.symbol)) {
              quotes.push(q);
            }
          }
          if (quotes.length > 0) onQuotes(quotes);
        })
        .catch(() => {
          // Isolate snapshot error; WS stream still proceeds
        });
    }

    const createWs = (url: string) => {
      if (this.wsFactory) return this.wsFactory(url);
      const Ctor = (globalThis as { WebSocket?: new (u: string) => ReturnType<WebSocketFactory> }).WebSocket;
      if (!Ctor) throw new Error('No WebSocket implementation available');
      return new Ctor(url);
    };

    const scheduleReconnect = () => {
      if (stopped) return;
      retryTimer = setTimeout(open, Math.min(30_000, 1000 * 2 ** attempts++));
    };

    const open = () => {
      if (stopped) return;
      try {
        ws = createWs(this.wsPublicBase);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        attempts = 0;
        try {
          ws?.send(
            JSON.stringify({
              op: 'subscribe',
              args: wanted.map((instId) => ({ channel: 'tickers', instId })),
            }),
          );
        } catch {
          // ignore send race
        }
      };
      ws.onmessage = (ev) => {
        if (stopped || typeof ev.data !== 'string') return;
        let frame: unknown;
        try {
          frame = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!isObject(frame)) return;
        // Per-symbol subscription errors (`event: 'error'`) are isolated — do NOT tear down healthy streams.
        if (frame.event === 'error' || frame.event === 'subscribe') return;
        if (!Array.isArray(frame.data)) return;
        const quotes: Quote[] = [];
        for (const row of frame.data) {
          const q = parseOkxTicker(row, this.volField);
          if (q && wantedSet.has(q.symbol)) {
            streamed.add(q.symbol);
            quotes.push(q);
          }
        }
        if (quotes.length > 0) onQuotes(quotes);
      };
      ws.onclose = () => {
        ws = null;
        scheduleReconnect();
      };
      ws.onerror = () => {
        // Let onclose drive reconnection backoff
      };
    };

    open();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
        ws = null;
      }
    };
  }
}

export interface FetchOkxCandlesParams {
  restBase: string;
  symbol: string;
  timeframe: TimeFrame;
  limit: number;
  /** Exclusive upper timestamp in ms: only bars with `time < before` are returned. */
  before?: number;
  volumeField?: OkxVolumeField;
  fetchFn?: typeof fetch;
  nowMs?: number;
}

/**
 * Fetch up to `limit` ascending OKX candles, paging backward in chunks of 300
 * and automatically routing between `/market/candles` (fresh) and `/market/history-candles` (archive).
 */
export async function fetchOkxCandles(params: FetchOkxCandlesParams): Promise<OHLCBar[]> {
  const {
    restBase,
    symbol,
    timeframe,
    limit,
    before,
    volumeField = 'contracts',
    fetchFn = fetch,
    nowMs = Date.now(),
  } = params;

  const target = Math.max(1, Math.floor(limit));
  const barParam = okxBarInterval(timeframe);
  const tfMs = Math.max(1_000, timeframeToMs(timeframe) || 60_000);
  const recentCutoff = nowMs - RECENT_WINDOW_BARS * tfMs;

  const byTime = new Map<number, OHLCBar>();
  let cursorAfter: number | undefined = before !== undefined ? Math.floor(before) : undefined;
  let forceArchive = cursorAfter !== undefined && cursorAfter < recentCutoff;

  for (let hop = 0; hop < MAX_PAGE_HOPS && byTime.size < target; hop++) {
    const pageLimit = Math.min(OKX_MAX_CANDLES, target - byTime.size);
    const endpoint = forceArchive ? '/api/v5/market/history-candles' : '/api/v5/market/candles';
    const afterQuery = cursorAfter !== undefined ? `&after=${cursorAfter}` : '';
    const url = `${restBase}${endpoint}?instId=${encodeURIComponent(symbol)}&bar=${barParam}&limit=${pageLimit}${afterQuery}`;

    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`OKX REST error: ${res.status}`);
    const body: unknown = await res.json();
    if (isObject(body) && typeof body.code === 'string' && body.code !== '0') {
      throw new Error(`OKX API error ${body.code}: ${typeof body.msg === 'string' ? body.msg : 'request failed'}`);
    }

    let rows = parseOkxRestCandles(body, volumeField);

    // If `/market/candles` hit the end of its ~1440-bar recent window, seamlessly fall back to `/market/history-candles`.
    if (rows.length === 0 && !forceArchive && cursorAfter !== undefined) {
      forceArchive = true;
      const archiveUrl = `${restBase}/api/v5/market/history-candles?instId=${encodeURIComponent(symbol)}&bar=${barParam}&limit=${pageLimit}${afterQuery}`;
      const archRes = await fetchFn(archiveUrl);
      if (!archRes.ok) throw new Error(`OKX REST error: ${archRes.status}`);
      const archBody: unknown = await archRes.json();
      rows = parseOkxRestCandles(archBody, volumeField);
    }

    if (rows.length === 0) break;

    let oldestInPage = Infinity;
    for (const bar of rows) {
      if (before !== undefined && bar.time >= before) continue;
      byTime.set(bar.time, bar);
      if (bar.time < oldestInPage) oldestInPage = bar.time;
    }

    if (!Number.isFinite(oldestInPage) || (cursorAfter !== undefined && oldestInPage >= cursorAfter)) {
      break;
    }
    cursorAfter = oldestInPage;
    if (cursorAfter < recentCutoff) {
      forceArchive = true;
    }
    if (rows.length < pageLimit && forceArchive) {
      break;
    }
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-target);
}

export function parseOkxWsMessage(
  raw: unknown,
  expectedSymbol?: string,
  volumeField: OkxVolumeField = 'contracts',
): WsParseResult | null {
  if (!isObject(raw)) return null;
  if (raw.event === 'error' || raw.event === 'subscribe' || raw.event === 'unsubscribe') return null;
  const arg = raw.arg;
  if (!isObject(arg) || typeof arg.channel !== 'string' || !arg.channel.startsWith('candle')) return null;
  if (expectedSymbol && typeof arg.instId === 'string' && arg.instId !== expectedSymbol) return null;

  const data = raw.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const row = data[data.length - 1];
  const parsed = parseOkxCandleRow(row, volumeField);
  if (!parsed) return null;
  return parsed;
}

export function parseOkxRestCandles(body: unknown, volumeField: OkxVolumeField = 'contracts'): OHLCBar[] {
  if (!isObject(body) || !Array.isArray(body.data)) return [];
  const out: OHLCBar[] = [];
  for (const row of body.data) {
    const parsed = parseOkxCandleRow(row, volumeField);
    if (parsed?.bar) out.push(parsed.bar);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

export function parseOkxCandleRow(
  row: unknown,
  volumeField: OkxVolumeField = 'contracts',
): { bar: OHLCBar; closed: boolean } | null {
  if (!Array.isArray(row) || row.length < 6) return null;
  const time = toFiniteNumber(row[0]);
  const open = toFiniteNumber(row[1]);
  const high = toFiniteNumber(row[2]);
  const low = toFiniteNumber(row[3]);
  const close = toFiniteNumber(row[4]);
  const vIdx = volumeIndex(volumeField);
  const volume = toFiniteNumber(row[vIdx] ?? row[5]);
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
  const closed = row.length >= 9 ? String(row[8]) === '1' : false;
  return {
    bar: { time, open, high, low, close, volume },
    closed,
  };
}

export function parseOkxInstruments(body: unknown): SymbolInfo[] {
  if (!isObject(body) || !Array.isArray(body.data)) return [];
  const out: SymbolInfo[] = [];
  for (const raw of body.data) {
    if (!isObject(raw) || typeof raw.instId !== 'string') continue;
    if (typeof raw.state === 'string' && raw.state !== 'live') continue;
    const instId = raw.instId;
    const instType = typeof raw.instType === 'string' ? raw.instType : inferInstType(instId);
    const base = typeof raw.baseCcy === 'string' && raw.baseCcy ? raw.baseCcy : instId.split('-')[0] ?? '';
    const quote =
      typeof raw.quoteCcy === 'string' && raw.quoteCcy
        ? raw.quoteCcy
        : typeof raw.settleCcy === 'string' && raw.settleCcy
          ? raw.settleCcy
          : instId.split('-')[1] ?? '';
    const tickSz = typeof raw.tickSz === 'string' ? raw.tickSz : undefined;
    const info: SymbolInfo = {
      symbol: instId,
      description:
        instType === 'SWAP' && base && quote
          ? `${base}/${quote} Perpetual`
          : base && quote
            ? `${base}/${quote}`
            : instId,
      exchange: 'OKX',
      type: instType === 'SWAP' || instType === 'FUTURES' ? 'futures' : 'crypto',
      timeZone: 'UTC',
    };
    if (quote) info.currency = quote;
    if (tickSz && Number(tickSz) > 0) {
      info.minTick = Number(tickSz);
      info.pricePrecision = stepDecimals(tickSz);
    }
    out.push(info);
  }
  return out;
}

export function parseOkxTicker(raw: unknown, volumeField: OkxVolumeField = 'contracts'): Quote | null {
  if (!isObject(raw) || typeof raw.instId !== 'string') return null;
  const last = toFiniteNumber(raw.last);
  if (last === null) return null;
  const open24h = toFiniteNumber(raw.open24h ?? raw.sodUtc0);
  const high = toFiniteNumber(raw.high24h);
  const low = toFiniteNumber(raw.low24h);
  const bid = toFiniteNumber(raw.bidPx);
  const ask = toFiniteNumber(raw.askPx);
  const volume =
    volumeField === 'quote'
      ? toFiniteNumber(raw.volCcy24h)
      : toFiniteNumber(raw.vol24h);
  const change = open24h !== null ? last - open24h : undefined;
  const changePercent = open24h !== null && open24h > 0 ? ((last - open24h) / open24h) * 100 : undefined;
  return {
    symbol: raw.instId,
    last,
    ...(open24h !== null ? { open: open24h } : {}),
    ...(change !== undefined ? { change } : {}),
    ...(changePercent !== undefined ? { changePercent } : {}),
    ...(high !== null ? { high } : {}),
    ...(low !== null ? { low } : {}),
    ...(bid !== null ? { bid } : {}),
    ...(ask !== null ? { ask } : {}),
    ...(volume !== null ? { volume } : {}),
  };
}
