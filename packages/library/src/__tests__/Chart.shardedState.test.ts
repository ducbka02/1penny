// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OHLCBar } from '@1penny/commons';
import { Chart } from '../Chart.js';
import { installChartStubs, sizedHost } from './chartTestEnv.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 0, 5);
const bars: OHLCBar[] = Array.from({ length: 60 }, (_, i) => ({
  time: T0 + i * HOUR,
  open: 100 + i * 0.5,
  high: 102 + i * 0.5,
  low: 99 + i * 0.5,
  close: 101 + i * 0.5,
  volume: 25,
}));

let hostA: HTMLDivElement;
let hostB: HTMLDivElement;
let chartA: Chart;
let chartB: Chart;

beforeEach(() => {
  installChartStubs();
  hostA = sizedHost();
  hostB = sizedHost();
  // Even when built-in localStorage saveLoad UI is disabled, host-controlled sharded APIs work.
  chartA = new Chart(hostA, { features: { saveLoad: false } });
  chartB = new Chart(hostB, { features: { saveLoad: false } });
  chartA.setData(bars);
  chartB.setData(bars);
});

afterEach(() => {
  chartA.destroy();
  chartB.destroy();
  hostA.remove();
  hostB.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Chart sharded config & drawings persistence', () => {
  it('exports/imports ChartConfigShard without wiping target chart drawings', () => {
    chartA.setChartType('line');
    chartA.setTheme('light');
    chartA.addIndicator('sma', { period: 14 });
    chartA.addDrawing({
      type: 'trendLine',
      anchors: [
        { time: bars[5]!.time, price: 102 },
        { time: bars[20]!.time, price: 112 },
      ],
    });

    // Target chart B has its own symbol drawing
    const keptId = chartB.addDrawing({
      type: 'horizontalLine',
      anchors: [{ time: bars[10]!.time, price: 105 }],
    });

    const configShard = chartA.exportChartConfig();
    expect('drawings' in configShard).toBe(false);

    chartB.importChartConfig(configShard);
    expect(chartB.exportChartConfig().chartType).toBe('line');
    expect(chartB.exportChartConfig().theme).toBe('light');
    expect(chartB.getIndicatorSetup().map((i) => i.id)).toEqual(['sma']);
    // Target chart B's existing drawing is untouched!
    expect(chartB.getDrawings().map((d) => d.id)).toEqual([keptId]);
  });

  it('exports/imports DrawingsShard with anchor capping and revision tracking', () => {
    const manyAnchors = Array.from({ length: 800 }, (_, i) => ({
      time: T0 + i * 60_000,
      price: 100 + Math.sin(i / 10),
    }));
    chartA.addDrawing({
      type: 'brush',
      anchors: manyAnchors,
    });

    const shard = chartA.exportDrawings({
      symbol: 'BTC-USDT-SWAP',
      revision: 12,
      maxAnchorsPerDrawing: 250,
    });
    expect(shard.symbol).toBe('BTC-USDT-SWAP');
    expect(shard.revision).toBe(12);
    expect(shard.drawings).toHaveLength(1);
    expect(shard.drawings[0]!.anchors).toHaveLength(250);

    const imported = chartB.importDrawings(JSON.stringify(shard));
    expect(imported.revision).toBe(12);
    expect(chartB.getDrawings()).toHaveLength(1);
    expect(chartB.getDrawings()[0]!.anchors).toHaveLength(250);
    expect(chartB.exportDrawings().revision).toBe(12);
  });
});
