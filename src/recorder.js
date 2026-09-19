const fs = require('fs');
const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');
const { suggestCapture, capturedNames } = require('./capture');
const { parseLocator, formatLocator } = require('./locator-parse');
const pw = require('./pw-session');
const { buildLocator } = require('./pw-locator');

const ENGINE_SOURCE = fs.readFileSync(path.join(__dirname, 'locator-engine.js'), 'utf8');
const PARSE_SOURCE = fs.readFileSync(path.join(__dirname, 'locator-parse.js'), 'utf8');
let testIdAttribute = 'data-testid';

let win = null;
let page = null;
let steps = [];
let handlers = { onChange: () => {}, onClose: () => {}, onNotice: () => {} };
let notices = [];

const uid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function makeStep(ev) {
  return {
    id: uid(),
    action: ev.action,
    target: ev.name || '',
    recordedTarget: ev.name || '',
    value: ev.value || '',
    secret: !!ev.secret,
    shot: true,
    locator: ev.locator || null,
    locators: ev.locators || null,
    grid: ev.grid || null
  };
}

const sameTarget = (a, b) => JSON.stringify([a.locator || null, a.locators, a.grid || null]) === JSON.stringify([b.locator || null, b.locators, b.grid || null]);

// The sandboxed recorder preload asks for the locator engine and parser sources.
ipcMain.on('rec:engine', (event) => {
  event.returnValue = win && event.sender === win.webContents
    ? { engine: ENGINE_SOURCE, parse: PARSE_SOURCE, testIdAttribute }
    : { engine: '', parse: '', testIdAttribute };
});

// Outlines the elements a locator matches in the recording window and returns how many there are.
async function highlight(text) {
  if (!win) throw new Error('Start recording first, then test the locator on the page.');
  const parsed = parseLocator(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const code = '(function () { const module = {};\n' + ENGINE_SOURCE + '\n;const engine = module.exports;' +
    'const els = engine.resolve(' + JSON.stringify(parsed.ast) + ', { testIdAttribute: ' + JSON.stringify(testIdAttribute) + ' });' +
    'els.forEach((el) => { const before = el.style.outline; el.style.outline = "3px solid #E8590C"; setTimeout(() => { el.style.outline = before; }, 2000); });' +
    'if (els[0]) els[0].scrollIntoView({ block: "center" });' +
    'return { count: els.length, visible: els.filter((el) => engine.isVisible(el)).length }; })()';
  try {
    const res = await win.webContents.executeJavaScript(code, true);
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: 'Could not run the locator on this page: ' + e.message };
  }
}

// The recorder generates locators with the in-page engine, but the runner finds elements with
// Playwright. This checks a new locator against Playwright while the page is still on screen, so a
// disagreement is caught now rather than when the test is run. Best-effort: a click that navigates
// immediately may leave nothing to check, and the step is then kept as recorded.
async function verifyLocator(step) {
  if (!page || !step.locator) return;
  const parsed = parseLocator(step.locator);
  if (!parsed.ok) return;

  let matches;
  try {
    matches = await buildLocator(page, parsed.ast).evaluateAll((els) => els.map((e) => e.hasAttribute('data-ts-rec')));
  } catch (e) {
    return; // the page moved on before we could look
  }

  const index = matches.indexOf(true);
  if (matches.length === 1 && index === 0) {
    // Playwright agrees: one match, and it is the element that was clicked.
  } else if (matches.length > 1 && index >= 0) {
    // Playwright is not strict about this locator, so pin the position it actually matched.
    step.locator = formatLocator(parsed.ast.concat({ name: 'nth', args: [index] }));
  } else {
    step.locatorNote = 'Playwright matched ' + matches.length + ' element(s) for this locator, not the one that was clicked. Check it in the step editor.';
  }

  await page.evaluate(() => document.querySelectorAll('[data-ts-rec]').forEach((e) => e.removeAttribute('data-ts-rec'))).catch(() => {});
  if (win) handlers.onChange(steps);
}

ipcMain.on('rec:event', (event, ev) => {
  if (!win || event.sender !== win.webContents) return;
  if (ev.action === 'Double-click') {
    for (let k = 0; k < 2; k++) {
      const prev = steps[steps.length - 1];
      if (prev && prev.action === 'Click' && sameTarget(prev, ev)) steps.pop();
    }
  }
  const last = steps[steps.length - 1];
  const sameField = last && last.action === 'Type' && ev.action === 'Type' && sameTarget(last, ev);
  if (sameField) {
    last.value = ev.value;
  } else {
    const step = makeStep(ev);
    steps.push(step);
    verifyLocator(step);
  }
  handlers.onChange(steps);
});

// A notification appeared, or the user clicked text in capture mode (save: true).
ipcMain.on('rec:notice', (event, ev) => {
  if (!win || event.sender !== win.webContents) return;
  const notice = { id: 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), text: String(ev.text || ''), afterStep: steps.length, at: new Date().toISOString() };
  notices = notices.concat(notice).slice(-8);
  if (ev.save) addCapture(notice.id);
  else handlers.onNotice(notices);
});

// Adds a "Save value from text" step for a notice, at the point in the recording where it appeared.
function addCapture(noticeId) {
  const notice = notices.find((n) => n.id === noticeId);
  if (!notice) throw new Error('That message is no longer available.');
  const { template, name } = suggestCapture(notice.text, capturedNames(steps));
  const step = makeStep({ action: 'Save value from text', name: '', value: template || notice.text });
  step.target = '';
  step.recordedTarget = '';
  step.shot = false;
  step.shareWithRun = false;
  steps.splice(Math.min(notice.afterStep, steps.length), 0, step);
  notices = notices.filter((n) => n.id !== noticeId);
  handlers.onNotice(notices);
  handlers.onChange(steps);
  return { steps, name };
}

function start(url, h, options) {
  if (win) stop();
  testIdAttribute = (options && options.testIdAttribute) || 'data-testid';
  handlers = { onNotice: () => {}, ...h };
  notices = [];
  steps = [
    {
      id: uid(),
      action: 'Open page',
      target: 'start page',
      recordedTarget: 'start page',
      value: url,
      secret: false,
      shot: true,
      locators: null
    }
  ];

  win = new BrowserWindow({
    width: 1320,
    height: 880,
    title: 'Recording – Test Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'recorder-preload.js'),
      contextIsolation: true,
      partition: 'recorder-' + Date.now()
    }
  });

  win.on('closed', () => {
    win = null;
    handlers.onClose(steps);
  });

  attach(url);
  handlers.onChange(steps);
}

// Attaches Playwright to the recording window before the page under test is loaded. Recording
// still works if this fails; locators are then kept exactly as the engine generated them.
async function attach(url) {
  const target = win;
  page = null;
  target.loadURL(url).catch(() => { /* navigation errors are shown in the window */ });
  try {
    await pw.connect();
    pw.setTestIdAttribute(testIdAttribute);
    if (win !== target) return;
    page = await pw.pageForWebContents(target.webContents);
  } catch (e) {
    page = null;
  }
}

function checkMode() {
  if (!win) return;
  win.focus();
  win.webContents.send('rec:check-mode');
}

function captureMode() {
  if (!win) return;
  win.focus();
  win.webContents.send('rec:capture-mode');
}

function undo() {
  if (steps.length) steps.pop();
  handlers.onChange(steps);
  return steps;
}

function stop() {
  const recorded = steps;
  page = null;
  if (win) {
    const w = win;
    win = null;
    w.removeAllListeners('closed');
    w.close();
  }
  return recorded;
}

function isRecording() {
  return !!win;
}

module.exports = { start, stop, undo, checkMode, captureMode, addCapture, highlight, isRecording };
