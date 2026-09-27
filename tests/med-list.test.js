// Tests with the exact medication list: doses that differ by slot, by weekday, neither, and PRN.
// Names come from tests/fixtures/med-list.js (neutral in the public repo; real names locally).
// Run from the repo root with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../sync-core.js');
const v11 = require('./fixtures/sync-core-v1.1.js');
const v20 = require('./fixtures/sync-core-v2.0.js');
const { names, medListState, medInputs } = require('./fixtures/med-list.js');

const N = names();
const { slotMeds, prnMeds, prnLogs, loggedDose, reminderBody, logKey, prnKey, merge, reconcile, migrate, canonical,
  editSchedule, scheduleOn, doseOn, scheduleSummary, encrypt, decrypt } = core;
const same = (a, b) => assert.equal(canonical(a), canonical(b));
const NOW = new Date('2026-09-26T16:00:00Z');
const clone = (x) => JSON.parse(JSON.stringify(x));

// Sun Sep 27 to Sat Oct 3, 2026, then the following week.
const DAYS = ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03',
  '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// What must be taken, written out by hand from the prescription, in list order.
function expected(slot, day) {
  const dow = DOW[core.weekdayOf(day)];
  if (slot === 'morning') {
    return [[N.splitA, '200 mg'], [N.splitB, '50 mg'], [N.breakfastOnly, '81 mg'], [N.twiceSame, '300 mg']];
  }
  return [[N.splitA, '600 mg'], [N.splitB, '25 mg'], [N.weekday, dow === 'Thu' || dow === 'Sun' ? '8 mg' : '6 mg'], [N.twiceSame, '300 mg']];
}
const actual = (s, slot, day) => slotMeds(s, slot, day).map((x) => [x.med.name, x.dose]);

// ---------- the full table ----------

test('every med, every slot, every day for two weeks: exactly the prescribed dose', () => {
  const s = medListState(core);
  for (const day of DAYS) {
    for (const slot of ['morning', 'evening']) {
      assert.deepEqual(actual(s, slot, day), expected(slot, day), `${slot} ${day} (${DOW[core.weekdayOf(day)]})`);
    }
  }
});

test(`${N.splitA}: 200 mg at breakfast and 600 mg at dinner, never swapped, anywhere`, () => {
  const s = medListState(core);
  const med = s.meds.find((m) => m.id === 'splitA');
  for (const day of DAYS) {
    // Today screen / history view of a past day: the dose listed under each slot card.
    const am = slotMeds(s, 'morning', day).find((x) => x.med.id === 'splitA');
    const pm = slotMeds(s, 'evening', day).find((x) => x.med.id === 'splitA');
    assert.equal(am.dose, '200 mg', `breakfast ${day}`);
    assert.equal(pm.dose, '600 mg', `dinner ${day}`);
    // Push notification text for each slot.
    assert.match(reminderBody(s, 'morning', day), new RegExp(`${N.splitA.replace(/[()]/g, '\\$&')} 200 mg`));
    assert.doesNotMatch(reminderBody(s, 'morning', day), /600 mg/);
    assert.match(reminderBody(s, 'evening', day), new RegExp(`${N.splitA.replace(/[()]/g, '\\$&')} 600 mg`));
    assert.doesNotMatch(reminderBody(s, 'evening', day), /200 mg/);
  }
  // Logged doses keep the slot's dose, and each slot's log reads back its own dose.
  const d = DAYS[0];
  s.logs[logKey(d, 'morning', 'splitA')] = { takenAt: '2026-09-27T12:00:00.000Z', updatedAt: '2026-09-27T12:00:00.000Z', dose: '200 mg' };
  s.logs[logKey(d, 'evening', 'splitA')] = { takenAt: '2026-09-27T22:00:00.000Z', updatedAt: '2026-09-27T22:00:00.000Z', dose: '600 mg' };
  assert.equal(loggedDose(s, d, 'morning', med), '200 mg');
  assert.equal(loggedDose(s, d, 'evening', med), '600 mg');
  // Unlogged past day in history: the slot's own dose.
  assert.equal(loggedDose(s, DAYS[1], 'morning', med), '200 mg');
  assert.equal(loggedDose(s, DAYS[1], 'evening', med), '600 mg');
  // Asking for "the" dose without a slot is refused, so no caller can show one slot's dose in the other.
  assert.throws(() => doseOn(scheduleOn(med, d), d), /pass the slot/);
});

test(`${N.splitB}: 50 mg at breakfast and 25 mg at dinner`, () => {
  const s = medListState(core);
  for (const day of DAYS) {
    assert.equal(slotMeds(s, 'morning', day).find((x) => x.med.id === 'splitB').dose, '50 mg');
    assert.equal(slotMeds(s, 'evening', day).find((x) => x.med.id === 'splitB').dose, '25 mg');
  }
});

test('each scheduled med appears once per slot it belongs to, and the PRN med never does', () => {
  const s = medListState(core);
  for (const day of DAYS) {
    const am = slotMeds(s, 'morning', day).map((x) => x.med.id);
    const pm = slotMeds(s, 'evening', day).map((x) => x.med.id);
    assert.deepEqual(am, ['splitA', 'splitB', 'breakfastOnly', 'twiceSame']);
    assert.deepEqual(pm, ['splitA', 'splitB', 'weekday', 'twiceSame']);
    assert.deepEqual(prnMeds(s, day).map((m) => m.id), ['prn']);
  }
  assert.equal(s.meds.length, 6, 'one entry per med, not one per dose');
});

test('push reminder text for the whole list, by slot and weekday', () => {
  const s = medListState(core);
  const thu = '2026-10-01', mon = '2026-09-28';
  assert.equal(reminderBody(s, 'morning', thu), `With breakfast: ${N.splitA} 200 mg, ${N.splitB} 50 mg, ${N.breakfastOnly} 81 mg, ${N.twiceSame} 300 mg. Tap to log.`);
  assert.equal(reminderBody(s, 'evening', thu), `With dinner: ${N.splitA} 600 mg, ${N.splitB} 25 mg, ${N.weekday} 8 mg, ${N.twiceSame} 300 mg. Tap to log.`);
  assert.equal(reminderBody(s, 'evening', mon), `With dinner: ${N.splitA} 600 mg, ${N.splitB} 25 mg, ${N.weekday} 6 mg, ${N.twiceSame} 300 mg. Tap to log.`);
  assert.ok(!reminderBody(s, 'morning', thu).includes(N.prn) && !reminderBody(s, 'evening', thu).includes(N.prn));
});

test('Meds list descriptions read correctly', () => {
  const s = medListState(core);
  const line = (id) => scheduleSummary(scheduleOn(s.meds.find((m) => m.id === id), '2026-09-27'));
  assert.equal(line('splitA'), '200 mg breakfast · 600 mg dinner');
  assert.equal(line('splitB'), '50 mg breakfast · 25 mg dinner');
  assert.equal(line('weekday'), '8 mg Sun, Thu · 6 mg Mon, Tue, Wed, Fri, Sat · Dinner');
  assert.equal(line('breakfastOnly'), '81 mg · Breakfast');
  assert.equal(line('twiceSame'), '300 mg · Breakfast + Dinner');
  assert.equal(line('prn'), 'As needed · 50 mg');
});

// ---------- history ----------

test('changing one slot\'s dose later leaves earlier days and logged doses alone', () => {
  const s = medListState(core);
  const d = '2026-09-28';
  s.logs[logKey(d, 'evening', 'splitA')] = { takenAt: '2026-09-28T22:00:00.000Z', updatedAt: '2026-09-28T22:00:00.000Z', dose: '600 mg' };
  const i = s.meds.findIndex((m) => m.id === 'splitA');
  s.meds[i] = editSchedule(s.meds[i], '2026-10-01', { doses: { morning: '200 mg', evening: '400 mg' } }, '2026-10-01', new Date('2026-10-01T12:00:00Z'));
  assert.equal(loggedDose(s, d, 'evening', s.meds[i]), '600 mg', 'logged dose unchanged');
  assert.equal(slotMeds(s, 'evening', '2026-09-30')[0].dose, '600 mg', 'day before the change');
  assert.equal(slotMeds(s, 'evening', '2026-10-01')[0].dose, '400 mg', 'from the change');
  assert.equal(slotMeds(s, 'morning', '2026-10-01')[0].dose, '200 mg', 'other slot untouched');
});

test('a slot can vary by weekday while the other slot is fixed', () => {
  const s = medListState(core);
  const i = s.meds.findIndex((m) => m.id === 'splitB');
  s.meds[i] = editSchedule(s.meds[i], '2026-09-27',
    { doses: { morning: '50 mg', evening: ['12.5 mg', '25 mg', '25 mg', '25 mg', '25 mg', '25 mg', '12.5 mg'] } }, '2026-09-27', NOW);
  assert.equal(slotMeds(s, 'morning', '2026-10-03').find((x) => x.med.id === 'splitB').dose, '50 mg');
  assert.equal(slotMeds(s, 'evening', '2026-10-03').find((x) => x.med.id === 'splitB').dose, '12.5 mg');
  assert.equal(slotMeds(s, 'evening', '2026-10-02').find((x) => x.med.id === 'splitB').dose, '25 mg');
  assert.equal(scheduleSummary(scheduleOn(s.meds[i], '2026-10-03')), '50 mg breakfast · dinner: 12.5 mg Sun, Sat, 25 mg Mon, Tue, Wed, Thu, Fri');
});

// ---------- sync ----------

test('the list survives sync both ways and through encryption', async () => {
  const phone = medListState(core);
  const mac = migrate({ meds: [], logs: {} });
  same(merge(phone, mac), merge(mac, phone));
  const back = migrate(await decrypt(await encrypt(merge(phone, mac), 'pass phrase 1'), 'pass phrase 1'));
  same(back, phone);
  for (const day of DAYS) for (const slot of ['morning', 'evening']) assert.deepEqual(actual(back, slot, day), expected(slot, day));
});

test('the PRN med logged twice in a day on one device and once on the other: all three kept', () => {
  const a = medListState(core), b = medListState(core);
  const day = '2026-09-29';
  a.logs[prnKey(day, 'prn', 'a1')] = { takenAt: '2026-09-29T13:00:00.000Z', updatedAt: '2026-09-29T13:00:00.000Z', dose: '50 mg' };
  a.logs[prnKey(day, 'prn', 'a2')] = { takenAt: '2026-09-29T20:00:00.000Z', updatedAt: '2026-09-29T20:00:00.000Z', dose: '50 mg' };
  b.logs[prnKey(day, 'prn', 'b1')] = { takenAt: '2026-09-29T16:00:00.000Z', updatedAt: '2026-09-29T16:00:00.000Z', dose: '50 mg' };
  const m = merge(a, b);
  same(m, merge(b, a));
  assert.equal(prnLogs(m, day).length, 3);
  for (const slot of ['morning', 'evening']) assert.deepEqual(actual(m, slot, day), expected(slot, day), 'PRN logs change nothing in the slots');
});

test('a device still on v2.0 sees the split dose in words, never a single wrong number, and cannot erase it', () => {
  const updated = medListState(core);
  // The v2.0 device merges the gist. v2.0 drops fields it doesn't know (the per-slot doses).
  const old = v20.merge(v20.emptyState(), clone(updated));
  const oldA = old.meds.find((m) => m.id === 'splitA');
  assert.equal(v20.doseOn(v20.scheduleOn(oldA, '2026-09-27'), '2026-09-27'), '200 mg breakfast · 600 mg dinner');
  assert.deepEqual(v20.slotMeds(old, 'morning', '2026-10-01').map((x) => [x.med.id, x.dose]),
    [['splitA', '200 mg breakfast · 600 mg dinner'], ['splitB', '50 mg breakfast · 25 mg dinner'], ['breakfastOnly', '81 mg'], ['twiceSame', '300 mg']]);
  assert.equal(v20.slotMeds(old, 'evening', '2026-10-01').find((x) => x.med.id === 'weekday').dose, '8 mg', 'v2.0 still gets weekday doses right');
  // The v2.0 device logs something and writes its whole (stripped) copy back.
  old.logs[logKey('2026-10-01', 'morning', 'breakfastOnly')] = { takenAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z', dose: '81 mg' };
  const r = reconcile(updated, clone(old), NOW);
  for (const day of DAYS) for (const slot of ['morning', 'evening']) assert.deepEqual(actual(r.merged, slot, day), expected(slot, day), `${slot} ${day}`);
  assert.ok(r.merged.logs[logKey('2026-10-01', 'morning', 'breakfastOnly')], 'kept the v2.0 device\'s log');
  // Converges: the updated device writes the full copy back. The v2.0 device, with nothing
  // new, leaves it there (it only writes when it has changes), and the updated device then
  // has nothing to write either.
  const gist = clone(r.merged);
  const oldNext = v20.reconcile(old, clone(gist), NOW);
  assert.equal(oldNext.remoteNeedsWrite, false, 'v2.0 does not overwrite the full copy');
  assert.equal(v20.reconcile(oldNext.merged, clone(gist), NOW).remoteNeedsWrite, false);
  assert.equal(reconcile(r.merged, clone(gist), NOW).remoteNeedsWrite, false);
});

test('the stripped v2.0 copy loses the tie from either side, for both split-dose meds', () => {
  const updated = medListState(core);
  const stripped = v20.merge(v20.emptyState(), clone(updated));
  for (const m of [merge(updated, stripped), merge(stripped, updated), merge(stripped, merge(stripped, updated))]) {
    for (const day of DAYS) for (const slot of ['morning', 'evening']) assert.deepEqual(actual(m, slot, day), expected(slot, day));
  }
});

test('a real dose change made later on a v2.0 device is honoured', () => {
  const updated = medListState(core);
  const old = v20.merge(v20.emptyState(), clone(updated));
  const i = old.meds.findIndex((m) => m.id === 'breakfastOnly');
  old.meds[i] = v20.editSchedule(old.meds[i], '2026-10-01', { morning: true, evening: false, dose: '162 mg' }, '2026-10-01', new Date('2026-10-01T12:00:00Z'));
  const m = merge(updated, old);
  same(m, merge(old, updated));
  assert.equal(slotMeds(m, 'morning', '2026-09-30').find((x) => x.med.id === 'breakfastOnly').dose, '81 mg');
  assert.equal(slotMeds(m, 'morning', '2026-10-01').find((x) => x.med.id === 'breakfastOnly').dose, '162 mg');
  for (const day of DAYS) assert.deepEqual(actual(m, 'evening', day), expected('evening', day), 'nothing else moved');
});

test('a device still on v1.1 sees each split dose in words', () => {
  const old = v11.migrate(clone(medListState(core)));
  const a = old.meds.find((m) => m.id === 'splitA');
  assert.equal(a.dosage, '200 mg breakfast · 600 mg dinner');
  assert.ok(a.morning && a.evening);
  const p = old.meds.find((m) => m.id === 'prn');
  assert.ok(!p.morning && !p.evening, 'v1.1 never shows the PRN med as due');
});

test('meds entered under v2.0 (no per-slot doses) migrate with the same doses', () => {
  // How v2.0 stores the parts of the list it can express.
  const n = names();
  const at = '2026-09-26T16:00:00.000Z';
  const v20Med = (id, name, version, order) => ({ id, name, notes: '', active: true, order, createdAt: at, updatedAt: at,
    schedule: [{ from: '', prn: false, morning: false, evening: false, dose: '', doseByDay: null, updatedAt: at, ...version }] });
  const stored = {
    meds: [
      v20Med('weekday', n.weekday, { evening: true, doseByDay: ['8 mg', '6 mg', '6 mg', '6 mg', '8 mg', '6 mg', '6 mg'] }, 2),
      v20Med('breakfastOnly', n.breakfastOnly, { morning: true, dose: '81 mg' }, 3),
      v20Med('twiceSame', n.twiceSame, { morning: true, evening: true, dose: '300 mg' }, 4),
      v20Med('prn', n.prn, { prn: true, dose: '50 mg' }, 5),
    ],
    logs: {},
  };
  const m = migrate(stored);
  for (const day of DAYS) {
    assert.deepEqual(actual(m, 'morning', day), expected('morning', day).filter(([name]) => name !== n.splitA && name !== n.splitB));
    assert.deepEqual(actual(m, 'evening', day), expected('evening', day).filter(([name]) => name !== n.splitA && name !== n.splitB));
  }
  same(migrate(m), m);
  // And the v2.0 copy of each migrated version is exactly what v2.0 stored, so the two
  // devices agree instead of trading versions back and forth.
  for (const med of m.meds) {
    const orig = stored.meds.find((x) => x.id === med.id).schedule[0];
    const back = v20.migrate({ meds: [med], logs: {} }).meds[0].schedule[0];
    assert.deepEqual(back, v20.migrate({ meds: [{ ...med, schedule: [orig] }], logs: {} }).meds[0].schedule[0]);
  }
});

test('fixture sanity: six meds, names unique', () => {
  const list = medInputs();
  assert.equal(list.length, 6);
  assert.equal(new Set(list.map((m) => m.name)).size, 6);
});
