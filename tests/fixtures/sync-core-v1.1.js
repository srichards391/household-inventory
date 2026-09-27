/* Meds sync core
 * The parts of sync that don't touch the network or the page: the data format,
 * migration from v1, the merge rule, and encryption. Kept in its own file so the
 * exact same code runs in the browser and in the Node tests (tests/sync-core.test.js).
 *
 * Data format (meds.v2):
 *   meds:     [{ id, name, dosage, morning, evening, notes, active, order, createdAt, updatedAt }]
 *             A deleted med becomes a tombstone { id, deleted: true, order, updatedAt } so the
 *             deletion survives sync. Views never show tombstones.
 *   logs:     { "YYYY-MM-DD|slot|medId": { takenAt, updatedAt } }
 *             takenAt is an ISO time when the dose was taken, or null when it was un-taken.
 *             The null entry is the tombstone: it lets "I tapped it by mistake" win over an
 *             older "taken" on the other device instead of the dose coming back.
 *             One key per day + slot + med means a dose can never be counted twice.
 *   settings: { breakfast, dinner, updatedAt }
 *
 * Merge rule: for each med, each log key, and the settings, the copy with the newest
 * updatedAt wins. A record only one side has is always kept. Ties (same updatedAt, different
 * content) are broken by comparing the records' text, so both devices pick the same winner.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MedsSyncCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EPOCH = '1970-01-01T00:00:00.000Z';
  const TOMBSTONE_DAYS = 90;
  const PBKDF2_ITERATIONS = 200000;
  const DEFAULT_SETTINGS = { breakfast: '08:00', dinner: '18:00' };

  const emptyState = () => ({ meds: [], logs: {}, settings: { ...DEFAULT_SETTINGS, updatedAt: EPOCH } });
  const time = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };

  // A timestamp for a local edit. Normally "now", but always later than the version being
  // replaced, so an edit you make always beats the record you were looking at even if this
  // device's clock is a little behind the other one.
  function nextStamp(prevUpdatedAt, now = new Date()) {
    const t = Math.max(now.getTime(), time(prevUpdatedAt) + 1);
    return new Date(t).toISOString();
  }

  // JSON with keys sorted, so two equal records always produce the same text.
  function stableStringify(v) {
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
    }
    return JSON.stringify(v);
  }

  // Bring any saved or synced data (v1 or v2) into the v2 shape. Never throws on odd input.
  function migrate(raw) {
    const out = emptyState();
    if (!raw || typeof raw !== 'object') return out;

    if (Array.isArray(raw.meds)) {
      for (const m of raw.meds) {
        if (!m || typeof m.id !== 'string') continue;
        // v1 meds have no updatedAt. Use createdAt so two devices that migrate the same
        // v1 list agree on the timestamps instead of each stamping "now".
        out.meds.push({ ...m, updatedAt: m.updatedAt || m.createdAt || EPOCH });
      }
    }

    if (raw.logs && typeof raw.logs === 'object') {
      for (const [k, v] of Object.entries(raw.logs)) {
        if (typeof v === 'string') out.logs[k] = { takenAt: v, updatedAt: v };           // v1: "key -> ISO taken"
        else if (v && typeof v === 'object') out.logs[k] = { takenAt: v.takenAt || null, updatedAt: v.updatedAt || v.takenAt || EPOCH };
      }
    }

    const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    out.settings = { ...DEFAULT_SETTINGS, ...s, updatedAt: s.updatedAt || EPOCH };
    return out;
  }

  // Pick the newer of two versions of the same record.
  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ta = time(a.updatedAt), tb = time(b.updatedAt);
    if (ta !== tb) return ta > tb ? a : b;
    return stableStringify(a) >= stableStringify(b) ? a : b;
  }

  // Merge two states. Symmetric: merge(a, b) and merge(b, a) give the same result.
  function merge(a, b) {
    a = migrate(a); b = migrate(b);

    const meds = new Map();
    for (const m of [...a.meds, ...b.meds]) meds.set(m.id, newer(meds.get(m.id), m));

    const logs = {};
    for (const k of new Set([...Object.keys(a.logs), ...Object.keys(b.logs)])) logs[k] = newer(a.logs[k], b.logs[k]);

    return clone({
      meds: [...meds.values()].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)),
      logs,
      settings: newer(a.settings, b.settings),
    });
  }

  // Drop tombstones (deleted meds, un-taken doses) older than 90 days so the data doesn't grow
  // forever. Known limit: a device that stays offline longer than that could bring an old
  // deleted med or an old un-taken dose back when it finally syncs.
  function purge(state, now = new Date()) {
    const cutoff = now.getTime() - TOMBSTONE_DAYS * 86400000;
    const logs = {};
    for (const [k, v] of Object.entries(state.logs)) if (v.takenAt || time(v.updatedAt) >= cutoff) logs[k] = v;
    return { ...state, meds: state.meds.filter((m) => !m.deleted || time(m.updatedAt) >= cutoff), logs };
  }

  // One text form per state, for "did anything change?" checks.
  function canonical(state) {
    const s = migrate(state);
    return stableStringify({ ...s, meds: [...s.meds].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)) });
  }

  // One sync step: merge what's on the gist (null if there is no gist yet) into this device's
  // data. Returns the merged state and whether this device and the gist each need updating.
  function reconcile(local, remote, now = new Date()) {
    const merged = purge(merge(remote || emptyState(), local), now);
    const text = canonical(merged);
    return {
      merged,
      localChanged: text !== canonical(local),
      remoteNeedsWrite: !remote || text !== canonical(purge(migrate(remote), now)),
    };
  }

  const clone = (v) => JSON.parse(JSON.stringify(v));

  // ---------- encryption ----------
  // PBKDF2 (SHA-256, 200k rounds, random salt) turns the passphrase into an AES-GCM key.
  // Every write gets a new random salt and IV. The gist only ever holds { v, salt, iv, ciphertext }.
  const subtle = () => globalThis.crypto.subtle;
  const keyCache = new Map(); // "salt|passphrase" -> CryptoKey, so repeat syncs skip the slow derivation

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  async function deriveKey(passphrase, salt) {
    const id = toB64(salt) + '|' + passphrase;
    if (keyCache.has(id)) return keyCache.get(id);
    const base = await subtle().importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    const key = await subtle().deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    if (keyCache.size > 8) keyCache.clear();
    keyCache.set(id, key);
    return key;
  }

  async function encrypt(data, passphrase) {
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const ct = await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
    return { v: 1, salt: toB64(salt), iv: toB64(iv), ciphertext: toB64(new Uint8Array(ct)) };
  }

  class DecryptError extends Error {}

  // Throws DecryptError for a wrong passphrase or a damaged file. The caller must not
  // overwrite the remote copy when that happens.
  async function decrypt(blob, passphrase) {
    if (!blob || blob.v !== 1 || !blob.salt || !blob.iv || !blob.ciphertext) throw new DecryptError('Sync file is not in a format this version understands.');
    try {
      const key = await deriveKey(passphrase, fromB64(blob.salt));
      const pt = await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ciphertext));
      return JSON.parse(new TextDecoder().decode(pt));
    } catch (e) {
      throw new DecryptError("Couldn't decrypt. Check the passphrase.");
    }
  }

  return { EPOCH, TOMBSTONE_DAYS, emptyState, nextStamp, stableStringify, migrate, merge, purge, canonical, reconcile, encrypt, decrypt, DecryptError };
});
