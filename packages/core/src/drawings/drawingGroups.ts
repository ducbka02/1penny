import type { DrawingState } from '@1penny/commons';
import type { UndoableAction } from '../features/UndoRedoManager.js';
import {
  MAX_GROUP_NAME,
  cloneDrawing,
  newGroupId,
  type DrawingOrderMove,
} from './drawingState.js';
import { orderTarget } from './drawingHistory.js';

export interface DrawingGroupSummary {
  id: string;
  name: string;
  ids: string[];
}

export function cleanGroupName(name: string | undefined): string {
  return (name ?? '').trim().slice(0, MAX_GROUP_NAME);
}

export function listDrawingGroups(drawings: readonly DrawingState[]): DrawingGroupSummary[] {
  const groups = new Map<string, DrawingGroupSummary>();
  for (const d of drawings) {
    if (!d.group) continue;
    const group = groups.get(d.group.id) ?? { id: d.group.id, name: d.group.name, ids: [] };
    group.ids.push(d.id);
    groups.set(d.group.id, group);
  }
  return [...groups.values()];
}

export function reorderDrawingList(
  drawings: readonly DrawingState[],
  id: string,
  to: DrawingOrderMove,
): { next: DrawingState[]; action: UndoableAction } | null {
  const from = drawings.findIndex((d) => d.id === id);
  if (from < 0) return null;
  const target = orderTarget(from, drawings.length, to);
  if (target === from) return null;
  const before = drawings.map((d) => d.id);
  const next = [...drawings];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return {
    next,
    action: {
      type: 'drawingOrder',
      before: null,
      after: null,
      order: { before, after: next.map((d) => d.id) },
    },
  };
}

export function mutateDrawingGroup(
  drawings: readonly DrawingState[],
  groupId: string,
  change: (d: DrawingState) => void,
  onModified: (action: UndoableAction, id: string) => void,
): boolean {
  const members = drawings.filter((d) => d.group?.id === groupId);
  if (members.length === 0) return false;
  for (const d of members) {
    const before = cloneDrawing(d);
    change(d);
    onModified({ type: 'drawingModify', before, after: cloneDrawing(d) }, d.id);
  }
  return true;
}

export function createDrawingGroup(
  drawings: readonly DrawingState[],
  ids: readonly string[],
  name: string | undefined,
  onModified: (action: UndoableAction, id: string) => void,
): string | null {
  const wanted = new Set(ids);
  const members = drawings.filter((d) => wanted.has(d.id));
  if (members.length < 2) return null;
  const { id, number } = newGroupId();
  const group = { id, name: cleanGroupName(name) || `Group ${number}` };
  for (const d of members) {
    const before = cloneDrawing(d);
    d.group = { ...group };
    onModified({ type: 'drawingModify', before, after: cloneDrawing(d) }, d.id);
  }
  return group.id;
}
