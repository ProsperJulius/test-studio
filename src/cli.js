// Headless runner used by CI and operating-system schedulers. Runs inside Electron without the studio window.
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs, USAGE } = require('./cli-args');
const { loadSuite } = require('./suite');
const { selectTests } = require('./select');
const { resolveEnvironment } = require('./environments');
const { validateSuite } = require('./validate');
const reporters = require('./reporters');

const out = (line) => process.stdout.write(line + '\n');
const err = (line) => process.stderr.write(line + '\n');

function printProblems(problems) {
  for (const p of problems) (p.level === 'error' ? err : out)('  ' + p.level.toUpperCase() + '  ' + p.where + ': ' + p.message);
}

function readHistory(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return {}; }
}

// ctx: { store, runner, report, runsDir } — store and runsDir are used when no --suite is given.
async function main(argv, ctx) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(e.message + '\n');
    err(USAGE);
    return 2;
  }
  if (args.command === 'help') { out(USAGE); return 0; }

  const fromSuite = !!args.suite;
  let data;
  try {
    data = fromSuite ? loadSuite(path.resolve(args.suite)) : ctx.store.get();
  } catch (e) {
    err(e.message);
    return 2;
  }

  let resolved;
  try {
    resolved = resolveEnvironment(data, args.env, {
      baseUrl: args['base-url'],
      buildVersion: args.build,
      retries: args.retries,
      stepTimeout: args.timeout
    }, process.env);
  } catch (e) {
    err(e.message);
    return 2;
  }

  const tests = selectTests(data.tests, { ids: args.test, tags: args.tag, excludeTags: args['exclude-tag'], approvedOnly: args['approved-only'] });

  if (args.command === 'list') {
    for (const t of tests) out(t.id.padEnd(8) + ' ' + (t.priority || '').padEnd(3) + ' ' + t.title + (t.tags.length ? '  [' + t.tags.join(', ') + ']' : '') + (t.disabled ? ' (disabled)' : ''));
    out(tests.length + ' test(s)');
    return 0;
  }

  const problems = validateSuite({ ...data, tests }, resolved.variables, { allTests: data.tests });
  const blocking = problems.filter((p) => p.level === 'error' || (p.level === 'warning' && args['warnings-as-errors']));
  const serious = problems.filter((p) => p.level !== 'info');
  if (serious.length) {
    out('Validation found ' + serious.length + ' problem(s):');
    printProblems(serious);
  }
  const notes = problems.length - serious.length;
  if (notes && args.command === 'validate') {
    out(notes + ' step(s) use older recorded targets. Convert them to Playwright-style locators in the step editor.');
  }
  if (args.command === 'validate') {
    if (!serious.length) out('No problems found in ' + tests.length + ' test(s).');
    return blocking.length ? 1 : 0;
  }
  if (blocking.length) { err('Fix the errors above before running.'); return 2; }
  if (!tests.length) { err('No tests match the options given.'); return 2; }

  const outRoot = args.out ? path.resolve(args.out) : fromSuite ? path.resolve('test-results') : ctx.runsDir;
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(outRoot, id);
  fs.mkdirSync(dir, { recursive: true });

  const settings = { ...resolved.settings, showRunWindow: !!args.headed };
  out('Running ' + tests.length + ' test(s) against ' + (settings.environment || 'default') + (settings.baseUrl ? ' (' + settings.baseUrl + ')' : '') + '…');

  const run = { id, trigger: 'Command line', startedAt: new Date().toISOString(), finishedAt: null, status: 'Running', executedBy: os.userInfo().username, settings, tests: [] };
  const printed = new Set();
  const final = await ctx.runner.run({
    run, tests, blocks: data.blocks, variables: resolved.variables, settings, dir,
    onUpdate: (snapshot) => {
      for (const t of snapshot.tests) {
        if (printed.has(t.id) || !['Passed', 'Failed', 'Cancelled'].includes(t.status)) continue;
        printed.add(t.id);
        const f = t.steps.find((s) => s.status === 'failed');
        const mark = t.status === 'Passed' ? (t.flaky ? '~ FLAKY ' : '✓ PASS  ') : t.status === 'Failed' ? '✕ FAIL  ' : '- SKIP  ';
        out('  ' + mark + t.id + ' ' + t.title + (t.flaky ? ' (passed on attempt ' + t.attempts + ')' : ''));
        if (f) err('           step ' + f.num + ': ' + f.text + '\n           ' + f.error);
      }
    }
  });

  // Compare with the previous result for each test.
  const historyFile = fromSuite || args.out ? path.join(outRoot, 'history.json') : null;
  const previous = historyFile ? readHistory(historyFile) : Object.fromEntries(data.tests.map((t) => [t.id, t.lastStatus]));
  reporters.compareWithPrevious(final, Object.fromEntries(Object.entries(previous).map(([k, v]) => [k, v && v.status ? v.status : v])));

  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(final, null, 2));
  fs.writeFileSync(path.join(dir, 'junit.xml'), reporters.toJUnit(final));
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(reporters.toJson(final), null, 2));
  fs.writeFileSync(path.join(dir, 'report.html'), reporters.toHtml(final));
  if (args.docx) await ctx.report.build(final, dir, path.join(dir, 'evidence.docx'));

  if (historyFile) {
    const history = readHistory(historyFile);
    for (const t of final.tests) if (t.status !== 'Cancelled') history[t.id] = { status: t.status, runId: final.id, at: final.finishedAt };
    fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));
  } else {
    ctx.recordRun(final);
  }
  // Stable paths for CI to pick up.
  fs.writeFileSync(path.join(outRoot, 'latest.json'), JSON.stringify({ id: final.id, dir, status: final.status }, null, 2));

  const sum = reporters.summarize(final);
  out('');
  out(final.status.toUpperCase() + ': ' + sum.passed + ' passed, ' + sum.failed + ' failed' + (sum.flaky ? ', ' + sum.flaky + ' flaky' : '') +
    (sum.newFailures ? ', ' + sum.newFailures + ' new failure(s)' : '') + (sum.fixed ? ', ' + sum.fixed + ' fixed' : '') + ' in ' + (sum.durationMs / 1000).toFixed(0) + 's');
  out('Reports: ' + dir);
  return final.status === 'Passed' ? 0 : 1;
}

module.exports = { main };
