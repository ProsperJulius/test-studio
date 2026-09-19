// Choosing which tests to run: by id, tag, approval.

function normTag(t) {
  return String(t || '').trim().toLowerCase();
}

function parseTags(text) {
  const seen = new Set();
  return String(text || '')
    .split(/[,\s]+/)
    .map(normTag)
    .filter((t) => t && !seen.has(t) && seen.add(t));
}

function list(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
}

// options.ids, options.tags (any match), options.excludeTags, options.approvedOnly.
// Disabled tests are left out unless they are asked for by id.
function selectTests(tests, options = {}) {
  const ids = list(options.ids);
  const tags = list(options.tags).map(normTag);
  const exclude = list(options.excludeTags).map(normTag);
  return (tests || []).filter((t) => {
    const testTags = (t.tags || []).map(normTag);
    if (ids.length && !ids.includes(t.id)) return false;
    if (t.disabled && !ids.includes(t.id)) return false;
    if (tags.length && !tags.some((x) => testTags.includes(x))) return false;
    if (exclude.some((x) => testTags.includes(x))) return false;
    if (options.approvedOnly && t.approval !== 'Approved') return false;
    return true;
  });
}

function allTags(tests) {
  return Array.from(new Set((tests || []).flatMap((t) => (t.tags || []).map(normTag)))).sort();
}

module.exports = { selectTests, parseTags, allTags, normTag };
