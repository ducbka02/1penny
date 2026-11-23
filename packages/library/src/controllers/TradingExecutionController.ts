import type {
  ChartEvent,
  ExecutionAdapter,
  ExecutionConfig,
  FillEvent,
  TradingOrder,
  TradingPosition,
} from '@1penny/commons';
import type { EventBus, TradingManager } from '@1penny/core';
import { wireExecution } from '../trading/wireExecution.js';

export interface TradingExecutionHost {
  eventBus: EventBus;
  tradingManager: TradingManager;
  isTradingEnabled: () => boolean;
  setOrders: (orders: TradingOrder[]) => void;
  setPositions: (positions: TradingPosition[]) => void;
  latestMarketPrice: () => number | null;
  onBeforeDisconnect: () => void;
}

/**
 * Coordinates the lifecycle of an `ExecutionAdapter` attached to a `Chart`:
 * intent wiring, bracket confirmation warnings, fill forwarding, and replay mark-price routing.
 */
export class TradingExecutionController {
  private adapter: ExecutionAdapter | null = null;
  private bracketsMode: 'event' | 'place' | null = null;
  private bracketsWarned = false;
  private bracketWarner: (() => void) | null = null;
  private teardown: (() => void) | null = null;

  constructor(private readonly host: TradingExecutionHost) {}

  connect(adapter: ExecutionAdapter, config: ExecutionConfig = {}): void {
    if (!this.host.isTradingEnabled()) {
      throw new Error('connectExecution requires features.trading to be enabled');
    }
    this.disconnect();
    this.adapter = adapter;
    this.bracketsMode = config.brackets ?? null;
    this.teardown = wireExecution(
      adapter,
      {
        onIntent: (type, handler) => {
          const wrapped = (e: ChartEvent) => handler(e.payload);
          this.host.eventBus.on(type, wrapped);
          return () => this.host.eventBus.off(type, wrapped);
        },
        setOrders: (orders) => this.host.setOrders(orders),
        setPositions: (positions) => this.host.setPositions(positions),
        onError: (error) => this.host.eventBus.emit('executionError', error),
        onFill: (fill: FillEvent) => {
          this.host.tradingManager.addFill(fill);
          this.host.eventBus.emit('executionFill', fill);
        },
        getPositions: () => this.host.tradingManager.getPositions(),
        marketPrice: () => this.host.latestMarketPrice(),
        onBracketOrder: (order, bracket) => this.host.eventBus.emit('bracketOrder', { order, bracket }),
      },
      { brackets: config.brackets },
    );
    if (config.brackets === undefined) this.warnOfUnsentBrackets();
    Promise.resolve(adapter.connect(config)).catch((cause) =>
      this.host.eventBus.emit('executionError', { message: 'Execution connect failed', cause }),
    );
  }

  disconnect(): void {
    this.host.onBeforeDisconnect();
    this.bracketsMode = null;
    this.stopBracketWarner();
    if (this.teardown) {
      this.teardown();
      this.teardown = null;
    }
    if (this.adapter) {
      this.adapter.disconnect();
      this.adapter = null;
    }
  }

  getAdapter(): ExecutionAdapter | null {
    return this.adapter;
  }

  placesBrackets(): boolean {
    return this.adapter !== null && this.bracketsMode === 'place';
  }

  acceptsMarkPrice(): boolean {
    return this.adapter?.setMarkPrice !== undefined;
  }

  feedMarkPrice(price: number, time?: number): boolean {
    if (!this.adapter?.setMarkPrice) return false;
    this.adapter.setMarkPrice(price, time);
    return true;
  }

  private warnOfUnsentBrackets(): void {
    if (this.bracketsWarned || this.bracketWarner) return;
    const warnOnce = () => {
      this.stopBracketWarner();
      this.bracketsWarned = true;
      console.warn(
        "[Chart] A bracket was confirmed with an execution adapter connected, and was not sent to it: only the bracketPlace event went out. connectExecution(adapter, { brackets: 'place' }) sends it as an order; { brackets: 'event' } keeps the event and says nothing. 'place' becomes the default in the next major version.",
      );
    };
    this.bracketWarner = warnOnce;
    this.host.eventBus.on('bracketPlace', warnOnce);
  }

  private stopBracketWarner(): void {
    if (!this.bracketWarner) return;
    this.host.eventBus.off('bracketPlace', this.bracketWarner);
    this.bracketWarner = null;
  }
}
