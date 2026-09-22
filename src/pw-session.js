// Connects Playwright to Test Studio's own Electron windows over CDP, so steps are matched
// by Playwright itself rather than by a re-implementation of its rules.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { chromium, selectors } = require('playwright-core');
const { buildLocator } = require('./pw-locator');

// Set on the single element a step is about to act on, so the in-page action code can find it.
const MARK = 'data-ts-target';

// The controls a person can work. A component framework wraps these in an element of its own.
const CONTROL = 'button,a[href],input,select,textarea,[role=button],[role=link],[contenteditable="true"],summary';

// Actions that work a control rather than read one. Reading text from a component means the
// component, so those are left pointing at whatever the locator matched.
const ACTS_ON_CONTROL = ['Click', 'Click and press Enter', 'Double-click', 'Right-click', 'Type', 'Type and press Enter', 'Select', 'Press Enter', 'Verify field value', 'Verify element is enabled', 'Verify element is disabled'];

// Playwright's own words for why it would not click, said the way the rest of the app says things.
function clickReason(e, source) {
  const msg = String((e && e.message) || '');
  if (/not enabled|is disabled/i.test(msg)) return source + ' is disabled, so it cannot be clicked.';
  if (/intercepts pointer events/i.test(msg)) return source + ' is covered by another element.';
  if (/not visible/i.test(msg)) return source + ' was found but is not visible.';
  if (/not stable/i.test(msg)) return source + ' kept moving, so it could not be clicked.';
  if (/Timeout/i.test(msg)) return source + ' could not be clicked before the step ran out of time.';
  return source + ' could not be clicked: ' + msg.split('\n')[0];
}

// A component host can have no box of its own — display: contents, or an inline wrapper around a
// button positioned out of it — while the control it holds is plainly on screen. Playwright calls
// the wrapper hidden, which is true of the wrapper and not of what the tester is looking at.
async function isShown(locator) {
  if (await locator.isVisible().catch(() => false)) return true;
  return locator.evaluate((el, sel) => Array.from(el.querySelectorAll(sel)).some((c) => {
    const r = c.getBoundingClientRect();
    const cs = getComputedStyle(c);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
  }), CONTROL).catch(() => false);
}

let browser = null;
let testIdAttribute = null;

// Chromium writes the port it actually bound to here, because main.js asks for port 0.
async function endpoint(timeoutMs = 15000) {
  const file = path.join(app.getPath('userData'), 'DevToolsActivePort');
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const port = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
      if (port) return 'http://127.0.0.1:' + port;
    } catch (e) { /* not written yet */ }
    if (Date.now() > end) throw new Error('Test Studio could not find its browser debugging port.');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function connect() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.connectOverCDP(await endpoint());
  return browser;
}

function setTestIdAttribute(attr) {
  const a = attr || 'data-testid';
  if (a === testIdAttribute) return;
  selectors.setTestIdAttribute(a);
  testIdAttribute = a;
}

// Electron windows all appear as pages on the default context, so a window is identified by
// stamping it through Electron and looking for that stamp through Playwright. Nothing navigates,
// because the window may already be showing the page under test.
async function pageForWebContents(wc, timeoutMs = 15000) {
  const token = 'ts-' + Math.random().toString(36).slice(2);
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      await wc.executeJavaScript('window.__tsAttach = ' + JSON.stringify(token) + '; true', true);
      for (const ctx of browser.contexts()) {
        for (const p of ctx.pages()) {
          if (p.isClosed()) continue;
          const found = await p.evaluate(() => window.__tsAttach).catch(() => null);
          if (found === token) {
            await p.evaluate(() => { delete window.__tsAttach; }).catch(() => {});
            return p;
          }
        }
      }
    } catch (e) { /* the window is still loading; try again */ }
    if (Date.now() > end) throw new Error('Test Studio could not attach to the browser window.');
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Resolves a step's locator and marks the match for the in-page action code.
// Returns { ok, fatal, reason, done } — done means the step is already decided.
async function markTarget(page, loc, action) {
  let locator;
  try {
    locator = buildLocator(page, loc.ast);
  } catch (e) {
    return { ok: false, fatal: true, reason: loc.source + ' is not supported: ' + e.message };
  }

  let count;
  try {
    count = await locator.count();
  } catch (e) {
    // Navigating or detached: let the caller poll again.
    return { ok: false, reason: 'The page was still loading.' };
  }

  if (count > 1) {
    // The same test ID on a component and on the control inside it is one element described twice,
    // not a locator that cannot tell two things apart. Matches that all sit in one chain mean the
    // tester pointed at one thing, so the innermost — the control itself — is the one meant.
    const nested = await locator
      .evaluateAll((els) => els.every((e) => els.every((o) => o === e || e.contains(o) || o.contains(e))))
      .catch(() => false);
    if (nested) {
      locator = locator.last();
      count = 1;
    }
  }

  if (action === 'Verify element is hidden') {
    if (!count) return { ok: true, done: true, used: 'locator' };
    const visible = await isShown(locator.first());
    return visible
      ? { ok: false, used: 'locator', reason: loc.source + ' is still visible.' }
      : { ok: true, done: true, used: 'locator' };
  }

  if (count > 1) {
    return { ok: false, fatal: true, reason: loc.source + ' matched ' + count + ' elements. Add .first() or .nth(), or make the locator more specific.' };
  }
  if (!count) return { ok: false, reason: 'Could not find ' + loc.source + ' on the page.' };

  const first = locator.first();
  if (!(await isShown(first))) return { ok: false, reason: loc.source + ' was found but is not visible.' };

  try {
    await first.evaluate((el, [mark, sel, descend]) => {
      // The tag from the step before has to go, wherever it was put. A component keeps its markup
      // in a shadow root, and a plain query stops at that boundary, so a tag left inside one would
      // be found first by the next step and acted on instead.
      const clear = (root) => {
        root.querySelectorAll('[' + mark + ']').forEach((e) => e.removeAttribute(mark));
        root.querySelectorAll('*').forEach((e) => { if (e.shadowRoot) clear(e.shadowRoot); });
      };
      clear(document);
      let target = el;
      if (descend && !el.matches(sel)) {
        const inner = Array.from(el.querySelectorAll(sel)).filter((c) => {
          const r = c.getBoundingClientRect();
          const cs = getComputedStyle(c);
          return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
        });
        if (inner.length === 1) target = inner[0];
      }
      target.setAttribute(mark, '1');
    }, [MARK, CONTROL, ACTS_ON_CONTROL.includes(action)]);
  } catch (e) {
    return { ok: false, reason: 'The page changed while finding ' + loc.source + '.' };
  }
  return { ok: true };
}

// Clicks through Playwright rather than from inside the page. Playwright waits for the element to
// be visible, still, enabled and actually able to receive the click, and it finds the element
// itself — so a click no longer depends on the page being able to see the tag, and a click that
// could not have happened is reported instead of passing quietly.
async function clickTarget(page, loc, action, timeout) {
  const found = await markTarget(page, loc, action);
  if (!found.ok || found.done) return found;
  try {
    await page.locator('[' + MARK + ']').click({ timeout: Math.max(1000, timeout) });
    return { ok: true, used: 'locator' };
  } catch (e) {
    return { ok: false, reason: clickReason(e, loc.source) };
  }
}

async function close() {
  if (browser && browser.isConnected()) await browser.close().catch(() => {});
  browser = null;
}

module.exports = { connect, setTestIdAttribute, pageForWebContents, markTarget, clickTarget, close, MARK };
