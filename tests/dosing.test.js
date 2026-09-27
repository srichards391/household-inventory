// Tests for day-of-week doses, schedule history, as-needed (PRN) meds, and syncing with a
// device still running v1.1. Run from the repo root with:  node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../sync-core.js');
const old = require('./fixtures/sync-core-v1.1.js'); // the exact sync core shipped in v1.1

const { newMed, editSchedule, scheduleOn, doseOn, slotMeds, prnMeds, prnLogs, loggedDose, reminderBody,
  merge, reconcile, migrate, canonical, logKey, prnKey, weekdayOf, doseSummary, nextStamp, encrypt, decrypt } = core;

const same = (a, b) => assert.equal(canonical(a), canonical(b));
const NOW = new Date('2026-09-26T16:00:00.000Z');
const TODAY = '2026-09-26'; // a Saturday

// The week of Sun Sep 27 to Sat Oct 3, 2026.
const WEEK = { Sun: '2026-09-27', Mon: '2026-09-28', Tue: '2026-09-29', Wed: '2026-09-30', Thu: '2026-10-01', Fri: '2026-10-02', Sat: '2026-10-03' };
//                     Sun     Mon     Tue     Wed     Thu     Fri     Sat
const WARFARIN_DAYS = ['8 mg', '6 mg', '6 mg', '6 mg', '8 mg', '6 mg', '6 mg'];

function warfarin(opts = {}) {
  return newMed('warf', { name: 'Warfarin', morning: false, evening: true, doseByDay: WARFARIN_DAYS, ...opts }, 0, TODAY, new Date('2026-09-01T12:00:00Z'));
}
const metoprolol = () => newMed('meto', { name: 'Metoprolol', morning: true, evening: true, dose: '25 mg' }, 1, TODAY, new Date('2026-09-01T12:00:00Z'));
const ibuprofen = () => newMed('ibu', { name: 'Ibuprofen', prn: true, dose: '200 mg', morning: true /* ignored for PRN */ }, 2, TODAY, new Date('2026-09-01T12:00:00Z'));
const state = (meds, logs = {}) => migrate({ meds, logs, settings: {} });
const taken = (iso, dose) => ({ takenAt: iso, updatedAt: iso, ...(dose ? { dose } : {}) });

// ---------- day-of-week doses ----------

test('warfarin: 8 mg on Thursday and Sunday, 6 mg every other day', () => {
  const s = state([warfarin()]);
  const expected = { Sun: '8 mg', Mon: '6 mg', Tue: '6 mg', Wed: '6 mg', Thu: '8 mg', Fri: '6 mg', Sat: '6 mg' };
  for (const [name, day] of Object.entries(WEEK)) {
    const due = slotMeds(s, 'evening', day);
    assert.equal(due.length, 1, name);
    assert.equal(due[0].dose, expected[name], `${name} ${day}`);
    assert.deepEqual(slotMeds(s, 'morning', day), [], 'warfarin is dinner only');
  }
});

test('weekday math agrees with the calendar for every day of 2026 and 2027', () => {
  for (let d = new Date(2026, 0, 1); d < new Date(2028, 0, 1); d.setDate(d.getDate() + 1)) {
    assert.equal(weekdayOf(core.dayKeyOf(d)), d.getDay(), core.dayKeyOf(d));
  }
});

test('dose summary reads the way a person would say it', () => {
  assert.equal(doseSummary(scheduleOn(warfarin(), TODAY)), '8 mg Sun, Thu · 6 mg Mon, Tue, Wed, Fri, Sat');
  assert.equal(doseSummary(scheduleOn(metoprolol(), TODAY)), '25 mg');
});

test('the push reminder carries the right dose for the day it fires, and skips what is already logged', () => {
  const s = state([warfarin(), metoprolol(), ibuprofen()]);
  assert.equal(reminderBody(s, 'evening', WEEK.Thu), 'With dinner: Warfarin 8 mg, Metoprolol 25 mg. Tap to log.');
  assert.equal(reminderBody(s, 'evening', WEEK.Mon), 'With dinner: Warfarin 6 mg, Metoprolol 25 mg. Tap to log.');
  assert.equal(reminderBody(s, 'morning', WEEK.Mon), 'With breakfast: Metoprolol 25 mg. Tap to log.');
  s.logs[logKey(WEEK.Thu, 'evening', 'meto')] = taken('2026-10-01T22:00:00.000Z', '25 mg');
  assert.equal(reminderBody(s, 'evening', WEEK.Thu), 'With dinner: Warfarin 8 mg. Tap to log.');
  s.logs[logKey(WEEK.Thu, 'evening', 'warf')] = taken('2026-10-01T22:01:00.000Z', '8 mg');
  assert.equal(reminderBody(s, 'evening', WEEK.Thu), 'All evening meds already logged.');
  assert.equal(reminderBody(state([ibuprofen()]), 'morning', WEEK.Mon), 'No morning meds scheduled today.');
});

// ---------- schedule history ----------

test('a past day shows the dose that applied then, not today\'s', () => {
  // Warfarin was 5 mg every day until a new day-of-week schedule started Thursday Oct 1.
  let w = newMed('warf', { name: 'Warfarin', evening: true, dose: '5 mg' }, 0, TODAY, new Date('2026-09-01T12:00:00Z'));
  w = editSchedule(w, WEEK.Thu, { evening: true, doseByDay: WARFARIN_DAYS }, WEEK.Thu, new Date('2026-10-01T12:00:00Z'));
  const s = state([w]);
  assert.equal(slotMeds(s, 'evening', WEEK.Sun)[0].dose, '5 mg', 'Sunday before the change keeps 5 mg (not the new Sunday 8 mg)');
  assert.equal(slotMeds(s, 'evening', WEEK.Wed)[0].dose, '5 mg');
  assert.equal(slotMeds(s, 'evening', WEEK.Thu)[0].dose, '8 mg');
  assert.equal(slotMeds(s, 'evening', WEEK.Sat)[0].dose, '6 mg');
  assert.equal(slotMeds(s, 'evening', '2026-10-04')[0].dose, '8 mg', 'next Sunday uses the new schedule');
  assert.equal(slotMeds(s, 'evening', '2026-01-01')[0].dose, '5 mg', 'the first version covers all earlier days');
});

test('a schedule edit never rewrites what a logged dose says was taken', () => {
  let w = warfarin();
  const s = state([w], {
    [logKey(WEEK.Sun, 'evening', 'warf')]: taken('2026-09-27T22:00:00.000Z', '8 mg'),
    [logKey(WEEK.Mon, 'evening', 'warf')]: taken('2026-09-28T22:00:00.000Z', '6 mg'),
  });
  // Even an edit dated back before those logs (to correct a mistake) leaves them alone.
  w = editSchedule(w, '2026-09-01', { evening: true, dose: '7 mg' }, WEEK.Tue, new Date('2026-09-29T12:00:00Z'));
  s.meds = [w];
  assert.equal(loggedDose(s, WEEK.Sun, 'evening', w), '8 mg');
  assert.equal(loggedDose(s, WEEK.Mon, 'evening', w), '6 mg');
  assert.equal(loggedDose(s, WEEK.Tue, 'evening', w), '7 mg', 'an unlogged day shows the schedule');
  // And the logs survive a sync round trip byte for byte.
  const again = merge(s, state([]));
  assert.equal(again.logs[logKey(WEEK.Sun, 'evening', 'warf')].dose, '8 mg');
});

test('a v1.x log with no saved dose shows the schedule for its own day', () => {
  let w = newMed('warf', { name: 'Warfarin', evening: true, dose: '5 mg' }, 0, TODAY, new Date('2026-09-01T12:00:00Z'));
  w = editSchedule(w, WEEK.Thu, { evening: true, doseByDay: WARFARIN_DAYS }, WEEK.Thu, new Date('2026-10-01T12:00:00Z'));
  const s = state([w], { [logKey(WEEK.Sun, 'evening', 'warf')]: '2026-09-27T22:00:00.000Z' }); // v1.0 string log
  assert.equal(loggedDose(s, WEEK.Sun, 'evening', s.meds[0]), '5 mg');
});

test('editing only the name or notes adds no schedule version; saving the same schedule is a no-op', () => {
  const w = warfarin();
  assert.equal(editSchedule(w, TODAY, { evening: true, doseByDay: WARFARIN_DAYS }, TODAY, NOW), w);
  const changed = editSchedule(w, TODAY, { evening: true, doseByDay: ['8 mg', '6 mg', '6 mg', '6 mg', '8 mg', '6 mg', '4 mg'] }, TODAY, NOW);
  assert.equal(changed.schedule.length, 2);
  assert.equal(changed.schedule[1].from, TODAY);
});

test('a future-dated change does not affect today', () => {
  const w = editSchedule(warfarin(), WEEK.Mon, { evening: true, dose: '5 mg' }, TODAY, NOW);
  const s = state([w]);
  assert.equal(slotMeds(s, 'evening', TODAY)[0].dose, '6 mg');
  assert.equal(slotMeds(s, 'evening', WEEK.Sun)[0].dose, '8 mg');
  assert.equal(slotMeds(s, 'evening', WEEK.Mon)[0].dose, '5 mg');
});

// ---------- as-needed (PRN) ----------

test('PRN meds are never due, never in a slot, never in a reminder', () => {
  const s = state([ibuprofen(), metoprolol()]);
  for (const day of Object.values(WEEK)) {
    for (const slot of ['morning', 'evening']) {
      assert.ok(!slotMeds(s, slot, day).some((x) => x.med.id === 'ibu'), `${slot} ${day}`);
      assert.ok(!reminderBody(s, slot, day).includes('Ibuprofen'));
    }
    assert.deepEqual(prnMeds(s, day).map((m) => m.id), ['ibu']);
  }
  assert.equal(s.meds.find((m) => m.id === 'ibu').morning, false, 'PRN ignores meal flags, so v1.1 devices never show it as due either');
});

test('a PRN logged twice in one day on one device, once on the other: all three survive the merge', () => {
  const day = WEEK.Tue;
  const phone = state([ibuprofen()], {
    [prnKey(day, 'ibu', 'p1')]: taken('2026-09-29T13:00:00.000Z', '200 mg'),
    [prnKey(day, 'ibu', 'p2')]: taken('2026-09-29T19:30:00.000Z', '400 mg'),
  });
  const mac = state([ibuprofen()], { [prnKey(day, 'ibu', 'm1')]: taken('2026-09-29T16:00:00.000Z', '200 mg') });
  const ab = merge(phone, mac), ba = merge(mac, phone);
  same(ab, ba);
  assert.deepEqual(prnLogs(ab, day).map((x) => [x.takenAt.slice(11, 16), x.dose]), [['19:30', '400 mg'], ['16:00', '200 mg'], ['13:00', '200 mg']]);
  assert.equal(prnLogs(ab, WEEK.Wed).length, 0);
});

test('PRN doses logged on both devices while they race to write all end up everywhere', () => {
  const gist = { data: null };
  const dev = (s) => ({ state: s, seen: null });
  const read = (d) => { d.seen = gist.data; };
  const write = (d) => { const r = reconcile(d.state, d.seen, NOW); d.state = r.merged; if (r.remoteNeedsWrite) gist.data = JSON.parse(JSON.stringify(r.merged)); return r; };
  const sync = (d) => { read(d); return write(d); };
  const phone = dev(state([ibuprofen()])), mac = dev(state([]));
  sync(phone); sync(mac);
  phone.state.logs[prnKey(TODAY, 'ibu', 'a')] = taken('2026-09-26T13:00:00.000Z', '200 mg');
  phone.state.logs[prnKey(TODAY, 'ibu', 'b')] = taken('2026-09-26T15:00:00.000Z', '200 mg');
  mac.state.logs[prnKey(TODAY, 'ibu', 'c')] = taken('2026-09-26T15:00:05.000Z', '200 mg');
  read(phone); read(mac); write(phone); write(mac); // Mac's write clobbers the phone's
  sync(phone); sync(mac);                           // the follow-up check restores it
  assert.equal(prnLogs(mac.state, TODAY).length, 3);
  same(phone.state, mac.state);
});

test('removing one PRN dose syncs as removal and leaves the other dose alone', () => {
  const k1 = prnKey(TODAY, 'ibu', 'a'), k2 = prnKey(TODAY, 'ibu', 'b');
  const phone = state([ibuprofen()], { [k1]: taken('2026-09-26T13:00:00.000Z', '200 mg'), [k2]: taken('2026-09-26T15:00:00.000Z', '200 mg') });
  const mac = JSON.parse(JSON.stringify(phone));
  mac.logs[k1] = { takenAt: null, updatedAt: nextStamp(mac.logs[k1].updatedAt, new Date('2026-09-26T16:00:00Z')) };
  const m = merge(phone, mac);
  assert.deepEqual(prnLogs(m, TODAY).map((x) => x.key), [k2]);
});

// ---------- merging schedule edits ----------

test('a dose change on one device and a note edit on the other both survive', () => {
  const base = warfarin();
  const mac = { ...editSchedule(base, WEEK.Mon, { evening: true, dose: '5 mg' }, TODAY, new Date('2026-09-26T16:00:00Z')) };
  const phone = { ...base, notes: 'INR check Friday', updatedAt: '2026-09-26T16:05:00.000Z' };
  const m = merge(state([mac]), state([phone]));
  same(m, merge(state([phone]), state([mac])));
  const w = m.meds[0];
  assert.equal(w.notes, 'INR check Friday');
  assert.equal(doseOn(scheduleOn(w, WEEK.Mon), WEEK.Mon), '5 mg', 'the dose change was not lost');
});

test('the same schedule day edited on both devices: newer edit wins, both devices agree', () => {
  const base = warfarin();
  const a = editSchedule(base, WEEK.Mon, { evening: true, dose: '5 mg' }, TODAY, new Date('2026-09-26T16:00:00Z'));
  const b = editSchedule(base, WEEK.Mon, { evening: true, dose: '7 mg' }, TODAY, new Date('2026-09-26T16:00:09Z'));
  const m = merge(state([a]), state([b]));
  same(m, merge(state([b]), state([a])));
  assert.equal(slotMeds(m, 'evening', WEEK.Mon)[0].dose, '7 mg');
});

// ---------- a device still on v1.1 ----------
// `old` is the real v1.1 sync core. These simulate the Mac updated and the phone not yet (or the reverse).

function oldEdit(med, data, at) { // what the v1.1 app's Save button does
  Object.assign(med, data, { updatedAt: old.nextStamp(med.updatedAt, new Date(at)) });
}

test('a v1.1 device syncing new-format data keeps the new fields and cannot erase saved doses', () => {
  const k = logKey(WEEK.Thu, 'evening', 'warf');
  const k2 = prnKey(WEEK.Thu, 'ibu', 'x');
  const updated = state([warfarin(), ibuprofen()], { [k]: taken('2026-10-01T22:00:00.000Z', '8 mg'), [k2]: taken('2026-10-01T14:00:00.000Z', '200 mg') });
  // v1.1 merges the gist into its own data. Its migrate drops the `dose` field from logs.
  let oldState = old.merge(old.emptyState(), JSON.parse(JSON.stringify(updated)));
  assert.equal(oldState.logs[k].dose, undefined, 'v1.1 does strip the dose (this is the hazard)');
  assert.ok(Array.isArray(oldState.meds.find((m) => m.id === 'warf').schedule), 'but keeps med fields it does not understand');
  // The v1.1 device then logs something of its own and writes its whole copy to the gist.
  oldState.logs[logKey(WEEK.Thu, 'morning', 'meto')] = { takenAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z' };
  const gist = JSON.parse(JSON.stringify(oldState));
  // The updated device merges that back: the dose it saved wins over the stripped copy.
  const r = reconcile(updated, gist, NOW);
  assert.equal(r.merged.logs[k].dose, '8 mg');
  assert.equal(r.merged.logs[k2].dose, '200 mg');
  assert.ok(r.merged.logs[logKey(WEEK.Thu, 'morning', 'meto')], 'and keeps the v1.1 device\'s new log');
  assert.equal(r.remoteNeedsWrite, true, 'and puts the doses back on the gist');
  assert.equal(slotMeds(r.merged, 'evening', WEEK.Thu)[0].dose, '8 mg', 'day-of-week schedule intact');
});

test('v1.1 shows a day-of-week med with its full summary and never shows a PRN as due', () => {
  const oldState = old.migrate(JSON.parse(JSON.stringify(state([warfarin(), ibuprofen()]))));
  const w = oldState.meds.find((m) => m.id === 'warf'), i = oldState.meds.find((m) => m.id === 'ibu');
  assert.equal(w.dosage, '8 mg Sun, Thu · 6 mg Mon, Tue, Wed, Fri, Sat');
  assert.equal(w.evening, true);
  assert.equal(i.morning || i.evening, false);
});

test('editing a med\'s name on v1.1 leaves its day-of-week schedule alone', () => {
  const oldState = old.migrate(JSON.parse(JSON.stringify(state([warfarin()]))));
  const w = oldState.meds[0];
  oldEdit(w, { name: 'Warfarin (Coumadin)', dosage: w.dosage, morning: w.morning, evening: w.evening, notes: '', active: true }, '2026-09-29T12:00:00Z');
  const m = migrate(oldState);
  assert.equal(m.meds[0].name, 'Warfarin (Coumadin)');
  assert.equal(m.meds[0].schedule.length, 1);
  assert.equal(slotMeds(m, 'evening', WEEK.Thu)[0].dose, '8 mg');
});

test('changing the dose on v1.1 starts a new version that day; earlier days keep their doses', () => {
  const oldState = old.migrate(JSON.parse(JSON.stringify(state([warfarin()]))));
  const w = oldState.meds[0];
  oldEdit(w, { name: 'Warfarin', dosage: '5 mg', morning: false, evening: true, notes: '', active: true }, '2026-09-29T16:00:00Z'); // Tue, local time
  const m = merge(oldState, state([warfarin()]));
  same(m, merge(state([warfarin()]), oldState));
  assert.equal(slotMeds(m, 'evening', WEEK.Sun)[0].dose, '8 mg', 'Sunday before the v1.1 edit is unchanged');
  assert.equal(slotMeds(m, 'evening', WEEK.Mon)[0].dose, '6 mg');
  assert.equal(slotMeds(m, 'evening', WEEK.Tue)[0].dose, '5 mg');
  assert.equal(slotMeds(m, 'evening', WEEK.Thu)[0].dose, '5 mg');
  // Migrating again (every load) changes nothing more.
  same(migrate(m), m);
});

test('a med created on v1.1 migrates into a one-version schedule', () => {
  const v11 = { id: 'asa', name: 'Aspirin', dosage: '81 mg', morning: true, evening: false, notes: '', active: true, order: 3, createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:00.000Z' };
  const m = migrate({ meds: [v11], logs: {} });
  assert.deepEqual(m.meds[0].schedule.map((v) => [v.from, v.dose, v.morning, v.evening, v.prn]), [['', '81 mg', true, false, false]]);
  assert.equal(slotMeds(m, 'morning', WEEK.Mon)[0].dose, '81 mg');
});

test('encrypted gist: v1.1 and v2.0 can each read what the other wrote', async () => {
  const s = state([warfarin(), ibuprofen()], { [prnKey(TODAY, 'ibu', 'a')]: taken('2026-09-26T13:00:00.000Z', '200 mg') });
  const fromNew = await encrypt(s, 'steady heart 42');
  assert.deepEqual(await old.decrypt(fromNew, 'steady heart 42'), s);
  const fromOld = await old.encrypt(old.migrate({ meds: [{ id: 'asa', name: 'Aspirin', dosage: '81 mg', morning: true }], logs: {} }), 'steady heart 42');
  const back = migrate(await decrypt(fromOld, 'steady heart 42'));
  assert.equal(back.meds[0].schedule[0].dose, '81 mg');
});

// ---------- the pieces that must agree for an update to land cleanly ----------

test('every version marker in the app agrees, so installed copies update as one', () => {
  const fs = require('node:fs');
  const read = (f) => fs.readFileSync(require('node:path').join(__dirname, '..', f), 'utf8');
  const v = core.VERSION;
  assert.match(read('app.js'), new RegExp(`APP_VERSION = '${v.replace('.', '\\.')}'`), 'app.js APP_VERSION');
  assert.match(read('sw.js'), new RegExp(`CACHE_VERSION = 'meds-v${v.replace('.', '\\.')}\\.0'`), 'sw.js CACHE_VERSION');
  assert.equal(JSON.parse(read('version.json')).version, v, 'version.json');
  const html = read('index.html');
  for (const f of ['config.js', 'sync-core.js', 'app.js', 'styles.css']) assert.ok(html.includes(`${f}?v=${v}`), `index.html loads ${f}?v=${v}`);
  const sw = read('sw.js');
  for (const f of ['config.js', 'sync-core.js', 'app.js', 'styles.css']) assert.ok(sw.includes(`./${f}?v=${v}`), `sw.js caches ${f}?v=${v}`);
});
