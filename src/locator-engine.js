// Finds elements for Playwright-style locators inside a web page, following Playwright's matching rules
// (roles, accessible names, text, labels, test IDs). Also generates a unique locator for an element,
// the way Playwright codegen does. Runs in the page: it must not depend on anything outside this file.
//
// Loaded by wrapping this source in a function that provides `module`, so it adds no page globals.
(function () {
  const norm = (t) => String(t == null ? '' : t).replace(/[\s​]+/g, ' ').trim();
  const isRegex = (v) => v && typeof v === 'object' && typeof v.regex === 'string';
  const makeRegex = (v) => new RegExp(v.regex, v.flags || '');

  function sortInDocumentOrder(list) {
    return Array.from(new Set(list)).sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  const descendants = (scope) => Array.from((scope.nodeType === 9 ? scope : scope).querySelectorAll('*'));
  const style = (el) => (el.ownerDocument.defaultView ? el.ownerDocument.defaultView.getComputedStyle(el) : null);

  // ---------- Visibility ----------
  function styleVisibilityVisible(el, s) {
    s = s || style(el);
    if (!s) return true;
    if (el.checkVisibility && !el.checkVisibility()) return false;
    return s.visibility === 'visible';
  }

  function isVisible(el) {
    const s = style(el);
    if (!s) return true;
    if (s.display === 'contents') {
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1 && isVisible(child)) return true;
        if (child.nodeType === 3 && child.nodeValue.trim()) {
          const range = el.ownerDocument.createRange();
          range.selectNodeContents(child);
          const rects = range.getClientRects();
          for (const r of rects) if (r.width > 0 && r.height > 0) return true;
        }
      }
      return false;
    }
    if (!styleVisibilityVisible(el, s)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // ---------- ARIA hidden ----------
  const IGNORED_TAGS = ['STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE'];

  function hiddenForAria(el, cache) {
    if (cache && cache.has(el)) return cache.get(el);
    let hidden;
    if (IGNORED_TAGS.includes(el.nodeName)) hidden = true;
    else {
      const s = style(el);
      if (s && s.display === 'contents' && el.nodeName !== 'SLOT') {
        hidden = true;
        for (let child = el.firstChild; child; child = child.nextSibling) {
          if ((child.nodeType === 1 && !hiddenForAria(child, cache)) || (child.nodeType === 3 && child.nodeValue.trim())) { hidden = false; break; }
        }
      } else {
        const optionInSelect = el.nodeName === 'OPTION' && !!el.closest('select');
        if (!optionInSelect && el.nodeName !== 'SLOT' && !styleVisibilityVisible(el, s)) hidden = true;
        else hidden = displayNoneOrAriaHidden(el);
      }
    }
    if (cache) cache.set(el, hidden);
    return hidden;
  }

  function displayNoneOrAriaHidden(el) {
    for (let node = el; node; node = node.parentElement) {
      const s = style(node);
      if (!s || s.display === 'none') return true;
      if (node.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  }

  // ---------- Roles ----------
  const VALID_ROLES = ['alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'meter', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem'];
  const GLOBAL_ARIA = ['aria-atomic', 'aria-busy', 'aria-controls', 'aria-current', 'aria-describedby', 'aria-details', 'aria-dropeffect', 'aria-flowto', 'aria-grabbed', 'aria-hidden', 'aria-keyshortcuts', 'aria-label', 'aria-labelledby', 'aria-live', 'aria-owns', 'aria-relevant', 'aria-roledescription'];
  const LANDMARK_BLOCKERS = 'article:not([role]), aside:not([role]), main:not([role]), nav:not([role]), section:not([role]), [role=article], [role=complementary], [role=main], [role=navigation], [role=region]';

  const hasGlobalAria = (el) => GLOBAL_ARIA.some((a) => el.hasAttribute(a));
  const hasExplicitName = (el) => el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
  const hasTabIndex = (el) => !Number.isNaN(Number(el.getAttribute('tabindex'))) && el.hasAttribute('tabindex');

  function isNativelyDisabled(el) {
    if (!['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP'].includes(el.nodeName)) return false;
    if (el.hasAttribute('disabled')) return true;
    const optgroup = el.nodeName === 'OPTION' && el.closest('optgroup');
    if (optgroup && optgroup.hasAttribute('disabled')) return true;
    const fieldset = el.parentElement && el.parentElement.closest('fieldset[disabled]');
    if (!fieldset) return false;
    const legend = fieldset.querySelector(':scope > legend');
    return !legend || !legend.contains(el);
  }

  function isFocusable(el) {
    if (isNativelyDisabled(el)) return false;
    const n = el.nodeName;
    const native = ['BUTTON', 'DETAILS', 'SELECT', 'TEXTAREA', 'IFRAME'].includes(n) ||
      (n === 'INPUT' && el.type !== 'hidden') || ((n === 'A' || n === 'AREA') && el.hasAttribute('href'));
    return native || hasTabIndex(el);
  }

  const IMPLICIT = {
    A: (e) => (e.hasAttribute('href') ? 'link' : null),
    AREA: (e) => (e.hasAttribute('href') ? 'link' : null),
    ARTICLE: () => 'article', ASIDE: () => 'complementary', BLOCKQUOTE: () => 'blockquote', BUTTON: () => 'button',
    CAPTION: () => 'caption', CODE: () => 'code', DATALIST: () => 'listbox', DD: () => 'definition', DEL: () => 'deletion',
    DETAILS: () => 'group', DFN: () => 'term', DIALOG: () => 'dialog', DT: () => 'term', EM: () => 'emphasis',
    FIELDSET: () => 'group', FIGURE: () => 'figure',
    FOOTER: (e) => (e.closest(LANDMARK_BLOCKERS) ? null : 'contentinfo'),
    FORM: (e) => (hasExplicitName(e) ? 'form' : null),
    H1: () => 'heading', H2: () => 'heading', H3: () => 'heading', H4: () => 'heading', H5: () => 'heading', H6: () => 'heading',
    HEADER: (e) => (e.closest(LANDMARK_BLOCKERS) ? null : 'banner'),
    HR: () => 'separator', HTML: () => 'document',
    IMG: (e) => (e.getAttribute('alt') === '' && !e.getAttribute('title') && !hasGlobalAria(e) && !hasTabIndex(e) ? 'presentation' : 'img'),
    INPUT: (e) => {
      const type = (e.type || '').toLowerCase();
      if (type === 'search') return e.hasAttribute('list') ? 'combobox' : 'searchbox';
      if (['email', 'tel', 'text', 'url', ''].includes(type)) {
        const listId = e.getAttribute('list');
        const list = listId && e.ownerDocument.getElementById(listId);
        return list && list.nodeName === 'DATALIST' ? 'combobox' : 'textbox';
      }
      if (type === 'hidden') return null;
      if (type === 'file') return 'button';
      return { button: 'button', checkbox: 'checkbox', image: 'button', number: 'spinbutton', radio: 'radio', range: 'slider', reset: 'button', submit: 'button' }[type] || 'textbox';
    },
    INS: () => 'insertion', LI: () => 'listitem', MAIN: () => 'main', MARK: () => 'mark', MATH: () => 'math', MENU: () => 'list',
    METER: () => 'meter', NAV: () => 'navigation', OL: () => 'list', OPTGROUP: () => 'group', OPTION: () => 'option',
    OUTPUT: () => 'status', P: () => 'paragraph', PROGRESS: () => 'progressbar', SEARCH: () => 'search',
    SECTION: (e) => (hasExplicitName(e) ? 'region' : null),
    SELECT: (e) => (e.hasAttribute('multiple') || e.size > 1 ? 'listbox' : 'combobox'),
    STRONG: () => 'strong', SUB: () => 'subscript', SUP: () => 'superscript', SVG: () => 'img', svg: () => 'img',
    TABLE: () => 'table', TBODY: () => 'rowgroup', THEAD: () => 'rowgroup', TFOOT: () => 'rowgroup',
    TD: (e) => { const t = e.closest('table'); const r = t && explicitRole(t); return r === 'grid' || r === 'treegrid' ? 'gridcell' : 'cell'; },
    TH: (e) => {
      if (e.getAttribute('scope') === 'col') return 'columnheader';
      if (e.getAttribute('scope') === 'row') return 'rowheader';
      const t = e.closest('table'); const r = t && explicitRole(t);
      return r === 'grid' || r === 'treegrid' ? 'gridcell' : 'cell';
    },
    TEXTAREA: () => 'textbox', TIME: () => 'time', TR: () => 'row', UL: () => 'list'
  };

  function explicitRole(el) {
    const roles = (el.getAttribute('role') || '').split(' ').map((r) => r.trim());
    return roles.find((r) => VALID_ROLES.includes(r)) || null;
  }

  function implicitRole(el) {
    const fn = IMPLICIT[el.nodeName] || IMPLICIT[el.nodeName.toUpperCase()];
    return (fn && fn(el)) || null;
  }

  function ariaRole(el) {
    const explicit = explicitRole(el);
    if (!explicit) return implicitRole(el);
    if ((explicit === 'none' || explicit === 'presentation') && (hasGlobalAria(el) || isFocusable(el))) return implicitRole(el);
    return explicit;
  }

  // ---------- ARIA states ----------
  const CHECKED_ROLES = ['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem'];
  const SELECTED_ROLES = ['gridcell', 'option', 'row', 'tab', 'rowheader', 'columnheader', 'treeitem'];
  const LEVEL_ROLES = ['heading', 'listitem', 'row', 'treeitem'];
  const DISABLED_ROLES = ['application', 'button', 'composite', 'gridcell', 'group', 'input', 'link', 'menuitem', 'scrollbar', 'separator', 'tab', 'checkbox', 'columnheader', 'combobox', 'grid', 'listbox', 'menu', 'menubar', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'radiogroup', 'row', 'rowheader', 'searchbox', 'select', 'slider', 'spinbutton', 'switch', 'tablist', 'textbox', 'toolbar', 'tree', 'treegrid', 'treeitem'];

  function ariaChecked(el) {
    if (el.nodeName === 'INPUT' && el.indeterminate) return 'mixed';
    if (el.nodeName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)) return el.checked;
    if (CHECKED_ROLES.includes(ariaRole(el) || '')) {
      const v = el.getAttribute('aria-checked');
      return v === 'true' ? true : v === 'mixed' ? 'mixed' : false;
    }
    return false;
  }

  function ariaPressed(el) {
    if ((ariaRole(el) || '') !== 'button') return false;
    const v = el.getAttribute('aria-pressed');
    return v === 'true' ? true : v === 'mixed' ? 'mixed' : false;
  }

  function ariaExpanded(el) {
    const v = el.getAttribute('aria-expanded');
    return v === 'true' ? true : v === 'false' ? false : undefined;
  }

  function ariaSelected(el) {
    if (el.nodeName === 'OPTION') return el.selected;
    if (SELECTED_ROLES.includes(ariaRole(el) || '')) return el.getAttribute('aria-selected') === 'true';
    return false;
  }

  function ariaLevel(el) {
    const native = { H1: 1, H2: 2, H3: 3, H4: 4, H5: 5, H6: 6 }[el.nodeName];
    if (native) return native;
    if (LEVEL_ROLES.includes(ariaRole(el) || '')) {
      const n = Number(el.getAttribute('aria-level'));
      if (!Number.isNaN(n) && n >= 1) return n;
    }
    return 0;
  }

  function explicitAriaDisabled(el, isAncestor) {
    if (!el) return false;
    if (isAncestor || DISABLED_ROLES.includes(ariaRole(el) || '')) {
      const v = (el.getAttribute('aria-disabled') || '').toLowerCase();
      if (v === 'true') return true;
      if (v === 'false') return false;
      return explicitAriaDisabled(el.parentElement, true);
    }
    return false;
  }

  const ariaDisabled = (el) => isNativelyDisabled(el) || explicitAriaDisabled(el, false);

  // ---------- Accessible name (accname subset, following Playwright) ----------
  const ALWAYS_NAME_FROM_CONTENT = ['button', 'cell', 'checkbox', 'columnheader', 'gridcell', 'heading', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'row', 'rowheader', 'switch', 'tab', 'tooltip', 'treeitem'];
  const DESCENDANT_NAME_FROM_CONTENT = ['', 'caption', 'code', 'contentinfo', 'definition', 'deletion', 'emphasis', 'insertion', 'list', 'listitem', 'mark', 'none', 'paragraph', 'presentation', 'region', 'row', 'rowgroup', 'section', 'strong', 'subscript', 'superscript', 'table', 'term', 'time'];
  const PROHIBITS_NAMING = ['caption', 'code', 'definition', 'deletion', 'emphasis', 'generic', 'insertion', 'mark', 'paragraph', 'presentation', 'strong', 'subscript', 'suggestion', 'superscript', 'term', 'time'];

  function idRefs(el, attr) {
    const value = el.getAttribute(attr);
    if (value === null) return null;
    const root = el.getRootNode();
    const refs = [];
    for (const id of value.split(' ').filter(Boolean)) {
      const ref = root.getElementById ? root.getElementById(id) : el.ownerDocument.getElementById(id);
      if (ref && !refs.includes(ref)) refs.push(ref);
    }
    return refs.length ? refs : null;
  }

  function cssContent(el, pseudo) {
    const s = el.ownerDocument.defaultView.getComputedStyle(el, pseudo);
    if (!s || s.display === 'none' || s.visibility === 'hidden') return '';
    const c = s.content;
    if (!c || c === 'none' || c === 'normal') return '';
    const m = /^"(.*)"$/.exec(c);
    return m ? m[1].replace(/\\"/g, '"') : '';
  }

  function allowsNameFromContent(role, descendant) {
    return ALWAYS_NAME_FROM_CONTENT.includes(role) || (descendant && DESCENDANT_NAME_FROM_CONTENT.includes(role));
  }

  function textAlternative(el, o) {
    if (o.visited.has(el)) return '';
    const hiddenTraversal = !!(o.inLabelledBy && o.inLabelledBy.hidden) || !!(o.inLabel && o.inLabel.hidden) || !!(o.inNative && o.inNative.hidden);
    if (!o.includeHidden && (IGNORED_TAGS.includes(el.nodeName) || (!hiddenTraversal && hiddenForAria(el, o.hiddenCache)))) {
      o.visited.add(el);
      return '';
    }

    const labelledBy = o.inLabelledBy ? null : idRefs(el, 'aria-labelledby');
    if (labelledBy) {
      const name = labelledBy.map((ref) => textAlternative(ref, {
        includeHidden: o.includeHidden, visited: o.visited, hiddenCache: o.hiddenCache,
        inLabelledBy: { element: ref, hidden: hiddenForAria(ref, o.hiddenCache) }, target: undefined
      })).join(' ');
      if (name) return name;
    }

    const role = ariaRole(el) || '';
    const tag = el.nodeName;

    if (o.inLabel || o.inLabelledBy || o.target === 'descendant') {
      const ownLabel = Array.from(el.labels || []).includes(o.inLabel && o.inLabel.element);
      const ownLabelledBy = !!(o.inLabelledBy && (idRefs(el, 'aria-labelledby') || []).includes(o.inLabelledBy.element));
      if (!ownLabel && !ownLabelledBy) {
        if (role === 'textbox') return tag === 'INPUT' || tag === 'TEXTAREA' ? el.value : el.textContent || '';
        if (role === 'combobox' || role === 'listbox') {
          const selected = tag === 'SELECT' ? Array.from(el.selectedOptions) : Array.from(el.querySelectorAll('[aria-selected="true"]'));
          if (!selected.length && tag === 'INPUT') return el.value;
          return selected.map((opt) => textAlternative(opt, { ...o, target: 'descendant' })).join(' ');
        }
        if (['progressbar', 'scrollbar', 'slider', 'spinbutton', 'meter'].includes(role)) {
          if (el.hasAttribute('aria-valuetext')) return el.getAttribute('aria-valuetext') || '';
          if (el.hasAttribute('aria-valuenow')) return el.getAttribute('aria-valuenow') || '';
          return el.getAttribute('value') || '';
        }
        if (role === 'menu') return '';
      }
    }

    const ariaLabel = el.getAttribute('aria-label') || '';
    if (norm(ariaLabel)) return ariaLabel;

    if (!['presentation', 'none'].includes(role)) {
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) {
        o.visited.add(el);
        const value = el.value || '';
        if (norm(value)) return value;
        if (el.type === 'submit') return 'Submit';
        if (el.type === 'reset') return 'Reset';
        return el.getAttribute('title') || '';
      }
      if (tag === 'INPUT' && el.type === 'image') {
        o.visited.add(el);
        const alt = el.getAttribute('alt') || '';
        if (norm(alt)) return alt;
        const title = el.getAttribute('title') || '';
        if (norm(title)) return title;
        return 'Submit';
      }
      if (!labelledBy && (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'INPUT')) {
        o.visited.add(el);
        const labels = Array.from(el.labels || []);
        if (labels.length && !o.inLabelledBy) {
          return labels.map((label) => textAlternative(label, {
            includeHidden: o.includeHidden, visited: o.visited, hiddenCache: o.hiddenCache,
            inLabel: { element: label, hidden: hiddenForAria(label, o.hiddenCache) }
          })).filter(Boolean).join(' ');
        }
        const usePlaceholder = (tag === 'INPUT' && ['text', 'password', 'search', 'tel', 'email', 'url'].includes(el.type)) || tag === 'TEXTAREA';
        const placeholder = el.getAttribute('placeholder') || '';
        const title = el.getAttribute('title') || '';
        if (!usePlaceholder || title) return title;
        return placeholder;
      }
      const nativeChild = (selector) => {
        for (let child = el.firstElementChild; child; child = child.nextElementSibling) {
          if (child.matches(selector)) {
            return textAlternative(child, { includeHidden: o.includeHidden, visited: o.visited, hiddenCache: o.hiddenCache, inNative: { element: child, hidden: hiddenForAria(child, o.hiddenCache) } });
          }
        }
        return null;
      };
      if (tag === 'FIELDSET') {
        o.visited.add(el);
        const name = nativeChild('legend');
        if (name) return name;
        return el.getAttribute('title') || '';
      }
      if (tag === 'FIGURE') {
        o.visited.add(el);
        const name = nativeChild('figcaption');
        if (name) return name;
        return el.getAttribute('title') || '';
      }
      if (tag === 'IMG') {
        o.visited.add(el);
        const alt = el.getAttribute('alt') || '';
        if (norm(alt)) return alt;
        return el.getAttribute('title') || '';
      }
      if (tag === 'TABLE') {
        o.visited.add(el);
        const name = nativeChild('caption');
        if (name) return name;
        const summary = el.getAttribute('summary') || '';
        if (summary) return summary;
      }
      if (tag === 'AREA') {
        o.visited.add(el);
        const alt = el.getAttribute('alt') || '';
        if (norm(alt)) return alt;
        return el.getAttribute('title') || '';
      }
    }

    if (allowsNameFromContent(role, o.target === 'descendant') || o.inLabelledBy || o.inLabel || o.inNative) {
      o.visited.add(el);
      const child = { ...o, target: o.target === 'self' ? 'descendant' : o.target };
      const tokens = [cssContent(el, '::before')];
      for (let node = el.firstChild; node; node = node.nextSibling) {
        if (node.nodeType === 1) {
          const s = style(node);
          let token = textAlternative(node, child);
          if ((s ? s.display : 'inline') !== 'inline' || node.nodeName === 'BR') token = ' ' + token + ' ';
          tokens.push(token);
        } else if (node.nodeType === 3) {
          tokens.push(node.textContent || '');
        }
      }
      tokens.push(cssContent(el, '::after'));
      const text = tokens.join('');
      if (o.target === 'self' ? norm(text) : text) return text;
    }

    if (!['presentation', 'none'].includes(role) || tag === 'IFRAME') {
      o.visited.add(el);
      const title = el.getAttribute('title') || '';
      if (norm(title)) return title;
    }
    return '';
  }

  function accessibleName(el, includeHidden, caches) {
    const key = includeHidden ? 'nameHidden' : 'name';
    const cache = caches && caches[key];
    if (cache && cache.has(el)) return cache.get(el);
    const name = PROHIBITS_NAMING.includes(ariaRole(el) || '')
      ? ''
      : norm(textAlternative(el, { includeHidden, visited: new Set(), hiddenCache: caches && caches.hidden, target: 'self' }));
    if (cache) cache.set(el, name);
    return name;
  }

  // ---------- Element text (Playwright's text engine) ----------
  function skipForText(el) {
    return el.nodeName === 'SCRIPT' || el.nodeName === 'NOSCRIPT' || el.nodeName === 'STYLE' || !!(el.ownerDocument.head && el.ownerDocument.head.contains(el));
  }

  function elementText(cache, root) {
    let value = cache.get(root);
    if (value) return value;
    value = { full: '', normalized: '' };
    if (!skipForText(root)) {
      if (root.nodeName === 'INPUT' && (root.type === 'submit' || root.type === 'button')) {
        value = { full: root.value, normalized: norm(root.value) };
      } else {
        for (let child = root.firstChild; child; child = child.nextSibling) {
          if (child.nodeType === 3) value.full += child.nodeValue || '';
          else if (child.nodeType === 1) value.full += elementText(cache, child).full;
        }
        if (root.shadowRoot) value.full += elementText(cache, root.shadowRoot).full;
        value.normalized = norm(value.full);
      }
    }
    cache.set(root, value);
    return value;
  }

  function textMatcher(value, exact) {
    if (isRegex(value)) {
      const re = makeRegex(value);
      return (et) => { re.lastIndex = 0; return re.test(et.full); };
    }
    const text = norm(value);
    if (exact) return (et) => et.normalized === text;
    const lower = text.toLowerCase();
    return (et) => et.normalized.toLowerCase().includes(lower);
  }

  function textMatches(cache, el, matcher) {
    if (skipForText(el)) return 'none';
    if (!matcher(elementText(cache, el))) return 'none';
    for (let child = el.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && matcher(elementText(cache, child))) return 'selfAndChildren';
    }
    if (el.shadowRoot && matcher(elementText(cache, el.shadowRoot))) return 'selfAndChildren';
    return 'self';
  }

  function nameMatches(name, value, exact) {
    if (isRegex(value)) { const re = makeRegex(value); return re.test(name); }
    const text = norm(value);
    return exact ? name === text : name.toLowerCase().includes(text.toLowerCase());
  }

  function attrMatcher(value, exact) {
    if (isRegex(value)) { const re = makeRegex(value); return (s) => !!s.match(re); }
    if (exact) return (s) => s === value;
    const lower = String(value).toLowerCase();
    return (s) => s.toLowerCase().includes(lower);
  }

  function elementLabels(cache, el) {
    const labelledBy = idRefs(el, 'aria-labelledby');
    if (labelledBy) return labelledBy.map((l) => elementText(cache, l));
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel !== null && ariaLabel.trim()) return [{ full: ariaLabel, normalized: norm(ariaLabel) }];
    const nonHiddenInput = el.nodeName === 'INPUT' && el.type !== 'hidden';
    if (['BUTTON', 'METER', 'OUTPUT', 'PROGRESS', 'SELECT', 'TEXTAREA'].includes(el.nodeName) || nonHiddenInput) {
      if (el.labels) return Array.from(el.labels).map((l) => elementText(cache, l));
    }
    return [];
  }

  // ---------- Resolving a locator ----------
  function newCaches() {
    return { text: new Map(), name: new Map(), nameHidden: new Map(), hidden: new Map() };
  }

  function queryCall(scope, call, options, caches) {
    const [a, b] = call.args;
    const o = b || {};
    switch (call.name) {
      case 'getByRole': {
        const role = String(a).toLowerCase();
        return descendants(scope).filter((el) => {
          if (ariaRole(el) !== role) return false;
          if (o.checked !== undefined && ariaChecked(el) !== o.checked) return false;
          if (o.pressed !== undefined && ariaPressed(el) !== o.pressed) return false;
          if (o.selected !== undefined && ariaSelected(el) !== o.selected) return false;
          if (o.expanded !== undefined && ariaExpanded(el) !== o.expanded) return false;
          if (o.level !== undefined && ariaLevel(el) !== o.level) return false;
          if (o.disabled !== undefined && ariaDisabled(el) !== o.disabled) return false;
          if (!o.includeHidden && hiddenForAria(el, caches.hidden)) return false;
          if (o.name !== undefined && !nameMatches(accessibleName(el, !!o.includeHidden, caches), o.name, !!o.exact)) return false;
          return true;
        });
      }
      case 'getByText': {
        const matcher = textMatcher(a, !!o.exact);
        const out = [];
        if (scope.nodeType === 1 && textMatches(caches.text, scope, matcher) === 'self') out.push(scope);
        for (const el of descendants(scope)) if (textMatches(caches.text, el, matcher) === 'self') out.push(el);
        return out;
      }
      case 'getByLabel': {
        const matcher = textMatcher(a, !!o.exact);
        return descendants(scope).filter((el) => elementLabels(caches.text, el).some(matcher));
      }
      case 'getByPlaceholder':
      case 'getByAltText':
      case 'getByTitle':
      case 'getByTestId': {
        const attr = { getByPlaceholder: 'placeholder', getByAltText: 'alt', getByTitle: 'title', getByTestId: options.testIdAttribute || 'data-testid' }[call.name];
        const matcher = attrMatcher(a, call.name === 'getByTestId' ? true : !!o.exact);
        return descendants(scope).filter((el) => el.hasAttribute(attr) && matcher(el.getAttribute(attr)));
      }
      case 'locator': {
        const sel = String(a);
        if (/^xpath=/.test(sel) || /^\/\//.test(sel)) {
          const expr = sel.replace(/^xpath=/, '');
          const doc = scope.nodeType === 9 ? scope : scope.ownerDocument;
          const snap = doc.evaluate(expr, scope, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          const out = [];
          for (let i = 0; i < snap.snapshotLength; i++) if (snap.snapshotItem(i).nodeType === 1) out.push(snap.snapshotItem(i));
          return out;
        }
        return Array.from(scope.querySelectorAll(sel.replace(/^css=/, '')));
      }
      default:
        throw new Error('Unsupported locator method ' + call.name);
    }
  }

  // Returns the elements matched by a locator (an array of calls), in document order.
  function resolve(ast, options) {
    options = options || {};
    const caches = options.caches || newCaches();
    let current = [options.root || document];
    for (const call of ast) {
      switch (call.name) {
        case 'first': current = current.slice(0, 1); break;
        case 'last': current = current.slice(-1); break;
        case 'nth': {
          const n = call.args[0];
          const el = n < 0 ? current[current.length + n] : current[n];
          current = el ? [el] : [];
          break;
        }
        case 'filter': {
          const o = call.args[0] || {};
          if (o.hasText !== undefined) { const m = textMatcher(o.hasText, false); current = current.filter((el) => m(elementText(caches.text, el))); }
          if (o.hasNotText !== undefined) { const m = textMatcher(o.hasNotText, false); current = current.filter((el) => !m(elementText(caches.text, el))); }
          if (o.visible !== undefined) current = current.filter((el) => isVisible(el) === !!o.visible);
          break;
        }
        default:
          current = sortInDocumentOrder(current.flatMap((scope) => queryCall(scope, call, options, caches)));
      }
    }
    return current;
  }

  // ---------- Generating a locator for an element (like Playwright codegen) ----------
  const OTHER_TEST_IDS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];
  const MAX_TEXT = 80;
  const isField = (el) => ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.nodeName) || el.isContentEditable;

  function candidates(el, options, caches, forAncestor) {
    const out = [];
    const add = (score, ast, kind) => out.push({ score, ast, kind });
    const testIdAttr = options.testIdAttribute || 'data-testid';

    const testId = el.getAttribute(testIdAttr);
    if (testId) add(1, [{ name: 'getByTestId', args: [testId] }], 'testid');
    for (const attr of OTHER_TEST_IDS) {
      if (attr === testIdAttr || !el.getAttribute(attr)) continue;
      add(2, [{ name: 'locator', args: ['[' + attr + '="' + el.getAttribute(attr).replace(/"/g, '\\"') + '"]'] }], 'testid');
    }

    const role = ariaRole(el);
    if (role && !['presentation', 'none', 'generic', 'document'].includes(role)) {
      const name = accessibleName(el, false, caches);
      if (name && name.length <= MAX_TEXT) {
        add(100, [{ name: 'getByRole', args: [role, { name }] }], 'role');
        add(105, [{ name: 'getByRole', args: [role, { name, exact: true }] }], 'role');
      }
    }
    if (forAncestor) {
      // A container found by its own text, e.g. getByRole('listitem').filter({ hasText: 'Pears' }).
      const own = norm(Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' '));
      if (role && !['presentation', 'none', 'generic'].includes(role) && own && own.length <= 50) {
        add(300, [{ name: 'getByRole', args: [role] }, { name: 'filter', args: [{ hasText: own }] }], 'role');
      }
      if (role && ['dialog', 'alertdialog', 'form', 'navigation', 'main', 'region', 'banner', 'contentinfo', 'complementary', 'table', 'list', 'tablist', 'menu', 'toolbar', 'group'].includes(role)) {
        add(510, [{ name: 'getByRole', args: [role] }], 'role');
      }
      return out.sort((x, y) => x.score - y.score);
    }

    const placeholder = el.getAttribute('placeholder');
    if (placeholder && placeholder.length <= MAX_TEXT) {
      add(120, [{ name: 'getByPlaceholder', args: [placeholder] }], 'placeholder');
      add(125, [{ name: 'getByPlaceholder', args: [placeholder, { exact: true }] }], 'placeholder');
    }
    const label = elementLabels(caches.text, el).map((l) => l.normalized).find((l) => l && l.length <= MAX_TEXT);
    if (label) {
      add(140, [{ name: 'getByLabel', args: [label] }], 'label');
      add(145, [{ name: 'getByLabel', args: [label, { exact: true }] }], 'label');
    }
    const alt = el.getAttribute('alt');
    if (alt && ['IMG', 'INPUT', 'AREA'].includes(el.nodeName) && alt.length <= MAX_TEXT) {
      add(160, [{ name: 'getByAltText', args: [alt] }], 'alt');
      add(165, [{ name: 'getByAltText', args: [alt, { exact: true }] }], 'alt');
    }
    if (!isField(el)) {
      const text = elementText(caches.text, el).normalized;
      if (text && text.length <= MAX_TEXT) {
        add(180, [{ name: 'getByText', args: [text] }], 'text');
        add(185, [{ name: 'getByText', args: [text, { exact: true }] }], 'text');
      }
    }
    const title = el.getAttribute('title');
    if (title && title.length <= MAX_TEXT) {
      add(200, [{ name: 'getByTitle', args: [title] }], 'title');
      add(205, [{ name: 'getByTitle', args: [title, { exact: true }] }], 'title');
    }
    if (el.id && !/\d{4,}|[:{}]/.test(el.id) && /^[A-Za-z][\w-]*$/.test(el.id)) add(500, [{ name: 'locator', args: ['#' + el.id] }], 'css');
    if (role && !['presentation', 'none', 'generic'].includes(role)) add(510, [{ name: 'getByRole', args: [role] }], 'role');
    if (el.nodeName === 'INPUT' && el.getAttribute('name')) {
      add(520, [{ name: 'locator', args: ['input[name="' + el.getAttribute('name').replace(/"/g, '\\"') + '"]'] }], 'css');
    }
    add(530, [{ name: 'locator', args: [el.nodeName.toLowerCase()] }], 'css');
    return out.sort((x, y) => x.score - y.score);
  }

  function uniqueIn(scope, el, options, caches, forAncestor) {
    for (const c of candidates(el, options, caches, forAncestor)) {
      const found = resolve(c.ast, { ...options, root: scope, caches });
      if (found.length === 1 && found[0] === el) return c;
    }
    return null;
  }

  function generate(el, options) {
    options = options || {};
    const caches = newCaches();
    const direct = uniqueIn(document, el, options, caches, false);
    if (direct && direct.score < 500) return { ast: direct.ast, quality: direct.kind };

    // Scope to an ancestor that can be found on its own, e.g. a dialog or a table row.
    let best = null;
    let depth = 0;
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement && depth < 12; a = a.parentElement, depth++) {
      const outer = uniqueIn(document, a, options, caches, true);
      if (!outer) continue;
      const inner = uniqueIn(a, el, options, caches, false);
      if (!inner) continue;
      const ast = outer.ast.concat(inner.ast);
      const found = resolve(ast, { ...options, caches });
      if (found.length !== 1 || found[0] !== el) continue;
      const score = outer.score + inner.score;
      if (!best || score < best.score) best = { ast, score, kind: inner.kind };
      if (score < 300) break;
    }
    if (best && (!direct || best.score < direct.score)) return { ast: best.ast, quality: best.kind };
    if (direct) return { ast: direct.ast, quality: direct.kind };

    // Last resort: the best candidate with a position.
    for (const c of candidates(el, options, caches, false)) {
      const found = resolve(c.ast, { ...options, caches });
      const index = found.indexOf(el);
      if (index >= 0) return { ast: c.ast.concat({ name: 'nth', args: [index] }), quality: 'nth' };
    }
    return { ast: [{ name: 'locator', args: [el.nodeName.toLowerCase()] }], quality: 'css' };
  }

  const api = { resolve, generate, isVisible, ariaRole, accessibleName: (el, includeHidden) => accessibleName(el, !!includeHidden, newCaches()), newCaches };
  if (typeof module !== 'undefined' && module && typeof module === 'object') module.exports = api;
})();
