'use strict';

const { describeStep, ACTIONS } = window.StepText;
const api = window.studio;

// ---------- Utilities ----------
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => JSON.parse(JSON.stringify(o));
const uid = (p) => (p || 's') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not run yet');
const cleanErr = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const ICON = {
  logo: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/></svg>',
  rec: '<svg width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>',
  play: '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  down: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>',
  up: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>',
  chevDown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#B3261E" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>'
};

// ---------- State ----------
const S = {
  data: null,
  screen: 'tests',
  setup: null,          // { title, url }
  recording: null,      // { obj, mode: 'new'|'append', steps }
  editing: null,        // { kind: 'test'|'block', obj }
  run: null,
  thumbs: {},
  viewer: null,
  toast: null,
  saveTimer: null,
  varsDraft: null
};

function toast(message, kind) {
  S.toast = { message, kind };
  render();
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { S.toast = null; render(); }, 4500);
}

async function call(channel, ...args) {
  try {
    return await api.invoke(channel, ...args);
  } catch (e) {
    toast(cleanErr(e), 'error');
    throw e;
  }
}

function go(screen) {
  S.screen = screen;
  render();
  const main = document.querySelector('.main');
  if (main) main.scrollTop = 0;
}

function nextTestId() {
  const max = S.data.tests.reduce((m, t) => Math.max(m, parseInt(String(t.id).replace(/\D/g, ''), 10) || 0), 0);
  return 'TC' + String(max + 1).padStart(3, '0');
}

function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'passed') return 'passed';
  if (s === 'failed') return 'failed';
  if (s === 'running') return 'running';
  if (s === 'cancelled' || s === 'skipped') return 'neutral';
  return '';
}

// ---------- Render ----------
function render() {
  if (!S.data) return;
  const main = document.querySelector('.main');
  const scroll = main ? main.scrollTop : 0;

  document.getElementById('app').innerHTML = `
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark">${ICON.logo}</div>
        <div class="brand-name">Test Studio</div>
        <div class="env-pill">${esc(S.data.settings.environment || 'No environment')} environment</div>
      </div>
      <div class="topbar-right">
        ${S.recording && S.screen !== 'record' ? '<button class="rec-return" data-act="go" data-to="record">Recording in progress</button>' : ''}
        <span>${esc(S.data.settings.appName || 'Set your application name in Settings')}</span>
      </div>
    </header>
    <div class="body">
      <nav class="sidebar" aria-label="Main">${navHtml()}</nav>
      <main class="main">${screenHtml()}</main>
    </div>
    ${S.viewer ? `<div class="viewer" data-act="close-viewer"><button class="btn close" data-act="close-viewer">Close</button><img src="${S.viewer}" alt="Step screenshot"></div>` : ''}
    ${S.toast ? `<div class="toast ${S.toast.kind === 'error' ? 'error' : ''}" role="status">${esc(S.toast.message)}</div>` : ''}
  `;

  const newMain = document.querySelector('.main');
  if (newMain) newMain.scrollTop = scroll;
}

function navHtml() {
  const map = {
    tests: 'tests', setup: 'tests', record: 'tests',
    edit: S.editing && S.editing.kind === 'block' ? 'blocks' : 'tests',
    run: 'runs', report: 'runs', runs: 'runs', blocks: 'blocks', data: 'data', schedules: 'schedules', settings: 'settings'
  };
  const active = map[S.screen];
  const items = [['tests', 'Tests'], ['runs', 'Runs'], ['blocks', 'Reusable blocks'], ['data', 'Test data'], ['schedules', 'Schedules'], ['settings', 'Settings']];
  return items.map(([key, label]) => `<button class="nav ${active === key ? 'active' : ''}" data-act="go" data-to="${key}">${label}</button>`).join('') +
    '<div class="sidebar-foot">Tests, runs and screenshots are stored on this computer.</div>';
}

function screenHtml() {
  switch (S.screen) {
    case 'setup': return setupHtml();
    case 'record': return recordHtml();
    case 'edit': return editHtml();
    case 'run': return runHtml();
    case 'report': return reportHtml();
    case 'runs': return runsHtml();
    case 'blocks': return blocksHtml();
    case 'data': return dataHtml();
    case 'schedules': return schedulesHtml();
    case 'settings': return settingsHtml();
    default: return testsHtml();
  }
}

// ----- Tests list -----
function testsHtml() {
  const tests = S.data.tests;
  const approved = tests.filter((t) => t.approval === 'Approved').length;
  const rows = tests.map((t) => `
    <div class="tr cols-tests">
      <div class="mono muted">${esc(t.id)}</div>
      <div><div class="row-title">${esc(t.title)}</div><div class="row-sub">${esc(t.startUrl || '')}</div></div>
      <div>${(t.steps || []).length}</div>
      <div class="muted">${esc(fmt(t.lastRun))}</div>
      <div><span class="pill ${statusClass(t.lastStatus)}">${esc(t.lastStatus || 'Draft')}</span></div>
      <div class="muted">${esc(t.approval || 'Not submitted')}</div>
      <div class="row-actions">
        <button class="btn btn-sm" data-act="edit-test" data-id="${esc(t.id)}">Edit</button>
        <button class="btn btn-sm" data-act="run-tests" data-ids="${esc(t.id)}">Run</button>
        <button class="icon-btn" aria-label="Delete ${esc(t.title)}" data-act="delete-test" data-id="${esc(t.id)}">${ICON.trash}</button>
      </div>
    </div>`).join('');

  return `
  <div class="page">
    <div class="page-head">
      <div class="intro">
        <h1>Regression tests</h1>
        <p>Record a test by using the application the way you normally would. Each step is captured with a screenshot for the evidence report.</p>
      </div>
      <div class="actions">
        <button class="btn" data-act="run-approved" ${approved ? '' : 'disabled title="Approve at least one test first"'}>${ICON.play} Run approved tests (${approved})</button>
        <button class="btn btn-primary" data-act="new-test">${ICON.rec} Record new test</button>
      </div>
    </div>
    ${tests.length ? `
    <div class="table">
      <div class="tr th cols-tests"><div>ID</div><div>Test</div><div>Steps</div><div>Last run</div><div>Result</div><div>Review</div><div></div></div>
      ${rows}
    </div>` : `
    <div class="card empty">
      <strong>No tests yet</strong>
      <p>Record your first test by clicking through the application as you do in manual testing.</p>
      <button class="btn btn-primary" data-act="new-test">${ICON.rec} Record new test</button>
    </div>`}
    <div class="explainers">
      <div class="card"><strong>1. Record</strong><p>Click through the app. Every click, entry and selection becomes a plain-English step.</p></div>
      <div class="card"><strong>2. Review and add checks</strong><p>Adjust steps with dropdowns and say what should appear on screen for the test to pass.</p></div>
      <div class="card"><strong>3. Run and download evidence</strong><p>Run on demand or on a schedule, then download the Word evidence document.</p></div>
    </div>
  </div>`;
}

// ----- Setup -----
function setupHtml() {
  const s = S.setup || { title: '', url: '' };
  return `
  <div class="page" style="max-width: 760px;">
    <button class="btn btn-sm" style="align-self: flex-start;" data-act="go" data-to="tests">← All tests</button>
    <div class="intro"><h1>Record a new test</h1></div>
    <div class="card card-pad">
      <label class="form-row">Test name
        <input class="field" id="setup-title" value="${esc(s.title)}" placeholder="For example: Create order as standard user">
      </label>
      <label class="form-row">Start page address
        <input class="field" id="setup-url" value="${esc(s.url)}" placeholder="https://myapp.company.com/login">
        <span class="hint">A browser window opens at this address. Use the application as normal and each action is recorded.</span>
      </label>
      <div class="actions">
        <button class="btn btn-primary" data-act="start-record">${ICON.rec} Start recording</button>
        <button class="btn" data-act="go" data-to="tests">Cancel</button>
      </div>
    </div>
  </div>`;
}

// ----- Recording -----
function recordHtml() {
  const r = S.recording;
  if (!r) return testsHtml();
  const steps = r.steps.map((st, i) => `
    <div class="step-item">
      <div class="step-num">${i + 1}</div>
      <div><div>${esc(describeStep(st, S.data.blocks))}</div></div>
    </div>`).join('');
  return `
  <div class="page">
    <div class="page-head">
      <div class="actions">
        <span class="rec-pill"><span class="rec-dot"></span>Recording</span>
        <h1 style="font-size: 22px;"><span class="mono">${esc(r.obj.id)}</span> ${esc(r.obj.title)}</h1>
      </div>
      <div class="actions">
        <button class="btn" data-act="rec-undo" ${r.steps.length ? '' : 'disabled'}>Undo last step</button>
        <button class="btn" data-act="rec-check">${ICON.check} Add check for this page</button>
        <button class="btn btn-primary" data-act="rec-stop">Stop and review steps</button>
      </div>
    </div>
    <div class="rec-layout">
      <div class="card">
        <div class="tr th" style="display: flex; justify-content: space-between;"><span>Captured steps</span><span>${r.steps.length} steps</span></div>
        <div class="step-list">${steps}</div>
      </div>
      <div class="card tips">
        <h2>Recording in the browser window</h2>
        <ol>
          <li><strong>Use the application as normal.</strong> Clicks, typed values, dropdown choices and Enter key presses are recorded.</li>
          <li><strong>Add checks.</strong> Click “Add check for this page”, then click the text in the browser that proves the step worked, such as a confirmation message.</li>
          <li><strong>Stop when you're done.</strong> You can edit, reorder and delete steps before running the test.</li>
        </ol>
        <p class="muted">Screenshots are taken each time the test runs, so the evidence always shows the latest build.</p>
      </div>
    </div>
  </div>`;
}

// ----- Step editor -----
function editHtml() {
  const e = S.editing;
  if (!e) return testsHtml();
  const o = e.obj;
  const isTest = e.kind === 'test';
  const blocks = S.data.blocks.filter((b) => b.id !== o.id);

  const rows = o.steps.map((st, i) => {
    const actionOpts = ACTIONS.filter((a) => isTest || a !== 'Use block')
      .map((a) => `<option value="${a}" ${a === st.action ? 'selected' : ''}>${a}</option>`).join('');
    const noTarget = ['Verify text appears', 'Wait', 'Use block'].includes(st.action);
    let valueField;
    if (st.action === 'Use block') {
      valueField = `<select class="field" aria-label="Block" data-field="value" data-i="${i}">
        <option value="">Choose a block</option>
        ${blocks.map((b) => `<option value="${esc(b.id)}" ${b.id === st.value ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}
      </select>`;
    } else if (['Click', 'Press Enter', 'Take screenshot'].includes(st.action)) {
      valueField = '<span class="muted">Not needed</span>';
    } else {
      const ph = { 'Open page': 'https://… or /path', Type: 'Value or {variable}', Select: 'Option text', 'Verify text appears': 'Text that must appear', Wait: 'Seconds' }[st.action] || '';
      valueField = `<input class="field" aria-label="Value" type="${st.secret ? 'password' : 'text'}" data-field="value" data-i="${i}" value="${esc(st.value)}" placeholder="${esc(ph)}">`;
    }
    return `
    <div class="tr cols-steps">
      <div class="mono muted">${i + 1}</div>
      <select class="field" aria-label="Action" data-field="action" data-i="${i}">${actionOpts}</select>
      ${noTarget ? '<span class="muted">Whole page</span>' : `<input class="field" aria-label="Target" data-field="target" data-i="${i}" value="${esc(st.target)}" placeholder="Field, button or page name">`}
      ${valueField}
      <div style="display: flex; flex-direction: column; gap: 4px;">
        <label class="check"><input type="checkbox" data-field="shot" data-i="${i}" ${st.shot ? 'checked' : ''}> Screenshot</label>
        ${st.action === 'Type' ? `<label class="check"><input type="checkbox" data-field="secret" data-i="${i}" ${st.secret ? 'checked' : ''}> Hide value</label>` : ''}
      </div>
      <div class="row-actions">
        <button class="icon-btn" aria-label="Move step up" data-act="step-move" data-i="${i}" data-d="-1">${ICON.up}</button>
        <button class="icon-btn" aria-label="Move step down" data-act="step-move" data-i="${i}" data-d="1">${ICON.chevDown}</button>
        <button class="icon-btn" aria-label="Delete step" data-act="step-remove" data-i="${i}">${ICON.trash}</button>
      </div>
    </div>`;
  }).join('');

  let reviewBtn = '';
  if (isTest) {
    if (o.approval === 'Awaiting QA review') reviewBtn = '<button class="btn" data-act="approve">Approve test</button>';
    else if (o.approval === 'Approved') reviewBtn = '<span class="pill passed">Approved</span>';
    else reviewBtn = '<button class="btn" data-act="submit-review">Submit for QA review</button>';
  }

  return `
  <div class="page">
    <div class="page-head">
      <div style="display: flex; flex-direction: column; gap: 8px; flex-grow: 1; max-width: 640px;">
        <button class="btn btn-sm" style="align-self: flex-start;" data-act="go" data-to="${isTest ? 'tests' : 'blocks'}">← ${isTest ? 'All tests' : 'All blocks'}</button>
        <label class="form-row">
          <span>${isTest ? `<span class="mono">${esc(o.id)}</span> test name` : 'Reusable block name'}</span>
          <input class="field field-lg" data-field="title" value="${esc(isTest ? o.title : o.name)}">
        </label>
        ${isTest ? `<label class="form-row">Start page address<input class="field" data-field="startUrl" value="${esc(o.startUrl || '')}"></label>` : ''}
      </div>
      <div class="actions">
        ${isTest ? `<button class="btn" data-act="record-more">${ICON.rec} Record more</button>` : ''}
        ${reviewBtn}
        ${isTest ? `<button class="btn btn-primary" data-act="run-edit">${ICON.play} Run test</button>` : ''}
      </div>
    </div>

    <div class="table">
      <div class="tr th cols-steps"><div>#</div><div>Action</div><div>On (field, button or page)</div><div>Value</div><div>Options</div><div></div></div>
      ${rows || '<div class="empty">No steps yet. Add a step or record more.</div>'}
      <div class="table-foot">
        <button class="btn btn-sm" data-act="add-step">+ Add step</button>
        ${isTest && o.steps.length ? `
          <span class="muted" style="margin-left: auto;">Save these steps as a reusable block:</span>
          <input class="field" id="block-name" placeholder="Block name, e.g. Log in as manager" style="width: 260px;">
          <button class="btn btn-sm" data-act="save-as-block">Save block</button>` : ''}
      </div>
    </div>
    <p class="muted">Changes save automatically. Use {variable} in values to pull from Test data. Hidden values are masked in the editor and the evidence document.</p>
  </div>`;
}

// ----- Run -----
function runCounts(run) {
  const steps = run.tests.flatMap((t) => t.steps);
  return {
    passed: steps.filter((s) => s.status === 'passed').length,
    failed: steps.filter((s) => s.status === 'failed').length,
    skipped: steps.filter((s) => s.status === 'skipped').length,
    testsPassed: run.tests.filter((t) => t.status === 'Passed').length,
    testsFailed: run.tests.filter((t) => t.status === 'Failed').length
  };
}

function runTitle(run) {
  return run.tests.length === 1 ? `<span class="mono" style="font-weight: 500;">${esc(run.tests[0].id)}</span> ${esc(run.tests[0].title)}` : `Regression run (${run.tests.length} tests)`;
}

function runHtml() {
  const run = S.run;
  if (!run) return '<div class="page"><h1>Starting run…</h1></div>';
  const c = runCounts(run);
  const done = run.status !== 'Running';
  const bannerClass = { Passed: 'passed', Failed: 'failed', Cancelled: 'cancelled' }[run.status] || '';
  const bannerTitle = {
    Running: 'Running… capturing a screenshot after each step',
    Passed: 'All tests passed. The evidence document is ready.',
    Failed: 'Some steps failed. Screenshots and errors are included in the evidence.',
    Cancelled: 'Run cancelled.'
  }[run.status];

  const tests = run.tests.map((t, ti) => `
    <div class="run-test">
      ${run.tests.length > 1 ? `<div class="run-test-head"><h2><span class="mono">${esc(t.id)}</span> ${esc(t.title)}</h2><span class="pill ${statusClass(t.status)}">${esc(t.status)}</span></div>` : ''}
      ${t.steps.map((s, si) => {
        const label = { pending: 'Waiting', running: 'Running…', passed: 'Passed', failed: 'Failed', skipped: 'Skipped because an earlier step failed' }[s.status];
        const symbol = { pending: s.num, running: '…', passed: '✓', failed: '✕', skipped: '–' }[s.status];
        const thumb = S.thumbs[ti + '-' + si];
        return `
        <div class="run-row ${s.status}">
          <div class="dot ${s.status}">${symbol}</div>
          <div class="run-body">
            <div class="run-text">${s.num}. ${esc(s.text)}</div>
            <div class="muted">${label}${s.ms ? ` in ${(s.ms / 1000).toFixed(1)}s` : ''}</div>
            ${s.error ? `<div class="run-error">${esc(s.error)}</div>` : ''}
          </div>
          ${thumb ? `<button class="thumb" data-act="open-image" data-file="${esc(s.screenshot)}" aria-label="Open screenshot for step ${s.num}"><img src="${thumb}" alt=""></button>` : ''}
        </div>`;
      }).join('')}
    </div>`).join('');

  return `
  <div class="page">
    <div class="page-head">
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <button class="btn btn-sm" style="align-self: flex-start;" data-act="back-from-run">← Back</button>
        <h1 style="font-size: 26px;">Run: ${runTitle(run)}</h1>
        <div class="muted">${esc(run.settings.environment || '')} environment · started ${esc(fmt(run.startedAt))}</div>
      </div>
      <div class="actions">
        ${done ? '' : '<button class="btn btn-danger" data-act="cancel-run">Cancel run</button>'}
        ${done ? `<button class="btn" data-act="run-tests" data-ids="${esc(run.tests.map((t) => t.id).join(','))}">Run again</button>` : ''}
        ${done ? '<button class="btn" data-act="go" data-to="report">Preview evidence</button>' : ''}
        ${done ? `<button class="btn btn-primary" data-act="export" data-id="${esc(run.id)}">${ICON.down} Download evidence (.docx)</button>` : ''}
      </div>
    </div>
    <div class="banner ${bannerClass}">
      <div class="banner-title">${bannerTitle}</div>
      <div class="banner-counts"><span>${c.passed} passed</span><span>${c.failed} failed</span><span>${c.skipped} skipped</span></div>
    </div>
    ${tests}
  </div>`;
}

// ----- Report preview -----
function reportHtml() {
  const run = S.run;
  if (!run) return runsHtml();
  const s = run.settings || {};
  const c = runCounts(run);
  const title = run.tests.length === 1 ? `${run.tests[0].id} ${run.tests[0].title}` : `${s.appName || 'Application'} regression run`;

  const evidence = run.tests.map((t, ti) => `
    <div style="display: flex; flex-direction: column; gap: 14px;">
      <h2>${esc(t.id)} ${esc(t.title)} <span class="pill ${statusClass(t.status)}" style="vertical-align: middle;">${esc(t.status)}</span></h2>
      ${t.steps.map((st, si) => `
        <div class="doc-step">
          <div class="body">
            <strong>Step ${st.num}: ${esc(st.text)}</strong>
            <div><span class="muted">Result: </span><span class="${st.status === 'passed' ? 'txt-pass' : st.status === 'failed' ? 'txt-fail' : 'muted'}">${esc(st.status.charAt(0).toUpperCase() + st.status.slice(1))}</span></div>
            <div class="muted">${st.action === 'Verify text appears' ? `Expected: “${esc(st.value)}” is shown on the page.` : 'Expected: the step completes without error.'}</div>
            ${st.error ? `<div class="txt-fail" style="font-weight: 400;">Actual: ${esc(st.error)}</div>` : ''}
          </div>
          ${S.thumbs[ti + '-' + si] ? `<img src="${S.thumbs[ti + '-' + si]}" alt="Screenshot for step ${st.num}">` : ''}
        </div>`).join('')}
    </div>`).join('');

  return `
  <div class="report-bg">
    <div class="report-bar">
      <button class="btn btn-sm" data-act="go" data-to="run">← Back to run</button>
      <div class="actions">
        <span class="muted">Preview of the Word document</span>
        <button class="btn btn-primary" data-act="export" data-id="${esc(run.id)}">${ICON.down} Download .docx</button>
      </div>
    </div>
    <article class="doc">
      <div>
        <div class="doc-kicker">Test execution evidence</div>
        <div class="doc-title">${esc(title)}</div>
      </div>
      <div class="doc-meta">
        <div><span class="muted">Application: </span>${esc(s.appName || '—')}</div>
        <div><span class="muted">Build version: </span>${esc(s.buildVersion || '—')}</div>
        <div><span class="muted">Environment: </span>${esc(s.environment || '—')}</div>
        <div><span class="muted">Trigger: </span>${esc(run.trigger || 'Manual')}</div>
        <div><span class="muted">Executed: </span>${esc(fmt(run.startedAt))}</div>
        <div><span class="muted">Executed by: </span>${esc(run.executedBy || '—')} using Test Studio</div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 10px;">
        <h2>Summary</h2>
        <div class="doc-summary">
          <div><div class="muted" style="font-size: 12px;">Overall result</div><div class="n ${run.status === 'Passed' ? 'txt-pass' : run.status === 'Failed' ? 'txt-fail' : ''}">${esc(run.status)}</div></div>
          <div><div class="muted" style="font-size: 12px;">Steps passed</div><div class="n">${c.passed}</div></div>
          <div><div class="muted" style="font-size: 12px;">Steps failed</div><div class="n">${c.failed}</div></div>
          <div><div class="muted" style="font-size: 12px;">Steps skipped</div><div class="n">${c.skipped}</div></div>
        </div>
      </div>
      <div style="display: flex; flex-direction: column; gap: 22px;">
        <h2>Step evidence</h2>
        ${evidence}
      </div>
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <h2>Sign-off</h2>
        <div class="signoff"><div><span>Tested by</span><hr></div><div><span>Approved by</span><hr></div><div><span>Date</span><hr></div></div>
      </div>
    </article>
  </div>`;
}

// ----- Runs history -----
function runsHtml() {
  const runs = S.data.runs.slice().reverse();
  const rows = runs.map((r) => `
    <div class="tr cols-runs">
      <div>${esc(fmt(r.startedAt))}</div>
      <div><div class="row-title">${r.tests.length === 1 ? esc(r.tests[0].id + ' ' + r.tests[0].title) : `${r.tests.length} tests`}</div>
        ${r.tests.length > 1 ? `<div class="row-sub">${esc(r.tests.map((t) => t.id).join(', '))}</div>` : ''}</div>
      <div><span class="pill ${statusClass(r.status)}">${esc(r.status)}</span></div>
      <div class="muted">${esc(r.trigger)}</div>
      <div class="row-actions">
        <button class="btn btn-sm" data-act="view-run" data-id="${esc(r.id)}">View</button>
        <button class="btn btn-sm" data-act="export" data-id="${esc(r.id)}">Download .docx</button>
        <button class="btn btn-sm" data-act="open-folder" data-id="${esc(r.id)}">Open folder</button>
        <button class="icon-btn" aria-label="Delete run" data-act="delete-run" data-id="${esc(r.id)}">${ICON.trash}</button>
      </div>
    </div>`).join('');
  const live = S.run && S.run.status === 'Running';
  return `
  <div class="page">
    <div class="page-head">
      <div class="intro"><h1>Runs</h1><p>Every run keeps its screenshots, so you can download the evidence document again at any time.</p></div>
      ${live ? '<button class="btn btn-primary" data-act="go" data-to="run">View run in progress</button>' : ''}
    </div>
    ${runs.length ? `<div class="table"><div class="tr th cols-runs"><div>Started</div><div>Tests</div><div>Result</div><div>Trigger</div><div></div></div>${rows}</div>`
      : '<div class="card empty"><strong>No runs yet</strong><p>Run a test from the Tests page to see results and evidence here.</p></div>'}
  </div>`;
}

// ----- Blocks -----
function blocksHtml() {
  const blocks = S.data.blocks;
  const usage = (id) => S.data.tests.filter((t) => (t.steps || []).some((s) => s.action === 'Use block' && s.value === id)).length;
  return `
  <div class="page">
    <div class="page-head">
      <div class="intro"><h1>Reusable blocks</h1><p>Steps you use in many tests, such as logging in. Change a block once and every test that uses it picks up the change.</p></div>
      <button class="btn btn-primary" data-act="new-block">+ New block</button>
    </div>
    ${blocks.length ? `<div class="table">
      <div class="tr th" style="grid-template-columns: minmax(0, 1fr) 100px 120px 160px;"><div>Block</div><div>Steps</div><div>Used in</div><div></div></div>
      ${blocks.map((b) => `
      <div class="tr" style="grid-template-columns: minmax(0, 1fr) 100px 120px 160px;">
        <div class="row-title">${esc(b.name)}</div>
        <div>${b.steps.length}</div>
        <div class="muted">${usage(b.id)} test(s)</div>
        <div class="row-actions">
          <button class="btn btn-sm" data-act="edit-block" data-id="${esc(b.id)}">Edit</button>
          <button class="icon-btn" aria-label="Delete block" data-act="delete-block" data-id="${esc(b.id)}">${ICON.trash}</button>
        </div>
      </div>`).join('')}
    </div>` : '<div class="card empty"><strong>No blocks yet</strong><p>Open a test and use “Save block” to turn its steps into a reusable block.</p></div>'}
  </div>`;
}

// ----- Test data -----
function dataHtml() {
  if (!S.varsDraft) S.varsDraft = clone(S.data.variables);
  return `
  <div class="page" style="max-width: 900px;">
    <div class="page-head">
      <div class="intro"><h1>Test data</h1><p>Values you can reuse in any step by typing the name in curly brackets, for example {username}. Change them here when accounts or environments change.</p></div>
    </div>
    <div class="table">
      <div class="tr th cols-vars"><div>Name</div><div>Value</div><div></div></div>
      ${S.varsDraft.map((v, i) => `
      <div class="tr cols-vars">
        <input class="field mono" aria-label="Name" data-var="key" data-i="${i}" value="${esc(v.key)}" placeholder="name">
        <input class="field" aria-label="Value" data-var="value" data-i="${i}" value="${esc(v.value)}">
        <button class="icon-btn" aria-label="Remove" data-act="var-remove" data-i="${i}">${ICON.trash}</button>
      </div>`).join('')}
      <div class="table-foot">
        <button class="btn btn-sm" data-act="var-add">+ Add value</button>
        <button class="btn btn-primary btn-sm" style="margin-left: auto;" data-act="var-save">Save test data</button>
      </div>
    </div>
    <p class="muted">Values are stored in plain text on this computer. Use dedicated test accounts, not personal passwords.</p>
  </div>`;
}

// ----- Schedules -----
function schedulesHtml() {
  const s = S.data.schedule;
  const days = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [0, 'Sun']];
  return `
  <div class="page" style="max-width: 760px;">
    <div class="intro"><h1>Schedules</h1><p class="muted" style="font-size: 15px; line-height: 1.5;">Run the regression suite automatically. Test Studio must be open on this computer at the scheduled time.</p></div>
    <div class="card card-pad">
      <label class="check"><input type="checkbox" id="sch-enabled" ${s.enabled ? 'checked' : ''}> Run tests automatically</label>
      <label class="form-row" style="max-width: 200px;">Time<input class="field" type="time" id="sch-time" value="${esc(s.time)}"></label>
      <div class="form-row">Days
        <div class="days">${days.map(([d, l]) => `<label class="check"><input type="checkbox" class="sch-day" value="${d}" ${s.days.includes(d) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
      </div>
      <label class="form-row" style="max-width: 320px;">Which tests
        <select class="field" id="sch-scope">
          <option value="approved" ${s.scope === 'approved' ? 'selected' : ''}>Approved tests only</option>
          <option value="all" ${s.scope === 'all' ? 'selected' : ''}>All tests</option>
        </select>
      </label>
      <div class="muted">${s.lastRunDate ? 'Last scheduled run: ' + esc(s.lastRunDate) : 'No scheduled run yet.'}</div>
      <div class="actions"><button class="btn btn-primary" data-act="save-schedule">Save schedule</button></div>
    </div>
  </div>`;
}

// ----- Settings -----
function settingsHtml() {
  const s = S.data.settings;
  return `
  <div class="page" style="max-width: 860px;">
    <div class="intro"><h1>Settings</h1><p class="muted" style="font-size: 15px;">These details appear on the cover of every evidence document.</p></div>
    <div class="card card-pad">
      <div class="form-grid">
        <label class="form-row">Application name<input class="field" id="set-appName" value="${esc(s.appName)}"></label>
        <label class="form-row">Environment<input class="field" id="set-environment" value="${esc(s.environment)}" placeholder="QA, UAT, Staging"></label>
        <label class="form-row">Build version<input class="field" id="set-buildVersion" value="${esc(s.buildVersion)}" placeholder="Update before each release run"></label>
        <label class="form-row">Base address<input class="field" id="set-baseUrl" value="${esc(s.baseUrl)}" placeholder="https://qa.myapp.company.com"><span class="hint">Used as the default start page and for steps that open a /path.</span></label>
        <label class="form-row">Step timeout (seconds)<input class="field" type="number" min="1" max="120" id="set-stepTimeout" value="${esc(s.stepTimeout)}"><span class="hint">How long to wait for a field, button or text to appear.</span></label>
      </div>
      <label class="check"><input type="checkbox" id="set-showRunWindow" ${s.showRunWindow ? 'checked' : ''}> Show the browser window while tests run</label>
      <div class="actions"><button class="btn btn-primary" data-act="save-settings">Save settings</button></div>
    </div>
  </div>`;
}

// ---------- Persistence ----------
function scheduleSave() {
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(saveEditing, 400);
}

async function saveEditing() {
  clearTimeout(S.saveTimer);
  const e = S.editing;
  if (!e) return;
  S.data = await call(e.kind === 'test' ? 'test:save' : 'block:save', clone(e.obj));
}

async function startRun(ids) {
  S.thumbs = {};
  S.run = null;
  try {
    await call('run:start', { testIds: ids });
    go('run');
  } catch (e) { /* toast shown */ }
}

async function finishRecording(steps) {
  const r = S.recording;
  if (!r) return;
  S.recording = null;
  const obj = r.obj;
  obj.steps = r.mode === 'append' ? obj.steps.concat(steps) : steps;
  if (obj.approval === 'Approved') obj.approval = 'Awaiting QA review';
  S.editing = { kind: 'test', obj };
  await saveEditing();
  go('edit');
}

function markChanged() {
  const o = S.editing && S.editing.obj;
  if (o && S.editing.kind === 'test' && o.approval === 'Approved') o.approval = 'Awaiting QA review';
  scheduleSave();
}

// ---------- Actions ----------
const actions = {
  go: (el) => {
    if (el.dataset.to === 'data') S.varsDraft = null;
    go(el.dataset.to);
  },

  'new-test': () => {
    S.setup = { title: '', url: S.data.settings.baseUrl || '' };
    go('setup');
    const t = document.getElementById('setup-title');
    if (t) t.focus();
  },

  'start-record': async () => {
    const title = document.getElementById('setup-title').value.trim() || 'Untitled test';
    const url = document.getElementById('setup-url').value.trim();
    S.setup = { title, url };
    const obj = { id: nextTestId(), title, startUrl: url, steps: [], approval: 'Not submitted', lastStatus: 'Draft', lastRun: null, createdAt: new Date().toISOString() };
    try {
      await call('recorder:start', { url });
      S.recording = { obj, mode: 'new', steps: [] };
      go('record');
    } catch (e) { /* toast shown */ }
  },

  'record-more': async () => {
    await saveEditing();
    const obj = S.editing.obj;
    try {
      await call('recorder:start', { url: obj.startUrl || S.data.settings.baseUrl });
      S.recording = { obj, mode: 'append', steps: [] };
      go('record');
    } catch (e) { /* toast shown */ }
  },

  'rec-check': () => call('recorder:check'),
  'rec-undo': async () => { S.recording.steps = await call('recorder:undo'); render(); },
  'rec-stop': async () => { const steps = await call('recorder:stop'); finishRecording(steps); },

  'edit-test': (el) => {
    const t = S.data.tests.find((x) => x.id === el.dataset.id);
    if (!t) return;
    S.editing = { kind: 'test', obj: clone(t) };
    go('edit');
  },

  'delete-test': async (el) => {
    const t = S.data.tests.find((x) => x.id === el.dataset.id);
    if (!t || !confirm(`Delete ${t.id} “${t.title}”? Past runs and evidence are kept.`)) return;
    S.data = await call('test:delete', t.id);
    render();
  },

  'run-tests': (el) => startRun(el.dataset.ids.split(',')),
  'run-approved': () => startRun(S.data.tests.filter((t) => t.approval === 'Approved').map((t) => t.id)),
  'run-edit': async () => { await saveEditing(); startRun([S.editing.obj.id]); },
  'cancel-run': () => call('run:cancel'),
  'back-from-run': () => go(S.editing && S.run && S.run.tests.length === 1 && S.editing.obj.id === S.run.tests[0].id ? 'edit' : 'tests'),

  'submit-review': () => { S.editing.obj.approval = 'Awaiting QA review'; saveEditing().then(render); },
  approve: () => { S.editing.obj.approval = 'Approved'; saveEditing().then(render); },

  'add-step': () => {
    S.editing.obj.steps.push({ id: uid(), action: 'Click', target: '', recordedTarget: '', value: '', secret: false, shot: true, locators: null });
    markChanged();
    render();
  },
  'step-move': (el) => {
    const i = +el.dataset.i;
    const j = i + +el.dataset.d;
    const steps = S.editing.obj.steps;
    if (j < 0 || j >= steps.length) return;
    [steps[i], steps[j]] = [steps[j], steps[i]];
    markChanged();
    render();
  },
  'step-remove': (el) => {
    S.editing.obj.steps.splice(+el.dataset.i, 1);
    markChanged();
    render();
  },

  'save-as-block': async () => {
    const input = document.getElementById('block-name');
    const name = input.value.trim();
    if (!name) { toast('Give the block a name first.', 'error'); input.focus(); return; }
    const block = { id: uid('b'), name, steps: clone(S.editing.obj.steps).filter((s) => s.action !== 'Use block') };
    S.data = await call('block:save', block);
    toast(`Saved “${name}”. Add it to any test with the “Use block” action.`);
  },

  'new-block': async () => {
    const block = { id: uid('b'), name: 'New block', steps: [] };
    S.data = await call('block:save', block);
    S.editing = { kind: 'block', obj: clone(block) };
    go('edit');
  },
  'edit-block': (el) => {
    const b = S.data.blocks.find((x) => x.id === el.dataset.id);
    if (!b) return;
    S.editing = { kind: 'block', obj: clone(b) };
    go('edit');
  },
  'delete-block': async (el) => {
    const b = S.data.blocks.find((x) => x.id === el.dataset.id);
    if (!b || !confirm(`Delete the block “${b.name}”? Tests that use it will fail at that step.`)) return;
    S.data = await call('block:delete', b.id);
    render();
  },

  'view-run': async (el) => {
    const { run, thumbs } = await call('runs:get', el.dataset.id);
    S.run = run;
    S.thumbs = thumbs;
    go('run');
  },
  export: async (el) => {
    const file = await call('report:export', el.dataset.id);
    if (file) toast('Evidence document saved.');
  },
  'open-folder': (el) => call('runs:folder', el.dataset.id),
  'delete-run': async (el) => {
    if (!confirm('Delete this run and its screenshots?')) return;
    S.data = await call('runs:delete', el.dataset.id);
    if (S.run && S.run.id === el.dataset.id) S.run = null;
    render();
  },
  'open-image': async (el) => {
    if (!el.dataset.file || !S.run) return;
    const img = await call('runs:image', { runId: S.run.id, file: el.dataset.file });
    if (img) { S.viewer = img; render(); }
  },
  'close-viewer': () => { S.viewer = null; render(); },

  'var-add': () => { S.varsDraft.push({ key: '', value: '' }); render(); },
  'var-remove': (el) => { S.varsDraft.splice(+el.dataset.i, 1); render(); },
  'var-save': async () => {
    const bad = S.varsDraft.find((v) => v.key && !/^\w+$/.test(v.key));
    if (bad) { toast(`“${bad.key}” can only use letters, numbers and underscores.`, 'error'); return; }
    S.data = await call('variables:save', S.varsDraft);
    S.varsDraft = clone(S.data.variables);
    toast('Test data saved.');
  },

  'save-schedule': async () => {
    const days = Array.from(document.querySelectorAll('.sch-day:checked')).map((c) => +c.value);
    S.data = await call('schedule:save', {
      enabled: document.getElementById('sch-enabled').checked,
      time: document.getElementById('sch-time').value || '07:00',
      days,
      scope: document.getElementById('sch-scope').value
    });
    toast('Schedule saved.');
  },

  'save-settings': async () => {
    const v = (id) => document.getElementById('set-' + id).value.trim();
    S.data = await call('settings:save', {
      appName: v('appName'),
      environment: v('environment'),
      buildVersion: v('buildVersion'),
      baseUrl: v('baseUrl'),
      stepTimeout: Math.min(120, Math.max(1, parseInt(v('stepTimeout'), 10) || 10)),
      showRunWindow: document.getElementById('set-showRunWindow').checked
    });
    toast('Settings saved.');
  }
};

// ---------- Event delegation ----------
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  if (el.classList.contains('viewer') && e.target !== el) return;
  const fn = actions[el.dataset.act];
  if (fn) Promise.resolve(fn(el)).catch(() => {});
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.field && S.editing) {
    const o = S.editing.obj;
    const f = el.dataset.field;
    if (f === 'title') {
      if (S.editing.kind === 'test') o.title = el.value; else o.name = el.value;
      markChanged();
      return;
    }
    if (f === 'startUrl') { o.startUrl = el.value.trim(); markChanged(); return; }
    const step = o.steps[+el.dataset.i];
    if (!step) return;
    if (f === 'shot' || f === 'secret') step[f] = el.checked;
    else step[f] = el.value;
    if (f === 'action' && step.action === 'Use block') step.value = '';
    markChanged();
    if (f === 'action' || f === 'secret') render();
    return;
  }
  if (el.dataset.var && S.varsDraft) {
    S.varsDraft[+el.dataset.i][el.dataset.var] = el.value.trim();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.viewer) { S.viewer = null; render(); }
});

// ---------- Main-process events ----------
api.on('recorder:steps', (steps) => {
  if (!S.recording) return;
  S.recording.steps = steps;
  if (S.screen === 'record') render();
});

api.on('recorder:closed', (steps) => finishRecording(steps));

api.on('run:update', ({ run, thumb }) => {
  if (!S.run || S.run.id !== run.id) S.thumbs = {};
  S.run = run;
  if (thumb) S.thumbs[thumb.key] = thumb.dataUrl;
  if (S.screen === 'run' || S.screen === 'report') render();
});

api.on('run:finished', async () => {
  S.data = await api.invoke('data:get');
  if (S.editing && S.editing.kind === 'test') {
    const fresh = S.data.tests.find((t) => t.id === S.editing.obj.id);
    if (fresh) { S.editing.obj.lastStatus = fresh.lastStatus; S.editing.obj.lastRun = fresh.lastRun; }
  }
  render();
});

api.on('run:error', ({ message }) => toast('The run stopped unexpectedly: ' + message, 'error'));
api.on('run:scheduled', () => toast('Scheduled run started.'));

// ---------- Boot ----------
(async function boot() {
  S.data = await api.invoke('data:get');
  render();
})();
