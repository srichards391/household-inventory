/* Meds core
 * Everything about the data that doesn't touch the network or the page: the data format,
 * migration from older versions, which dose applies on which day, the merge rule, and
 * encryption. Kept in its own file so the exact same code runs in the app, in the service
 * worker (for the push reminder text), and in the Node tests (tests/*.test.*).
 *
 * Data format (stored under localStorage "meds.v2"; shape version 3 since Meds v2.0):
 *
 *   meds: [{ id, name, notes, active, order, createdAt, updatedAt, schedule: [version, ...],
 *            dosage, morning, evening, _mirror }]
 *     schedule: the med's dosing over time, oldest first. Each version applies from its
 *       `from` day ("YYYY-MM-DD", or "" for "from the beginning") until the next version.
 *       version = { from, prn, morning, evening, dose, doseByDay, updatedAt }
 *         prn:       true for as-needed meds. They are never due, never missed, never in a reminder.
 *         dose:      the dose as typed, e.g. "25 mg". Used when doseByDay is null.
 *         doseByDay: null, or 7 doses indexed Sunday=0 ... Saturday=6, e.g. warfarin
 *                    ["8 mg","6 mg","6 mg","6 mg","8 mg","6 mg","6 mg"].
 *       Editing a dose or schedule adds a version starting on a chosen day (default today),
 *       so earlier days keep showing the dose that applied then.
 *     dosage, morning, evening: a copy of the current version in the v1.x shape, so a device
 *       still running v1.1 shows something sensible. _mirror records what that copy was when
 *       this version wrote it; if they differ, a v1.1 device edited the med (see migrateMed).
 *     A deleted med becomes a tombstone { id, deleted: true, order, updatedAt }.
 *
 *   logs: { key: { takenAt, updatedAt, dose? } }
 *     Scheduled dose: key "YYYY-MM-DD|morning|medId" (or evening). One per day, slot and med,
 *       so a dose can never be counted twice.
 *     As-needed dose: key "YYYY-MM-DD|prn:<unique id>|medId". A new key per dose, so several
 *       in one day never collide.
 *     takenAt: ISO time taken, or null when un-taken (the tombstone that lets an undo sync).
 *     dose: the dose as it was when logged. Later schedule edits never change it.
 *       Logs written by v1.x have no dose; the schedule for that day is shown instead.
 *
 *   settings: { breakfast, dinner, updatedAt }
 *
 * Merge rule: for each med, each log key, and the settings, the copy with the newest
 * updatedAt wins. A record only one side has is always kept. A med's schedule versions are
 * merged one by one (by `from` day), so a dose change on one device and a note edit on the
 * other both survive. Ties (same updatedAt) go to the copy that has everything the other
 * has plus more (so a v1.1 device dropping a log's dose can't erase it), else to the larger
 * text, so both devices always pick the same winner.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MedsSyncCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '2.0'; // must match APP_VERSION in app.js (checked at startup and by tests)
  const EPOCH = '1970-01-01T00:00:00.000Z';
  const TOMBSTONE_DAYS = 90;
  const PBKDF2_ITERATIONS = 200000;
  const DEFAULT_SETTINGS = { breakfast: '08:00', dinner: '18:00' };
  const SLOT_IDS = ['morning', 'evening'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const emptyState = () => ({ meds: [], logs: {}, settings: { ...DEFAULT_SETTINGS, updatedAt: EPOCH } });
  const time = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? 0 : t; };
  const byId = (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  const clone = (v) => JSON.parse(JSON.stringify(v));

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

  // ---------- days ----------
  const pad = (n) => String(n).padStart(2, '0');
  // "YYYY-MM-DD" for a Date, in this device's time zone.
  const dayKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  // 0 = Sunday ... 6 = Saturday, for a "YYYY-MM-DD" key. Pure calendar math, no time zone.
  function weekdayOf(dayKey) {
    const [y, m, d] = dayKey.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  // ---------- schedules and doses ----------
  const cleanDose = (s) => String(s == null ? '' : s).trim();

  function normalizeVersion(v, fallbackUpdatedAt) {
    const prn = Boolean(v.prn);
    const byDay = Array.isArray(v.doseByDay) && v.doseByDay.length === 7 ? v.doseByDay.map(cleanDose) : null;
    return {
      from: typeof v.from === 'string' ? v.from : '',
      prn,
      morning: !prn && Boolean(v.morning),
      evening: !prn && Boolean(v.evening),
      dose: cleanDose(v.dose),
      doseByDay: prn ? null : byDay,
      updatedAt: v.updatedAt || fallbackUpdatedAt || EPOCH,
    };
  }

  // The parts of a version that decide what you take. Two versions with the same text here are the same schedule.
  const scheduleText = (v) => stableStringify({ prn: v.prn, morning: v.morning, evening: v.evening, dose: v.dose, doseByDay: v.doseByDay });

  // Which version applies on a day (the last one starting on or before it).
  function scheduleOn(med, dayKey) {
    let found = null;
    for (const v of med.schedule || []) if (v.from <= dayKey) found = v;
    return found;
  }

  // The dose a version says to take on a day.
  function doseOn(version, dayKey) {
    if (!version) return '';
    if (version.doseByDay) return version.doseByDay[weekdayOf(dayKey)] || '';
    return version.dose || '';
  }

  // "8 mg Sun, Thu · 6 mg Mon, Tue, Wed, Fri, Sat"
  function doseSummary(version) {
    if (!version) return '';
    if (!version.doseByDay) return version.dose || '';
    const groups = new Map();
    version.doseByDay.forEach((d, i) => { if (!groups.has(d)) groups.set(d, []); groups.get(d).push(WEEKDAYS[i]); });
    if (groups.size === 1) return version.doseByDay[0];
    return [...groups].map(([d, days]) => `${d || '(blank)'} ${days.join(', ')}`).join(' · ');
  }

  // One line describing a version, for the Meds list and the schedule history.
  function scheduleSummary(version) {
    if (!version) return '';
    const dose = doseSummary(version);
    if (version.prn) return `As needed${dose ? ' · ' + dose : ''}`;
    const when = [version.morning ? 'Breakfast' : null, version.evening ? 'Dinner' : null].filter(Boolean).join(' + ') || 'No schedule';
    return dose ? `${dose} · ${when}` : when;
  }

  // The v1.x-shaped copy kept on each med for devices still running v1.1.
  function legacyFields(version) {
    return { dosage: doseSummary(version), morning: Boolean(version && version.morning), evening: Boolean(version && version.evening) };
  }
  const legacyText = (m) => stableStringify({ dosage: cleanDose(m.dosage), morning: Boolean(m.morning), evening: Boolean(m.evening) });

  // Add or replace the version starting on `from` (pure: returns a new med).
  function upsertVersion(schedule, version) {
    const out = schedule.filter((v) => v.from !== version.from);
    const existing = schedule.find((v) => v.from === version.from);
    out.push(existing ? newer(existing, version) : version);
    return out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  }

  // Apply an edit to a med's dose or schedule, starting on day `from`. Earlier days, and every
  // dose already logged, are untouched. Returns the med unchanged if nothing about the
  // schedule actually changed on that day. `todayKey` picks which version the v1.x copy shows.
  function editSchedule(med, from, fields, todayKey, now = new Date()) {
    const current = scheduleOn(med, from);
    const next = normalizeVersion({ ...fields, from }, EPOCH);
    if (current && scheduleText(current) === scheduleText(next)) return med;
    const prevSame = (med.schedule || []).find((v) => v.from === from);
    next.updatedAt = nextStamp(prevSame ? prevSame.updatedAt : med.updatedAt, now);
    const out = { ...med, schedule: upsertVersion(med.schedule || [], next), updatedAt: nextStamp(med.updatedAt, now) };
    return withLegacyFields(out, todayKey);
  }

  function withLegacyFields(med, todayKey) {
    const legacy = legacyFields(scheduleOn(med, todayKey) || (med.schedule || [])[0]);
    return { ...med, ...legacy, _mirror: legacyText(legacy) };
  }

  // A brand-new med. Its first version applies "from the beginning" so a forgotten earlier
  // day can still be logged.
  function newMed(id, fields, order, todayKey, now = new Date()) {
    const at = now.toISOString();
    const version = normalizeVersion({ ...fields, from: '' }, at);
    const med = { id, name: fields.name, notes: fields.notes || '', active: fields.active !== false, order, createdAt: at, updatedAt: at, schedule: [version] };
    return withLegacyFields(med, todayKey);
  }

  // ---------- migration ----------
  // Bring one med from any older shape to the current one. Deterministic, so two devices
  // migrating the same data get the same result.
  function migrateMed(m) {
    const updatedAt = m.updatedAt || m.createdAt || EPOCH;
    if (m.deleted) return { id: m.id, deleted: true, order: Number(m.order) || 0, updatedAt };
    const med = { ...m, updatedAt };

    if (!Array.isArray(m.schedule) || m.schedule.length === 0) {
      // v1.x med: its single dose and meal flags become one version covering all time.
      med.schedule = [normalizeVersion({ from: '', prn: false, morning: m.morning, evening: m.evening, dose: m.dosage }, updatedAt)];
      med._mirror = legacyText(m);
      return med;
    }

    med.schedule = m.schedule.filter((v) => v && typeof v === 'object')
      .map((v) => normalizeVersion(v, updatedAt))
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    // Duplicate `from` days (shouldn't happen) collapse to the newer version.
    med.schedule = med.schedule.reduce((acc, v) => upsertVersion(acc, v), []);

    if (typeof m._mirror === 'string' && legacyText(m) !== m._mirror) {
      // A device still on v1.1 changed the dose text or meal checkboxes. Honour it as a new
      // version starting the day that edit was made. (It can only express one dose for every
      // day; a v1.1 edit to a day-of-week med replaces the day-of-week doses from then on.)
      const from = dayKeyOf(new Date(updatedAt));
      med.schedule = upsertVersion(med.schedule, normalizeVersion({ from, prn: false, morning: m.morning, evening: m.evening, dose: m.dosage, updatedAt }, updatedAt));
      med._mirror = legacyText(m);
    } else if (typeof m._mirror !== 'string') {
      med._mirror = legacyText(m);
    }
    return med;
  }

  // Bring any saved or synced data (v1.x or v2.x) into the current shape. Never throws on odd input.
  function migrate(raw) {
    const out = emptyState();
    if (!raw || typeof raw !== 'object') return out;

    if (Array.isArray(raw.meds)) {
      for (const m of raw.meds) {
        if (!m || typeof m.id !== 'string') continue;
        out.meds.push(migrateMed(m));
      }
    }

    if (raw.logs && typeof raw.logs === 'object') {
      for (const [k, v] of Object.entries(raw.logs)) {
        if (typeof v === 'string') out.logs[k] = { takenAt: v, updatedAt: v };           // v1.0: "key -> ISO taken"
        else if (v && typeof v === 'object') {
          const log = { takenAt: v.takenAt || null, updatedAt: v.updatedAt || v.takenAt || EPOCH };
          if (log.takenAt && typeof v.dose === 'string') log.dose = v.dose;
          out.logs[k] = log;
        }
      }
    }

    const s = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
    out.settings = { ...DEFAULT_SETTINGS, ...s, updatedAt: s.updatedAt || EPOCH };
    return out;
  }

  // ---------- merge ----------
  // True if `a` has every field `b` has, with the same value.
  function covers(a, b) {
    return Object.keys(b).every((k) => b[k] === undefined || stableStringify(a[k]) === stableStringify(b[k]));
  }

  // Pick the newer of two versions of the same record.
  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ta = time(a.updatedAt), tb = time(b.updatedAt);
    if (ta !== tb) return ta > tb ? a : b;
    const ab = covers(a, b), ba = covers(b, a);
    if (ab !== ba) return ab ? a : b; // same time, one just has more detail: keep the detail
    return stableStringify(a) >= stableStringify(b) ? a : b;
  }

  function mergeMed(a, b) {
    const win = newer(a, b);
    if (!a || !b || win.deleted) return win;
    // Both sides are live, or the newer side is live: merge schedule versions one by one.
    let schedule = [];
    for (const v of [...(a.schedule || []), ...(b.schedule || [])]) schedule = upsertVersion(schedule, v);
    return { ...win, schedule };
  }

  // Merge two states. Symmetric: merge(a, b) and merge(b, a) give the same result.
  function merge(a, b) {
    a = migrate(a); b = migrate(b);

    const meds = new Map();
    for (const m of [...a.meds, ...b.meds]) meds.set(m.id, mergeMed(meds.get(m.id), m));

    const logs = {};
    for (const k of new Set([...Object.keys(a.logs), ...Object.keys(b.logs)])) logs[k] = newer(a.logs[k], b.logs[k]);

    return clone({
      meds: [...meds.values()].sort(byId),
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
    return stableStringify({ ...s, meds: [...s.meds].sort(byId) });
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

  // ---------- what's due on a day ----------
  const parseKey = (k) => { const [day, slot, medId] = k.split('|'); return { day, slot, medId }; };
  const liveMeds = (state) => state.meds.filter((m) => !m.deleted).sort((a, b) => (a.order - b.order) || (a.id < b.id ? -1 : 1));
  const logKey = (dayKey, slotId, medId) => `${dayKey}|${slotId}|${medId}`;
  const prnKey = (dayKey, medId, uniqueId) => `${dayKey}|prn:${uniqueId}|${medId}`;

  // Scheduled meds for a slot on a day, with the dose for that day. As-needed meds never appear.
  function slotMeds(state, slotId, dayKey) {
    const out = [];
    for (const med of liveMeds(state)) {
      if (!med.active) continue;
      const version = scheduleOn(med, dayKey);
      if (!version || version.prn || !version[slotId]) continue;
      out.push({ med, version, dose: doseOn(version, dayKey) });
    }
    return out;
  }

  // As-needed meds available on a day.
  function prnMeds(state, dayKey) {
    return liveMeds(state).filter((m) => m.active && (scheduleOn(m, dayKey) || {}).prn);
  }

  // As-needed doses logged on a day (or on every day if dayKey is omitted), newest first.
  function prnLogs(state, dayKey) {
    const out = [];
    for (const [key, log] of Object.entries(state.logs)) {
      const p = parseKey(key);
      if (!p.slot || !p.slot.startsWith('prn:') || !log.takenAt) continue;
      if (dayKey && p.day !== dayKey) continue;
      out.push({ key, day: p.day, medId: p.medId, takenAt: log.takenAt, dose: log.dose || '' });
    }
    return out.sort((a, b) => (a.takenAt < b.takenAt ? 1 : -1));
  }

  // What a scheduled log says was taken: the dose saved with it, or (for logs from v1.x,
  // which didn't save one) what the schedule said for that day.
  function loggedDose(state, dayKey, slotId, med) {
    const log = state.logs[logKey(dayKey, slotId, med.id)];
    if (log && log.takenAt && typeof log.dose === 'string') return log.dose;
    return doseOn(scheduleOn(med, dayKey), dayKey);
  }

  // Push notification body, built on the device from its own data when the reminder arrives.
  function reminderBody(state, slotId, dayKey) {
    const due = slotMeds(state, slotId, dayKey);
    const meal = slotId === 'morning' ? 'breakfast' : 'dinner';
    if (due.length === 0) return `No ${slotId} meds scheduled today.`;
    const left = due.filter((x) => !(state.logs[logKey(dayKey, slotId, x.med.id)] || {}).takenAt);
    if (left.length === 0) return `All ${slotId} meds already logged.`;
    return `With ${meal}: ` + left.map((x) => x.med.name + (x.dose ? ` ${x.dose}` : '')).join(', ') + '. Tap to log.';
  }

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

  return {
    VERSION, EPOCH, TOMBSTONE_DAYS, SLOT_IDS, WEEKDAYS, WEEKDAY_NAMES,
    emptyState, nextStamp, stableStringify, dayKeyOf, weekdayOf,
    scheduleOn, doseOn, doseSummary, scheduleSummary, scheduleText, editSchedule, newMed, withLegacyFields,
    migrate, merge, purge, canonical, reconcile,
    logKey, prnKey, parseKey, slotMeds, prnMeds, prnLogs, loggedDose, reminderBody,
    encrypt, decrypt, DecryptError,
  };
});
