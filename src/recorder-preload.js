// Runs inside the recording window, on every page of the application under test.
// Captures user actions and sends them to the main process as plain steps.
const { ipcRenderer } = require('electron');

const sentValues = new WeakMap();
let checkMode = false;   // false, 'check' or 'capture'

const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();

function testIdOf(el) {
  for (const a of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
    const v = el.getAttribute(a);
    if (v) return v;
  }
  return null;
}

function labelOf(el) {
  const aria = el.getAttribute('aria-label');
  if (norm(aria)) return norm(aria);
  if (el.id) {
    try {
      const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (l && norm(l.innerText)) return norm(l.innerText).replace(/\s*\*$/, '');
    } catch (e) { /* ignore */ }
  }
  const wrap = el.closest('label');
  if (wrap && norm(wrap.innerText)) return norm(wrap.innerText).replace(/\s*\*$/, '');
  return null;
}

function isField(el) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['submit', 'button', 'checkbox', 'radio', 'reset', 'image', 'file'].includes(el.type);
  }
  return false;
}

function stableId(id) {
  return id && !/\d{4,}|[:{}]/.test(id) ? id : null;
}

function cssPath(el) {
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && parts.length < 6) {
    const id = stableId(node.id);
    if (id) {
      parts.unshift('#' + CSS.escape(id));
      break;
    }
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(' > ');
}

function describe(el) {
  const field = isField(el);
  const text = field ? null : norm(el.innerText || el.value).slice(0, 80);
  const locators = {
    testId: testIdOf(el),
    id: stableId(el.id),
    label: labelOf(el),
    placeholder: el.getAttribute('placeholder'),
    name: el.getAttribute('name'),
    text: text || null,
    css: cssPath(el)
  };
  const name =
    locators.label ||
    locators.placeholder ||
    locators.text ||
    el.getAttribute('title') ||
    locators.name ||
    locators.testId ||
    el.tagName.toLowerCase();
  return { name, locators };
}

// ---------- AG Grid ----------
function gridLabel(root) {
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
}

const KEY_HEADER = /\bid\b|number|\bno\b|reference|\bref\b|code|\bkey\b/i;

// Tree data: rows seen while recording, by row index, so a row's folders are known even after they have
// scrolled out of view. Row indexes change when folders open or close, the grid is sorted, or the number of
// rows changes, so the cache is cleared then.
const treeCaches = new WeakMap();
const levelOf = (r) => Number((r.className.match(/ag-row-level-(\d+)/) || [0, 0])[1]);

function treeCache(root) {
  const counter = root.querySelector('[aria-rowcount]');
  const count = counter ? counter.getAttribute('aria-rowcount') : null;
  let cache = treeCaches.get(root);
  if (!cache || cache.count !== count) {
    cache = { count, rows: new Map() };
    treeCaches.set(root, cache);
  }
  return cache.rows;
}

function rememberTree(root) {
  const values = root.querySelectorAll('.ag-row .ag-group-value');
  if (!values.length) return;
  const rows = treeCache(root);
  for (const v of values) {
    const r = v.closest('.ag-row');
    const index = Number(r.getAttribute('row-index'));
    if (Number.isFinite(index) && norm(v.innerText)) rows.set(index, { level: levelOf(r), name: norm(v.innerText) });
  }
}

// For tree data, the row's path such as “Documents › Work › Report.pdf”, built from the folder rows
// above it. Returns null when the grid is not a tree or a folder above it was never seen.
function gridTreePath(root, rowEl) {
  // Older grids split a row into pinned and centre parts, so look in every part with this row index.
  const valueEl = root.querySelector('.ag-row[row-index="' + CSS.escape(rowEl.getAttribute('row-index') || '') + '"] .ag-group-value');
  const treeCell = valueEl && valueEl.closest('.ag-cell');
  if (!treeCell) return null;
  rowEl = treeCell.closest('.ag-row');
  const colId = treeCell.getAttribute('col-id');
  rememberTree(root);
  const known = treeCache(root);
  // Folder rows stuck to the top while scrolling are the folders of the rows under them.
  const sticky = Array.from(root.querySelectorAll('[class*="sticky"] .ag-row'))
    .map((r) => ({ index: Number(r.getAttribute('row-index')), level: levelOf(r), name: norm((r.querySelector('.ag-group-value') || {}).innerText) }))
    .filter((r) => Number.isFinite(r.index) && r.name);

  let level = levelOf(rowEl);
  const names = [norm(valueEl.innerText)];
  for (let i = Number(rowEl.getAttribute('row-index')) - 1; level > 0 && i >= 0; i--) {
    let r = known.get(i);
    if (!r) {
      // A gap above the visible rows: continue from the stuck folder row one level up, if there is one.
      const up = sticky.filter((x) => x.index < i && x.level < level).sort((a, b) => b.level - a.level)[0];
      if (!up) return null;
      i = up.index;
      r = up;
    }
    if (r.level < level) { level = r.level; names.unshift(r.name); }
  }
  if (level > 0 || names.some((n) => !n)) return null;
  const header = root.querySelector('.ag-header-cell[col-id="' + CSS.escape(colId) + '"]');
  const headerText = header ? norm((header.querySelector('.ag-header-cell-text') || header).innerText) : null;
  return { mode: 'path', column: { colId, header: headerText }, value: names.join(' › ') };
}

// Describes a grid cell, header or filter so it can be found again after sorting and scrolling.
function gridTarget(el) {
  const root = el.closest('.ag-root-wrapper');
  if (!root) return null;
  const grid = { index: Array.from(document.querySelectorAll('.ag-root-wrapper')).indexOf(root), label: gridLabel(root) };
  const headerById = (colId) => root.querySelector('.ag-header-cell[col-id="' + CSS.escape(colId) + '"]');
  const headerText = (h) => (h ? norm((h.querySelector('.ag-header-cell-text') || h).innerText) : null);
  const columnOf = (h) => ({ colId: h ? h.getAttribute('col-id') : null, header: headerText(h) });

  const floating = el.closest('.ag-floating-filter');
  if (floating) {
    const h = root.querySelector('.ag-header-cell[aria-colindex="' + floating.getAttribute('aria-colindex') + '"]');
    return h ? { grid, part: 'floating-filter', column: columnOf(h) } : null;
  }
  const header = el.closest('.ag-header-cell');
  if (header) {
    if (el.closest('.ag-header-cell-resize, .ag-header-select-all')) return null;
    const part = el.closest('.ag-header-cell-menu-button') ? 'header-menu' : el.closest('.ag-header-cell-filter-button') ? 'header-filter' : 'header';
    treeCaches.delete(root); // sorting or filtering moves rows
    return { grid, part, column: columnOf(header) };
  }
  const cell = el.closest('.ag-cell');
  const rowEl = cell && cell.closest('.ag-row');
  if (!cell || !rowEl) return null;
  const rowIndex = Number(rowEl.getAttribute('row-index'));
  const treePath = gridTreePath(root, rowEl);

  // Choose a key column whose value identifies this row: an ID-like column first, then any other column
  // whose value is unique among the rows on screen. Pinned and centre parts of the row are both searched.
  const rowCells = Array.from(root.querySelectorAll('.ag-row[row-index="' + rowIndex + '"] .ag-cell[col-id]')).filter((c) => norm(c.innerText));
  const candidates = rowCells.filter((c) => KEY_HEADER.test(headerText(headerById(c.getAttribute('col-id'))) || c.getAttribute('col-id')))
    .concat(rowCells.filter((c) => c !== cell), rowCells);
  let row = { mode: 'index', index: rowIndex };
  if (treePath) row = treePath;
  else for (const c of candidates) {
    const colId = c.getAttribute('col-id');
    const value = norm(c.innerText);
    const same = Array.from(root.querySelectorAll('.ag-cell[col-id="' + CSS.escape(colId) + '"]')).filter((x) => norm(x.innerText) === value);
    if (value.length <= 80 && same.length === 1) {
      row = { mode: 'match', column: columnOf(headerById(colId)), value, index: rowIndex };
      if (!row.column.colId) row.column.colId = colId;
      break;
    }
  }
  const link = el.closest('a');
  const button = el.closest('button,[role=button]');
  // The recorder sees the click before the grid handles it, so the arrow still shows the old state.
  const arrow = el.closest('.ag-group-contracted, .ag-group-expanded');
  const box = el.closest('.ag-group-checkbox, .ag-selection-checkbox');
  const boxInput = box && box.querySelector('input');
  // A click on the checkbox input itself has already flipped it by the time the recorder sees the click.
  const wasChecked = boxInput ? (el === boxInput ? !boxInput.checked : boxInput.checked) : false;
  const inner = box && cell.contains(box) ? (wasChecked ? 'deselect' : 'select')
    : arrow && cell.contains(arrow) ? (arrow.classList.contains('ag-group-contracted') ? 'expand' : 'collapse')
    : link && cell.contains(link) ? 'a' : button && cell.contains(button) ? 'button' : null;
  if (inner === 'expand' || inner === 'collapse') treeCaches.delete(root); // rows below move
  const column = columnOf(headerById(cell.getAttribute('col-id')));
  if (!column.colId) column.colId = cell.getAttribute('col-id');
  return { grid, part: 'cell', column, row, inner };
}

// ---------- Playwright-style locators ----------
// The locator engine and parser are loaded from the main process, because this preload runs sandboxed.
let locatorTools = null;
function tools() {
  if (locatorTools) return locatorTools;
  const src = ipcRenderer.sendSync('rec:engine');
  const load = (code) => {
    const module = { exports: {} };
    new Function('module', code)(module);
    return module.exports;
  };
  locatorTools = { engine: load(src.engine), parse: load(src.parse), testIdAttribute: src.testIdAttribute };
  return locatorTools;
}

// Chooses a unique locator for the element, as Playwright codegen does. Null if that fails.
function locatorFor(el) {
  try {
    const t = tools();
    const generated = t.engine.generate(el, { testIdAttribute: t.testIdAttribute });
    return { locator: t.parse.formatLocator(generated.ast), quality: generated.quality, name: t.parse.targetName(generated.ast) };
  } catch (e) {
    return null;
  }
}

function send(action, el, value, secret) {
  const grid = gridTarget(el);
  const loc = grid ? null : locatorFor(el);
  const d = loc ? null : describe(el);
  // Tag the element so the main process can check the generated locator with Playwright,
  // which is what the runner will use to find it again.
  if (loc) {
    try {
      document.querySelectorAll('[data-ts-rec]').forEach((e) => e.removeAttribute('data-ts-rec'));
      el.setAttribute('data-ts-rec', '1');
    } catch (e) { /* the check is best-effort */ }
  }
  ipcRenderer.send('rec:event', {
    action,
    name: grid ? grid.column.header || grid.column.colId : loc ? loc.name : d.name,
    locator: loc ? loc.locator : null,
    locators: d ? d.locators : null,
    grid,
    value: value == null ? '' : String(value),
    secret: !!secret
  });
}

function flushType(el) {
  if (sentValues.get(el) === el.value) return;
  sentValues.set(el, el.value);
  send('Type', el, el.value, el.type === 'password');
}

// ---------- Check mode (click on text that must appear) ----------
function ensureCheckUi() {
  if (!document.getElementById('__studio_style')) {
    const style = document.createElement('style');
    style.id = '__studio_style';
    style.textContent =
      'html.__studio-check *:hover{outline:2px dashed #B3261E !important;outline-offset:2px !important;cursor:crosshair !important}' +
      '#__studio_banner{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1A1C20;color:#fff;' +
      'font:600 14px system-ui,sans-serif;padding:10px 16px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25)}';
    document.documentElement.appendChild(style);
  }
  if (!document.getElementById('__studio_banner')) {
    const banner = document.createElement('div');
    banner.id = '__studio_banner';
    banner.textContent = checkMode === 'capture'
      ? 'Click the text that contains the value to save, such as an order number. Press Esc to cancel.'
      : 'Click the text that must appear for this test to pass. Press Esc to cancel.';
    document.documentElement.appendChild(banner);
  }
  document.documentElement.classList.add('__studio-check');
}

function exitCheck() {
  checkMode = false;
  document.documentElement.classList.remove('__studio-check');
  const banner = document.getElementById('__studio_banner');
  if (banner) banner.remove();
}

ipcRenderer.on('rec:check-mode', () => {
  exitCheck();
  checkMode = 'check';
  ensureCheckUi();
});

ipcRenderer.on('rec:capture-mode', () => {
  exitCheck();
  checkMode = 'capture';
  ensureCheckUi();
});

// ---------- Notifications (toasts) ----------
// Toasts often disappear before anyone can click them, so report every one that appears.
const NOTICE = '[role=alert],[role=status],[aria-live]:not([aria-live=off]),[class*=toast],[class*=snackbar],[class*=notification],[class*=Toast],[class*=Snackbar],[class*=Notification]';
const recentNotices = new Map();

function reportNotices(nodes) {
  const found = new Set();
  for (const node of nodes) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || el.closest('#__studio_banner')) continue;
    const match = el.closest(NOTICE);
    if (match) found.add(match);
    if (el.querySelectorAll) el.querySelectorAll(NOTICE).forEach((x) => found.add(x));
  }
  for (const el of found) {
    // Skip screen-reader-only announcements, including AG Grid's own, which are not visible messages.
    if (el.closest('.ag-root-wrapper,.ag-aria-description-container,[class^="ag-"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) continue;
    const text = norm(el.innerText || el.textContent).slice(0, 300);
    const now = Date.now();
    if (!text || now - (recentNotices.get(text) || 0) < 3000) continue;
    recentNotices.set(text, now);
    ipcRenderer.send('rec:notice', { text });
  }
}

let pendingNodes = [];
let noticeTimer = null;
function watchNotices() {
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'characterData') pendingNodes.push(m.target);
      else m.addedNodes.forEach((n) => pendingNodes.push(n));
    }
    clearTimeout(noticeTimer);
    // Wait briefly so the message text has rendered.
    noticeTimer = setTimeout(() => { const nodes = pendingNodes; pendingNodes = []; reportNotices(nodes); }, 150);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}
if (document.documentElement) watchNotices();
else window.addEventListener('DOMContentLoaded', watchNotices);

// ---------- Listeners ----------
// Remember tree rows as grids scroll, so a row's folders are known after they scroll out of view.
let treeScrollPending = false;
document.addEventListener(
  'scroll',
  (e) => {
    const root = e.target instanceof Element ? e.target.closest('.ag-root-wrapper') : null;
    if (!root || treeScrollPending) return;
    treeScrollPending = true;
    // The grid draws the newly scrolled rows shortly after the scroll event.
    setTimeout(() => {
      treeScrollPending = false;
      rememberTree(root);
    }, 150);
  },
  true
);

document.addEventListener(
  'click',
  (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;

    if (checkMode) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (el.id === '__studio_banner') return;
      const text = norm(el.innerText || el.value).slice(0, 200);
      const mode = checkMode;
      exitCheck();
      if (text && mode === 'capture') ipcRenderer.send('rec:notice', { text, save: true });
      else if (text) ipcRenderer.send('rec:event', { action: 'Verify text appears', name: 'Page', value: text, locators: null });
      return;
    }

    if (!e.isTrusted) return;
    if (isField(el) || el.isContentEditable) return;

    const target =
      el.closest(
        'button,a,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],input,summary,label'
      ) || el;
    if (isField(target)) return;
    send('Click', target);
  },
  true
);

// A double-click replaces the two single clicks recorded just before it (see recorder.js).
document.addEventListener(
  'dblclick',
  (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el || !e.isTrusted || checkMode || isField(el) || el.isContentEditable) return;
    send('Double-click', el.closest('button,a,[role=button],[role=link],.ag-cell,.ag-header-cell') || el);
  },
  true
);

document.addEventListener(
  'contextmenu',
  (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el || !e.isTrusted || checkMode) return;
    send('Right-click', el.closest('button,a,[role=button],[role=link],.ag-cell,.ag-header-cell') || el);
  },
  true
);

document.addEventListener(
  'change',
  (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (el instanceof HTMLSelectElement) {
      const opt = el.options[el.selectedIndex];
      send('Select', el, opt ? norm(opt.text) : el.value);
      return;
    }
    if (isField(el)) flushType(el);
  },
  true
);

document.addEventListener(
  'keydown',
  (e) => {
    if (checkMode && e.key === 'Escape') {
      exitCheck();
      return;
    }
    const el = e.target;
    if (e.key === 'Enter' && el instanceof HTMLInputElement && isField(el)) {
      flushType(el);
      send('Press Enter', el);
    }
  },
  true
);
