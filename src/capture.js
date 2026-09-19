// "Save value from text" steps: a template such as "Order {orderId} created" marks the part of a
// message to save as test data. Advanced users can give a regular expression with named groups
// instead, written as /Order (?<orderId>\d+)/.
(function (root) {
  const PLACEHOLDER = /\{(\w+)\}/g;
  const TRAILING = /[.,;:!?)\]'"”’]+$/;

  function isRegex(template) {
    return /^\/.+\/[a-z]*$/s.test(String(template || '').trim());
  }

  function namesIn(template) {
    const t = String(template || '').trim();
    if (isRegex(t)) return Array.from(t.matchAll(/\(\?<(\w+)>/g), (m) => m[1]);
    return Array.from(t.matchAll(PLACEHOLDER), (m) => m[1]);
  }

  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');

  // Returns { regex, names } or throws with a message a business user can act on.
  function templateToRegex(template) {
    const t = String(template || '').trim();
    if (isRegex(t)) {
      const body = t.slice(1, t.lastIndexOf('/'));
      const flags = t.slice(t.lastIndexOf('/') + 1);
      let regex;
      try { regex = new RegExp(body, flags.includes('i') ? flags : flags + 'i'); } catch (e) { throw new Error('The pattern is not valid: ' + e.message); }
      const names = namesIn(t);
      if (!names.length) throw new Error('The pattern needs a named group such as (?<orderId>\\d+).');
      return { regex, names, raw: true };
    }
    const names = namesIn(t);
    if (!names.length) throw new Error('Put the part to save in curly brackets, for example: Order {orderId} created');
    if (new Set(names).size !== names.length) throw new Error('Each name can only appear once in the text.');

    let source = '';
    let last = 0;
    const parts = Array.from(t.matchAll(PLACEHOLDER));
    parts.forEach((m, i) => {
      source += escape(t.slice(last, m.index));
      last = m.index + m[0].length;
      const atEnd = i === parts.length - 1 && !t.slice(last).trim();
      // Between literal text a value may contain spaces; at the end it is one word.
      source += atEnd ? '(\\S+)' : '(.+?)';
    });
    source += escape(t.slice(last));
    return { regex: new RegExp(source, 'i'), names, raw: false };
  }

  // Returns { name: value } for the first match in text, or null.
  function extract(template, text) {
    const { regex, names, raw } = templateToRegex(template);
    const m = regex.exec(String(text || '').replace(/\s+/g, ' '));
    if (!m) return null;
    const out = {};
    names.forEach((name, i) => {
      let v = raw ? m.groups[name] : m[i + 1];
      v = String(v == null ? '' : v).trim();
      if (!raw) v = v.replace(TRAILING, '');
      out[name] = v;
    });
    return Object.values(out).every((v) => v) ? out : null;
  }

  const LEAD = /^[#(“"']+/;
  const STOP = new Set(['is', 'was', 'are', 'the', 'a', 'an', 'with', 'for', 'of', 'your', 'our', 'has', 'been', 'id', 'no', 'number', 'ref', 'reference', 'code']);

  const splitWords = (text) => String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);

  // Index of the most ID-like word: a UUID, or the word with the most digits. -1 if none.
  function idWordIndex(words) {
    const score = (w) => {
      const clean = w.replace(TRAILING, '').replace(LEAD, '');
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) return 1000;
      const digits = (clean.match(/\d/g) || []).length;
      return digits ? digits * 2 + clean.length : 0;
    };
    let best = -1;
    words.forEach((w, i) => { if (score(w) > (best < 0 ? 0 : score(words[best]))) best = i; });
    return best;
  }

  // Suggests a template from a message by replacing its most ID-like word, e.g.
  // "Order 12345 created" -> "Order {name} created".
  function suggestTemplate(text, name) {
    const words = splitWords(text);
    const best = idWordIndex(words);
    if (best < 0) return null;
    const w = words[best];
    words[best] = (w.match(LEAD) || [''])[0] + '{' + name + '}' + (w.match(TRAILING) || [''])[0];
    // Keep the template short: a few words either side of the value.
    return words.slice(Math.max(0, best - 4), best + 5).join(' ');
  }

  // Suggests a template and a variable name, e.g. "Order 5001 created" ->
  // { template: "Order {orderId} created", name: "orderId" }. existing: names already in use.
  function suggestCapture(text, existing) {
    const used = new Set(existing || []);
    const words = splitWords(text);
    const best = idWordIndex(words);
    let base = 'capturedValue';
    for (let k = best - 1; best >= 0 && k >= Math.max(0, best - 3); k--) {
      const w = words[k].replace(/[^A-Za-z]/g, '');
      if (w.length >= 2 && !STOP.has(w.toLowerCase())) {
        base = w.toLowerCase() + 'Id';
        break;
      }
    }
    let name = base;
    for (let n = 2; used.has(name); n++) name = base + n;
    return { template: suggestTemplate(text, name), name };
  }

  // Names saved by capture steps, in step order, with blocks expanded.
  function capturedNames(steps, blocks, depth = 0) {
    const out = [];
    for (const s of steps || []) {
      if (s.disabled) continue;
      if (s.action === 'Use block') {
        const b = (blocks || []).find((x) => x.id === s.value);
        if (b && depth < 5) out.push(...capturedNames(b.steps, blocks, depth + 1));
      } else if (s.action === 'Save value from text') {
        out.push(...namesIn(s.value));
      }
    }
    return out;
  }

  const api = { templateToRegex, extract, suggestTemplate, suggestCapture, capturedNames, namesIn, isRegex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Capture = api;
})(typeof window !== 'undefined' ? window : globalThis);
