import type {
  ChartStyleOverrides,
  ChartType,
  ChartTypeOptions,
  DrawingState,
} from '@1penny/commons';
import type { PriceAlert } from './AlertManager.js';
import {
  SNAPSHOT_VERSION,
  validateSnapshot,
  type ChartSnapshot,
  type SnapshotIndicator,
} from './ChartState.js';

/**
 * Browser `fetch(..., { keepalive: true })` enforces a hard 64 KiB (65,536 bytes)
 * body cap across all in-flight keepalive requests. Using 60,000 bytes leaves
 * safe headroom for concurrent beacon/auth requests on `pagehide`.
 */
export const KEEPALIVE_SAFE_BYTES = 60_000;

/** Default upper bound for a single serialized shard before quota rejection. */
export const DEFAULT_MAX_SHARD_BYTES = 512_000;

/** Default cap on anchor count per drawing (e.g. freehand `brush`/`highlighter` strokes). */
export const DEFAULT_MAX_FREEHAND_ANCHORS = 500;

/**
 * Lightweight, symbol-independent visual & indicator configuration shard
 * (typically < 4 KB). Excludes drawings, working orders, and open positions.
 */
export interface ChartConfigShard {
  version: number;
  timestamp: number;
  chartType: ChartType;
  chartTypeOptions?: ChartTypeOptions;
  theme?: string;
  overrides?: Record<string, ChartStyleOverrides>;
  locale?: string;
  indicators: SnapshotIndicator[];
  /** Non-drawing price/indicator alerts carried with the template/layout. */
  alerts: PriceAlert[];
}

/**
 * Per-symbol drawings shard persisted independently from `ChartConfigShard`.
 */
export interface DrawingsShard {
  version: 1;
  symbol?: string;
  revision: number;
  updatedAt: number;
  drawings: DrawingState[];
}

/**
 * Incremental patch between two drawing lists for delta autosave and multi-tab sync.
 */
export interface DrawingsDelta {
  symbol?: string;
  baseRevision: number;
  nextRevision: number;
  upserted: DrawingState[];
  deletedIds: string[];
  /** Full drawing ID sequence when z-order changed or drawings were added/removed. */
  orderIds?: string[];
}

export interface CloudSaveCheck {
  json: string;
  bytes: number;
  keepaliveSafe: boolean;
  withinQuota: boolean;
}

export interface BuildCloudSaveInitOptions {
  method?: 'PUT' | 'POST' | 'PATCH';
  /** Optional `ETag` passed as `If-Match` for optimistic concurrency (`412` detection). */
  ifMatch?: string;
  headers?: Record<string, string>;
  maxKeepaliveBytes?: number;
}

const utf8Encoder = new TextEncoder();

/** Exact UTF-8 byte length of a string. */
export function utf8ByteLength(text: string): number {
  return utf8Encoder.encode(text).byteLength;
}

/**
 * Serialize (if needed) and inspect byte size against `keepalive` and quota limits.
 */
export function measureShardPayload(
  payload: string | object,
  options?: { maxKeepaliveBytes?: number; maxShardBytes?: number },
): CloudSaveCheck {
  const json = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const bytes = utf8ByteLength(json);
  const keepaliveLimit = options?.maxKeepaliveBytes ?? KEEPALIVE_SAFE_BYTES;
  const quotaLimit = options?.maxShardBytes ?? DEFAULT_MAX_SHARD_BYTES;
  return {
    json,
    bytes,
    keepaliveSafe: bytes <= keepaliveLimit,
    withinQuota: bytes <= quotaLimit,
  };
}

/**
 * Build a `fetch` `RequestInit` for cloud autosave that automatically drops
 * `keepalive` to `false` when the UTF-8 payload exceeds `KEEPALIVE_SAFE_BYTES`
 * (preventing Chromium/Safari/Firefox `TypeError: Failed to fetch` > 64 KiB).
 */
export function buildCloudSaveRequestInit(
  payload: string | object,
  options?: BuildCloudSaveInitOptions,
): RequestInit & { body: string; bytes: number; keepalive: boolean } {
  const check = measureShardPayload(payload, {
    maxKeepaliveBytes: options?.maxKeepaliveBytes,
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers ?? {}),
  };
  if (options?.ifMatch) {
    headers['If-Match'] = options.ifMatch;
  }
  return {
    method: options?.method ?? 'PUT',
    headers,
    body: check.json,
    bytes: check.bytes,
    keepalive: check.keepaliveSafe,
  };
}

/**
 * Bound the number of anchor points on a drawing (such as dense `brush` or
 * `highlighter` freehand strokes) using endpoint-preserving uniform index
 * decimation so payloads stay bounded.
 */
export function capDrawingAnchors(
  drawing: DrawingState,
  maxAnchors = DEFAULT_MAX_FREEHAND_ANCHORS,
): DrawingState {
  const limit = Math.max(2, Math.floor(maxAnchors));
  const total = drawing.anchors.length;
  if (total <= limit) return drawing;

  const sampled: DrawingState['anchors'] = new Array(limit);
  for (let i = 0; i < limit; i++) {
    const idx = Math.round((i * (total - 1)) / (limit - 1));
    const pt = drawing.anchors[idx]!;
    sampled[i] = { time: pt.time, price: pt.price };
  }
  return {
    ...drawing,
    anchors: sampled,
  };
}

/**
 * Extract the lightweight, symbol-independent `ChartConfigShard` from a full `ChartSnapshot`.
 * Drawing-linked alerts (`drawingId !== undefined`) are omitted so importing a config shard
 * onto another symbol never creates dangling drawing alerts.
 */
export function extractChartConfig(snapshot: ChartSnapshot): ChartConfigShard {
  const themeName =
    typeof snapshot.theme === 'string'
      ? snapshot.theme
      : snapshot.theme?.name;
  return {
    version: snapshot.version,
    timestamp: snapshot.timestamp,
    chartType: snapshot.chartType,
    ...(snapshot.chartTypeOptions && Object.keys(snapshot.chartTypeOptions).length > 0
      ? { chartTypeOptions: snapshot.chartTypeOptions }
      : {}),
    ...(themeName ? { theme: themeName } : {}),
    ...(snapshot.overrides && Object.keys(snapshot.overrides).length > 0
      ? { overrides: snapshot.overrides }
      : {}),
    ...(snapshot.locale ? { locale: snapshot.locale } : {}),
    indicators: snapshot.indicators,
    alerts: snapshot.alerts.filter((a) => a.drawingId === undefined),
  };
}

/**
 * Validate and parse an untrusted JSON string or object into a `ChartConfigShard`.
 */
export function parseChartConfigShard(jsonOrRaw: string | unknown): ChartConfigShard {
  const raw: unknown = typeof jsonOrRaw === 'string' ? JSON.parse(jsonOrRaw) : jsonOrRaw;
  const validated = validateSnapshot(raw);
  return extractChartConfig(validated);
}

/**
 * Merge a `ChartConfigShard` onto an existing `ChartSnapshot` while preserving
 * the target snapshot's `symbol`, `timeframe`, `drawings`, `orders`, `positions`,
 * and any alerts tied to existing drawings.
 */
export function mergeChartConfig(
  base: ChartSnapshot,
  config: ChartConfigShard,
): ChartSnapshot {
  const drawingIds = new Set(base.drawings.map((d) => d.id));
  const keptDrawingAlerts = base.alerts.filter(
    (a) => a.drawingId !== undefined && drawingIds.has(a.drawingId),
  );
  return {
    ...base,
    version: config.version,
    timestamp: config.timestamp,
    chartType: config.chartType,
    chartTypeOptions: config.chartTypeOptions,
    theme: config.theme ?? base.theme,
    overrides: config.overrides,
    locale: config.locale ?? base.locale,
    indicators: config.indicators,
    alerts: [...config.alerts.filter((a) => a.drawingId === undefined), ...keptDrawingAlerts],
  };
}

/**
 * Validate and parse a `DrawingsShard` (or raw `DrawingState[]` / JSON string),
 * optionally capping dense freehand anchors.
 */
export function parseDrawingsShard(
  input: string | DrawingsShard | readonly DrawingState[] | unknown,
  options?: { symbol?: string; maxAnchorsPerDrawing?: number },
): DrawingsShard {
  const raw: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  const isArrayInput = Array.isArray(raw);
  const obj =
    !isArrayInput && typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const rawDrawings = isArrayInput ? raw : Array.isArray(obj.drawings) ? obj.drawings : [];

  const validated = validateSnapshot({
    version: SNAPSHOT_VERSION,
    indicators: [],
    drawings: rawDrawings,
  });

  const maxAnchors = options?.maxAnchorsPerDrawing;
  const drawings =
    maxAnchors !== undefined
      ? validated.drawings.map((d) => capDrawingAnchors(d, maxAnchors))
      : validated.drawings;

  const revision =
    typeof obj.revision === 'number' && Number.isInteger(obj.revision) && obj.revision >= 0
      ? obj.revision
      : 0;
  const updatedAt =
    typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt)
      ? obj.updatedAt
      : Date.now();
  const symbol =
    options?.symbol ?? (typeof obj.symbol === 'string' && obj.symbol.length > 0 ? obj.symbol : undefined);

  return {
    version: 1,
    ...(symbol ? { symbol } : {}),
    revision,
    updatedAt,
    drawings,
  };
}

/** Canonical JSON representation (sorted object keys) for deterministic equality checks. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Compute an incremental `DrawingsDelta` from `prev` to `next`. */
export function diffDrawings(
  prev: readonly DrawingState[],
  next: readonly DrawingState[],
  baseRevision = 0,
  symbol?: string,
): DrawingsDelta {
  const prevMap = new Map<string, string>();
  for (const d of prev) {
    prevMap.set(d.id, canonicalJson(d));
  }

  const nextIds = new Set<string>();
  const upserted: DrawingState[] = [];
  for (const d of next) {
    nextIds.add(d.id);
    const serialized = canonicalJson(d);
    if (prevMap.get(d.id) !== serialized) {
      upserted.push(d);
    }
  }

  const deletedIds: string[] = [];
  for (const d of prev) {
    if (!nextIds.has(d.id)) {
      deletedIds.push(d.id);
    }
  }

  const orderChanged =
    prev.length !== next.length || prev.some((d, idx) => d.id !== next[idx]?.id);
  const changed = upserted.length > 0 || deletedIds.length > 0 || orderChanged;

  return {
    ...(symbol ? { symbol } : {}),
    baseRevision,
    nextRevision: changed ? baseRevision + 1 : baseRevision,
    upserted,
    deletedIds,
    ...(orderChanged ? { orderIds: next.map((d) => d.id) } : {}),
  };
}

/** Apply a `DrawingsDelta` onto `current`, preserving z-order and concurrent additions. */
export function applyDrawingsDelta(
  current: readonly DrawingState[],
  delta: DrawingsDelta,
): DrawingState[] {
  const deleted = new Set(delta.deletedIds);
  const upsertedMap = new Map(delta.upserted.map((d) => [d.id, d]));

  const byId = new Map<string, DrawingState>();
  const naturalOrder: string[] = [];

  for (const d of current) {
    if (deleted.has(d.id)) continue;
    byId.set(d.id, upsertedMap.get(d.id) ?? d);
    naturalOrder.push(d.id);
  }

  for (const d of delta.upserted) {
    if (deleted.has(d.id)) continue;
    if (!byId.has(d.id)) {
      byId.set(d.id, d);
      naturalOrder.push(d.id);
    }
  }

  if (!delta.orderIds) {
    return naturalOrder.map((id) => byId.get(id)!);
  }

  const ordered: DrawingState[] = [];
  const placed = new Set<string>();
  for (const id of delta.orderIds) {
    const item = byId.get(id);
    if (item && !placed.has(id)) {
      ordered.push(item);
      placed.add(id);
    }
  }
  for (const id of naturalOrder) {
    if (!placed.has(id)) {
      ordered.push(byId.get(id)!);
      placed.add(id);
    }
  }
  return ordered;
}

/**
 * Deterministic 3-way merge of `base`, `local`, and `remote` drawing sets for
 * resolving multi-tab / multi-device HTTP `412 Precondition Failed` (`ETag`) conflicts:
 * - Unilateral additions in either `local` or `remote` are kept.
 * - Unilateral deletions are respected when the other side left the drawing untouched.
 * - Unilateral edits win over untouched `base` or unilateral deletion (so user edits are never silently lost).
 * - Concurrent edits to the same drawing ID resolve via `options.prefer` (default `'local'`).
 */
export function threeWayMergeDrawings(
  base: readonly DrawingState[],
  local: readonly DrawingState[],
  remote: readonly DrawingState[],
  options?: { prefer?: 'local' | 'remote' },
): DrawingState[] {
  const prefer = options?.prefer ?? 'local';
  const baseJson = new Map(base.map((d) => [d.id, canonicalJson(d)]));
  const localMap = new Map(local.map((d) => [d.id, d]));
  const remoteMap = new Map(remote.map((d) => [d.id, d]));
  const localJson = new Map(local.map((d) => [d.id, canonicalJson(d)]));
  const remoteJson = new Map(remote.map((d) => [d.id, canonicalJson(d)]));

  const candidateOrder: string[] = [];
  const seen = new Set<string>();
  const primaryList = prefer === 'remote' ? remote : local;
  const secondaryList = prefer === 'remote' ? local : remote;
  for (const d of primaryList) {
    if (!seen.has(d.id)) {
      seen.add(d.id);
      candidateOrder.push(d.id);
    }
  }
  for (const d of secondaryList) {
    if (!seen.has(d.id)) {
      seen.add(d.id);
      candidateOrder.push(d.id);
    }
  }

  const merged: DrawingState[] = [];
  for (const id of candidateOrder) {
    const bStr = baseJson.get(id);
    const lItem = localMap.get(id);
    const rItem = remoteMap.get(id);
    const lStr = localJson.get(id);
    const rStr = remoteJson.get(id);

    if (bStr === undefined) {
      // Added after base in local, remote, or both
      if (lItem && rItem) {
        merged.push(prefer === 'remote' ? rItem : lItem);
      } else if (lItem) {
        merged.push(lItem);
      } else if (rItem) {
        merged.push(rItem);
      }
      continue;
    }

    // Existed in base
    if (!lItem && !rItem) {
      continue;
    }
    if (!lItem && rItem) {
      // Deleted in local: drop if remote didn't modify it; keep remote if remote edited it
      if (rStr !== bStr) merged.push(rItem);
      continue;
    }
    if (lItem && !rItem) {
      // Deleted in remote: drop if local didn't modify it; keep local if local edited it
      if (lStr !== bStr) merged.push(lItem);
      continue;
    }

    // Present in both local and remote
    const localChanged = lStr !== bStr;
    const remoteChanged = rStr !== bStr;
    if (localChanged && !remoteChanged) {
      merged.push(lItem!);
    } else if (!localChanged && remoteChanged) {
      merged.push(rItem!);
    } else if (!localChanged && !remoteChanged) {
      merged.push(lItem!);
    } else {
      merged.push(prefer === 'remote' ? rItem! : lItem!);
    }
  }

  return merged;
}
