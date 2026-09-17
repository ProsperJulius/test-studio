// Runs inside the recording window, on every page of the application under test.
// Captures user actions and sends them to the main process as plain steps.
const { ipcRenderer } = require('electron');

const sentValues = new WeakMap();
let checkMode = false;

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

function send(action, el, value, secret) {
  const d = describe(el);
  ipcRenderer.send('rec:event', {
    action,
    name: d.name,
    locators: d.locators,
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
    banner.textContent = 'Click the text that must appear for this test to pass. Press Esc to cancel.';
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
  checkMode = true;
  ensureCheckUi();
});

// ---------- Listeners ----------
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
      exitCheck();
      if (text) {
        ipcRenderer.send('rec:event', { action: 'Verify text appears', name: 'Page', value: text, locators: null });
      }
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
