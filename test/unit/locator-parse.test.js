const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLocator, formatLocator, describeLocator, legacyToLocator, mapText, locatorQuality, targetName } = require('../../src/locator-parse');
const { substitute, locatorsFor } = require('../../src/steps');
const { validateSuite } = require('../../src/validate');

const roundTrip = (text) => {
  const r = parseLocator(text);
  assert.ok(r.ok, text + ': ' + r.error);
  return formatLocator(r.ast);
};

test('parses and formats every supported call', () => {
  const cases = [
    "getByRole('button', { name: 'Save order', exact: true })",
    "getByRole('checkbox', { checked: true, disabled: false, includeHidden: true })",
    "getByRole('heading', { level: 2, name: /orders/i })",
    "getByRole('tab', { selected: true, expanded: false, pressed: true })",
    "getByText('Welcome')", "getByText(/^Order \\d+$/)", "getByLabel('Email', { exact: true })",
    "getByPlaceholder('Search')", "getByAltText('Logo')", "getByTitle('Help')", "getByTestId('save')",
    "locator('#save')", "locator('xpath=//li')",
    "getByRole('dialog').getByRole('button', { name: 'Cancel' })",
    "getByRole('listitem').filter({ hasText: 'Pears', hasNotText: /apples/, visible: true }).first()",
    "getByRole('button').last()", "getByRole('button').nth(-1)"
  ];
  for (const c of cases) assert.equal(roundTrip(c), c);
});

test('normalises quotes, spacing and the page. prefix', () => {
  assert.equal(roundTrip(`page.getByRole("button",{name:"It's"})`), "getByRole('button', { name: 'It\\'s' })");
  assert.equal(roundTrip("  getByText( `a\\nb` ) "), "getByText('a\\nb')");
  assert.equal(roundTrip("getByRole('button', { 'name': 'x' })"), "getByRole('button', { name: 'x' })");
});

test('reports helpful errors with positions', () => {
  const err = (text) => parseLocator(text);
  assert.match(err('').error, /empty/);
  assert.match(err("getByButton('Save')").error, /Did you mean getByRole\('button'/);
  assert.match(err("getByRole('button', { nam: 'x' })").error, /unknown option “nam”/);
  assert.deepEqual([err("getByText('open").at, /missing its closing/.test(err("getByText('open").error)], [10, true]);
  assert.match(err('first()').error, /must follow another locator/);
  assert.match(err("getByText(`${x}`)").error, /Template expressions/);
  assert.match(err("getByText(/(/)").error, /Invalid regular expression/);
  assert.match(err("getByRole('button') trailing").error, /after the locator/);
  assert.match(err("getByRole('button').nth('2')").error, /whole number/);
  assert.match(err('getByRole(button)').error, /Use quotes/);
});

test('describes locators in plain English and names targets', () => {
  const ast = (t) => parseLocator(t).ast;
  assert.equal(describeLocator(ast("getByRole('dialog', { name: 'Edit order' }).getByRole('button', { name: 'Save' })")), '“Save” button in the “Edit order” dialog');
  assert.equal(describeLocator(ast("getByRole('listitem').filter({ hasText: 'Pears' }).getByRole('button').nth(1)")), 'item 2 of button in the listitem containing “Pears”');
  assert.equal(targetName(ast("getByLabel('Email')")), 'Email');
  assert.equal(targetName(ast("getByRole('button', { name: 'Save' }).first()")), 'Save');
});

test('converts older recorded hints to locators', () => {
  assert.equal(legacyToLocator({ testId: 'save', label: 'x' }), "getByTestId('save')");
  assert.equal(legacyToLocator({ testId: 'save' }, 'data-qa'), `locator('[data-testid="save"],[data-test="save"],[data-qa="save"],[data-cy="save"]')`);
  assert.equal(legacyToLocator({ label: 'Username' }), "getByLabel('Username', { exact: true })");
  // An id names one element in a page; a label describes one, and a dialog opening over the page
  // can put a second element with the same label in it. A <label for=…> needs the field to have an
  // id, so a converted field step nearly always has one to use.
  assert.equal(legacyToLocator({ id: 'qty', label: 'Quantity', name: 'qty' }), "locator('#qty')");
  assert.equal(legacyToLocator({ testId: 'save', id: 'qty' }), "getByTestId('save')", 'a test id still comes first');
  // An id the page made up as it ran names a different element next time, so it is not used.
  assert.equal(legacyToLocator({ id: 'input-8831742', label: 'Quantity' }), "getByLabel('Quantity', { exact: true })");
  assert.equal(legacyToLocator({ id: 'r:0', label: 'Quantity' }), "getByLabel('Quantity', { exact: true })");
  assert.equal(legacyToLocator({ placeholder: 'Search' }), "getByPlaceholder('Search', { exact: true })");
  assert.equal(legacyToLocator({ id: 'secret-panel' }), "locator('#secret-panel')");
  assert.equal(legacyToLocator({ name: 'q' }), `locator('[name="q"]')`);
  assert.equal(legacyToLocator({ text: 'Sign in' }), "getByText('Sign in', { exact: true })");
  assert.equal(legacyToLocator({ css: 'main > button' }), "locator('main > button')");
  assert.equal(legacyToLocator({}), null);
  for (const l of [{ testId: 'a"b' }, { label: "it's" }, { css: 'a[title="x"]' }]) assert.ok(parseLocator(legacyToLocator(l)).ok);
});

test('substitutes {name} test data inside locators, but not inside regular expressions', () => {
  const vars = [{ key: 'orderId', value: '1002' }];
  const ast = mapText(parseLocator("getByRole('row', { name: 'Order {orderId}' }).getByText(/{orderId}/)").ast, (t) => substitute(t, vars));
  assert.equal(formatLocator(ast), "getByRole('row', { name: 'Order 1002' }).getByText(/{orderId}/)");
  const loc = locatorsFor({ locator: "getByTestId('row-{orderId}')" }, vars, { testIdAttribute: 'data-qa' });
  assert.deepEqual([loc.source, loc.testIdAttribute, loc.quality], ["getByTestId('row-1002')", 'data-qa', 'testid']);
  assert.throws(() => locatorsFor({ locator: 'getByRole(' }, vars), /not valid/);
});

test('classifies locator quality', () => {
  const q = (t) => locatorQuality(parseLocator(t).ast);
  assert.equal(q("getByTestId('x')"), 'testid');
  assert.equal(q("getByRole('button', { name: 'x' })"), 'role');
  assert.equal(q("getByText('x')"), 'text');
  assert.equal(q("getByRole('button').nth(1)"), 'nth');
  assert.equal(q("locator('#x')"), 'css');
  assert.equal(q("locator('main > div:nth-of-type(2)')"), 'css-path');
});

test('validation reports invalid and fragile locators and older targets', () => {
  const data = { blocks: [], tests: [{ id: 'T', steps: [
    { action: 'Click', target: 'Save', locator: "getByRole('button', { name: 'Save' })" },
    { action: 'Click', target: 'x', locator: "getByRole('button').nth(2)" },
    { action: 'Click', target: 'y', locator: 'getByRole(' },
    { action: 'Click', target: 'Old' },
    { action: 'Verify element text', target: 'r', value: 'z', locator: "getByRole('row', { name: '{nope}' })" }
  ] }] };
  const p = validateSuite(data, []);
  const at = (where) => p.filter((x) => x.where === where).map((x) => x.level + ': ' + x.message).join(' | ');
  assert.equal(at('T step 1'), '');
  assert.match(at('T step 2'), /^warning: .*position/);
  assert.match(at('T step 3'), /^error: The locator is not valid/);
  assert.match(at('T step 4'), /^info: .*Convert to locator/);
  assert.match(at('T step 5'), /Test data not found: \{nope\}/);
});
