// Turns a locator AST from locator-parse.js into a Playwright locator.
// Kept separate from the runner so the parity test can check the mapping on its own.

const isRegex = (v) => v && typeof v === 'object' && typeof v.regex === 'string';
const val = (v) => (isRegex(v) ? new RegExp(v.regex, v.flags || '') : v);

const ROLE_FLAGS = ['exact', 'checked', 'disabled', 'expanded', 'includeHidden', 'level', 'pressed', 'selected'];

function roleOptions(o) {
  const out = {};
  for (const k of ROLE_FLAGS) if (o[k] !== undefined) out[k] = o[k];
  if (o.name !== undefined) out.name = val(o.name);
  return Object.keys(out).length ? out : undefined;
}

const textOptions = (o) => (o && o.exact !== undefined ? { exact: o.exact } : undefined);

// root is a Page or a Locator; every call narrows it the way Playwright chains do.
function buildLocator(root, ast) {
  let cur = root;
  for (const call of ast || []) {
    const a = call.args[0];
    const o = call.args[1] || {};
    switch (call.name) {
      case 'getByRole': cur = cur.getByRole(a, roleOptions(o)); break;
      case 'getByText': cur = cur.getByText(val(a), textOptions(o)); break;
      case 'getByLabel': cur = cur.getByLabel(val(a), textOptions(o)); break;
      case 'getByPlaceholder': cur = cur.getByPlaceholder(val(a), textOptions(o)); break;
      case 'getByAltText': cur = cur.getByAltText(val(a), textOptions(o)); break;
      case 'getByTitle': cur = cur.getByTitle(val(a), textOptions(o)); break;
      case 'getByTestId': cur = cur.getByTestId(val(a)); break;
      case 'locator': cur = cur.locator(a); break;
      case 'first': cur = cur.first(); break;
      case 'last': cur = cur.last(); break;
      case 'nth': cur = cur.nth(a); break;
      case 'filter': {
        const f = {};
        if (a && a.hasText !== undefined) f.hasText = val(a.hasText);
        if (a && a.hasNotText !== undefined) f.hasNotText = val(a.hasNotText);
        if (a && a.visible !== undefined) f.visible = a.visible;
        cur = cur.filter(f);
        break;
      }
      default:
        throw new Error('Unsupported locator method ' + call.name);
    }
  }
  return cur;
}

module.exports = { buildLocator };
