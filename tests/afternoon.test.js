// Tests for v3.0: the afternoon slot, the as-needed daily limit, and syncing with a device
// still running v2.1. Run from the repo root with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../sync-core.js');
const v21 = require('./fixtures/sync-core-v2.1.js'); // the exact sync core shipped in v2.1

const { newMed, editSchedule, scheduleOn, slotMeds, prnMeds, prnLogs, prnStatus, reminderBody, scheduleSummary, dosesText,
  merge, reconcile, migrate, canonical, logKey, prnKey, encrypt, decrypt } = core;

const same = (a, b) => assert.equal(canonical(a), canonical(b));
const clone = (x) => JSON.parse(JSON.stringify(x));
const NOW = new Date('2026-09-29T16:00:00.000Z');
const TODAY = '2026-09-29'; // a Tuesday
const ENTERED = new Date('2026-09-29T14:00:00Z');
const taken = (iso, dose) => ({ takenAt: iso, updatedAt: iso, ...(dose ? { dose } : {}) });
const state = (meds, logs = {}) => migrate({ meds, logs, settings: {} });

// Neutral names: this repo is public.
const lithium = () => newMed('lith', { name: 'Afternoon-only', doses: { morning: null, afternoon: '300 mg', evening: null } }, 0, TODAY, ENTERED);
const twice = () => newMed('twice', { name: 'Twice-daily', doses: { morning: '500 mg', afternoon: null, evening: '500 mg' } }, 1, TODAY, ENTERED);
const xanax = (max = 2) => newMed('prn2', { name: 'As-needed-limited', prn: true, dose: '0.5 mg', maxPerDay: max }, 2, TODAY, ENTERED);
const legacyInput = () => newMed('old', { name: 'Old-shape', morning: true, evening: false, dose: '10 mg' }, 3, TODAY, ENTERED); // v2.0-style input

// ---------- afternoon slot ----------

test('an afternoon-only med is due in the afternoon and nowhere else', () => {
  const s = state([lithium(), twice()]);
  assert.deepEqual(slotMeds(s, 'afternoon', TODAY).map((x) => [x.med.id, x.dose]), [['lith', '300 mg']]);
  assert.deepEqual(slotMeds(s, 'morning', TODAY).map((x) => x.med.id), ['twice']);
  assert.deepEqual(slotMeds(s, 'evening', TODAY).map((x) => x.med.id), ['twice']);
});

test('the afternoon reminder reads naturally and skips what is logged', () => {
  const s = state([lithium(), twice()]);
  assert.equal(reminderBody(s, 'afternoon', TODAY), 'This afternoon: Afternoon-only 300 mg. Tap to log.');
  assert.equal(reminderBody(s, 'morning', TODAY), 'With breakfast: Twice-daily 500 mg. Tap to log.');
  s.logs[logKey(TODAY, 'afternoon', 'lith')] = taken('2026-09-29T18:05:00.000Z', '300 mg');
  assert.equal(reminderBody(s, 'afternoon', TODAY), 'All afternoon meds already logged.');
  assert.equal(reminderBody(state([twice()]), 'afternoon', TODAY), 'No afternoon meds scheduled today.');
});

test('summaries name the afternoon', () => {
  assert.equal(scheduleSummary(scheduleOn(lithium(), TODAY)), '300 mg · Afternoon');
  assert.equal(scheduleSummary(scheduleOn(twice(), TODAY)), '500 mg · Breakfast + Dinner');
  const split = newMed('sp', { name: 'Split', doses: { morning: '10 mg', afternoon: '20 mg', evening: null } }, 4, TODAY, ENTERED);
  assert.equal(dosesText(scheduleOn(split, TODAY)), '10 mg breakfast · 20 mg afternoon');
  const three = newMed('th', { name: 'Three', doses: { morning: '1 mg', afternoon: '1 mg', evening: '1 mg' } }, 5, TODAY, ENTERED);
  assert.equal(scheduleSummary(scheduleOn(three, TODAY)), '1 mg · Breakfast + Afternoon + Dinner');
});

test('the afternoon reminder time has a default and old settings pick it up', () => {
  const s = migrate({ meds: [], logs: {}, settings: { breakfast: '07:30', dinner: '19:00', updatedAt: '2026-09-01T00:00:00.000Z' } });
  assert.equal(s.settings.afternoon, '14:00');
  assert.equal(s.settings.breakfast, '07:30');
});

test('v2.0-style input (meal flags, one dose) still works and never lands in the afternoon', () => {
  const s = state([legacyInput()]);
  assert.deepEqual(slotMeds(s, 'morning', TODAY).map((x) => x.dose), ['10 mg']);
  assert.deepEqual(slotMeds(s, 'afternoon', TODAY), []);
  assert.deepEqual(Object.keys(s.meds[0].schedule[0].doses).sort(), ['afternoon', 'evening', 'morning']);
});

// ---------- as-needed daily limit ----------

test('a PRN med with a daily limit: counts today, stops at the limit, resets tomorrow', () => {
  const s = state([xanax(2)]);
  const m = s.meds[0];
  assert.equal(scheduleSummary(scheduleOn(m, TODAY)), 'As needed · 0.5 mg · up to 2 a day');
  assert.deepEqual(prnStatus(s, m, TODAY), { count: 0, max: 2, atMax: false });
  s.logs[prnKey(TODAY, 'prn2', 'a')] = taken('2026-09-29T13:00:00.000Z', '0.5 mg');
  assert.deepEqual(prnStatus(s, m, TODAY), { count: 1, max: 2, atMax: false });
  s.logs[prnKey(TODAY, 'prn2', 'b')] = taken('2026-09-29T20:00:00.000Z', '0.5 mg');
  assert.deepEqual(prnStatus(s, m, TODAY), { count: 2, max: 2, atMax: true });
  assert.deepEqual(prnStatus(s, m, '2026-09-30'), { count: 0, max: 2, atMax: false });
  // Removing one frees a slot again.
  s.logs[prnKey(TODAY, 'prn2', 'b')] = { takenAt: null, updatedAt: '2026-09-29T20:05:00.000Z' };
  assert.equal(prnStatus(s, m, TODAY).atMax, false);
  // Still never due, never in a reminder.
  for (const slot of core.SLOT_IDS) assert.deepEqual(slotMeds(s, slot, TODAY), []);
});

test('no limit, a blank limit and a bad limit all mean "no limit"', () => {
  for (const max of [undefined, '', null, 0, -1, 'two']) {
    const m = newMed('p', { name: 'P', prn: true, dose: '1', maxPerDay: max }, 0, TODAY, ENTERED);
    assert.equal(scheduleOn(m, TODAY).maxPerDay, null, String(max));
    assert.equal(scheduleSummary(scheduleOn(m, TODAY)), 'As needed · 1');
    assert.equal(prnStatus(state([m]), m, TODAY).atMax, false);
  }
  assert.equal(scheduleOn(newMed('p', { name: 'P', prn: true, dose: '1', maxPerDay: '3' }, 0, TODAY, ENTERED), TODAY).maxPerDay, 3);
});

test('changing only the limit is a schedule change; saving the same limit is not', () => {
  const m = xanax(2);
  assert.equal(editSchedule(m, TODAY, { prn: true, dose: '0.5 mg', maxPerDay: 2 }, TODAY, NOW), m);
  const changed = editSchedule(m, TODAY, { prn: true, dose: '0.5 mg', maxPerDay: 3 }, TODAY, NOW);
  assert.equal(changed.schedule.length, 2);
  assert.equal(scheduleOn(changed, TODAY).maxPerDay, 3);
  assert.equal(scheduleOn(changed, '2026-09-28').maxPerDay, 2, 'yesterday keeps the old limit');
});

test('a PRN med with a limit logged on both devices: the merge counts every dose against the limit', () => {
  const phone = state([xanax(2)], { [prnKey(TODAY, 'prn2', 'p1')]: taken('2026-09-29T13:00:00.000Z', '0.5 mg') });
  const mac = state([xanax(2)], { [prnKey(TODAY, 'prn2', 'm1')]: taken('2026-09-29T15:00:00.000Z', '0.5 mg') });
  const m = merge(phone, mac);
  same(m, merge(mac, phone));
  assert.equal(prnLogs(m, TODAY).length, 2);
  assert.equal(prnStatus(m, m.meds[0], TODAY).atMax, true);
});

// ---------- a device still on v2.1 ----------
// `v21` is the real v2.1 sync core: the Mac updated and the phone not yet, or the reverse.

test('a v2.1 device never shows the afternoon med as due, and its copy cannot erase the afternoon dose or the limit', () => {
  const updated = state([lithium(), twice(), xanax(2)], {
    [logKey(TODAY, 'afternoon', 'lith')]: taken('2026-09-29T18:05:00.000Z', '300 mg'),
    [prnKey(TODAY, 'prn2', 'a')]: taken('2026-09-29T13:00:00.000Z', '0.5 mg'),
  });
  // The v2.1 device merges the gist into its own data. Its migrate keeps only morning and evening.
  const old = v21.merge(v21.emptyState(), clone(updated));
  const oldLith = old.meds.find((m) => m.id === 'lith');
  assert.equal(oldLith.schedule[0].doses.afternoon, undefined, 'v2.1 does drop the afternoon dose (this is the hazard)');
  for (const slot of ['morning', 'evening']) assert.ok(!v21.slotMeds(old, slot, TODAY).some((x) => x.med.id === 'lith'), `not due at ${slot} on v2.1`);
  assert.deepEqual(v21.slotMeds(old, 'morning', TODAY).map((x) => [x.med.id, x.dose]), [['twice', '500 mg']], 'the rest is unchanged on v2.1');
  assert.equal(old.meds.find((m) => m.id === 'prn2').schedule[0].maxPerDay, undefined, 'v2.1 drops the limit too');
  assert.ok(old.logs[logKey(TODAY, 'afternoon', 'lith')].takenAt, 'but keeps the afternoon log it does not understand');

  // The v2.1 device logs something and writes its whole (stripped) copy back.
  old.logs[logKey(TODAY, 'morning', 'twice')] = { takenAt: '2026-09-29T12:00:00.000Z', updatedAt: '2026-09-29T12:00:00.000Z', dose: '500 mg' };
  const r = reconcile(updated, clone(old), NOW);
  assert.deepEqual(slotMeds(r.merged, 'afternoon', TODAY).map((x) => [x.med.id, x.dose]), [['lith', '300 mg']], 'afternoon dose survives');
  assert.equal(scheduleOn(r.merged.meds.find((m) => m.id === 'prn2'), TODAY).maxPerDay, 2, 'limit survives');
  assert.ok(r.merged.logs[logKey(TODAY, 'morning', 'twice')], 'and the v2.1 device\'s log is kept');
  assert.equal(r.remoteNeedsWrite, true, 'and the full copy goes back on the gist');
  same(merge(updated, clone(old)), merge(clone(old), updated));

  // Converges: the v2.1 device, with nothing new, leaves the full copy alone.
  const gist = clone(r.merged);
  const oldNext = v21.reconcile(old, clone(gist), NOW);
  assert.equal(oldNext.remoteNeedsWrite, false, 'v2.1 does not overwrite the full copy');
  assert.equal(reconcile(r.merged, clone(gist), NOW).remoteNeedsWrite, false);
});

test('the stripped v2.1 copy loses the tie from either side, even merged twice', () => {
  const updated = state([lithium(), twice(), xanax(2)]);
  const stripped = v21.merge(v21.emptyState(), clone(updated));
  for (const m of [merge(updated, stripped), merge(stripped, updated), merge(stripped, merge(stripped, updated))]) {
    assert.deepEqual(slotMeds(m, 'afternoon', TODAY).map((x) => x.dose), ['300 mg']);
    assert.equal(scheduleOn(m.meds.find((x) => x.id === 'prn2'), TODAY).maxPerDay, 2);
  }
});

test('a real later edit on the v2.1 device is honoured (and, being v2.1, cannot carry the afternoon dose)', () => {
  const updated = state([twice()]);
  const old = v21.merge(v21.emptyState(), clone(updated));
  old.meds[0] = v21.editSchedule(old.meds[0], '2026-10-01', { doses: { morning: '250 mg', evening: '500 mg' } }, '2026-10-01', new Date('2026-10-01T12:00:00Z'));
  const m = merge(updated, old);
  same(m, merge(old, updated));
  assert.equal(slotMeds(m, 'morning', '2026-09-30')[0].dose, '500 mg');
  assert.equal(slotMeds(m, 'morning', '2026-10-01')[0].dose, '250 mg');
  assert.deepEqual(slotMeds(m, 'afternoon', '2026-10-01'), []);
});

test('data saved by v2.1 migrates in place: every version gains an afternoon slot, and migrating again changes nothing', () => {
  const fromOld = v21.migrate({ meds: [
    { id: 'a', name: 'A', dosage: '5 mg', morning: true, evening: true, notes: '', active: true, order: 0, createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z' },
    { id: 'p', name: 'P', dosage: '1', morning: false, evening: false, notes: '', active: true, order: 1, createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z',
      schedule: [{ from: '', prn: true, dose: '1', updatedAt: '2026-09-20T12:00:00.000Z' }] },
  ], logs: {} });
  const m = migrate(clone(fromOld));
  assert.equal(m.meds[0].schedule[0].doses.afternoon, null);
  assert.deepEqual(slotMeds(m, 'morning', TODAY).map((x) => x.dose), ['5 mg']);
  assert.deepEqual(prnMeds(m, TODAY).map((x) => x.id), ['p']);
  assert.equal(m.meds[1].schedule[0].maxPerDay, null);
  same(migrate(m), m);
});

test('encrypted gist: v2.1 can read what v3.0 wrote and the other way round', async () => {
  const s = state([lithium()], { [logKey(TODAY, 'afternoon', 'lith')]: taken('2026-09-29T18:05:00.000Z', '300 mg') });
  const blob = await encrypt(s, 'steady heart 42');
  assert.deepEqual(await v21.decrypt(blob, 'steady heart 42'), s);
  const back = migrate(await decrypt(await v21.encrypt(v21.migrate(clone(s)), 'steady heart 42'), 'steady heart 42'));
  assert.ok(back.logs[logKey(TODAY, 'afternoon', 'lith')].takenAt, 'the afternoon log round-trips through v2.1');
});
