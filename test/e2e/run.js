// End-to-end check of the headless runner against the fixture app.
// Runs the suite in test/e2e/suite and checks results, reports and screenshots.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { start } = require('../fixture/server');

const BIN = path.join(__dirname, '..', '..', 'bin', 'test-studio.js');
const SUITE = path.join(__dirname, 'suite');

function cli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env } });
    let output = '';
    child.stdout.on('data', (d) => { output += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { output += d; process.stderr.write(d); });
    child.on('exit', (code) => resolve({ code, output }));
  });
}

(async () => {
  const server = await start(0);
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-e2e-'));
  try {
    const list = await cli(['list', '--suite', SUITE, '--tag', 'smoke']);
    assert.equal(list.code, 0);
    assert.match(list.output, /2 test\(s\)/);

    const early = await cli(['validate', '--suite', SUITE, '--test', 'TC010']);
    assert.equal(early.code, 1, 'TC010 alone uses a value before it is saved');
    assert.match(early.output, /\{newOrderId\} is used before a “Save value from text” step saves it/);

    const validate = await cli(['validate', '--suite', SUITE], { TS_VAR_password: 'x' });
    assert.equal(validate.code, 0, 'validate should pass');

    const noSecret = await cli(['validate', '--suite', SUITE, '--warnings-as-errors']);
    assert.equal(noSecret.code, 1, 'a blank secret is a warning');
    assert.match(noSecret.output, /set the TS_VAR_password environment variable/);

    const run = await cli(['run', '--suite', SUITE, '--base-url', baseUrl, '--retries', '1', '--out', out, '--docx'], { TS_VAR_password: 'correct-horse' });
    assert.equal(run.code, 1, 'run should exit 1 because of the expected failures');

    const latest = JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8'));
    const results = JSON.parse(fs.readFileSync(path.join(latest.dir, 'results.json'), 'utf8'));
    const byId = Object.fromEntries(results.tests.map((t) => [t.id, t]));

    assert.equal(byId.TC001.status, 'Passed', 'TC001: ' + JSON.stringify(byId.TC001.failure));
    assert.equal(byId.TC001.flaky, false);
    assert.equal(byId.TC002.status, 'Passed', 'TC002: ' + JSON.stringify(byId.TC002.failure));
    assert.equal(byId.TC003.status, 'Failed');
    assert.equal(byId.TC003.failure.step, 2);
    assert.match(byId.TC003.failure.error, /was not found/);
    assert.equal(byId.TC003.attempts, 2, 'failed test is retried');
    assert.equal(byId.TC004.status, 'Passed');
    assert.equal(byId.TC004.flaky, true, 'TC004 passes only on retry');
    assert.equal(byId.TC005.status, 'Failed');
    assert.match(byId.TC005.failure.error, /console error/);
    assert.equal(results.summary.flaky, 1);

    // AG Grid and captured values.
    for (const id of ['TC006', 'TC007', 'TC008', 'TC009', 'TC010', 'TC013', 'TC014', 'TC015', 'TC016', 'TC018', 'TC019', 'TC020', 'TC024', 'TC025']) assert.equal(byId[id].status, 'Passed', id + ': ' + JSON.stringify(byId[id].failure));
    assert.deepEqual(byId.TC007.captured, { orderId: '1003' });
    assert.deepEqual(byId.TC009.captured, { newOrderId: '5001' });
    const runTests = JSON.parse(fs.readFileSync(path.join(latest.dir, 'run.json'), 'utf8')).tests;
    const inRun = (id) => runTests.find((t) => t.id === id);
    const stepText = (id, match) => (inRun(id).steps.find((s) => match.test(s.text)) || {}).text;
    const tc010 = inRun('TC010');
    assert.equal(tc010.steps[0].value, '/order.html?id=5001');
    assert.match(tc010.steps[1].text, /Order details for 5001/);

    // Test data reaches a grid row and a locator, and the results show the values actually used.
    assert.ok(stepText('TC013', /row where Customer contains “customer 250”/), 'TC013 finds its row through {keyCustomer}');
    assert.ok(!JSON.stringify(inRun('TC013')).includes('{keyCustomer}'), 'no placeholder is left in the results');
    // TC011 step s202 has no target, so its name in the run view comes from its locator.
    assert.equal(stepText('TC011', /Welcome/), 'Check that “Welcome, alice” is visible');

    // A column wider than the space between the pinned columns never fits: acting on it used to
    // scroll one edge in and the other out until the step timed out.
    assert.ok(inRun('TC018').steps.every((s) => s.ms < 20000), 'TC018 does not sit in a scrolling loop');

    // A check that has its own locator keeps it, even with a grid target left over from an earlier
    // action. Without that the step silently becomes "is this row in the grid?" instead.
    assert.equal(stepText('TC019', /Admin/), 'Check that “Admin tools” is not visible');

    // A test ID on the wrapper a framework puts round a control. Every step has to reach the
    // control inside it, and none of them may be sent twice — the page counts its submits.
    assert.ok(inRun('TC020').steps.every((s) => s.ms < 4000), 'TC020 never waits out a timeout');
    // A control a component keeps in a shadow root: Playwright looks inside one, so the step has to.
    assert.ok(stepText('TC020', /Applied estimate/), 'TC020 reaches the control in the shadow root');

    // Clicking something that cannot be clicked has to fail, and say which of the reasons it is.
    assert.equal(byId.TC021.status, 'Failed');
    assert.match(byId.TC021.failure.error, /is disabled, so it cannot be clicked/);

    // Not finding something has three quite different causes, and the failure has to name which.
    assert.equal(byId.TC022.status, 'Failed');
    assert.match(byId.TC022.failure.error, /an element has data-test-id="adjustment-apply-button"/);
    assert.match(byId.TC022.failure.error, /Change the test ID attribute in Settings/);

    // Nothing matched, but names from the same part of the application are on screen: the step is
    // asking for the wrong name, not looking at the wrong screen.
    assert.equal(byId.TC023.status, 'Failed');
    assert.match(byId.TC023.failure.error, /the right part of the application looks to be on screen/);
    assert.match(byId.TC023.failure.error, /“estimate-amount”|“estimate-apply”/);

    // Everything TC024 works is inside a frame, and one of the controls is in a shadow root inside
    // that frame, so both boundaries are crossed on the same step.
    assert.ok(stepText('TC024', /Applied estimate 250/), 'TC024 reaches through the frame');

    // Playwright-style locators and strict mode.
    assert.equal(byId.TC011.status, 'Passed', 'TC011: ' + JSON.stringify(byId.TC011.failure));
    assert.deepEqual(byId.TC011.fragileSteps, [14], 'the .nth() locator is reported as fragile');
    assert.equal(byId.TC012.status, 'Failed');
    assert.match(byId.TC012.failure.error, /getByRole\('button', \{ name: 'Edit' \}\) matched 2 elements/);

    // Tree data (AG Grid Enterprise): a check reports a collapsed folder instead of opening it.
    assert.equal(byId.TC017.status, 'Failed');
    assert.match(byId.TC017.failure.error, /“Proposal\.docx” is inside the collapsed folder “Documents”/);

    const junit = fs.readFileSync(path.join(latest.dir, 'junit.xml'), 'utf8');
    assert.match(junit, /tests="25" failures="7"/);
    for (const f of ['report.html', 'evidence.docx', 'run.json']) assert.ok(fs.statSync(path.join(latest.dir, f)).size > 0, f);

    const shot = byId.TC003.failure.screenshot;
    assert.ok(shot && fs.statSync(path.join(latest.dir, shot)).size > 1000, 'failure screenshot is saved');

    const runJson = fs.readFileSync(path.join(latest.dir, 'run.json'), 'utf8');
    assert.ok(!runJson.includes('correct-horse'), 'secret values are not written to run results');

    // A second run compares with the first.
    const again = await cli(['run', '--suite', SUITE, '--base-url', baseUrl, '--test', 'TC003', '--out', out], { TS_VAR_password: 'correct-horse' });
    assert.equal(again.code, 1);
    const second = JSON.parse(fs.readFileSync(path.join(JSON.parse(fs.readFileSync(path.join(out, 'latest.json'), 'utf8')).dir, 'results.json'), 'utf8'));
    assert.equal(second.tests[0].change, 'Still failing');

    console.log('\nEnd-to-end checks passed.');
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error('\nEnd-to-end checks FAILED:\n' + (e.stack || e));
  process.exit(1);
});
