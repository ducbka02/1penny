import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (file: string) => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const css = read('WidgetStyles.css');
const dialogs = read('WidgetDialogs.css');

/** The declarations of a rule written once at the top level of the stylesheet. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThan(-1);
  // Its declarations only: comments may name what it must not have.
  return css.slice(at, css.indexOf('}', at)).replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every block of `sheet` for `selector`, in a media query or not, its comments left out. */
const blocks = (sheet: string, selector: string) => [...sheet.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1].split(',').some((s) => s.trim() === selector))
  .map((m) => m[2]);

/** The part of `sheet` in its `@media (max-width: 640px)` blocks: the phone's rules. */
const phone = (sheet: string) => sheet.split('@media (max-width: 640px)').slice(1).map((part) => part.slice(0, part.indexOf('\n}\n'))).join('\n');

describe('the widget’s own box', () => {
  // Hidden overflow still scrolls when the keyboard lands on what is past the edge ("more" pushed out
  // by a long layout name shifted the whole widget left until a resize); clipped overflow never does.
  it('clips what is past its edges, where the browser can, so focus never scrolls it', () => {
    const root = rule('.pcw-root');
    expect(root).toMatch(/overflow:\s*hidden;\s*overflow:\s*clip;/);
  });
});

describe('the toolbar’s symbol', () => {
  // A long ticker on a 390 phone held its width and pushed "more" off the bar.
  it('gives way only when the fit squeezes it, its ticker cut short', () => {
    expect(rule('.pcw-toolbar-symbol')).not.toMatch(/min-width|flex-shrink/);
    // The button shows the ticker alone: nothing is left styling a venue on it.
    expect(css).not.toMatch(/pcw-toolbar-venue|pcw-toolbar-symbol--venue/);
    expect(rule(".pcw-toolbar[data-pcw-squeeze='cut'] > .pcw-toolbar-symbol")).toMatch(/min-width:\s*0/);
    const ticker = rule(".pcw-toolbar[data-pcw-squeeze='cut'] .pcw-toolbar-ticker");
    expect(ticker).toMatch(/min-width:\s*0/);
    expect(ticker).toMatch(/text-overflow:\s*ellipsis/);
  });
});

describe('frosted menus', () => {
  // `ui.blur` above 0 (the Capsule look) shows the chart through every menu, blurred: the right-click
  // and "more" menus showed it sharp behind their words.
  it.each(['.pcw-dropdown', '.pcw-flyout', '.pcw-context-menu'])('blurs what is under %s', (selector) => {
    const declarations = rule(selector);
    expect(declarations).toMatch(/(?<!-)backdrop-filter:\s*blur\(var\(--1p-blur\)\)/);
    expect(declarations).toMatch(/-webkit-backdrop-filter:\s*blur\(var\(--1p-blur\)\)/);
  });
});

describe('the shortcut sheet', () => {
  // Columns on the box that scrolls, a fixed height, lay the groups past its height sideways, out of reach.
  it('lays its groups in columns on a block inside the scroller, never on the scroller', () => {
    expect(blocks(dialogs, '.pcw-hotkey-body').join('')).not.toMatch(/columns/);
    expect(blocks(dialogs, '.pcw-hotkey-body')[0]).toMatch(/overflow-y:\s*auto/);
    expect(blocks(dialogs, '.pcw-hotkey-columns')[0]).toMatch(/columns:\s*2/);
  });
});

describe('the dock', () => {
  const panels = read('WidgetPanels.css').replace(/\/\*[\s\S]*?\*\//g, '');
  /** The declarations of the top-level rule for exactly `selector` in the panels' stylesheet. */
  const panelRule = (selector: string) => {
    const at = panels.indexOf(`\n${selector} {`);
    expect(at, selector).toBeGreaterThan(-1);
    return panels.slice(at, panels.indexOf('}', at));
  };

  // A page scrolls under its header; the watchlist's own rule, as specific and later, hid its overflow,
  // so 34 symbols in a 768 px window could not be scrolled to, by wheel or by keyboard.
  it('lets the watchlist’s page scroll as every page does', () => {
    expect(panelRule('.pcw-dock-panel > .pcw-dock-page')).toMatch(/overflow-y:\s*auto/);
    expect(panelRule('.pcw-dock-panel > .pcw-watchlist')).not.toMatch(/overflow/);
  });

  // The arrow keys up the watchlist left its first symbol under the sticky header; then 1-1.5 px
  // under it, the padding 34 px and the header 35 with the rule under it.
  it('scrolls a row the keyboard moves to in below the page’s header, its rule too, from one height', () => {
    const page = panelRule('.pcw-dock-page');
    expect(page).toMatch(/--1p-dock-head-h:\s*max\(calc\(var\(--1p-space-6\) \+ var\(--1p-space-5\)\), var\(--1p-control-h\)\);/);
    expect(page).toMatch(/--1p-dock-head-rule:\s*1px;/);
    const header = panelRule('.pcw-dock-page > :is(.pcw-watchlist-header, .pcw-alerts-header, .pcw-tree-header, .pcw-datawin-header, .pcw-syminfo-header, .pcw-ladder-header, .pcw-dock-host-header)');
    expect(header).toMatch(/min-height:\s*var\(--1p-dock-head-h\);/);
    expect(header).toMatch(/padding-block:\s*0;/);
    expect(header).toMatch(/border-bottom:\s*var\(--1p-dock-head-rule\) solid var\(--1p-divider\);/);
    expect(panelRule('.pcw-dock-panel > .pcw-dock-page')).toMatch(/scroll-padding-block-start:\s*calc\(var\(--1p-dock-head-h\) \+ var\(--1p-dock-head-rule\)\);/);
  });
});

describe('a dialog’s search field', () => {
  // A boxed field that lit up in the accent with a ring when focused looked loud in every search
  // dialog; the caret and the dialog itself already say where typing goes.
  const field = () => blocks(dialogs, '.pcw-ss-search').find((b) => /display:\s*flex/.test(b))!;

  it('is a band across the dialog, a rule under it, no box', () => {
    const band = field();
    expect(band).toMatch(/margin:\s*0;/);
    expect(band).toMatch(/border:\s*none;/);
    expect(band).toMatch(/border-bottom:\s*1px solid var\(--1p-divider\);/);
    expect(band).toMatch(/border-radius:\s*0;/);
    expect(band).toMatch(/padding:\s*0 var\(--1p-space-6\);/);
  });

  it('does not light up or ring when focused, but where the system sets the colours', () => {
    const forced = '@media (forced-colors: active)';
    const at = dialogs.indexOf(forced);
    expect(at).toBeGreaterThan(-1);
    const own = dialogs.slice(0, at) + dialogs.slice(dialogs.indexOf('\n}\n', at) + 3);
    expect(blocks(own, '.pcw-ss-search:focus-within').join('')).not.toMatch(/box-shadow|border-color|outline/);
    expect(dialogs.slice(at, dialogs.indexOf('\n}\n', at))).toMatch(/outline:\s*2px solid Highlight/);
  });

  it('types in the size above the text, as the reading it starts', () => {
    expect(blocks(dialogs, '.pcw-ss-search input')[0]).toMatch(/font-size:\s*var\(--1p-font-size-lg\);/);
  });

  // Each dialog drew its own rule under the band as well, or set the band in from the edges.
  it('keeps one rule under it and no inset of its own anywhere', () => {
    for (const below of ['.pcw-ip-body', '.pcw-hotkey-body', '.pcw-cp-results', '.pcw-layouts-body']) {
      expect(blocks(dialogs, below).join(''), below).not.toMatch(/border-top/);
    }
    expect(dialogs).not.toMatch(/\.pcw-cp \.pcw-cp-search\s*\{/);
    expect(phone(dialogs)).not.toMatch(/:is\(\.pcw-hotkey-search, \.pcw-cp-search, \.pcw-layouts-search-row\)/);
    expect(blocks(phone(dialogs), '.pcw-ss-search').join('')).not.toMatch(/margin/);
  });
});

describe('a dialog’s close', () => {
  // Drawn at 16, its cross was 8 px of 1.2 px lines under a 21 px title.
  it('is sized from the title, its icon root phi of the title, its target phi', () => {
    const close = rule('.pcw-modal-close');
    expect(close).toMatch(/--1p-close-box:\s*calc\(var\(--1p-font-size-display\) \* 1\.618\);/);
    expect(close).toMatch(/--1p-close-icon:\s*calc\(var\(--1p-font-size-display\) \* 1\.272\);/);
    expect(close).toMatch(/width:\s*var\(--1p-close-box\);/);
    expect(rule('.pcw-modal-close svg')).toMatch(/width:\s*var\(--1p-close-icon\);/);
    // The keyboard finds it.
    expect(rule('.pcw-modal-close:focus-visible')).toMatch(/box-shadow:\s*var\(--1p-ring\)/);
  });
});

describe('a search field’s clear button', () => {
  // The browser's own: bold, and blue in Chrome's light scheme.
  it('is the icon set’s close in the muted text', () => {
    const clear = blocks(dialogs, '.pcw-ss-search input::-webkit-search-cancel-button').join('');
    expect(clear).toMatch(/-webkit-appearance:\s*none/);
    expect(clear).toMatch(/background:\s*var\(--1p-text-muted\)/);
    expect(clear).toMatch(/M6 6L18 18M18 6L6 18/);
  });
});

describe('the symbol search', () => {
  // Eight kinds at 1366 wrap "Perpetual" onto a line of its own: the exchange list stays on the first.
  it('keeps the exchange list on the kind tabs’ first line when they wrap', () => {
    expect(blocks(dialogs, '.pcw-ss-filters')[0]).toMatch(/align-items:\s*flex-start/);
  });

  // On a phone "OKX:BTC-USDT-SWAP" showed "BTC-USDT-S…" beside a name with room, and one long exchange
  // held the exchange column at 89 on every row.
  // A feed's figure of 1e21 wrote every digit in a column as wide as it, and pushed the name out.
  it('keeps the price and change columns to a width, a huge figure cut in its own', () => {
    expect(blocks(dialogs, '.pcw-ss-results.pcw-ss--quoted')[0]).toContain('fit-content(144px) fit-content(144px) fit-content(89px) auto;');
    expect(phone(dialogs)).toMatch(/\.pcw-ss-results\.pcw-ss--quoted\s*\{\s*grid-template-columns:[^;]*minmax\(0, 1fr\) fit-content\(89px\) auto;/);
  });

  it('keeps a ticker whole on a phone before its name', () => {
    const rules = phone(dialogs);
    expect(rules).toMatch(/\.pcw-ss-results\s*\{\s*grid-template-columns:\s*max-content fit-content\(min\(144px, 38\.2%\)\) minmax\(0, 1fr\) auto;/);
  });

  // At 1920 the search stayed a 610 box, and "HYPERLIQUID:xyz:SP500" lost its venue to the ellipsis
  // in a 144 column with 8 px before its name.
  it('grows with a wide screen, phi steps from 610 to 987', () => {
    expect(blocks(dialogs, '.pcw-modal.pcw-ss')[0]).toMatch(/width:\s*min\(987px, max\(610px, 38\.2vw\)\);/);
  });

  // 'XYZ · HYPERLIQUID' showed 'XYZ · HYPERLI…' in an 89 px column beside a short name with room.
  it('lets an exchange take its width up to 144, the name giving way first', () => {
    expect(blocks(dialogs, '.pcw-ss-results')[0]).toContain('minmax(0, 1fr) fit-content(89px) fit-content(144px) auto;');
  });

  it('gives the symbol column up to 233 as the dialog grows, and a clear gap before the name', () => {
    expect(blocks(dialogs, '.pcw-ss-results')[0]).toMatch(/grid-template-columns:\s*max-content fit-content\(clamp\(144px, 25%, 233px\)\) minmax\(0, 1fr\)/);
    expect(blocks(dialogs, '.pcw-modal.pcw-ss').join('')).toMatch(/--1p-ss-name-gap:\s*var\(--1p-space-4\);/);
    // On the name's side: the cell is left to right in any widget, so a side, not its end.
    expect(blocks(dialogs, '.pcw-ss-symbol')[0]).toMatch(/padding-right:\s*var\(--1p-ss-name-gap\)/);
    const rtl = blocks(dialogs, "[dir='rtl'] .pcw-ss-symbol").join('');
    expect(rtl).toMatch(/padding-right:\s*0/);
    expect(rtl).toMatch(/padding-left:\s*var\(--1p-ss-name-gap\)/);
    // A phone keeps its column's room for the ticker.
    expect(blocks(phone(dialogs), '.pcw-modal.pcw-ss').join('')).toMatch(/--1p-ss-name-gap:\s*0px/);
    // As specific as the base, so it wins only after it.
    expect(dialogs.indexOf('--1p-ss-name-gap: 0px')).toBeGreaterThan(dialogs.indexOf('--1p-ss-name-gap: var(--1p-space-4)'));
  });
});

describe('the symbol search’s ticker', () => {
  // A row shows the ticker alone; the venue is the exchange column's.
  it('has nothing left styling a venue, and cuts a ticker only when it alone is wider', () => {
    expect(dialogs).not.toMatch(/pcw-ss-venue/);
    const ticker = blocks(dialogs, '.pcw-ss-ticker')[0];
    expect(ticker).toMatch(/text-overflow:\s*ellipsis/);
    expect(ticker).toMatch(/flex:\s*none/);
  });
});

describe('small boxes that scrolled a few px', () => {
  // Out to the menu's edges past its padding, the typed interval scrolled the menu 3 px both ways.
  it('takes the typed interval out to the timeframe menu’s edges and no further', () => {
    const custom = rule('.pcw-tf-custom');
    expect(custom).not.toMatch(/-6px/);
    expect(custom).toMatch(/bottom:\s*calc\(-1 \* var\(--1p-menu-pad\)\)/);
    expect(custom).toMatch(/margin:\s*4px calc\(-1 \* var\(--1p-menu-pad\)\) calc\(-1 \* var\(--1p-menu-pad\)\)/);
  });

  // The first and last buttons' 1px margins added 2 px past the padding: at 1366 x 768 it scrolled by them.
  it('counts the drawing tools’ end margins in the sidebar’s padding', () => {
    expect(rule('.pcw-sidebar')).toMatch(/padding:\s*calc\(var\(--1p-space-3\) - 1px\) 0/);
    expect(rule('.pcw-sidebar-btn')).toMatch(/margin:\s*1px 0/);
  });

  // Each value shrinking on its own cut all three of Bollinger's at once on a phone ("98… 98… 97…"):
  // as one line of text, the values before the cut stay whole and one ellipsis ends the line.
  it('ends a legend’s values in one ellipsis where a narrow chart cuts them, the values before it whole', () => {
    const box = rule('.pcw-ind-legend-values');
    expect(box).toMatch(/display:\s*block/);
    expect(box).toMatch(/min-width:\s*0/);
    expect(box).toMatch(/overflow:\s*hidden/);
    expect(box).toMatch(/text-overflow:\s*ellipsis/);
    expect(blocks(css, '.pcw-ind-legend-values > *').join('')).not.toMatch(/min-width|overflow|flex/);
    expect(rule('.pcw-ind-legend-values > * + *')).toMatch(/margin-inline-start:\s*var\(--1p-space-4\)/);
  });

  // Hidden, not gone: the box keeps its room, so it is measured again and the values come back.
  it('hides a legend’s values with no room for a digit and an ellipsis, keeping their room', () => {
    const declarations = rule('.pcw-ind-legend-values--no-room');
    expect(declarations).toMatch(/visibility:\s*hidden/);
    expect(declarations).not.toMatch(/display/);
  });
});

describe('the dialogs’ layout rules', () => {
  // A dialog is a column with a height cap: a part of it with an overflow of its own loses its
  // minimum height, and a long body squashes it (1.16.0 squashed the Settings' tabs this way).
  it('keeps the tabs of a dialog their height, whatever its body holds', () => {
    const tabs = rule('.pcw-modal-tabs');
    expect(tabs).toMatch(/flex-shrink:\s*0/);
    expect(tabs).not.toMatch(/overflow/);
  });

  it('lets a narrow dialog span a phone screen like every sheet', () => {
    const at = css.indexOf('.pcw-modal-narrow {');
    expect(at).toBeGreaterThan(-1);
    const before = css.slice(0, at);
    expect(before.lastIndexOf('@media (min-width: 641px)')).toBeGreaterThan(before.lastIndexOf('}\n\n'));
  });
});

describe('a watchlist row’s remove button', () => {
  // Shown on focus from the keyboard (or on hover), it sat over the price and the change.
  it('has a column of its own after the numbers, never over them', () => {
    // The list is one grid, its columns set by the script, with a last one for the button when rows
    // can be removed; every row is a subgrid of it, so the button keeps that column.
    expect(rule('.pcw-watchlist-list')).toMatch(/grid-template-columns:\s*var\(--1p-watchlist-columns/);
    expect(rule('.pcw-watchlist-row')).toMatch(/grid-template-columns:\s*subgrid/);
    // An empty list's message spans the grid; placed as a cell it fell into the 2px gutter.
    expect(rule('.pcw-watchlist-empty')).toMatch(/grid-column:\s*1 \/ -1/);
  });

  it('keeps its rows short, and drops the move first in a narrow panel', () => {
    expect(rule('.pcw-watchlist-row')).not.toMatch(/padding:\s*\d+px \d/);
    expect(css).toMatch(/\.pcw-watchlist-row \{[^}]*min-height:\s*24px/);
    expect(rule('.pcw-watchlist')).toMatch(/container:\s*pcw-watchlist \/ inline-size/);
    // Under 300: at the dock's 262, "PEPE/USDT" at 0.00000528, its move -0.00000003, left the names
    // "ETH/US…" and "DOGE/…".
    expect(css).toMatch(/@container pcw-watchlist \(width < 300px\) \{\s*\.pcw-watchlist-move,\s*\.pcw-watchlist-column-move \{\s*display:\s*none/);
    const button = rule('.pcw-watchlist-remove');
    expect(button).not.toMatch(/position:\s*absolute/);
    expect(button).toMatch(/width:\s*var\(--1p-watchlist-remove\)/);
  });
});

describe('the phone’s drawing button', () => {
  it('sits in from the bottom of the price pane the widget sets, not the bottom of the chart', () => {
    const fab = rule(".pcw-root[data-pcw-narrow] > .pcw-body > .pcw-sidebar-fab");
    expect(fab).toContain('bottom: calc(var(--1p-fab-plot-bottom, 34px) + 10px);');
    expect(fab).not.toContain('bottom: 44px');
  });
});
