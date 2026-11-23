import type { OHLCBar, ViewportState } from '@1penny/commons';
import { DataExporter, valuePlots, type ExportColumn, type IndicatorEngine } from '@1penny/core';
import { indicatorChipLabel } from '../indicatorLabel.js';

export interface DataExportOptions {
  range?: 'all' | 'visible';
  indicators?: boolean;
}

export function collectChartExportData(params: {
  allBars: readonly OHLCBar[];
  viewportState: ViewportState;
  indicatorEngine: IndicatorEngine;
  options?: DataExportOptions;
}): { bars: OHLCBar[]; columns: ExportColumn[] } {
  const { allBars, viewportState, indicatorEngine, options = {} } = params;
  let from = 0;
  let to = allBars.length - 1;
  if (options.range === 'visible') {
    const { visibleRange } = viewportState;
    from = Math.max(0, visibleRange.from);
    to = Math.min(allBars.length - 1, visibleRange.to);
  }
  const bars = allBars.slice(from, to + 1);
  if (options.indicators === false) return { bars, columns: [] };

  const columns: ExportColumn[] = [];
  for (const ind of indicatorEngine.getActiveIndicators()) {
    const series = indicatorEngine.getOutput(ind.instanceId)?.series;
    if (!series) continue;
    const name = indicatorChipLabel(ind.id, ind.params, ind.descriptor.defaultConfig, ind.descriptor.shortName);
    const plots = ind.descriptor.plots
      ? valuePlots(ind.descriptor.plots)
      : Object.keys(series.find((p) => p) ?? {}).map((key) => ({ key, title: key }));
    for (const plot of plots) {
      const title = plots.length > 1 ? ` ${plot.title ?? plot.key}` : '';
      columns.push({
        name: `${name}${title}`,
        values: bars.map((_, i) => series[from + i]?.[plot.key] ?? null),
      });
    }
  }

  const seen = new Map<string, number>();
  for (const column of columns) {
    const count = (seen.get(column.name) ?? 0) + 1;
    seen.set(column.name, count);
    if (count > 1) column.name = `${column.name} (${count})`;
  }
  return { bars, columns };
}

export function formatChartExportText(
  format: 'csv' | 'json',
  exported: { bars: OHLCBar[]; columns: ExportColumn[] },
): string {
  return format === 'json'
    ? DataExporter.toJSON(exported.bars, exported.columns)
    : DataExporter.toCSV(exported.bars, exported.columns);
}

export function downloadChartExport(
  format: 'csv' | 'json',
  text: string,
  filename?: string,
): void {
  if (format === 'json') {
    DataExporter.download(text, filename ?? 'chart-data.json', 'application/json');
  } else {
    DataExporter.download(text, filename ?? 'chart-data.csv', 'text/csv');
  }
}
