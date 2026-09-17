// Shared by the main process (reports) and the renderer (editor, run view).
(function (root) {
  const ACTIONS = [
    'Open page',
    'Click',
    'Type',
    'Select',
    'Press Enter',
    'Verify text appears',
    'Wait',
    'Take screenshot',
    'Use block'
  ];

  function describeStep(step, blocks) {
    const shown = step.secret ? '••••••••' : (step.value || '');
    switch (step.action) {
      case 'Open page':
        return 'Open ' + (step.target || 'page') + (step.value ? ' (' + step.value + ')' : '');
      case 'Click':
        return 'Click “' + (step.target || '…') + '”';
      case 'Type':
        return 'Type “' + (shown || '…') + '” into ' + (step.target || '…');
      case 'Select':
        return 'Select “' + (shown || '…') + '” in ' + (step.target || '…');
      case 'Press Enter':
        return 'Press Enter in ' + (step.target || 'the current field');
      case 'Verify text appears':
        return 'Check that “' + (shown || '…') + '” appears on the page';
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

  const api = { ACTIONS, describeStep };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StepText = api;
})(typeof window !== 'undefined' ? window : globalThis);
