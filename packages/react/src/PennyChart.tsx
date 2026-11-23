import { useRef, useEffect, useImperativeHandle, forwardRef, type CSSProperties } from 'react';
import {
  Chart,
  BinanceAdapter,
  DARK_THEME,
  LIGHT_THEME,
  syncIndicators,
  feedBars,
} from '@1penny/chart';
import type {
  ChartType,
  ChartEventType,
  TimeFrame,
  ChartOptions,
  FeaturesConfig,
  Theme,
  OHLCBar,
  SignalMarker,
  TradeZone,
  SignalMarkerStyle,
  TradeZoneStyle,
  DataAdapter,
  DataFeed,
  ChartStyleOverrides,
  IndicatorSpec,
  FedBars,
  TradingOrder,
  TradingPosition,
  ExecutionAdapter,
  ExecutionConfig,
  DrawingToolType,
  TimeZoneSetting,
  OrderPlacePayload,
  OrderModifyPayload,
  OrderCancelPayload,
  PositionModifyPayload,
  PositionClosePayload,
  FillEvent,
  DrawingCreatePayload,
  DrawingRemovePayload,
  BarClickPayload,
} from '@1penny/chart';

export interface PennyChartRef {
  getChart(): Chart | null;
  screenshot(filename?: string): void;
  screenshotDataURL(): string | null;
}

/**
 * Host-controlled React wrapper for `@1penny/chart` (`Chart`).
 *
 * Allows an external UI shell (e.g. HeroUI + Tabler toolbars/modals) to drive
 * streaming, orders, positions, execution adapters, active drawing tools,
 * magnet snapping, time zone, and chart events declaratively without mounting
 * `ChartWidget`'s built-in DOM chrome.
 */
export interface PennyChartProps {
  /** The stream's symbol (`'BTCUSDT'`); a new one reconnects the stream, while there is no `data`. */
  symbol?: string;
  /** The stream's interval (`'5m'`); a new one reconnects it, while there is no `data`. */
  timeframe?: TimeFrame;
  theme?: 'dark' | 'light' | Theme;
  chartType?: ChartType;
  /** Indicators by id (`'rsi'`), or with their inputs (`{ id: 'ema', params: { period: 50 } }`). */
  indicators?: IndicatorSpec[];
  /** Controlled OHLCV bar series. */
  data?: OHLCBar[];
  /** The stream's feed (Binance by default), taken when the stream connects. */
  adapter?: DataAdapter;
  /** The stream's source as a feed the chart pulls from (`DataFeed`, `PennyBackendFeed`); over `adapter` when both are given. */
  feed?: DataFeed;
  /** `false`: no stream until you say so; the chart waits for `data`. Default `true`. */
  stream?: boolean;
  historyLimit?: number;
  /** What users can do on the chart; changes after mount are applied too. */
  features?: FeaturesConfig;
  autoScale?: boolean;
  signalMarkers?: SignalMarker[];
  signalMarkerStyle?: SignalMarkerStyle;
  tradeZones?: TradeZone[];
  tradeZoneStyle?: TradeZoneStyle;
  /** Style overrides, by key: all of your app's (`chart.setOverrides`). */
  overrides?: ChartStyleOverrides;
  watermarkText?: string;
  /** Controlled working orders rendered on the chart. */
  orders?: TradingOrder[];
  /** Controlled open positions rendered on the chart. */
  positions?: TradingPosition[];
  /** Optional `ExecutionAdapter` (e.g. `PaperExecutionAdapter` or broker OMS) wired via `connectExecution`. */
  executionAdapter?: ExecutionAdapter | null;
  /** Options passed to `connectExecution` when `executionAdapter` is set. */
  executionConfig?: ExecutionConfig;
  /** Controlled active drawing tool (`'trendLine'`, `'fibRetracement'`, or `null` for pointer/idle). */
  activeDrawingTool?: DrawingToolType | null;
  /** Controlled drawing magnet mode (`'off' | 'weak' | 'strong'`). */
  magnetMode?: 'off' | 'weak' | 'strong';
  /** Controlled display time zone (`'UTC'`, `'Asia/Ho_Chi_Minh'`, `'exchange'`, or `null`). */
  timeZone?: TimeZoneSetting;
  /** Chart options merged over defaults at mount. */
  options?: Partial<ChartOptions>;
  onReady?: (chart: Chart) => void;
  onCrosshairMove?: (payload: unknown) => void;
  onBarClick?: (payload: BarClickPayload) => void;
  onOrderPlace?: (payload: OrderPlacePayload) => void;
  onOrderModify?: (payload: OrderModifyPayload) => void;
  onOrderCancel?: (payload: OrderCancelPayload) => void;
  onPositionModify?: (payload: PositionModifyPayload) => void;
  onPositionClose?: (payload: PositionClosePayload) => void;
  onPositionReverse?: (payload: { positionId: string }) => void;
  onExecutionFill?: (payload: FillEvent) => void;
  onDrawingCreate?: (payload: DrawingCreatePayload) => void;
  onDrawingUpdate?: (payload: { id: string }) => void;
  onDrawingRemove?: (payload: DrawingRemovePayload) => void;
  onDrawingToolChange?: (payload: { tool: DrawingToolType | null }) => void;
  onReplayStep?: (payload: unknown) => void;
  className?: string;
  style?: CSSProperties;
}

function resolveTheme(theme: 'dark' | 'light' | Theme | undefined): Theme {
  if (!theme || theme === 'dark') return DARK_THEME;
  if (theme === 'light') return LIGHT_THEME;
  return theme;
}

function useChartEvent<T>(
  chartRef: React.RefObject<Chart | null>,
  event: ChartEventType,
  callback: ((payload: T) => void) | undefined,
  unwrapPayload = true,
): void {
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !callback) return;
    const listener = (ev: unknown) => {
      if (unwrapPayload && ev && typeof ev === 'object' && 'payload' in ev) {
        callback((ev as { payload: T }).payload);
      } else {
        callback(ev as T);
      }
    };
    chart.on(event, listener as (e: unknown) => void);
    return () => chart.off(event, listener as (e: unknown) => void);
  }, [chartRef, event, callback, unwrapPayload]);
}

export const PennyChart = forwardRef<PennyChartRef, PennyChartProps>(
  function PennyChart(props, ref) {
    const {
      symbol = 'BTCUSDT',
      timeframe = '5m' as TimeFrame,
      theme = 'dark',
      chartType = 'candlestick' as ChartType,
      indicators = [],
      data,
      adapter,
      feed,
      stream = true,
      historyLimit = 500,
      features,
      autoScale = true,
      signalMarkers,
      signalMarkerStyle,
      tradeZones,
      tradeZoneStyle,
      overrides,
      watermarkText,
      orders,
      positions,
      executionAdapter,
      executionConfig,
      activeDrawingTool,
      magnetMode,
      timeZone,
      options,
      onReady,
      onCrosshairMove,
      onBarClick,
      onOrderPlace,
      onOrderModify,
      onOrderCancel,
      onPositionModify,
      onPositionClose,
      onPositionReverse,
      onExecutionFill,
      onDrawingCreate,
      onDrawingUpdate,
      onDrawingRemove,
      onDrawingToolChange,
      onReplayStep,
      className,
      style,
    } = props;

    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<Chart | null>(null);
    const indicatorIdsRef = useRef<Map<string, string>>(new Map());
    const fedRef = useRef<FedBars | null>(null);
    const streamKeyRef = useRef<string | null>(null);
    const featuresRef = useRef(JSON.stringify(features ?? null));

    useImperativeHandle(ref, () => ({
      getChart: () => chartRef.current,
      screenshot: (filename?: string) => chartRef.current?.screenshot(filename),
      screenshotDataURL: () => chartRef.current?.screenshotDataURL() ?? null,
    }));

    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const opts: ChartOptions = {
        crosshair: { mode: 'magnet' },
        ...options,
        chartType,
        theme: resolveTheme(theme),
        autoScale,
        features: {
          drawings: true,
          drawingMagnet: true,
          drawingUndoRedo: true,
          indicators: true,
          trading: true,
          volume: true,
          legend: true,
          crosshair: true,
          keyboard: true,
          screenshot: true,
          alerts: true,
          barCountdown: true,
          logScale: true,
          watermark: true,
          ...options?.features,
          ...features,
        },
      };

      if (watermarkText) {
        opts.watermark = { text: watermarkText, fontSize: 48, color: 'rgba(255,255,255,0.03)' };
      }

      const chart = new Chart(container, opts);
      chartRef.current = chart;
      indicatorIdsRef.current = new Map();

      fedRef.current = data ? feedBars(chart, data, null) : null;
      if (!data && stream) {
        const source = feed ? { feed } : { adapter: adapter ?? new BinanceAdapter() };
        chart.connect({ ...source, symbol, timeframe, historyLimit });
        streamKeyRef.current = `${symbol}|${timeframe}`;
      }

      onReady?.(chart);

      return () => {
        chart.disconnectStream();
        chart.destroy();
        chartRef.current = null;
        indicatorIdsRef.current.clear();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const chart = chartRef.current;
      if (!chart) return;
      if (!stream) {
        if (streamKeyRef.current !== null) chart.disconnectStream();
        streamKeyRef.current = null;
        return;
      }
      if (data) return;
      const key = `${symbol}|${timeframe}`;
      if (streamKeyRef.current === key) return;
      streamKeyRef.current = key;

      chart.disconnectStream();
      const source = feed ? { feed } : { adapter: adapter ?? new BinanceAdapter() };
      chart.connect({ ...source, symbol, timeframe, historyLimit });
      if (watermarkText !== undefined) {
        chart.setWatermark(watermarkText);
      }
    }, [symbol, timeframe, adapter, feed, historyLimit, data, stream, watermarkText]);

    useEffect(() => {
      const next = JSON.stringify(features ?? null);
      if (next === featuresRef.current) return;
      featuresRef.current = next;
      if (features) chartRef.current?.setFeatures(features);
    }, [features]);

    useEffect(() => {
      chartRef.current?.setTheme(resolveTheme(theme));
    }, [theme]);

    useEffect(() => {
      chartRef.current?.setChartType(chartType);
    }, [chartType]);

    useEffect(() => {
      const chart = chartRef.current;
      if (!chart) return;
      fedRef.current = data ? feedBars(chart, data, fedRef.current) : null;
    }, [data]);

    useEffect(() => {
      const chart = chartRef.current;
      if (chart) syncIndicators(chart, indicators, indicatorIdsRef.current);
    }, [indicators]);

    useEffect(() => {
      if (signalMarkers) chartRef.current?.setSignalMarkers(signalMarkers);
    }, [signalMarkers]);

    useEffect(() => {
      if (signalMarkerStyle) chartRef.current?.setSignalMarkerStyle(signalMarkerStyle);
    }, [signalMarkerStyle]);

    useEffect(() => {
      if (tradeZones) chartRef.current?.setTradeZones(tradeZones);
    }, [tradeZones]);

    useEffect(() => {
      if (tradeZoneStyle) chartRef.current?.setTradeZoneStyle(tradeZoneStyle);
    }, [tradeZoneStyle]);

    const overridesGiven = useRef(false);
    useEffect(() => {
      if (overrides === undefined && !overridesGiven.current) return;
      overridesGiven.current = overrides !== undefined;
      chartRef.current?.setOverrides(overrides ?? {});
    }, [overrides]);

    // Host-controlled trading, drawing, magnet, and timeZone props
    useEffect(() => {
      if (orders !== undefined) chartRef.current?.setOrders(orders);
    }, [orders]);

    useEffect(() => {
      if (positions !== undefined) chartRef.current?.setPositions(positions);
    }, [positions]);

    useEffect(() => {
      const chart = chartRef.current;
      if (!chart || executionAdapter === undefined) return;
      if (executionAdapter === null) {
        chart.disconnectExecution();
        return;
      }
      chart.connectExecution(executionAdapter, executionConfig);
      return () => chart.disconnectExecution();
    }, [executionAdapter, executionConfig]);

    useEffect(() => {
      if (activeDrawingTool !== undefined) {
        chartRef.current?.setDrawingTool(activeDrawingTool);
      }
    }, [activeDrawingTool]);

    useEffect(() => {
      if (magnetMode !== undefined) {
        chartRef.current?.setDrawingMagnetMode(magnetMode);
      }
    }, [magnetMode]);

    useEffect(() => {
      if (timeZone !== undefined) {
        chartRef.current?.setTimeZone(timeZone);
      }
    }, [timeZone]);

    // Keep exact handler reference identity on `onCrosshairMove` for legacy callers
    useEffect(() => {
      const chart = chartRef.current;
      if (!chart || !onCrosshairMove) return;
      const handler = onCrosshairMove as (e: unknown) => void;
      chart.on('crosshairMove', handler);
      return () => chart.off('crosshairMove', handler);
    }, [onCrosshairMove]);
    useChartEvent(chartRef, 'barClick', onBarClick);
    useChartEvent(chartRef, 'orderPlace', onOrderPlace);
    useChartEvent(chartRef, 'orderModify', onOrderModify);
    useChartEvent(chartRef, 'orderCancel', onOrderCancel);
    useChartEvent(chartRef, 'positionModify', onPositionModify);
    useChartEvent(chartRef, 'positionClose', onPositionClose);
    useChartEvent(chartRef, 'positionReverse', onPositionReverse);
    useChartEvent(chartRef, 'executionFill', onExecutionFill);
    useChartEvent(chartRef, 'drawingCreate', onDrawingCreate);
    useChartEvent(chartRef, 'drawingUpdate', onDrawingUpdate);
    useChartEvent(chartRef, 'drawingRemove', onDrawingRemove);
    useChartEvent(chartRef, 'drawingToolChange', onDrawingToolChange);
    useChartEvent(chartRef, 'replayStep', onReplayStep);

    return (
      <div
        ref={containerRef}
        className={className}
        style={{ width: '100%', height: '100%', ...style }}
      />
    );
  },
);
