const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const { describeStep } = require('./describe');

let running = false;
let cancelled = false;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Functions injected into the page under test ----------
// These are serialised with toString(), so they must be self-contained.
function studioAct(loc, action, value) {
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

  const fieldAction = action === 'Type' || action === 'Select' || action === 'Press Enter';
  const fieldSel = 'input,select,textarea,[contenteditable="true"]';
  const clickSel = 'button,a,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],input[type=submit],input[type=button],input[type=checkbox],input[type=radio],summary,label,li,td,th,span,div,p,h1,h2,h3,h4';

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
  const wanted = loc.label || loc.text || loc.placeholder || loc.testId || loc.name || loc.css || 'element';
  if (!el) return { ok: false, reason: 'Could not find “' + wanted + '” on the page.' };

  el.scrollIntoView({ block: 'center', inline: 'center' });

  if (action === 'Click') {
    el.click();
  } else if (action === 'Type') {
    el.focus();
    if (el.isContentEditable) {
      el.innerText = value;
    } else {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (action === 'Select') {
    if (!(el instanceof HTMLSelectElement)) return { ok: false, fatal: true, reason: '“' + wanted + '” is not a dropdown.' };
    const opt = Array.from(el.options).find((o) => o.value === value || norm(o.text) === norm(value));
    if (!opt) return { ok: false, reason: 'Option “' + value + '” is not available in “' + wanted + '”.' };
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, opt.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (action === 'Press Enter') {
    el.focus();
  }
  return { ok: true, used };
}

function studioVerify(text) {
  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  const body = document.body ? norm(document.body.innerText) : '';
  return { ok: body.includes(norm(text)) };
}

// ---------- Helpers ----------
function substitute(value, variables) {
  return String(value || '').replace(/\{(\w+)\}/g, (m, key) => {
    const v = variables.find((x) => x.key === key);
    return v ? v.value : m;
  });
}

function expandSteps(steps, blocks, depth = 0, prefix = '') {
  const out = [];
  for (const step of steps || []) {
    if (step.action === 'Use block') {
      const block = blocks.find((b) => b.id === step.value);
      if (!block || depth > 5) {
        out.push({ ...step, _missingBlock: true, _prefix: prefix });
      } else {
        out.push(...expandSteps(block.steps, blocks, depth + 1, prefix + block.name + ' › '));
      }
    } else {
      out.push({ ...step, _prefix: prefix });
    }
  }
  return out;
}

async function exec(wc, fn, ...args) {
  try {
    return await wc.executeJavaScript('(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')', true);
  } catch (e) {
    return { ok: false, reason: 'The page was still loading.' };
  }
}

async function tryUntil(fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await fn();
    if (res.ok || res.fatal || Date.now() > end) return res;
    await delay(300);
  }
}

async function settle(wc) {
  await delay(350);
  const end = Date.now() + 30000;
  while (wc.isLoading() && Date.now() < end) await delay(200);
  await delay(250);
}

function locatorsFor(step) {
  const target = (step.target || '').trim();
  if (step.locators && target === (step.recordedTarget || '').trim()) return step.locators;
  // The user renamed the target in the editor: find it by what they typed.
  return { label: target, text: target, placeholder: target };
}

async function executeStep(wc, step, ctx) {
  const value = substitute(step.value, ctx.variables);
  const timeout = Math.max(1, Number(ctx.settings.stepTimeout) || 10) * 1000;

  switch (step.action) {
    case 'Open page': {
      let url = value;
      if (ctx.settings.baseUrl && !/^[a-z]+:\/\//i.test(url)) url = new URL(url, ctx.settings.baseUrl).toString();
      await wc.loadURL(url).catch((e) => {
        if (!/ERR_ABORTED/.test(String(e && e.message))) throw new Error('Could not open ' + url + '. ' + (e && e.message ? e.message : ''));
      });
      await settle(wc);
      return;
    }
    case 'Click':
    case 'Type':
    case 'Select':
    case 'Press Enter': {
      const res = await tryUntil(() => exec(wc, studioAct, locatorsFor(step), step.action, value), timeout);
      if (!res.ok) throw new Error(res.reason || 'The step could not be completed.');
      if (step.action === 'Press Enter') {
        wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        wc.sendInputEvent({ type: 'char', keyCode: '\r' });
        wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
      await settle(wc);
      return;
    }
    case 'Verify text appears': {
      const res = await tryUntil(() => exec(wc, studioVerify, value), timeout);
      if (!res.ok) throw new Error('Expected text “' + value + '” was not found on the page.');
      return;
    }
    case 'Wait':
      await delay(Math.max(0, Number(value) || 1) * 1000);
      return;
    case 'Take screenshot':
      return;
    default:
      throw new Error('Unknown action “' + step.action + '”.');
  }
}

async function capture(wc, dir, fileName) {
  const image = await wc.capturePage();
  fs.writeFileSync(path.join(dir, fileName), image.toPNG());
  return image.resize({ width: 320 }).toDataURL();
}

// ---------- Main entry ----------
async function run({ run, tests, blocks, variables, settings, dir, onUpdate }) {
  running = true;
  cancelled = false;
  const ctx = { variables, settings };

  run.tests = tests.map((t) => ({
    id: t.id,
    title: t.title,
    status: 'Queued',
    consoleErrors: [],
    steps: expandSteps(t.steps, blocks).map((s, i) => ({
      num: i + 1,
      action: s.action,
      text: (s._prefix || '') + describeStep(s, blocks),
      value: s.secret ? '' : substitute(s.value, variables),
      status: 'pending',
      error: null,
      screenshot: null,
      ms: 0,
      _step: s
    }))
  }));
  const publish = (thumb) => onUpdate(stripInternal(run), thumb);
  publish();

  for (let ti = 0; ti < run.tests.length; ti++) {
    const t = run.tests[ti];
    if (cancelled) { t.status = 'Cancelled'; t.steps.forEach((s) => (s.status = 'skipped')); continue; }

    t.status = 'Running';
    publish();

    const win = new BrowserWindow({
      width: 1366,
      height: 860,
      show: settings.showRunWindow !== false,
      title: 'Running ' + t.id + ' – Test Studio',
      autoHideMenuBar: true,
      webPreferences: { partition: 'run-' + run.id + '-' + ti, contextIsolation: true }
    });
    const wc = win.webContents;
    wc.on('console-message', (event, level, message) => {
      const lvl = typeof level === 'number' ? level : event && event.level;
      const msg = message != null ? message : event && event.message;
      if (lvl === 3 || lvl === 'error') t.consoleErrors.push(String(msg).slice(0, 500));
    });
    await wc.loadURL('about:blank').catch(() => {});

    let failed = false;
    for (let si = 0; si < t.steps.length; si++) {
      const s = t.steps[si];
      if (failed || cancelled) { s.status = 'skipped'; continue; }
      s.status = 'running';
      publish();
      const started = Date.now();
      try {
        if (s._step._missingBlock) throw new Error('The reusable block used here no longer exists.');
        await executeStep(wc, s._step, ctx);
        s.status = 'passed';
      } catch (e) {
        s.status = 'failed';
        s.error = e.message;
        failed = true;
      }
      s.ms = Date.now() - started;

      let thumb = null;
      if (s._step.shot || s.action === 'Take screenshot' || s.status === 'failed') {
        try {
          const fileName = 't' + (ti + 1) + '-step' + String(si + 1).padStart(2, '0') + '.png';
          const dataUrl = await capture(wc, dir, fileName);
          s.screenshot = fileName;
          thumb = { key: ti + '-' + si, dataUrl };
        } catch (e) { /* window may have closed */ }
      }
      publish(thumb);
    }

    t.status = cancelled && !failed ? 'Cancelled' : failed ? 'Failed' : 'Passed';
    if (!win.isDestroyed()) win.destroy();
    publish();
  }

  run.finishedAt = new Date().toISOString();
  run.status = cancelled ? 'Cancelled' : run.tests.some((t) => t.status === 'Failed') ? 'Failed' : 'Passed';
  running = false;
  const final = stripInternal(run);
  publish();
  return final;
}

function stripInternal(run) {
  return JSON.parse(JSON.stringify(run, (k, v) => (k === '_step' ? undefined : v)));
}

module.exports = {
  run,
  cancel: () => { cancelled = true; },
  isRunning: () => running
};
