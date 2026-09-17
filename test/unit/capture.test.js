const test = require('node:test');
const assert = require('node:assert/strict');
const { templateToRegex, extract, suggestTemplate, capturedNames, namesIn } = require('../../src/capture');

test('extract captures a value at the end and trims punctuation', () => {
  assert.deepEqual(extract('Order {orderId}', 'Success! Order 1234 updated.'), { orderId: '1234' });
  assert.equal(extract('Invoice {id}', 'Order 1234 updated'), null);
  assert.deepEqual(extract('Order {orderId} updated', 'Success! Order 1234 updated.'), { orderId: '1234' });
  assert.deepEqual(extract('Reference: {ref}', 'Saved. Reference: ORD-2026-0012.'), { ref: 'ORD-2026-0012' });
});

test('extract handles values between literals, multiple names, spacing and case', () => {
  assert.deepEqual(extract('Customer {name} placed order {id}', 'customer  Jane Doe placed order #77!'), { name: 'Jane Doe', id: '#77' });
  assert.deepEqual(extract('Total ${amount} due', 'Total $12.50 due today'), { amount: '12.50' });
});

test('extract supports regular expressions with named groups', () => {
  assert.deepEqual(extract('/Order (?<orderId>\\d+)/', 'Order 5001 created successfully'), { orderId: '5001' });
  assert.equal(extract('/Order (?<orderId>\\d+)/', 'Nothing here'), null);
});

test('templateToRegex explains invalid templates', () => {
  assert.throws(() => templateToRegex('Order created'), /curly brackets/);
  assert.throws(() => templateToRegex('{a} and {a}'), /only appear once/);
  assert.throws(() => templateToRegex('/Order \\d+/'), /named group/);
  assert.throws(() => templateToRegex('/Order (?<id>/'), /not valid/);
});

test('suggestTemplate replaces the most ID-like word', () => {
  assert.equal(suggestTemplate('Order 5001 created successfully', 'orderId'), 'Order {orderId} created successfully');
  assert.equal(suggestTemplate('Saved (ref #A-12345).', 'ref'), 'Saved (ref #{ref}).');
  assert.equal(suggestTemplate('All done', 'x'), null);
  const t = suggestTemplate('Order 5001 created successfully', 'orderId');
  assert.deepEqual(extract(t, 'Order 5001 created successfully'), { orderId: '5001' });
});

test('capturedNames walks steps and blocks in order', () => {
  const blocks = [{ id: 'b', name: 'Create', steps: [{ action: 'Save value from text', value: 'Order {orderId} created' }] }];
  const steps = [{ action: 'Use block', value: 'b' }, { action: 'Save value from text', value: '/Ref (?<ref>\\w+)/' }, { action: 'Click' }];
  assert.deepEqual(capturedNames(steps, blocks), ['orderId', 'ref']);
  assert.deepEqual(namesIn('{a} x {b}'), ['a', 'b']);
});

test('suggestCapture names the value from the words before it and avoids names in use', () => {
  const { suggestCapture } = require('../../src/capture');
  assert.deepEqual(suggestCapture('Order 5001 created successfully', []), { template: 'Order {orderId} created successfully', name: 'orderId' });
  assert.equal(suggestCapture('Order 5001 created', ['orderId']).name, 'orderId2');
  assert.equal(suggestCapture('Your booking reference is BK-99812', []).name, 'bookingId');
  assert.deepEqual(suggestCapture('All done', []), { template: null, name: 'capturedValue' });
});
