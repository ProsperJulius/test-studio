// Shared by the main process (runner, reports, CLI) and the renderer (editor, run view).
(function (root) {
  // target: the step acts on a field, button or element (false = whole page).
  // value: placeholder for the value field, or null when no value is needed.
  // verify: the step is a pass/fail check.
  // field: the target must be a form field (input, select, textarea).
  // grid: the target can be a cell or header in an AG Grid.
  // capture: the step saves part of the page text as test data.
  const ACTION_META = {
    'Open page': { target: true, value: 'https://… or /path' },
    Click: { target: true, value: null, grid: true },
    'Double-click': { target: true, value: null, grid: true },
    'Right-click': { target: true, value: null, grid: true },
    Type: { target: true, value: 'Value or {variable}', field: true, secretable: true, grid: true },
    Select: { target: true, value: 'Option text', field: true },
    'Press Enter': { target: true, value: null, field: true, grid: true },
    'Verify text appears': { target: false, value: 'Text that must appear', verify: true },
    'Verify text is not shown': { target: false, value: 'Text that must not appear', verify: true },
    'Verify element is visible': { target: true, value: null, verify: true, grid: true },
    'Verify element is hidden': { target: true, value: null, verify: true, grid: true },
    'Verify element is enabled': { target: true, value: null, verify: true },
    'Verify element is disabled': { target: true, value: null, verify: true },
    'Verify field value': { target: true, value: 'Expected value, or checked / unchecked', verify: true, field: true },
    'Verify element text': { target: true, value: 'Text the element must contain', verify: true, grid: true },
    'Verify page address contains': { target: false, value: 'For example /orders/confirmation', verify: true },
    'Verify page title': { target: false, value: 'Text the title must contain', verify: true },
    'Verify no console errors': { target: false, value: null, verify: true },
    'Save value from text': { target: true, optionalTarget: true, value: 'Order {orderId} created', capture: true },
    Wait: { target: false, value: 'Seconds' },
    'Take screenshot': { target: true, value: null },
    'Use block': { target: false, value: 'block' }
  };

  const ACTIONS = Object.keys(ACTION_META);

  function metaFor(action) {
    return ACTION_META[action] || { target: true, value: '' };
  }

  const PARTS = { header: 'the header of', 'header-menu': 'the column menu of', 'header-filter': 'the filter button of', 'floating-filter': 'the filter box of' };

  // A tree path such as “Documents › Work › Report.pdf”. › , > and / all separate the folders.
  function splitPath(value) {
    return String(value || '').split(/\s+(?:›|>|\/)\s+/).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }

  const gridNameOf = (g) => (g.grid && g.grid.label ? 'the ' + g.grid.label + ' grid' : 'the grid');

  // How a grid step finds its row, e.g. row where Customer contains “Jane”.
  function describeGridRow(g) {
    const r = (g && g.row) || {};
    if (r.mode === 'index') return 'row ' + ((Number(r.index) || 0) + 1);
    if (r.mode === 'path') return 'row “' + (splitPath(r.value).join(' › ') || '…') + '”';
    return 'row where ' + ((r.column && (r.column.header || r.column.colId)) || 'column') + (r.match === 'contains' ? ' contains “' : ' is “') + (r.value || '…') + '”';
  }

  // Plain-English name for a grid target, e.g. “Status” in the Orders grid, row where Order ID is “1001”.
  function describeGridTarget(g) {
    if (!g) return '';
    const col = (g.column && (g.column.header || g.column.colId)) || 'column';
    const gridName = gridNameOf(g);
    const inner = g.inner === 'a' || g.inner === 'button' ? ' ' + (g.inner === 'a' ? 'link' : 'button') + ' in' : '';
    if (g.part && g.part !== 'cell') return PARTS[g.part] + ' “' + col + '” in ' + gridName;
    const row = describeGridRow(g);
    return (inner ? 'the' + inner + ' ' : '') + '“' + col + '” in ' + gridName + ', ' + row;
  }

  let LocatorParse = null;
  function locatorName(text) {
    try {
      if (!LocatorParse) LocatorParse = typeof module !== 'undefined' && module.exports ? require('./locator-parse') : root.LocatorParse;
      const parsed = LocatorParse && LocatorParse.parseLocator(text);
      return parsed && parsed.ok ? LocatorParse.targetName(parsed.ast) : '';
    } catch (e) {
      return '';
    }
  }

  function describeStep(step, blocks) {
    if (!step.target && step.locator) step = { ...step, target: locatorName(step.locator) };
    const shown = step.secret ? '••••••••' : (step.value || '');
    if (step.grid && metaFor(step.action).grid) {
      const where = describeGridTarget(step.grid);
      const inner = step.grid.inner;
      if ((inner === 'expand' || inner === 'collapse') && (step.grid.part || 'cell') === 'cell') {
        return (inner === 'expand' ? 'Expand the ' : 'Collapse the ') + describeGridRow(step.grid) + ' in ' + gridNameOf(step.grid);
      }
      switch (step.action) {
        case 'Click': return 'Click ' + where;
        case 'Double-click': return 'Double-click ' + where;
        case 'Right-click': return 'Right-click ' + where;
        case 'Type': return 'Type “' + (shown || '…') + '” into ' + where;
        case 'Press Enter': return 'Press Enter in ' + where;
        case 'Verify element is visible': return 'Check that ' + where + ' is visible';
        case 'Verify element text': return 'Check that ' + where + ' contains “' + (shown || '…') + '”';
        case 'Verify element is hidden': return 'Check that the ' + describeGridRow(step.grid) + ' is not in ' + gridNameOf(step.grid);
        default: break;
      }
    }
    const target = step.target || '…';
    switch (step.action) {
      case 'Open page':
        return 'Open ' + (step.target || 'page') + (step.value ? ' (' + step.value + ')' : '');
      case 'Click':
        return 'Click “' + target + '”';
      case 'Double-click':
        return 'Double-click “' + target + '”';
      case 'Right-click':
        return 'Right-click “' + target + '”';
      case 'Save value from text':
        return 'Save a value from text matching “' + (step.value || '…') + '”' + (step.target ? ' in ' + step.target : '');
      case 'Type':
        return 'Type “' + (shown || '…') + '” into ' + target;
      case 'Select':
        return 'Select “' + (shown || '…') + '” in ' + target;
      case 'Press Enter':
        return 'Press Enter in ' + (step.target || 'the current field');
      case 'Verify text appears':
        return 'Check that “' + (shown || '…') + '” appears on the page';
      case 'Verify text is not shown':
        return 'Check that “' + (shown || '…') + '” is not shown on the page';
      case 'Verify element is visible':
        return 'Check that “' + target + '” is visible';
      case 'Verify element is hidden':
        return 'Check that “' + target + '” is not visible';
      case 'Verify element is enabled':
        return 'Check that “' + target + '” is enabled';
      case 'Verify element is disabled':
        return 'Check that “' + target + '” is disabled';
      case 'Verify field value':
        return 'Check that ' + target + ' is “' + (shown || '…') + '”';
      case 'Verify element text':
        return 'Check that “' + target + '” contains “' + (shown || '…') + '”';
      case 'Verify page address contains':
        return 'Check that the page address contains “' + (shown || '…') + '”';
      case 'Verify page title':
        return 'Check that the page title contains “' + (shown || '…') + '”';
      case 'Verify no console errors':
        return 'Check that the browser console has no errors';
      case 'Wait':
        return 'Wait ' + (step.value || '1') + ' second(s)';
      case 'Take screenshot':
        return 'Take a screenshot' + (step.target ? ' of ' + step.target : '');
      case 'Use block': {
        const block = (blocks || []).find((b) => b.id === step.value);
        return 'Use reusable block “' + (block ? block.name : 'missing block') + '”';
      }
      default:
        return step.action || 'Step';
    }
  }

  // Expected result shown in the evidence document for a run step.
  function expectedResult(step) {
    if (step.action === 'Save value from text') return 'Expected: text matching the pattern appears and its value is saved.';
    if (!metaFor(step.action).verify) return 'Expected: the step completes without error.';
    return 'Expected: ' + String(step.text || '').replace(/^Check that /, '') + '.';
  }

  const api = { ACTIONS, ACTION_META, metaFor, describeStep, describeGridTarget, describeGridRow, splitPath, expectedResult };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StepText = api;
})(typeof window !== 'undefined' ? window : globalThis);
