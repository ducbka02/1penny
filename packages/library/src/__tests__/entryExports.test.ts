import { describe, it, expect } from 'vitest';
import * as chart from '../index.js';

describe('@1penny/chart entry', () => {
  it('exports the realtime helpers its docs import from it', () => {
    // The realtime page imports these from '@1penny/chart', the one package an app installs.
    expect(typeof chart.ReconnectManager).toBe('function');
    expect(typeof chart.ReplayController).toBe('function');
  });
});
