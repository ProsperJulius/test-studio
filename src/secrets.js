// Encrypts secret values at rest with the operating system keychain (Electron safeStorage).
// Outside Electron, or where no keychain is available, values pass through unchanged.
const PREFIX = 'enc:v1:';

let safeStorage = null;
try {
  const electron = require('electron');
  if (electron && typeof electron === 'object') safeStorage = electron.safeStorage || null;
} catch (e) { /* not running in Electron */ }

function available() {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable());
  } catch (e) {
    return false;
  }
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function encrypt(value) {
  if (!value || isEncrypted(value) || !available()) return value;
  return PREFIX + safeStorage.encryptString(String(value)).toString('base64');
}

function decrypt(value) {
  if (!isEncrypted(value)) return value;
  if (!available()) throw new Error('Secret values are encrypted but this computer’s keychain is not available.');
  return safeStorage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'));
}

// Applies fn to every secret value in the studio data (test data, environments, hidden step values).
function mapSecrets(data, fn) {
  const vars = (list) => (list || []).map((v) => (v.secret ? { ...v, value: fn(v.value) } : v));
  const steps = (list) => (list || []).map((s) => (s.secret ? { ...s, value: fn(s.value) } : s));
  return {
    ...data,
    variables: vars(data.variables),
    environments: (data.environments || []).map((e) => ({ ...e, variables: vars(e.variables) })),
    tests: (data.tests || []).map((t) => ({ ...t, steps: steps(t.steps) })),
    blocks: (data.blocks || []).map((b) => ({ ...b, steps: steps(b.steps) }))
  };
}

module.exports = { available, encrypt, decrypt, isEncrypted, mapSecrets };
