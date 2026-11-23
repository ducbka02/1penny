import type { DataSeries, ViewportState, Theme } from '@1penny/commons';

export interface ChartRendererInterface {
  render(
    ctx: CanvasRenderingContext2D,
    data: DataSeries,
    viewport: ViewportState,
    theme: Theme,
  ): void;
}
