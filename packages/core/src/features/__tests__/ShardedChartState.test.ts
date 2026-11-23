import { describe, expect, it } from 'vitest';
import type { DrawingState } from '@1penny/commons';
import type { ChartSnapshot } from '../ChartState.js';
import {
  KEEPALIVE_SAFE_BYTES,
  applyDrawingsDelta,
  buildCloudSaveRequestInit,
  capDrawingAnchors,
  diffDrawings,
  extractChartConfig,
  mergeChartConfig,
  parseDrawingsShard,
  threeWayMergeDrawings,
  utf8ByteLength,
} from '../ShardedChartState.js';

function makeDrawing(id: string, price: number, extraAnchors = 0): DrawingState {
  const anchors = [
    { time: 1_700_000_000_000, price },
    { time: 1_700_000_060_000, price: price + 10 },
  ];
  for (let i = 0; i < extraAnchors; i++) {
    anchors.push({ time: 1_700_000_120_000 + i * 1000, price: price + i * 0.1 });
  }
  return {
    id,
    type: extraAnchors > 0 ? 'brush' : 'trendLine',
    anchors,
    style: { color: '#22c55e', lineWidth: 2, lineStyle: 'solid' },
    visible: true,
    locked: false,
  };
}

describe('ShardedChartState', () => {
  it('separates lightweight ChartConfigShard (<4KB) from drawings and preserves drawings on merge', () => {
    const source: ChartSnapshot = {
      version: 3,
      timestamp: 1000,
      symbol: 'BTC-USDT-SWAP',
      timeframe: '1m',
      chartType: 'heikinAshi',
      viewport: { barWidth: 8, barSpacing: 2, offset: 0 },
      theme: 'dark',
      indicators: [{ id: 'ema', instanceId: 'ema-1', params: { period: 50 } }],
      drawings: [makeDrawing('d-source', 60_000, 1200)],
      orders: [],
      positions: [],
      alerts: [
        {
          id: 'a-price',
          price: 65_000,
          condition: 'crossingUp',
          triggered: false,
          repeating: false,
          channel: 'price',
        },
        {
          id: 'a-draw',
          price: 60_000,
          drawingId: 'd-source',
          condition: 'crossing',
          triggered: false,
          repeating: true,
          channel: 'price',
        },
      ],
    };

    const configShard = extractChartConfig(source);
    expect(utf8ByteLength(JSON.stringify(configShard))).toBeLessThan(4096);
    expect('drawings' in configShard).toBe(false);
    expect(configShard.alerts.map((a) => a.id)).toEqual(['a-price']);

    const target: ChartSnapshot = {
      version: 3,
      timestamp: 2000,
      symbol: 'ETH-USDT-SWAP',
      timeframe: '5m',
      chartType: 'candlestick',
      viewport: { barWidth: 8, barSpacing: 2, offset: 0 },
      theme: 'light',
      indicators: [],
      drawings: [makeDrawing('d-eth', 3_200)],
      orders: [],
      positions: [],
      alerts: [
        {
          id: 'a-eth-draw',
          price: 3_200,
          drawingId: 'd-eth',
          condition: 'crossing',
          triggered: false,
          repeating: false,
          channel: 'price',
        },
      ],
    };

    const merged = mergeChartConfig(target, configShard);
    expect(merged.symbol).toBe('ETH-USDT-SWAP');
    expect(merged.chartType).toBe('heikinAshi');
    expect(merged.theme).toBe('dark');
    expect(merged.indicators).toHaveLength(1);
    expect(merged.drawings.map((d) => d.id)).toEqual(['d-eth']);
    expect(merged.alerts.map((a) => a.id)).toEqual(['a-price', 'a-eth-draw']);
  });

  it('computes deterministic deltas and preserves z-order & canonical key order', () => {
    const d1 = { ...makeDrawing('d1', 100), meta: { a: 1, b: 2 } };
    const d2 = makeDrawing('d2', 200);
    const prev = [d1, d2];

    // Identical content with swapped object key order produces zero delta
    const d1ReorderedKeys: DrawingState = { ...makeDrawing('d1', 100), meta: { b: 2, a: 1 } };
    const noopDelta = diffDrawings(prev, [d1ReorderedKeys, d2], 4, 'BTCUSDT');
    expect(noopDelta.nextRevision).toBe(4);
    expect(noopDelta.upserted).toHaveLength(0);
    expect(noopDelta.deletedIds).toHaveLength(0);

    // Modify d2, delete d1, insert d3 in front of d2
    const d2Modified = makeDrawing('d2', 250);
    const d3 = makeDrawing('d3', 300);
    const next = [d3, d2Modified];
    const delta = diffDrawings(prev, next, 4, 'BTCUSDT');
    expect(delta.nextRevision).toBe(5);
    expect(delta.deletedIds).toEqual(['d1']);
    expect(delta.upserted.map((d) => d.id)).toEqual(['d3', 'd2']);
    expect(delta.orderIds).toEqual(['d3', 'd2']);

    const reconstructed = applyDrawingsDelta(prev, delta);
    expect(reconstructed).toEqual(next);
  });

  it('resolves multi-tab ETag (412) conflicts via 3-way merge without losing edits', () => {
    const dSharedKeep = makeDrawing('keep', 100);
    const dRemoteDeleted = makeDrawing('rem-del', 200);
    const dLocalEditedVsRemoteDeleted = makeDrawing('edit-wins', 300);
    const dBothEdited = makeDrawing('conflict', 400);
    const base = [dSharedKeep, dRemoteDeleted, dLocalEditedVsRemoteDeleted, dBothEdited];

    const local = [
      dSharedKeep,
      dRemoteDeleted, // untouched locally, deleted remotely -> should delete
      makeDrawing('edit-wins', 350), // edited locally, deleted remotely -> edit wins!
      makeDrawing('conflict', 410), // edited in both
      makeDrawing('added-local', 500),
    ];
    const remote = [
      makeDrawing('keep', 105), // edited remotely, untouched locally -> remote edit kept!
      // 'rem-del' deleted remotely
      // 'edit-wins' deleted remotely
      makeDrawing('conflict', 490), // edited in both
      makeDrawing('added-remote', 600),
    ];

    const merged = threeWayMergeDrawings(base, local, remote, { prefer: 'local' });
    const byId = new Map(merged.map((d) => [d.id, d.anchors[0]!.price]));
    expect(byId.has('rem-del')).toBe(false);
    expect(byId.get('keep')).toBe(105);
    expect(byId.get('edit-wins')).toBe(350);
    expect(byId.get('conflict')).toBe(410);
    expect(byId.get('added-local')).toBe(500);
    expect(byId.get('added-remote')).toBe(600);
  });

  it('caps freehand anchors preserving exact endpoints and disables keepalive above 60KB', () => {
    const dense = makeDrawing('brush-1', 50_000, 1498); // 1500 anchors
    const capped = capDrawingAnchors(dense, 500);
    expect(capped.anchors).toHaveLength(500);
    expect(capped.anchors[0]).toEqual(dense.anchors[0]);
    expect(capped.anchors[499]).toEqual(dense.anchors[1499]);

    const parsedShard = parseDrawingsShard(
      { symbol: 'BTCUSDT', revision: 7, drawings: [dense] },
      { maxAnchorsPerDrawing: 300 },
    );
    expect(parsedShard.revision).toBe(7);
    expect(parsedShard.drawings[0]!.anchors).toHaveLength(300);

    const smallInit = buildCloudSaveRequestInit(parsedShard, { ifMatch: '"rev-7"' });
    expect(smallInit.bytes).toBeLessThanOrEqual(KEEPALIVE_SAFE_BYTES);
    expect(smallInit.keepalive).toBe(true);
    expect((smallInit.headers as Record<string, string>)['If-Match']).toBe('"rev-7"');

    // Construct >60 KB payload -> keepalive automatically disabled to prevent browser fetch failure
    const hugeDrawings = Array.from({ length: 25 }, (_, i) => makeDrawing(`b-${i}`, 50_000 + i, 200));
    const largeInit = buildCloudSaveRequestInit({ symbol: 'BTCUSDT', revision: 8, drawings: hugeDrawings });
    expect(largeInit.bytes).toBeGreaterThan(KEEPALIVE_SAFE_BYTES);
    expect(largeInit.keepalive).toBe(false);
  });
});
