import type { DrawingState, DrawingToolType } from '@1penny/commons';
import { cloneOptions } from './drawingState.js';
import { offsetScreenPoints } from './screenAnchors.js';

/** How far across and down the plot each paste of a screen-anchored drawing lands (fraction of plot). */
export const SCREEN_PASTE_STEP = 0.02;

export interface PasteDraft {
  paneId?: string;
  type: DrawingToolType;
  anchors: DrawingState['anchors'];
  style: DrawingState['style'];
  options?: DrawingState['options'];
  intervals?: DrawingState['intervals'];
  meta?: DrawingState['meta'];
  name?: string;
}

/**
 * Shared drawing clipboard supporting both single-chart staggered paste and
 * cross-chart copy/paste on the same page.
 */
export class DrawingClipboard {
  private items: DrawingState[] = [];
  private pastes = 0;

  copy(selected: readonly DrawingState[]): number {
    if (selected.length === 0) return 0;
    this.items = selected.map((d) => structuredClone(d));
    this.pastes = 0;
    return selected.length;
  }

  canPaste(isCreating: boolean, canAcceptType: (type: DrawingToolType) => boolean): boolean {
    return !isCreating && this.items.some((d) => canAcceptType(d.type));
  }

  buildPasteDrafts(params: {
    isCreating: boolean;
    existingDrawings: readonly DrawingState[];
    canAcceptType: (type: DrawingToolType) => boolean;
    canAcceptPane: (paneId: string, type: DrawingToolType) => boolean;
    isScreenTool: (type: DrawingToolType) => boolean;
    barOffsetTime: (barsAhead: number) => number;
  }): PasteDraft[] {
    if (this.items.length === 0 || params.isCreating) return [];
    const fromHere = this.items.every((c) => params.existingDrawings.some((d) => d.id === c.id));
    this.pastes += 1;
    const shift = fromHere ? params.barOffsetTime(3 * this.pastes) : 0;

    const drafts: PasteDraft[] = [];
    for (const source of this.items) {
      if (!params.canAcceptType(source.type)) continue;
      if (source.paneId !== undefined && !params.canAcceptPane(source.paneId, source.type)) continue;
      drafts.push({
        ...(source.paneId !== undefined ? { paneId: source.paneId } : {}),
        type: source.type,
        anchors: params.isScreenTool(source.type)
          ? offsetScreenPoints(source.anchors, SCREEN_PASTE_STEP * this.pastes)
          : source.anchors.map((a) => ({ ...a, time: a.time + shift })),
        style: { ...source.style },
        options: source.options ? cloneOptions(source.options) : undefined,
        intervals: source.intervals,
        meta: source.meta ? structuredClone(source.meta) : undefined,
        name: source.name,
      });
    }
    return drafts;
  }

  clear(): void {
    this.items = [];
    this.pastes = 0;
  }
}

export const sharedDrawingClipboard = new DrawingClipboard();
