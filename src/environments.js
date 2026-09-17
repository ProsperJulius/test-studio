// Environment profiles: each has a base address and values that override the default test data.

function findEnvironment(data, name) {
  const envs = data.environments || [];
  const byName = (n) => envs.find((e) => e.name.toLowerCase() === String(n || '').toLowerCase()) || null;
  if (name) return byName(name);
  return byName((data.settings || {}).activeEnvironment) || envs[0] || null;
}

// Returns the settings and variables a run should use.
// overrides: { baseUrl, buildVersion, stepTimeout, retries } from the command line.
// processEnv: TS_VAR_<name> variables override test data values (for CI secrets).
function resolveEnvironment(data, name, overrides = {}, processEnv = {}) {
  const env = findEnvironment(data, name);
  if (name && !env) {
    const known = (data.environments || []).map((e) => e.name).join(', ') || 'none';
    throw new Error('Unknown environment “' + name + '”. Known environments: ' + known + '.');
  }

  const byKey = new Map();
  for (const v of data.variables || []) if (v.key) byKey.set(v.key, { ...v });
  for (const v of (env && env.variables) || []) {
    if (!v.key) continue;
    // An environment value left blank falls back to the default value.
    if (v.value === '' && byKey.has(v.key)) continue;
    byKey.set(v.key, { ...v });
  }
  for (const [k, value] of Object.entries(processEnv || {})) {
    const m = /^TS_VAR_(\w+)$/.exec(k);
    if (m) byKey.set(m[1], { key: m[1], value, secret: true });
  }

  const settings = { ...(data.settings || {}) };
  settings.environment = env ? env.name : settings.environment || '';
  settings.baseUrl = env ? env.baseUrl || '' : settings.baseUrl || '';
  for (const k of ['baseUrl', 'buildVersion', 'stepTimeout', 'retries']) {
    if (overrides[k] != null && overrides[k] !== '') settings[k] = overrides[k];
  }
  return { settings, variables: Array.from(byKey.values()), environment: env };
}

module.exports = { findEnvironment, resolveEnvironment };
