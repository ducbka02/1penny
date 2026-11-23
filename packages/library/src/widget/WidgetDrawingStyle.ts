import type { DrawingStyle } from '@1penny/commons';
import { createIcon } from './icons.js';
import { DrawingTemplateStore } from './DrawingTemplateStore.js';
import { EN_TRANSLATOR, type Translator } from './i18n.js';
import { escapeHtml } from './escapeHtml.js';

export interface DrawingStyleCallbacks {
  /** Apply a style change to the active (next) drawing and the selected one. */
  onStyleChange: (style: Partial<DrawingStyle>) => void;
  /** Current active drawing style, for seeding controls and saving templates. */
  getStyle: () => DrawingStyle;
}

/** The drawing colours offered here and on the selection toolbar. */
export const SWATCHES = ['#4c8dff', '#1fa874', '#e8505b', '#f2a93b', '#a57cff', '#1398a8', '#ffffff', '#7d8696'];
export const WIDTHS = [1, 2, 3, 4];
export const LINE_STYLES: DrawingStyle['lineStyle'][] = ['solid', 'dashed', 'dotted'];

/**
 * Drawing style popover — pick colour, line width, and line style for the next
 * drawing (and the selected one), plus save/apply named style templates
 * persisted via `DrawingTemplateStore`.
 */
export class WidgetDrawingStyle {
  private el: HTMLDivElement;
  private templatesEl: HTMLDivElement;
  private nameInput: HTMLInputElement;
  private callbacks: DrawingStyleCallbacks;
  private store: DrawingTemplateStore;
  private open = false;

  constructor(
    host: HTMLElement,
    callbacks: DrawingStyleCallbacks,
    store: DrawingTemplateStore,
    private readonly t: Translator = EN_TRANSLATOR,
  ) {
    this.callbacks = callbacks;
    this.store = store;

    this.el = document.createElement('div');
    this.el.className = 'pcw-style-panel';
    this.el.hidden = true;

    const header = document.createElement('div');
    header.className = 'pcw-style-header';
    const title = document.createElement('span');
    title.textContent = this.t('drawingStyle.title');
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pcw-style-close';
    closeBtn.setAttribute('aria-label', this.t('common.close'));
    closeBtn.innerHTML = createIcon('x', 14);
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(title);
    header.appendChild(closeBtn);
    this.el.appendChild(header);

    this.el.appendChild(this.colorRow());
    this.el.appendChild(this.widthRow());
    this.el.appendChild(this.lineStyleRow());

    // Templates
    const tmplHead = document.createElement('div');
    tmplHead.className = 'pcw-style-subhead';
    tmplHead.textContent = this.t('drawingStyle.templates');
    this.el.appendChild(tmplHead);

    const saveRow = document.createElement('div');
    saveRow.className = 'pcw-style-save';
    this.nameInput = document.createElement('input');
    this.nameInput.type = 'text';
    this.nameInput.placeholder = this.t('drawingStyle.templateName');
    this.nameInput.className = 'pcw-style-name';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'pcw-style-savebtn';
    saveBtn.innerHTML = `${createIcon('plus', 13)}<span>${escapeHtml(this.t('common.save'))}</span>`;
    saveBtn.addEventListener('click', () => this.saveTemplate());
    saveRow.appendChild(this.nameInput);
    saveRow.appendChild(saveBtn);
    this.el.appendChild(saveRow);

    this.templatesEl = document.createElement('div');
    this.templatesEl.className = 'pcw-style-templates';
    this.el.appendChild(this.templatesEl);

    host.appendChild(this.el);
    this.renderTemplates();
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    this.open ? this.close() : this.openPanel();
  }

  openPanel(): void {
    this.open = true;
    this.el.hidden = false;
    this.syncActiveControls();
    this.renderTemplates();
  }

  close(): void {
    this.open = false;
    this.el.hidden = true;
  }

  destroy(): void {
    this.el.remove();
  }

  private colorRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'pcw-style-row pcw-style-colors';
    for (const c of SWATCHES) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'pcw-style-swatch';
      sw.style.background = c;
      sw.dataset.color = c;
      sw.setAttribute('aria-label', c);
      sw.addEventListener('click', () => this.applyStyle({ color: c }));
      row.appendChild(sw);
    }
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'pcw-style-picker';
    picker.addEventListener('input', () => this.applyStyle({ color: picker.value }));
    row.appendChild(picker);
    return row;
  }

  private widthRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'pcw-style-row pcw-style-widths';
    for (const w of WIDTHS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pcw-style-width';
      btn.dataset.width = String(w);
      const bar = document.createElement('span');
      bar.style.height = `${w}px`;
      btn.appendChild(bar);
      btn.addEventListener('click', () => this.applyStyle({ lineWidth: w }));
      row.appendChild(btn);
    }
    return row;
  }

  private lineStyleRow(): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'pcw-style-row pcw-style-dashes';
    for (const ls of LINE_STYLES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pcw-style-dash';
      btn.dataset.linestyle = ls;
      btn.textContent = ls === 'solid' ? '──' : ls === 'dashed' ? '╌╌' : '┄┄';
      btn.title = ls;
      btn.addEventListener('click', () => this.applyStyle({ lineStyle: ls }));
      row.appendChild(btn);
    }
    return row;
  }

  private applyStyle(patch: Partial<DrawingStyle>): void {
    this.callbacks.onStyleChange(patch);
    this.syncActiveControls();
  }

  /** Mark the controls matching the current active style. */
  private syncActiveControls(): void {
    const style = this.callbacks.getStyle();
    this.el.querySelectorAll<HTMLElement>('.pcw-style-swatch').forEach((sw) => {
      sw.classList.toggle('pcw-on', sw.dataset.color?.toLowerCase() === style.color?.toLowerCase());
    });
    this.el.querySelectorAll<HTMLElement>('.pcw-style-width').forEach((b) => {
      b.classList.toggle('pcw-on', Number(b.dataset.width) === style.lineWidth);
    });
    this.el.querySelectorAll<HTMLElement>('.pcw-style-dash').forEach((b) => {
      b.classList.toggle('pcw-on', b.dataset.linestyle === style.lineStyle);
    });
  }

  private saveTemplate(): void {
    const name = this.nameInput.value.trim();
    if (!name) return;
    this.store.save(name, this.callbacks.getStyle());
    this.nameInput.value = '';
    this.renderTemplates();
  }

  private renderTemplates(): void {
    this.templatesEl.replaceChildren();
    const templates = this.store.list();
    if (templates.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pcw-style-empty';
      empty.textContent = this.t('drawingStyle.noTemplates');
      this.templatesEl.appendChild(empty);
      return;
    }
    for (const t of templates) {
      const row = document.createElement('div');
      row.className = 'pcw-style-template';

      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'pcw-style-apply';
      const dot = document.createElement('span');
      dot.className = 'pcw-style-tdot';
      dot.style.background = (t.style.color as string) ?? 'var(--1p-text-muted)';
      const label = document.createElement('span');
      label.textContent = t.name;
      apply.appendChild(dot);
      apply.appendChild(label);
      apply.addEventListener('click', () => {
        this.callbacks.onStyleChange({ ...t.style });
        this.syncActiveControls();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pcw-style-tdel';
      del.setAttribute('aria-label', this.t('drawingStyle.deleteTemplate'));
      del.innerHTML = createIcon('trash', 13);
      del.addEventListener('click', () => {
        this.store.remove(t.name);
        this.renderTemplates();
      });

      row.appendChild(apply);
      row.appendChild(del);
      this.templatesEl.appendChild(row);
    }
  }
}
