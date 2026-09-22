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
const ACTS_ON_CONTROL = ['Click', 'Click and press Enter', 'Click without checking', 'Double-click', 'Right-click', 'Type', 'Type and press Enter', 'Select', 'Press Enter', 'Verify field value', 'Verify element is enabled', 'Verify element is disabled'];

// The attribute names teams use for test IDs. Only one is in force at a time — the one in Settings.
const TEST_ID_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy', 'data-automation-id'];

const testIdIn = (ast) => {
  for (const call of ast || []) if (call.name === 'getByTestId' && typeof call.args[0] === 'string') return call.args[0];
  return null;
};

// "Could not find it" is true but says nothing about why. Look at what the page does have, so the
// failure tells the difference between the wrong attribute name, the wrong value, and an element
// that was not there at all — which is the difference between fixing the step and fixing the test.
async function missingHint(page, loc) {
  const value = testIdIn(loc.ast);
  if (!value) return '';
  let seen;
  try {
    const perRoot = await Promise.all(rootsOf(page).map((root) => root.evaluate(([v, attrs]) => {
      const exact = [];
      let partial = 0;
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          for (const a of attrs) {
            const got = el.getAttribute(a);
            if (got === v) exact.push(a);
            else if (got && got.includes(v)) partial++;
          }
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      };
      walk(document);
      // What the page does hold, so "it was not there" can say whether the step was on the wrong
      // screen or asking for the wrong name.
      const all = [];
      const collect = (root) => {
        for (const el of root.querySelectorAll('*')) {
          for (const a of attrs) {
            const got = el.getAttribute(a);
            if (got) all.push(got);
          }
          if (el.shadowRoot) collect(el.shadowRoot);
        }
      };
      collect(document);
      return {
        exact: Array.from(new Set(exact)),
        partial,
        total: all.length,
        related: Array.from(new Set(all.filter((x) => x.split(/[-_ ]/)[0] === v.split(/[-_ ]/)[0]))).slice(0, 5),
        frames: document.querySelectorAll('iframe,frame').length
      };
    }, [value, TEST_ID_ATTRS]).catch(() => null)));
    const got = perRoot.filter(Boolean);
    seen = {
      exact: Array.from(new Set(got.flatMap((r) => r.exact))),
      partial: got.reduce((n, r) => n + r.partial, 0),
      total: got.reduce((n, r) => n + r.total, 0),
      related: Array.from(new Set(got.flatMap((r) => r.related))).slice(0, 5),
      frames: got.reduce((n, r) => n + r.frames, 0)
    };
  } catch (e) {
    return '';
  }
  const other = seen.exact.filter((a) => a !== testIdAttribute);
  if (other.length) {
    return ' Nothing has ' + testIdAttribute + '="' + value + '", but an element has ' + other[0] + '="' + value +
      '". Change the test ID attribute in Settings to ' + other[0] + '.';
  }
  if (seen.exact.length) return ' It is on the page now, so it appeared after the step gave up waiting.';
  if (seen.partial) return ' No element has exactly that test ID; ' + seen.partial + ' have one containing it.';

  let why = ' Nothing on the page has that test ID under any name, so it was not there while the step waited.';
  if (seen.related.length) {
    // Other test IDs from the same part of the application are on screen, so the screen is right
    // and the name is not.
    why += ' The page does have ' + seen.related.map((x) => '“' + x + '”').join(', ') +
      ', so the right part of the application looks to be on screen and the name may be wrong.';
  } else if (seen.total) {
    why += ' The page has ' + seen.total + ' other test ID(s), none of them from the same part of the application' +
      ' — so the screen or dialog holding it was probably not open. The screenshot taken when this step failed shows what was.';
  } else {
    why += ' The page has no test IDs at all, so it may not have finished loading.';
  }
  if (seen.frames) why += ' It also has ' + seen.frames + ' frame(s), which were searched as well.';
  return why;
}

// Playwright's own words for why it would not act, said the way the rest of the app says things.
function actReason(e, source, action, value) {
  const msg = String((e && e.message) || '');
  const clicking = /click/i.test(action);
  if (/did not find some option|no such option/i.test(msg)) return 'Option “' + value + '” is not available in ' + source + '.';
  if (/not a <select>/i.test(msg)) return source + ' is not a dropdown.';
  if (/not an <input>|not an <input>, <textarea>|contenteditable/i.test(msg)) return source + ' is not a field that can be typed into.';
  if (/not enabled|is disabled/i.test(msg)) return source + ' is disabled, so it cannot be ' + (clicking ? 'clicked' : 'used') + '.';
  if (/intercepts pointer events/i.test(msg)) return source + ' is covered by another element.';
  if (/not visible/i.test(msg)) return source + ' was found but is not visible.';
  if (/not editable/i.test(msg)) return source + ' cannot be edited.';
  if (/not stable/i.test(msg)) return source + ' kept moving, so the step could not act on it.';
  if (/Timeout/i.test(msg)) return 'The step could not act on ' + source + ' before it ran out of time.';
  return 'The step could not act on ' + source + ': ' + msg.split('\n')[0];
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

// A page often shows part of itself in a frame — a dialog, a report, an editor — and a locator does
// not look inside one on its own. The page is tried first, then each frame, so a locator written
// against what the tester sees keeps working wherever the element actually lives. Playwright reaches
// into a frame from another site too, which the page's own code cannot.
const rootsOf = (page) => [page, ...page.frames().filter((f) => f !== page.mainFrame())];

async function locatorFor(page, ast) {
  let first = null;
  for (const root of rootsOf(page)) {
    const locator = buildLocator(root, ast);
    const n = await locator.count();
    if (!first) first = { locator, count: n, root };
    if (n) return { locator, count: n, root };
  }
  return first;
}

// Resolves a step's locator and marks the match for the in-page action code.
// Returns { ok, fatal, reason, done } — done means the step is already decided.
async function markTarget(page, loc, action) {
  let found;
  try {
    found = await locatorFor(page, loc.ast);
  } catch (e) {
    if (/not supported|Unsupported/.test(String((e && e.message) || ''))) {
      return { ok: false, fatal: true, reason: loc.source + ' is not supported: ' + e.message };
    }
    // Navigating or detached: let the caller poll again.
    return { ok: false, reason: 'The page was still loading.' };
  }

  let locator = found.locator;
  let count = found.count;
  const root = found.root;

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
  // notFound marks this apart from a step that failed for a reason of its own: once an element has
  // gone, every later try says this, which would otherwise bury why the step really failed.
  if (!count) return { ok: false, notFound: true, reason: 'Could not find ' + loc.source + ' on the page.' + (await missingHint(page, loc)) };

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
  return { ok: true, root };
}

// The actions Playwright carries out itself. It waits for the element to be visible, still, enabled
// and able to receive what is being done to it, and it finds the element on its own — so a step no
// longer depends on the page being able to see the tag, and something that could not have happened
// is reported instead of passing quietly.
const PLAYWRIGHT_ACTS = ['Click', 'Click and press Enter', 'Click without checking', 'Double-click', 'Right-click', 'Press Enter', 'Select', 'Type', 'Type and press Enter'];

async function actOnTarget(page, loc, action, value, timeout) {
  const found = await markTarget(page, loc, action);
  if (!found.ok || found.done) return found;
  // The tag may be inside a frame, so it is looked for where the element was found.
  const target = (found.root || page).locator('[' + MARK + ']');
  const opts = { timeout: Math.max(1000, timeout) };
  try {
    switch (action) {
      case 'Click':
      case 'Click and press Enter':
        await target.click(opts);
        break;
      case 'Click without checking':
        // force: send the click without first deciding whether the element looks clickable. Those
        // checks are the "verifying" this action is asked to skip; the click itself is a real one,
        // sent at the element's position. Whatever it sets off is not judged either — see the catch.
        await target.click({ ...opts, force: true });
        break;
      case 'Double-click':
        await target.dblclick(opts);
        break;
      case 'Right-click':
        await target.click({ ...opts, button: 'right' });
        break;
      case 'Press Enter':
        await target.press('Enter', opts);
        break;
      case 'Select':
        await target.selectOption(value, opts);
        break;
      case 'Type':
      case 'Type and press Enter': {
        // Typing into a dropdown picks the option that matches, as it does in a browser; fill would
        // refuse, because a dropdown is not something text goes into.
        const dropdown = await target.evaluate((el) => el.tagName === 'SELECT').catch(() => false);
        if (dropdown) await target.selectOption(value, opts);
        else await target.fill(value, opts);
        break;
      }
      default:
        return { ok: false, fatal: true, reason: 'Unknown action “' + action + '”.' };
    }
    // Only the plain Press Enter is sent here. The composites send theirs as key input from the
    // main process afterwards, so it reaches whatever the click or the typing left focused.
    return { ok: true, used: 'locator', entered: action === 'Press Enter' };
  } catch (e) {
    // The step said not to judge what the click set off, and the click was sent, so it is done.
    if (action === 'Click without checking') return { ok: true, used: 'locator' };
    // A dialog that closes on its own button takes the button with it. Playwright then reports the
    // element as detached, or gives up waiting on it, when the application has already done what
    // the step asked for. Nothing else touched it, so if what was tagged has gone, the step worked.
    // A count that cannot be taken is not evidence the element survived — the click was already
    // sent — so it is asked for twice before deciding the element is still there.
    let left = await target.count().catch(() => null);
    if (left === null) left = await target.count().catch(() => 0);
    if (left === 0) return { ok: true, used: 'locator' };
    return { ok: false, reason: actReason(e, loc.source, action, value) };
  }
}

async function close() {
  if (browser && browser.isConnected()) await browser.close().catch(() => {});
  browser = null;
}

module.exports = { connect, setTestIdAttribute, pageForWebContents, markTarget, actOnTarget, PLAYWRIGHT_ACTS, close, MARK };
