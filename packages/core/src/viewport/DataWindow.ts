import type { DataSeries, ViewportState } from '@1penny/commons';
import { sliceVisibleData } from '@1penny/commons';

export function getVisibleData(data: DataSeries, viewport: ViewportState): DataSeries {
  return sliceVisibleData(data, viewport.visibleRange.from, viewport.visibleRange.to);
}
