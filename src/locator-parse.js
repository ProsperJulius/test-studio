// Parses Playwright-style locators such as getByRole('button', { name: 'Save' }) without evaluating code.
// Shared by the main process, the renderer (live validation) and tests.
(function (root) {
  const TEXT_METHODS = ['getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle'];
  const ROLE_OPTIONS = ['name', 'exact', 'checked', 'disabled', 'expanded', 'includeHidden', 'level', 'pressed', 'selected'];
  const METHODS = ['getByRole', 'getByTestId', 'locator', 'first', 'last', 'nth', 'filter'].concat(TEXT_METHODS);

  class ParseError extends Error {
    constructor(message, at) {
      super(message);
      this.at = at;
    }
  }

  // ---------- Tokenizer-free recursive descent over the source string ----------
  function parser(src) {
    let i = 0;
    const fail = (msg, at = i) => { throw new ParseError(msg, at); };
    const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
    const peek = () => { ws(); return src[i]; };
    const expect = (ch) => {
      ws();
      if (src[i] !== ch) fail('Expected “' + ch + '”' + (i < src.length ? ' but found “' + src[i] + '”' : ' at the end') + '.');
      i++;
    };
    const ident = () => {
      ws();
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
      if (!m) fail('Expected a method name.');
      i += m[0].length;
      return m[0];
    };

    function string() {
      const quote = src[i];
      const start = i++;
      let out = '';
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') {
          const next = src[i + 1];
          out += { n: '\n', t: '\t', r: '\r' }[next] || next;
          i += 2;
        } else {
          if (quote === '`' && src[i] === '$' && src[i + 1] === '{') fail('Template expressions such as ${…} are not supported. Use {name} for test data.');
          out += src[i++];
        }
      }
      if (src[i] !== quote) fail('This text is missing its closing ' + quote + '.', start);
      i++;
      return out;
    }

    function regex() {
      const start = i++;
      let body = '';
      let inClass = false;
      while (i < src.length && (src[i] !== '/' || inClass)) {
        if (src[i] === '\\') { body += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === '[') inClass = true;
        if (src[i] === ']') inClass = false;
        body += src[i++];
      }
      if (src[i] !== '/') fail('This regular expression is missing its closing /.', start);
      i++;
      const flags = (/^[dgimsuy]*/.exec(src.slice(i)) || [''])[0];
      i += flags.length;
      try { new RegExp(body, flags); } catch (e) { fail('Invalid regular expression: ' + e.message, start); }
      return { regex: body, flags };
    }

    function value() {
      const ch = peek();
      if (ch === "'" || ch === '"' || ch === '`') return string();
      if (ch === '/') return regex();
      if (ch === '{') return object();
      const m = /^(-?\d+(\.\d+)?|true|false)/.exec(src.slice(i));
      if (m) {
        i += m[0].length;
        return m[0] === 'true' ? true : m[0] === 'false' ? false : Number(m[0]);
      }
      fail(i >= src.length ? 'The locator ends too early.' : 'Unexpected “' + src[i] + '”. Use quotes around text.');
    }

    function object() {
      expect('{');
      const out = {};
      while (peek() !== '}') {
        let key;
        const ch = peek();
        if (ch === "'" || ch === '"') key = string();
        else key = ident();
        expect(':');
        out[key] = value();
        if (peek() === ',') i++;
        else break;
      }
      expect('}');
      return out;
    }

    function call() {
      const at = (ws(), i);
      const name = ident();
      if (!METHODS.includes(name)) {
        const hint = /^getBy(Button|Link|Heading|Checkbox|Textbox)$/i.test(name)
          ? " Did you mean getByRole('" + name.slice(5).toLowerCase() + "', { name: '…' })?"
          : ' Supported: ' + METHODS.join(', ') + '.';
        fail('Unknown method ' + name + '.' + hint, at);
      }
      expect('(');
      const args = [];
      while (peek() !== ')') {
        args.push(value());
        if (peek() === ',') i++;
        else break;
      }
      expect(')');
      return { name, args, at };
    }

    return {
      parse() {
        ws();
        if (!src.trim()) fail('The locator is empty.', 0);
        if (/^page\s*\./.test(src.slice(i))) { i = src.indexOf('.', i) + 1; }
        const calls = [call()];
        while (peek() === '.') { i++; calls.push(call()); }
        ws();
        if (i < src.length) fail('Unexpected “' + src.slice(i, i + 10) + '” after the locator.');
        return calls;
      }
    };
  }

  // ---------- Checking the calls ----------
  const isText = (v) => typeof v === 'string' || (v && typeof v === 'object' && typeof v.regex === 'string');

  function check(calls) {
    calls.forEach((c, n) => {
      const fail = (msg) => { throw new ParseError(c.name + ': ' + msg, c.at); };
      const opts = (allowed) => {
        const o = c.args[1];
        if (o === undefined) return;
        if (!o || typeof o !== 'object' || o.regex) fail('the second argument must be options in { }.');
        for (const k of Object.keys(o)) if (!allowed.includes(k)) fail('unknown option “' + k + '”. Allowed: ' + allowed.join(', ') + '.');
      };
      if (c.name === 'getByRole') {
        if (typeof c.args[0] !== 'string' || !c.args[0]) fail("the first argument must be a role in quotes, such as 'button'.");
        opts(ROLE_OPTIONS);
        const o = c.args[1] || {};
        if (o.name !== undefined && !isText(o.name)) fail('name must be text or a regular expression.');
      } else if (TEXT_METHODS.includes(c.name) || c.name === 'getByTestId') {
        if (!isText(c.args[0])) fail('the first argument must be text in quotes or a regular expression.');
        opts(c.name === 'getByTestId' ? [] : ['exact']);
      } else if (c.name === 'locator') {
        if (typeof c.args[0] !== 'string' || !c.args[0].trim()) fail("the argument must be a CSS selector in quotes, such as '#save'.");
        if (c.args.length > 1) fail('options are not supported.');
      } else if (c.name === 'nth') {
        if (!Number.isInteger(c.args[0])) fail('needs a whole number, starting at 0.');
      } else if (c.name === 'first' || c.name === 'last') {
        if (c.args.length) fail('takes no arguments.');
      } else if (c.name === 'filter') {
        const o = c.args[0];
        if (!o || typeof o !== 'object' || o.regex) fail('needs options such as { hasText: \'…\' }.');
        for (const k of Object.keys(o)) if (!['hasText', 'hasNotText', 'visible'].includes(k)) fail('unknown option “' + k + '”. Allowed: hasText, hasNotText, visible.');
      }
      if (n === 0 && ['first', 'last', 'nth', 'filter'].includes(c.name)) fail('must follow another locator, for example getByRole(…).' + c.name + '(…).');
    });
  }

  function parseLocator(text) {
    try {
      const calls = parser(String(text == null ? '' : text)).parse();
      check(calls);
      return { ok: true, ast: calls.map(({ name, args }) => ({ name, args })) };
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return { ok: false, error: e.message, at: e.at };
    }
  }

  // ---------- Formatting ----------
  function formatValue(v) {
    if (v && typeof v === 'object' && typeof v.regex === 'string') return '/' + v.regex + '/' + (v.flags || '');
    if (typeof v === 'string') return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'";
    if (v && typeof v === 'object') {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      if (!keys.length) return '{}';
      return '{ ' + keys.map((k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : formatValue(k)) + ': ' + formatValue(v[k])).join(', ') + ' }';
    }
    return String(v);
  }

  function formatLocator(ast) {
    return (ast || []).map((c) => c.name + '(' + c.args.filter((a) => a !== undefined).map(formatValue).join(', ') + ')').join('.');
  }

  // ---------- Plain English ----------
  const shown = (v) => (v && typeof v === 'object' && v.regex ? 'matching /' + v.regex + '/' : '“' + v + '”');

  function describeLocator(ast) {
    let out = '';
    for (const c of ast || []) {
      const a = c.args[0];
      let part;
      switch (c.name) {
        case 'getByRole': {
          const o = c.args[1] || {};
          part = (o.name !== undefined ? shown(o.name) + ' ' : '') + a + (o.level ? ' (level ' + o.level + ')' : '');
          break;
        }
        case 'getByText': part = 'text ' + shown(a); break;
        case 'getByLabel': part = 'field labelled ' + shown(a); break;
        case 'getByPlaceholder': part = 'field with placeholder ' + shown(a); break;
        case 'getByAltText': part = 'image ' + shown(a); break;
        case 'getByTitle': part = 'element titled ' + shown(a); break;
        case 'getByTestId': part = 'test ID ' + shown(a); break;
        case 'locator': part = 'element ' + a; break;
        case 'first': out = 'first ' + out; continue;
        case 'last': out = 'last ' + out; continue;
        case 'nth': out = 'item ' + (a + 1) + ' of ' + out; continue;
        case 'filter': {
          const o = a || {};
          if (o.hasText !== undefined) out += ' containing ' + shown(o.hasText);
          if (o.hasNotText !== undefined) out += ' not containing ' + shown(o.hasNotText);
          continue;
        }
        default: part = c.name;
      }
      out = out ? part + ' in the ' + out : part;
    }
    return out;
  }

  // ---------- Converting old recorded hints ----------
  function legacyToLocator(locators, testIdAttribute) {
    const l = locators || {};
    const attr = testIdAttribute || 'data-testid';
    let ast = null;
    if (l.testId) ast = attr === 'data-testid' ? [{ name: 'getByTestId', args: [l.testId] }] : [{ name: 'locator', args: ['[data-testid="' + l.testId + '"],[data-test="' + l.testId + '"],[data-qa="' + l.testId + '"],[data-cy="' + l.testId + '"]'] }];
    else if (l.label) ast = [{ name: 'getByLabel', args: [l.label, { exact: true }] }];
    else if (l.placeholder) ast = [{ name: 'getByPlaceholder', args: [l.placeholder, { exact: true }] }];
    else if (l.id) ast = [{ name: 'locator', args: ['#' + (/^[A-Za-z][\w-]*$/.test(l.id) ? l.id : '[id="' + l.id + '"]').replace('#[', '[')] }];
    else if (l.name) ast = [{ name: 'locator', args: ['[name="' + l.name + '"]'] }];
    else if (l.text) ast = [{ name: 'getByText', args: [l.text, { exact: true }] }];
    else if (l.css) ast = [{ name: 'locator', args: [l.css] }];
    return ast ? formatLocator(ast) : null;
  }

  // Applies fn to every text argument (used to substitute {name} test data).
  function mapText(ast, fn) {
    const map = (v) => {
      if (typeof v === 'string') return fn(v);
      if (v && typeof v === 'object' && !v.regex) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, map(x)]));
      return v;
    };
    return ast.map((c) => ({ name: c.name, args: c.args.map(map) }));
  }

  // Kinds that depend on wording or page structure rather than a stable attribute or role.
  function locatorQuality(ast) {
    const names = (ast || []).map((c) => c.name);
    if (names.includes('nth') || names.includes('first') || names.includes('last')) return 'nth';
    const main = (ast || []).filter((c) => !['filter'].includes(c.name)).pop();
    if (!main) return 'unknown';
    if (main.name === 'locator') return /nth-|>|\s/.test(main.args[0]) ? 'css-path' : 'css';
    return { getByTestId: 'testid', getByRole: 'role', getByLabel: 'label', getByPlaceholder: 'placeholder', getByAltText: 'alt', getByText: 'text', getByTitle: 'title' }[main.name] || 'unknown';
  }

  // A short name for a step target, e.g. “Save order” for getByRole('button', { name: 'Save order' }).
  function targetName(ast) {
    const main = (ast || []).filter((c) => !['first', 'last', 'nth', 'filter'].includes(c.name)).pop();
    if (!main) return '';
    const a = main.name === 'getByRole' ? (main.args[1] || {}).name : main.args[0];
    if (typeof a === 'string' && main.name !== 'locator') return a;
    return describeLocator(ast);
  }

  const api = { parseLocator, formatLocator, describeLocator, legacyToLocator, mapText, locatorQuality, targetName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LocatorParse = api;
})(typeof window !== 'undefined' ? window : globalThis);
