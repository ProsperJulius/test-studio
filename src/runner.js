const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const { describeStep, metaFor, usesGrid } = require('./describe');
const { substitute, stepRefs, missingFor, expandSteps, resolveGrid, locatorsFor, resolveStep } = require('./steps');
const captureText = require('./capture');
const pw = require('./pw-session');

let running = false;
let cancelled = false;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Locators that depend on page layout or wording rather than a stable attribute.
const FRAGILE_LOCATORS = ['text', 'css', 'css-path', 'nth'];

// ---------- Functions injected into the page under test ----------
// These are serialised with toString(), so they must be self-contained.
function studioAct(loc, action, value, fieldAction) {
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const attr = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const q = (sel) => {
    try { return Array.from(document.querySelectorAll(sel)); } catch (e) { return []; }
  };
  const firstVisible = (list) => list.find(visible) || null;
  const deepest = (list) => list.filter((e) => !list.some((o) => o !== e && e.contains(o)));

  const fieldSel = 'input,select,textarea,[contenteditable="true"]';
  const clickSel = 'button,a,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],input[type=submit],input[type=button],input[type=checkbox],input[type=radio],summary,label,li,td,th,span,div,p,h1,h2,h3,h4,h5,h6';

  const controlForLabel = (text) => {
    const labels = q('label').filter((l) => norm(l.innerText).replace(/\s*\*$/, '') === text);
    for (const l of labels) {
      if (l.htmlFor) {
        const c = document.getElementById(l.htmlFor);
        if (visible(c)) return c;
      }
      const inner = l.querySelector('input,select,textarea');
      if (visible(inner)) return inner;
    }
    return firstVisible(q('[aria-label="' + attr(text) + '"]'));
  };

  const strategies = [
    ['test id', () => loc.testId && firstVisible(q('[data-testid="' + attr(loc.testId) + '"],[data-test="' + attr(loc.testId) + '"],[data-qa="' + attr(loc.testId) + '"],[data-cy="' + attr(loc.testId) + '"]'))],
    ['id', () => { const el = loc.id && document.getElementById(loc.id); return visible(el) ? el : null; }],
    ['label', () => loc.label && controlForLabel(loc.label)],
    ['placeholder', () => loc.placeholder && firstVisible(q('[placeholder="' + attr(loc.placeholder) + '"]'))],
    ['name', () => loc.name && firstVisible(q('[name="' + attr(loc.name) + '"]'))],
    ['text', () => {
      if (!loc.text || fieldAction) return null;
      const matches = q(clickSel).filter((e) => visible(e) && (norm(e.innerText) === loc.text || norm(e.value) === loc.text));
      return deepest(matches)[0] || null;
    }],
    ['css', () => loc.css && firstVisible(q(loc.css))]
  ];

  let el = null;
  let used = null;
  let wanted;
  if (loc.marked) {
    // Playwright matched this step in the main process and tagged the one element it found.
    el = document.querySelector('[data-ts-target]');
    wanted = loc.source;
    if (!el) return { ok: false, reason: 'Could not find ' + loc.source + ' on the page.' };
    if (fieldAction && !(el.matches(fieldSel) || el.isContentEditable)) {
      return { ok: false, fatal: true, reason: loc.source + ' is a ' + el.nodeName.toLowerCase() + ', not a field that can be typed into or selected.' };
    }
    used = 'locator';
  } else {
    for (const [name, find] of strategies) {
      try {
        const found = find();
        if (found && (!fieldAction || found.matches(fieldSel) || found.isContentEditable)) {
          el = found;
          used = name;
          break;
        }
      } catch (e) { /* try next */ }
    }
    wanted = '“' + (loc.label || loc.text || loc.placeholder || loc.testId || loc.name || loc.css || 'element') + '”';

    if (action === 'Verify element is hidden') {
      return el ? { ok: false, used, reason: wanted + ' is still visible.' } : { ok: true, used: null };
    }
    if (!el) return { ok: false, reason: 'Could not find ' + wanted + ' on the page.' };
  }

  el.scrollIntoView({ block: 'center', inline: 'center' });
  const disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.closest('fieldset[disabled]'));

  switch (action) {
    case 'Click':
    case 'Double-click':
    case 'Right-click': {
      // AG Grid and its popups react to real mouse events; everything else keeps a plain click.
      const needsMouse = action !== 'Click' || !!el.closest('.ag-root-wrapper,.ag-popup,.ag-menu,.ag-popup-child');
      if (!needsMouse) { el.click(); break; }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === el || el.contains(hit))) return { ok: true, used, mouse: { x, y } };
      // Something covers the element: fall back to a synthetic event.
      if (action === 'Click') el.click();
      else el.dispatchEvent(new MouseEvent(action === 'Double-click' ? 'dblclick' : 'contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: action === 'Right-click' ? 2 : 0 }));
      break;
    }
    case 'Read text':
      return { ok: true, used, text: norm(el.innerText || el.value) };
    case 'Type': {
      el.focus();
      if (el.isContentEditable) {
        el.innerText = value;
      } else {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    case 'Select': {
      if (!(el instanceof HTMLSelectElement)) return { ok: false, fatal: true, reason: wanted + ' is not a dropdown.' };
      const opt = Array.from(el.options).find((o) => o.value === value || norm(o.text) === norm(value));
      if (!opt) return { ok: false, reason: 'Option “' + value + '” is not available in ' + wanted + '.' };
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      break;
    }
    case 'Press Enter':
      el.focus();
      break;
    case 'Verify element is visible':
      break;
    case 'Verify element is enabled':
      if (disabled) return { ok: false, used, reason: wanted + ' is disabled.' };
      break;
    case 'Verify element is disabled':
      if (!disabled) return { ok: false, used, reason: wanted + ' is enabled.' };
      break;
    case 'Verify field value': {
      if (el.type === 'checkbox' || el.type === 'radio') {
        const wantChecked = ['checked', 'true', 'yes', 'on', 'selected', 'ticked'].includes(norm(value).toLowerCase());
        if (el.checked !== wantChecked) return { ok: false, used, reason: wanted + ' is ' + (el.checked ? 'checked' : 'unchecked') + '.' };
        break;
      }
      let actual;
      if (el instanceof HTMLSelectElement) {
        const opt = el.options[el.selectedIndex];
        actual = opt && norm(opt.text) === norm(value) ? norm(opt.text) : el.value;
      } else {
        actual = el.isContentEditable ? el.innerText : el.value;
      }
      if (norm(actual) !== norm(value)) return { ok: false, used, reason: wanted + ' is “' + norm(actual) + '”, expected “' + norm(value) + '”.' };
      break;
    }
    case 'Verify element text': {
      const actual = norm(el.innerText || el.value);
      if (!actual.includes(norm(value))) return { ok: false, used, reason: wanted + ' shows “' + actual.slice(0, 200) + '”, expected it to contain “' + norm(value) + '”.' };
      break;
    }
    default:
      break;
  }
  return { ok: true, used };
}

// Finds a cell, header or filter in an AG Grid and acts on it or returns where to click.
// scanId identifies one step, so scrolling to search for a row continues between calls.
function studioGrid(g, rowValue, action, value, scanId) {
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const roots = Array.from(document.querySelectorAll('.ag-root-wrapper'));
  if (!roots.length) return { ok: false, reason: 'No AG Grid was found on the page.' };

  const gridLabel = (root) => {
    let node = root;
    for (let depth = 0; node && node !== document.body && depth < 5; depth++, node = node.parentElement) {
      const aria = node.getAttribute && node.getAttribute('aria-label');
      if (norm(aria)) return norm(aria);
      for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
        const heads = sib.matches('h1,h2,h3,h4,h5,h6,[role=heading]') ? [sib] : Array.from(sib.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]'));
        const h = heads.reverse().find((x) => norm(x.innerText));
        if (h) return norm(h.innerText).slice(0, 60);
      }
    }
    return null;
  };

  const want = g.grid || {};
  const root = (want.label && roots.find((r) => gridLabel(r) === want.label)) || roots[want.index || 0] || roots[0];
  const gridName = want.label ? 'the ' + want.label + ' grid' : 'the grid';
  const st = root.__tsScan && root.__tsScan.id === scanId ? root.__tsScan : (root.__tsScan = { id: scanId, v: 'start', h: 'start' });
  // AG Grid 36 and later scroll rows and columns with one .ag-grid-viewport element.
  const v36 = root.querySelector('.ag-grid-viewport');
  const vp = root.querySelector('.ag-body-viewport') || v36;
  const hp = v36 || root.querySelector('.ag-body-horizontal-scroll-viewport') || root.querySelector('.ag-center-cols-viewport');

  // Scrolls one page at a time to bring virtualised rows or columns into the page.
  const scan = (axis, reason) => {
    const el = axis === 'v' ? vp : hp;
    const pos = axis === 'v' ? 'scrollTop' : 'scrollLeft';
    const size = axis === 'v' ? 'clientHeight' : 'clientWidth';
    const total = axis === 'v' ? 'scrollHeight' : 'scrollWidth';
    if (!el || el[total] <= el[size] + 1 || st[axis + 'Done']) return { ok: false, reason };
    if (st[axis] === 'start') {
      st[axis] = 'scanning';
      el[pos] = 0;
      return { ok: false, scrolled: true, reason };
    }
    if (el[pos] + el[size] >= el[total] - 1) {
      st[axis + 'Done'] = true;
      return { ok: false, reason };
    }
    el[pos] += Math.max(40, el[size] * 0.8);
    return { ok: false, scrolled: true, reason };
  };

  const headers = () => Array.from(root.querySelectorAll('.ag-header-row-column .ag-header-cell, .ag-header-cell'));
  const headerFor = (col) => {
    if (!col) return null;
    const list = headers();
    return (col.colId && list.find((c) => c.getAttribute('col-id') === col.colId)) ||
      (col.header && list.find((c) => norm((c.querySelector('.ag-header-cell-text') || c).innerText) === norm(col.header))) || null;
  };
  const colName = (col) => (col && (col.header || col.colId)) || 'column';
  const part = g.part || 'cell';
  const column = g.column || {};

  let el = null;
  let wantEdit = false;
  if (part === 'header' || part === 'header-menu' || part === 'header-filter' || part === 'floating-filter') {
    const h = headerFor(column);
    if (!h) return scan('h', 'Column “' + colName(column) + '” was not found in ' + gridName + '.');
    if (part === 'header') el = h.querySelector('.ag-header-cell-text') || h;
    else if (part === 'header-filter') el = h.querySelector('.ag-header-cell-filter-button');
    else if (part === 'header-menu') {
      el = h.querySelector('.ag-header-cell-menu-button');
      const r = el && el.getBoundingClientRect();
      if (!el || !r.width || getComputedStyle(el).opacity === '0') {
        // The menu button appears when the mouse is over the header.
        const hr = h.getBoundingClientRect();
        if (!st.hovered) {
          st.hovered = true;
          return { ok: false, scrolled: true, hover: { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 }, reason: 'The column menu button of “' + colName(column) + '” did not appear.' };
        }
        if (!el || !r.width) return { ok: false, reason: 'The column menu button of “' + colName(column) + '” did not appear.' };
      }
    } else {
      const idx = h.getAttribute('aria-colindex');
      const box = root.querySelector('.ag-floating-filter[aria-colindex="' + esc(idx) + '"]');
      el = box && box.querySelector('input');
    }
    if (!el) return { ok: false, reason: 'The ' + part.replace('header-', '') + ' of column “' + colName(column) + '” was not found in ' + gridName + '.' };
  } else {
    // Find the row: remembered from an earlier call, by key column value, or by position.
    const r = g.row || {};
    const contains = r.match === 'contains';
    const hidden = action === 'Verify element is hidden';
    const parts = r.mode === 'path' ? String(rowValue || '').split(/\s+(?:›|>|\/)\s+/).map(norm).filter(Boolean) : [];
    const describeRow = r.mode === 'index' ? 'Row ' + ((Number(r.index) || 0) + 1)
      : r.mode === 'path' ? 'Row “' + parts.join(' › ') + '”'
      : 'Row where ' + colName(r.column) + (contains ? ' contains “' : ' is “') + rowValue + '”';
    // A row that is not in the grid only counts as missing once the whole grid has been searched.
    const missing = (res) => (res.scrolled ? res : { ...res, missing: true });
    if (hidden && !root.querySelector('.ag-row, .ag-overlay-no-rows-wrapper, .ag-overlay-no-rows-center')) {
      return { ok: false, reason: gridName + ' has not finished loading.' };
    }
    // Rows still coming from a server (for example the children of a folder just opened) are never
    // reported as missing: wait for them instead.
    const loading = () => root.querySelector('.ag-row-loading, .ag-row .ag-loading, .ag-skeleton-container');
    // Checks do not change the grid, so only these actions open collapsed folders on a path.
    const opensFolders = ['Click', 'Double-click', 'Right-click', 'Type', 'Press Enter'].includes(action);
    const rowSel = () => st.rowId != null ? '.ag-row[row-id="' + esc(st.rowId) + '"]' : '.ag-row[row-index="' + esc(st.rowIndex) + '"]';
    if (st.rowId == null && st.rowIndex == null || !root.querySelector(rowSel())) {
      // The row that was found has gone, so search the whole grid again.
      if (hidden && (st.rowId != null || st.rowIndex != null)) { st.v = 'start'; st.vDone = false; st.path = null; }
      st.rowId = st.rowIndex = null;
      let row = null;
      if (r.mode === 'index') {
        row = root.querySelector('.ag-row[row-index="' + (Number(r.index) || 0) + '"]');
        if (!row && vp) {
          const sample = root.querySelector('.ag-center-cols-container .ag-row') || root.querySelector('.ag-row');
          const height = sample ? sample.offsetHeight : 40;
          if (!st.jumped) {
            st.jumped = true;
            vp.scrollTop = Math.max(0, (Number(r.index) || 0) * height - vp.clientHeight / 2);
            return { ok: false, scrolled: true, reason: describeRow + ' was not found in ' + gridName + '.' };
          }
        }
        if (!row) return { ok: false, missing: true, reason: describeRow + ' was not found in ' + gridName + '.' };
      } else if (r.mode === 'path') {
        // Tree data: walk the rows from the top, keeping the names of the folders above each row,
        // and open collapsed folders on the way. Checking that a row is not shown does not open folders.
        if (!parts.length) return { ok: false, reason: 'No path is set for the row.' };
        const key = headerFor(r.column);
        const anyTree = root.querySelector('.ag-cell .ag-group-value');
        const keyId = key ? key.getAttribute('col-id') : (r.column && r.column.colId) || (anyTree && anyTree.closest('.ag-cell').getAttribute('col-id'));
        if (!keyId || !root.querySelector('.ag-cell[col-id="' + esc(keyId) + '"]')) {
          if (!root.querySelector('.ag-row')) return { ok: false, reason: gridName + ' has not finished loading.' };
          return scan('h', 'Column “' + colName(r.column) + '” was not found in ' + gridName + '.');
        }
        if (!st.path) {
          st.path = { stack: [], last: -1, deepest: 0 };
          if (vp && vp.scrollTop > 0) {
            vp.scrollTop = 0;
            st.v = 'scanning';
            return { ok: false, scrolled: true, reason: describeRow + ' was not found in ' + gridName + '.' };
          }
        }
        const p = st.path;
        const rows = Array.from(root.querySelectorAll('.ag-cell[col-id="' + esc(keyId) + '"]'))
          .map((c) => ({ cell: c, row: c.closest('.ag-row') }))
          .filter((x) => x.row && Number.isFinite(Number(x.row.getAttribute('row-index'))))
          .sort((a, b) => Number(a.row.getAttribute('row-index')) - Number(b.row.getAttribute('row-index')));
        // Rows that are loading, or whose name has not been drawn yet, cannot be placed in the tree.
        if (loading() || rows.some((x) => !norm(x.cell.innerText))) return { ok: false, reason: gridName + ' is still loading rows.' };
        // Rows are read strictly in order, so a row's folders are always read before it.
        for (const { cell: c, row: rowEl } of rows) {
          const index = Number(rowEl.getAttribute('row-index'));
          if (index <= p.last) continue;
          if (index !== p.last + 1) break;
          p.last = index;
          const level = Number((rowEl.className.match(/ag-row-level-(\d+)/) || [0, 0])[1]);
          p.stack.length = Math.min(p.stack.length, level);
          p.stack[level] = norm((c.querySelector('.ag-group-value') || c).innerText);
          const path = p.stack.slice(0, level + 1);
          if (path.length > parts.length || path.some((name, i) => name !== parts[i])) continue;
          p.deepest = Math.max(p.deepest, path.length);
          if (path.length === parts.length) { row = rowEl; st.path = null; break; }
          const collapsed = rowEl.getAttribute('aria-expanded') === 'false' || c.getAttribute('aria-expanded') === 'false';
          const arrow = collapsed && Array.from(c.querySelectorAll('.ag-group-contracted')).find((a) => !a.classList.contains('ag-hidden'));
          if (arrow && opensFolders) {
            arrow.click();
            st.path = null;
            st.v = 'start';
            st.vDone = false;
            return { ok: false, scrolled: true, reason: 'Could not open “' + path[path.length - 1] + '” in ' + gridName + '.' };
          }
          if (collapsed && !hidden) {
            st.path = null;
            return { ok: false, reason: '“' + parts[parts.length - 1] + '” is inside the collapsed folder “' + path.join(' › ') + '”.' };
          }
        }
        // Before scrolling on, every row showing in the grid must have been read. The grid may still be
        // drawing the rows at the new scroll position; rows it keeps off screen (such as the focused row) do not count.
        const box = vp && vp.getBoundingClientRect();
        const inView = (el) => { const b = el.getBoundingClientRect(); return b.height > 0 && (!box || (b.bottom > box.top && b.top < box.bottom)); };
        const shown = rows.filter((x) => inView(x.row));
        if (!row && (!shown.length || shown.some((x) => Number(x.row.getAttribute('row-index')) > p.last))) {
          // Give the grid time to draw; if a gap stays, scroll back a little in case a page was skipped.
          p.gapWait = (p.gapWait || 0) + 1;
          if (p.gapWait > 8 && vp) {
            vp.scrollTop = Math.max(0, vp.scrollTop - vp.clientHeight / 2);
            p.gapWait = 0;
          }
          return { ok: false, scrolled: true, reason: describeRow + ' was not found in ' + gridName + '.' };
        }
        if (!row) {
          const where = p.deepest ? '“' + parts[p.deepest] + '” was not found under “' + parts.slice(0, p.deepest).join(' › ') + '”' : '“' + parts[0] + '” was not found';
          const res = missing(scan('v', where + ' in ' + gridName + '.'));
          if (!res.scrolled) st.path = null;
          return res;
        }
      } else {
        const key = headerFor(r.column);
        const keyId = key ? key.getAttribute('col-id') : r.column && r.column.colId;
        const keyCells = keyId ? Array.from(root.querySelectorAll('.ag-cell[col-id="' + esc(keyId) + '"]')) : [];
        if (!key && !keyCells.length) return scan('h', 'Column “' + colName(r.column) + '” was not found in ' + gridName + '.');
        const wanted = norm(rowValue).toLowerCase();
        const match = keyCells.find((c) => (contains ? norm(c.innerText).toLowerCase().includes(wanted) : norm(c.innerText) === norm(rowValue)));
        if (!match) {
          // Keep scrolling while rows arrive, rather than standing still until the step times out.
          const res = scan('v', describeRow + ' was not found in ' + gridName + '.');
          if (res.scrolled) return res;
          // Rows still coming from a server are not the same as a row that is not there, so the
          // search is not finished and “not in the grid” must not pass yet.
          if (loading()) return { ok: false, reason: gridName + ' is still loading rows.' };
          return missing(res);
        }
        row = match.closest('.ag-row');
      }
      st.rowId = row.getAttribute('row-id');
      st.rowIndex = row.getAttribute('row-index');
      st.h = 'start';
      st.hDone = false;
    }
    if (hidden) return { ok: true, rowFound: true, reason: describeRow + ' is still in ' + gridName + '.' };

    const h = headerFor(column);
    let colId = h ? h.getAttribute('col-id') : column.colId;
    if (!colId && ['expand', 'collapse', 'select', 'deselect'].includes(g.inner)) {
      // Expanding and selecting need no column: use the column that shows the tree.
      const treeCell = root.querySelector(rowSel() + ' .ag-group-value');
      colId = treeCell && treeCell.closest('.ag-cell').getAttribute('col-id');
    }
    const cell = colId && root.querySelector(rowSel() + ' .ag-cell[col-id="' + esc(colId) + '"]');
    if (!cell) return scan('h', 'Column “' + colName(column) + '” was not found in ' + gridName + '.');
    el = cell;
    if (g.inner === 'select' || g.inner === 'deselect') {
      const boxes = Array.from(root.querySelectorAll(rowSel() + ' .ag-group-checkbox, ' + rowSel() + ' .ag-selection-checkbox'));
      const box = boxes.find((b) => !b.classList.contains('ag-invisible') && !b.classList.contains('ag-hidden') && b.getBoundingClientRect().width);
      if (!box) return { ok: false, reason: describeRow + ' has no selection checkbox.' };
      const input = box.querySelector('input');
      const selected = input ? input.checked : cell.closest('.ag-row').getAttribute('aria-selected') === 'true';
      if (selected === (g.inner === 'select')) return { ok: true, used: 'grid' };
      el = box.querySelector('.ag-checkbox-input-wrapper') || box;
    } else if (g.inner === 'expand' || g.inner === 'collapse') {
      const rowEl = cell.closest('.ag-row');
      const open = rowEl.getAttribute('aria-expanded') || cell.getAttribute('aria-expanded');
      if ((g.inner === 'expand' && open === 'true') || (g.inner === 'collapse' && open === 'false')) return { ok: true, used: 'grid' };
      const arrows = Array.from(root.querySelectorAll(rowSel() + ' ' + (g.inner === 'expand' ? '.ag-group-contracted' : '.ag-group-expanded')));
      el = arrows.find((a) => !a.classList.contains('ag-hidden') && a.getBoundingClientRect().width);
      if (!el) return { ok: false, reason: describeRow + ' has no children to ' + g.inner + '.' };
    } else if (g.inner) {
      el = cell.querySelector(g.inner === 'a' ? 'a' : 'button,[role=button]');
      if (!el) return { ok: false, reason: 'There is no ' + (g.inner === 'a' ? 'link' : 'button') + ' in the “' + colName(column) + '” cell.' };
    }

    if (action === 'Verify element is visible') return { ok: true, used: 'grid' };
    if (action === 'Verify element text') {
      const actual = norm(cell.innerText);
      return actual.includes(norm(value)) ? { ok: true, used: 'grid' } : { ok: false, used: 'grid', reason: 'The “' + colName(column) + '” cell shows “' + actual.slice(0, 200) + '”, expected it to contain “' + norm(value) + '”.' };
    }
    const editor = cell.querySelector('input:not([type=checkbox]):not([type=radio]),textarea,[contenteditable="true"]');
    if (action === 'Type' && !editor) {
      // Open the cell editor with a double-click, once, then type on the next call.
      if (st.editTried) return { ok: false, reason: 'The “' + colName(column) + '” cell did not open for editing. Check that the column is editable.' };
      wantEdit = true;
    } else if (action === 'Type') {
      editor.focus();
      if (editor.isContentEditable) editor.innerText = value;
      else Object.getOwnPropertyDescriptor(editor instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(editor, value);
      editor.dispatchEvent(new Event('input', { bubbles: true }));
      editor.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, used: 'grid' };
    }
    if (action === 'Press Enter') {
      (editor || cell).focus();
      return { ok: true, used: 'grid' };
    }
  }

  if (part === 'floating-filter' && (action === 'Type' || action === 'Press Enter')) {
    el.focus();
    if (action === 'Type') {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { ok: true, used: 'grid' };
  }

  // Mouse actions: make sure the element is inside the visible part of the grid first.
  const rect = el.getBoundingClientRect();
  // How far to scroll to bring lo..hi inside min..max. A cell can be wider or taller than the space
  // it is shown in — a long name or tree column between pinned columns, or a row under sticky folder
  // rows — and then it never fits. Line its leading edge up and work with the part that shows,
  // instead of scrolling one edge into view and the other out of it for ever.
  const shift = (lo, hi, min, max) => {
    if (hi - lo >= max - min) return lo > min ? lo - min : hi < max ? hi - max : 0;
    if (lo < min) return lo - min - 4;
    if (hi > max) return hi - max + 4;
    return 0;
  };
  let band = null;
  if (vp && part === 'cell') {
    const box = vp.getBoundingClientRect();
    // In AG Grid 36 the header and the scrollbars are inside the viewport, so use the area rows are shown in.
    const header = root.querySelector('.ag-header');
    const v = {
      top: header && vp.contains(header) ? header.getBoundingClientRect().bottom : box.top,
      bottom: box.top + vp.clientTop + vp.clientHeight,
      left: box.left + vp.clientLeft,
      right: box.left + vp.clientLeft + vp.clientWidth
    };
    // Folder rows that stick to the top while scrolling, and rows pinned to the top or bottom such as
    // a totals row, are drawn over the scrolling rows. A cell under one of them cannot be clicked,
    // and in AG Grid 36 they are inside the viewport, so the area rows can be used in is smaller.
    const TOP_BANDS = '.ag-grid-sticky-top-rows-container, .ag-sticky-top-container, .ag-grid-pinned-top-rows, .ag-floating-top';
    const BOTTOM_BANDS = '.ag-grid-sticky-bottom-rows-container, .ag-sticky-bottom-container, .ag-grid-pinned-bottom-rows, .ag-floating-bottom';
    if (!el.closest('[class*="sticky"], ' + TOP_BANDS + ', ' + BOTTOM_BANDS)) {
      for (const s of root.querySelectorAll(TOP_BANDS)) {
        const r = s.getBoundingClientRect();
        if (r.height && !s.classList.contains('ag-hidden')) v.top = Math.max(v.top, r.bottom);
      }
      for (const s of root.querySelectorAll(BOTTOM_BANDS)) {
        const r = s.getBoundingClientRect();
        if (r.height && !s.classList.contains('ag-hidden')) v.bottom = Math.min(v.bottom, r.top);
      }
    }
    const dy = shift(rect.top, rect.bottom, v.top, v.bottom);
    if (dy) {
      vp.scrollTop += dy;
      return { ok: false, scrolled: true, reason: 'Could not scroll to the “' + colName(column) + '” cell.' };
    }
    const pinned = el.closest('.ag-pinned-left-cols-container,.ag-pinned-right-cols-container,.ag-grid-pinned-left-cells,.ag-grid-pinned-right-cells');
    let c = null;
    const center = root.querySelector('.ag-center-cols-viewport');
    if (center) c = center.getBoundingClientRect();
    else if (v36) {
      // Scrolling columns pass under the pinned columns, so the visible band is between them.
      const rowEl = el.closest('.ag-row');
      const edge = (sel) => { const e = rowEl && rowEl.querySelector(sel); const r = e && e.getBoundingClientRect(); return r && r.width ? r : null; };
      const left = edge('.ag-grid-pinned-left-cells');
      const right = edge('.ag-grid-pinned-right-cells');
      c = { left: left ? left.right : v.left, right: right ? right.left : v.right };
    }
    band = { top: v.top, bottom: v.bottom, left: v.left, right: v.right };
    if (c && hp && !pinned) {
      band.left = Math.max(v.left, c.left);
      band.right = Math.min(v.right, c.right);
      const dx = shift(rect.left, rect.right, band.left, band.right);
      if (dx) {
        hp.scrollLeft += dx;
        return { ok: false, scrolled: true, reason: 'Could not scroll to the “' + colName(column) + '” cell.' };
      }
    }
  }
  // Aim at the middle of the part that is showing, which is not the middle of an oversized cell.
  const within = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi));
  let x = rect.left + rect.width / 2;
  let y = rect.top + rect.height / 2;
  if (band) {
    x = within(x, Math.max(rect.left, band.left) + 2, Math.min(rect.right, band.right) - 2);
    y = within(y, Math.max(rect.top, band.top) + 2, Math.min(rect.bottom, band.bottom) - 2);
  }
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(hit === el || el.contains(hit) || (el.closest('.ag-cell') && el.closest('.ag-cell').contains(hit)))) {
    return { ok: false, reason: 'The “' + colName(column) + '” ' + (part === 'cell' ? 'cell' : 'header') + ' is covered by another element.' };
  }
  if (wantEdit) {
    st.editTried = true;
    return { ok: false, scrolled: true, editAt: { x, y }, reason: 'The “' + colName(column) + '” cell did not open for editing.' };
  }
  return { ok: true, used: 'grid', mouse: { x, y } };
}

function studioPageText() {
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const notices = Array.from(document.querySelectorAll('[role=alert],[role=status],[aria-live],[class*=toast],[class*=snackbar],[class*=notification],[class*=Toast],[class*=Snackbar],[class*=Notification]'))
    .filter((el) => !el.closest('.ag-aria-description-container'))
    .map((el) => norm(el.textContent)).filter(Boolean);
  return { ok: true, texts: notices.concat(document.body ? [norm(document.body.innerText)] : []) };
}

function studioVerify(text) {
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const body = document.body ? norm(document.body.innerText) : '';
  return { ok: true, found: body.includes(norm(text)) };
}

// ---------- Helpers ----------
async function exec(wc, fn, ...args) {
  const call = '(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')';
  try {
    return await wc.executeJavaScript(call, true);
  } catch (e) {
    return { ok: false, reason: 'The page was still loading.' };
  }
}

// Resolves a step's locator with Playwright when it has one, then performs the action in the page.
// Steps recorded before locators existed still use the older hints, matched in the page as before.
async function act(wc, ctx, loc, action, value, fieldAction) {
  if (!loc.ast) return exec(wc, studioAct, loc, action, value, fieldAction);
  const found = await pw.markTarget(ctx.page, loc, action);
  if (!found.ok || found.done) return found;
  return exec(wc, studioAct, { marked: true, source: loc.source }, action, value, fieldAction);
}

// Polls fn until it succeeds or times out. While a grid is being scrolled to search for a row,
// polling is faster and may continue up to a minute beyond the step timeout.
async function tryUntil(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  const scrollEnd = end + 60000;
  for (;;) {
    const res = await fn();
    if (res.ok || res.fatal) return res;
    if (Date.now() > (res.scrolled ? scrollEnd : end)) return res;
    await delay(res.scrolled ? 80 : 300);
  }
}

// Waits for navigation or rendering to finish. fast is used before a step that saves text from
// a message, so short-lived notifications are not missed.
async function settle(wc, fast) {
  await delay(fast ? 100 : 350);
  const end = Date.now() + 30000;
  while (wc.isLoading() && Date.now() < end) await delay(fast ? 50 : 200);
  await delay(fast ? 50 : 250);
}

async function mouseAt(wc, point, action) {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  const button = action === 'Right-click' ? 'right' : 'left';
  wc.sendInputEvent({ type: 'mouseMove', x, y });
  const clicks = action === 'Double-click' ? 2 : 1;
  for (let c = 1; c <= clicks; c++) {
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: c });
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: c });
  }
  await delay(50);
}

function pressEnter(wc) {
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
}

async function gridStep(wc, step, ctx, value, vars, timeout) {
  const g = resolveGrid(step.grid, vars);
  if (step.action === 'Verify element is hidden' && (g.part || 'cell') !== 'cell') throw new Error('Only a row can be checked as not in the grid. Set the grid part to Cell.');
  const scanId = Math.random().toString(36).slice(2);
  const rowValue = g.row && g.row.mode !== 'index' ? g.row.value : null;
  const res = await tryUntil(async () => {
    const r = await exec(wc, studioGrid, g, rowValue, step.action, value, scanId);
    if (r.hover) {
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(r.hover.x), y: Math.round(r.hover.y) });
      await delay(200);
    }
    if (r.editAt) {
      await mouseAt(wc, r.editAt, 'Double-click');
      await delay(250);
    }
    // Checking a row is not in the grid: finding it is the failure, and a full search without it is the pass.
    if (step.action === 'Verify element is hidden') {
      if (r.rowFound) return { ok: false, reason: r.reason };
      if (r.missing) return { ok: true };
    }
    return r;
  }, timeout);
  if (!res.ok) throw new Error(res.reason || 'The grid step could not be completed.');
  if (res.mouse) await mouseAt(wc, res.mouse, step.action);
  if (step.action === 'Press Enter') pressEnter(wc);
  if (res.mouse || step.action === 'Press Enter') await settle(wc, ctx.beforeCapture);
  return { used: 'grid' };
}

// Returns extra facts about the step, such as which locator found the element.
async function executeStep(wc, step, ctx) {
  const vars = ctx.vars();
  // Without this the {name} would be typed, clicked or searched for as literal text.
  const missing = missingFor(step, vars);
  if (missing.length) {
    throw new Error('No value for ' + missing.map((k) => '{' + k + '}').join(', ')
      + '. Add it in Test data, or save it with an earlier “Save value from text” step that is turned on.');
  }
  const value = substitute(step.value, vars);
  const timeout = Math.max(1, Number(ctx.settings.stepTimeout) || 10) * 1000;
  const meta = metaFor(step.action);
  if (usesGrid(step)) return gridStep(wc, step, ctx, value, vars, timeout);

  switch (step.action) {
    case 'Open page': {
      let url = value;
      if (ctx.settings.baseUrl && !/^[a-z]+:\/\//i.test(url)) url = new URL(url, ctx.settings.baseUrl).toString();
      await wc.loadURL(url).catch((e) => {
        if (!/ERR_ABORTED/.test(String(e && e.message))) throw new Error('Could not open ' + url + '. ' + (e && e.message ? e.message : ''));
      });
      await settle(wc, ctx.beforeCapture);
      return {};
    }
    case 'Click':
    case 'Double-click':
    case 'Right-click':
    case 'Type':
    case 'Select':
    case 'Press Enter':
    case 'Verify element is visible':
    case 'Verify element is hidden':
    case 'Verify element is enabled':
    case 'Verify element is disabled':
    case 'Verify field value':
    case 'Verify element text': {
      const loc = locatorsFor(step, vars, ctx.settings);
      const res = await tryUntil(() => act(wc, ctx, loc, step.action, value, !!meta.field), timeout);
      if (!res.ok) throw new Error(res.reason || 'The step could not be completed.');
      if (res.mouse) await mouseAt(wc, res.mouse, step.action);
      if (step.action === 'Press Enter') pressEnter(wc);
      if (!meta.verify) await settle(wc, ctx.beforeCapture);
      return { used: res.used, quality: loc.ast ? loc.quality : null };
    }
    case 'Save value from text': {
      try {
        captureText.templateToRegex(step.value);
      } catch (e) {
        throw new Error(e.message);
      }
      const res = await tryUntil(async () => {
        const r = step.target && String(step.target).trim()
          ? await act(wc, ctx, locatorsFor(step, vars, ctx.settings), 'Read text', '', false)
          : await exec(wc, studioPageText);
        if (!r.ok) return r;
        for (const text of r.texts || [r.text]) {
          const values = captureText.extract(step.value, text);
          if (values) return { ok: true, values, used: r.used };
        }
        return { ok: false, reason: 'No text matching “' + step.value + '” appeared' + (step.target ? ' in “' + step.target + '”' : ' on the page') + '.' };
      }, timeout);
      if (!res.ok) throw new Error(res.reason);
      return { captured: res.values, used: res.used };
    }
    case 'Verify text appears':
    case 'Verify text is not shown': {
      const wantFound = step.action === 'Verify text appears';
      const res = await tryUntil(async () => {
        const r = await exec(wc, studioVerify, value);
        return { ok: r.found === wantFound };
      }, timeout);
      if (!res.ok) throw new Error(wantFound ? 'Expected text “' + value + '” was not found on the page.' : 'Text “' + value + '” is shown on the page but should not be.');
      return {};
    }
    case 'Verify page address contains': {
      const res = await tryUntil(async () => ({ ok: wc.getURL().includes(value) }), timeout);
      if (!res.ok) throw new Error('The page address is ' + wc.getURL() + ', expected it to contain “' + value + '”.');
      return {};
    }
    case 'Verify page title': {
      const res = await tryUntil(async () => ({ ok: wc.getTitle().includes(value) }), timeout);
      if (!res.ok) throw new Error('The page title is “' + wc.getTitle() + '”, expected it to contain “' + value + '”.');
      return {};
    }
    case 'Verify no console errors': {
      const errors = ctx.consoleErrors();
      if (errors.length) throw new Error(errors.length + ' console error(s). First: ' + errors[0]);
      return {};
    }
    case 'Wait':
      await delay(Math.max(0, Number(value) || 1) * 1000);
      return {};
    case 'Take screenshot':
      return {};
    default:
      throw new Error('Unknown action “' + step.action + '”.');
  }
}

async function capture(wc, dir, fileName) {
  const image = await wc.capturePage();
  if (image.isEmpty()) throw new Error('Empty screenshot');
  fs.writeFileSync(path.join(dir, fileName), image.toPNG());
  return image.resize({ width: 320 }).toDataURL();
}

function freshSteps(template, blocks, variables, settings) {
  return expandSteps(template.steps, blocks).map((s, i) => {
    const r = resolveStep(s, variables, settings);
    return {
      num: i + 1,
      action: s.action,
      text: (s._prefix || '') + describeStep(r, blocks),
      value: s.secret ? '' : r.value,
      status: 'pending',
      error: null,
      screenshot: null,
      ms: 0,
      locator: r.locator || null,
      locatedBy: null,
      fragile: false,
      _step: s
    };
  });
}

// Runs every step of one attempt in its own clean browser session. Returns true if all steps passed.
async function runAttempt({ t, ti, attempt, ctx, settings, run, dir, publish }) {
  const win = new BrowserWindow({
    width: 1366,
    height: 860,
    show: settings.showRunWindow !== false,
    title: 'Running ' + t.id + ' – Test Studio',
    autoHideMenuBar: true,
    webPreferences: {
      partition: 'run-' + run.id + '-' + ti + '-' + attempt,
      contextIsolation: true,
      backgroundThrottling: false
    }
  });
  const wc = win.webContents;
  wc.on('console-message', (event) => {
    if (event.level === 'error') t.consoleErrors.push(String(event.message).slice(0, 500));
  });
  await wc.loadURL('about:blank').catch(() => {});
  const page = await pw.pageForWebContents(wc);

  // Values saved during this attempt come first, then values shared by earlier tests, then test data.
  const runtime = new Map();
  const entries = (m) => Array.from(m, ([key, value]) => ({ key, value }));
  const stepCtx = { ...ctx, page, consoleErrors: () => t.consoleErrors, vars: () => [...entries(runtime), ...entries(ctx.shared), ...ctx.variables] };

  let failed = false;
  try {
    for (let si = 0; si < t.steps.length; si++) {
      const s = t.steps[si];
      if (failed || cancelled) { s.status = 'skipped'; continue; }
      s.status = 'running';
      publish();
      const started = Date.now();
      try {
        if (s._step._missingBlock) throw new Error('The reusable block used here no longer exists.');
        if (win.isDestroyed()) throw new Error('The browser window was closed.');
        // Show the values actually used, such as a saved order ID, in results and evidence.
        const src = s._step;
        if (stepRefs(src).length) {
          const resolved = resolveStep(src, stepCtx.vars(), ctx.settings);
          if (!src.secret && src.action !== 'Save value from text') s.value = resolved.value;
          if (resolved.locator) s.locator = resolved.locator;
          s.text = (src._prefix || '') + describeStep(resolved, ctx.blocks);
        }
        const next = t.steps[si + 1];
        stepCtx.beforeCapture = !!(next && next.action === 'Save value from text');
        const info = await executeStep(wc, s._step, stepCtx);
        s.status = 'passed';
        if (info.captured) {
          for (const [k, v] of Object.entries(info.captured)) {
            runtime.set(k, v);
            if (s._step.shareWithRun) ctx.shared.set(k, v);
          }
          s.captured = s._step.secret ? Object.fromEntries(Object.keys(info.captured).map((k) => [k, '••••••••'])) : info.captured;
          Object.assign(t.captured, s.captured);
          s.text = (s._step._prefix || '') + 'Saved ' + Object.entries(s.captured).map(([k, v]) => '“' + v + '” as {' + k + '}').join(', ');
        }
        if (info.used) {
          s.locatedBy = info.used;
          s.fragile = FRAGILE_LOCATORS.includes(info.used === 'locator' ? info.quality : info.used);
        }
      } catch (e) {
        s.status = 'failed';
        s.error = e.message;
        failed = true;
      }
      s.ms = Date.now() - started;

      let thumb = null;
      if (!win.isDestroyed() && (s._step.shot || s.action === 'Take screenshot' || s.status === 'failed')) {
        try {
          const fileName = 't' + (ti + 1) + (attempt > 1 ? '-a' + attempt : '') + '-step' + String(si + 1).padStart(2, '0') + '.png';
          const dataUrl = await capture(wc, dir, fileName);
          s.screenshot = fileName;
          thumb = { key: ti + '-' + si, dataUrl };
        } catch (e) { /* window may have closed */ }
      }
      publish(thumb);
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
  return !failed;
}

// ---------- Main entry ----------
async function run({ run, tests, blocks, variables, settings, dir, onUpdate }) {
  running = true;
  cancelled = false;
  try {
    await pw.connect();
    pw.setTestIdAttribute(settings.testIdAttribute);
  } catch (e) {
    running = false;
    throw new Error('Test Studio could not start its browser automation. ' + e.message);
  }
  const ctx = { variables, settings, blocks, shared: new Map() };
  const retries = Math.max(0, Math.min(5, parseInt(settings.retries, 10) || 0));

  try {
    run.tests = tests.map((t) => ({
      id: t.id,
      title: t.title,
      tags: t.tags || [],
      priority: t.priority || '',
      requirement: t.requirement || '',
      status: 'Queued',
      attempts: 0,
      flaky: false,
      previousAttempts: [],
      consoleErrors: [],
      captured: {},
      steps: freshSteps(t, blocks, variables, settings)
    }));
    const publish = (thumb) => onUpdate(stripInternal(run), thumb);
    publish();

    for (let ti = 0; ti < run.tests.length; ti++) {
      const t = run.tests[ti];
      if (cancelled) { t.status = 'Cancelled'; t.steps.forEach((s) => (s.status = 'skipped')); continue; }

      t.status = 'Running';
      let passed = false;
      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        if (attempt > 1) {
          const f = t.steps.find((s) => s.status === 'failed');
          t.previousAttempts.push({ attempt: attempt - 1, failedStep: f ? f.num : null, error: f ? f.error : null, ms: t.steps.reduce((n, s) => n + s.ms, 0) });
          t.steps = freshSteps(tests[ti], blocks, variables, settings);
          t.consoleErrors = [];
          t.captured = {};
        }
        t.attempts = attempt;
        publish();
        passed = await runAttempt({ t, ti, attempt, ctx, settings, run, dir, publish });
        if (passed || cancelled) break;
      }

      t.flaky = passed && t.attempts > 1;
      t.status = cancelled && !passed && !t.steps.some((s) => s.status === 'failed') ? 'Cancelled' : passed ? 'Passed' : 'Failed';
      publish();
    }

    run.finishedAt = new Date().toISOString();
    run.status = cancelled ? 'Cancelled' : run.tests.some((t) => t.status === 'Failed') ? 'Failed' : 'Passed';
    const final = stripInternal(run);
    publish();
    return final;
  } finally {
    running = false;
  }
}

function stripInternal(run) {
  return JSON.parse(JSON.stringify(run, (k, v) => (k === '_step' ? undefined : v)));
}

module.exports = {
  run,
  cancel: () => { cancelled = true; },
  isRunning: () => running
};
