// Tests for sync-core.js. Run from the repo root with:  node --test tests/
// No browser and no packages needed (Node 20+ has Web Crypto built in).
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../sync-core.js');

const { merge, reconcile, canonical, migrate, purge, nextStamp, encrypt, decrypt, DecryptError, emptyState } = core;

const NOW = new Date('2026-09-26T12:00:00.000Z');
const at = (hhmmss) => `2026-09-26T${hhmmss}.000Z`;
const K = '2026-09-26|morning|warf';

function med(id, fields = {}) {
  return { id, name: id, dosage: '5 mg', morning: true, evening: false, notes: '', active: true, order: 0,
    createdAt: at('07:00:00'), updatedAt: at('07:00:00'), ...fields };
}
function state(meds = [], logs = {}, settings = {}) {
  return { meds, logs, settings: { breakfast: '08:00', dinner: '18:00', updatedAt: core.EPOCH, ...settings } };
}
const takenCount = (s) => Object.values(s.logs).filter((l) => l.takenAt).length;
const same = (a, b) => assert.equal(canonical(a), canonical(b));

// ---------- merge rule ----------

test('two diverged states merge to the same result in both directions', () => {
  const phone = state(
    [med('warf', { updatedAt: at('07:10:00'), dosage: '5 mg' }), med('metoprolol')],
    { [K]: { takenAt: at('08:01:00'), updatedAt: at('08:01:00') } },
    { breakfast: '07:30', updatedAt: at('06:00:00') });
  const mac = state(
    [med('warf', { updatedAt: at('07:20:00'), dosage: '7.5 mg' }), med('asa')],
    { '2026-09-26|evening|asa': { takenAt: at('18:02:00'), updatedAt: at('18:02:00') } },
    { dinner: '19:00', updatedAt: at('06:30:00') });

  const ab = merge(phone, mac), ba = merge(mac, phone);
  same(ab, ba);
  assert.equal(ab.meds.length, 3, 'meds only one side has are kept');
  assert.equal(ab.meds.find((m) => m.id === 'warf').dosage, '7.5 mg', 'newer med edit wins');
  assert.equal(Object.keys(ab.logs).length, 2, 'logs only one side has are kept');
  assert.equal(ab.settings.dinner, '19:00', 'newer settings win as a whole');
});

test('same dose tapped on Mac and phone seconds apart: one dose, never two', () => {
  const phone = state([med('warf')], { [K]: { takenAt: at('08:00:01'), updatedAt: at('08:00:01') } });
  const mac = state([med('warf')], { [K]: { takenAt: at('08:00:04'), updatedAt: at('08:00:04') } });
  const m = merge(phone, mac);
  same(m, merge(mac, phone));
  assert.equal(takenCount(m), 1);
  assert.equal(m.logs[K].takenAt, at('08:00:04'));
});

test('un-taking a dose survives sync when it is the newer action', () => {
  const phone = state([med('warf')], { [K]: { takenAt: at('08:00:00'), updatedAt: at('08:00:00') } });
  const mac = state([med('warf')], { [K]: { takenAt: null, updatedAt: at('08:05:00') } });
  assert.equal(merge(phone, mac).logs[K].takenAt, null);
  assert.equal(merge(mac, phone).logs[K].takenAt, null);
});

test('an older un-take does not erase a newer "taken"', () => {
  const phone = state([med('warf')], { [K]: { takenAt: null, updatedAt: at('08:00:00') } });
  const mac = state([med('warf')], { [K]: { takenAt: at('08:05:00'), updatedAt: at('08:05:00') } });
  assert.equal(merge(phone, mac).logs[K].takenAt, at('08:05:00'));
  assert.equal(merge(mac, phone).logs[K].takenAt, at('08:05:00'));
});

test('a deleted med stays deleted unless edited again later', () => {
  const tomb = { id: 'asa', deleted: true, order: 1, updatedAt: at('09:00:00') };
  const olderEdit = med('asa', { dosage: '81 mg', updatedAt: at('08:00:00') });
  const newerEdit = med('asa', { dosage: '81 mg', updatedAt: at('10:00:00') });
  assert.equal(merge(state([tomb]), state([olderEdit])).meds[0].deleted, true);
  assert.equal(merge(state([olderEdit]), state([tomb])).meds[0].deleted, true);
  assert.equal(merge(state([tomb]), state([newerEdit])).meds[0].deleted, undefined);
});

test('equal timestamps with different content pick the same winner on both devices', () => {
  const a = state([med('warf', { dosage: '5 mg' })]);
  const b = state([med('warf', { dosage: '7.5 mg' })]);
  same(merge(a, b), merge(b, a));
  const la = state([], { [K]: { takenAt: at('08:00:00'), updatedAt: at('08:00:00') } });
  const lb = state([], { [K]: { takenAt: null, updatedAt: at('08:00:00') } });
  same(merge(la, lb), merge(lb, la));
});

test('merge is idempotent and order does not matter across three copies', () => {
  const a = state([med('a', { updatedAt: at('07:01:00') })], { x: { takenAt: at('08:00:00'), updatedAt: at('08:00:00') } });
  const b = state([med('a', { updatedAt: at('07:02:00'), name: 'A2' })], { x: { takenAt: null, updatedAt: at('08:01:00') } });
  const c = state([med('c')], { y: { takenAt: at('09:00:00'), updatedAt: at('09:00:00') } }, { dinner: '17:00', updatedAt: at('05:00:00') });
  same(merge(a, a), migrate(a));
  same(merge(merge(a, b), c), merge(a, merge(b, c)));
  same(merge(merge(a, b), c), merge(c, merge(b, a)));
});

// ---------- migration from v1 ----------

test('v1 data migrates, and two devices migrating the same v1 list agree', () => {
  const v1 = {
    meds: [{ id: 'warf', name: 'Warfarin', dosage: '5 mg', morning: false, evening: true, notes: '', active: true, order: 0, createdAt: at('07:00:00') }],
    logs: { '2026-09-25|evening|warf': at('18:03:00') },
    settings: { breakfast: '08:00', dinner: '18:00' },
  };
  const m = migrate(v1);
  assert.equal(m.meds[0].updatedAt, at('07:00:00'));
  assert.deepEqual(m.logs['2026-09-25|evening|warf'], { takenAt: at('18:03:00'), updatedAt: at('18:03:00') });
  assert.equal(m.settings.updatedAt, core.EPOCH);
  same(migrate(JSON.parse(JSON.stringify(v1))), m);
  // Merging a migrated v1 copy with an untouched v1 copy changes nothing.
  same(merge(m, v1), m);
});

test('migrate never throws on junk', () => {
  for (const junk of [null, 42, 'x', {}, { meds: 'no', logs: 3 }, { meds: [null, { id: 5 }], logs: { a: null } }]) {
    const m = migrate(junk);
    assert.ok(Array.isArray(m.meds) && typeof m.logs === 'object');
  }
});

// ---------- local edit timestamps ----------

test('a local edit always beats the version it replaced, even with a slow clock', () => {
  const fromOtherDevice = '2026-09-26T08:00:10.000Z';
  const slowClock = new Date('2026-09-26T08:00:05.000Z');
  const stamp = nextStamp(fromOtherDevice, slowClock);
  assert.ok(Date.parse(stamp) > Date.parse(fromOtherDevice));
  assert.equal(nextStamp(undefined, slowClock), slowClock.toISOString());
});

// ---------- tombstone purge ----------

test('purge drops only old tombstones and never a taken dose', () => {
  const old = '2026-06-01T00:00:00.000Z', recent = '2026-09-20T00:00:00.000Z';
  const s = state(
    [{ id: 'gone', deleted: true, order: 0, updatedAt: old }, { id: 'new-gone', deleted: true, order: 1, updatedAt: recent }, med('keep', { updatedAt: old })],
    {
      oldTaken: { takenAt: old, updatedAt: old },
      oldUntaken: { takenAt: null, updatedAt: old },
      newUntaken: { takenAt: null, updatedAt: recent },
    });
  const p = purge(s, NOW);
  assert.deepEqual(p.meds.map((m) => m.id).sort(), ['keep', 'new-gone']);
  assert.deepEqual(Object.keys(p.logs).sort(), ['newUntaken', 'oldTaken']);
});

// ---------- the sync protocol, simulated ----------
// A fake gist plus two devices running the same read -> merge -> write steps as app.js.

function device(initial) {
  return {
    state: migrate(initial),
    read(gist) { this.seen = gist.data; },
    write(gist) {
      const r = reconcile(this.state, this.seen, NOW);
      this.state = r.merged;
      if (r.remoteNeedsWrite) gist.data = JSON.parse(JSON.stringify(r.merged));
      return r;
    },
    sync(gist) { this.read(gist); return this.write(gist); },
    take(key, iso) { this.state.logs[key] = { takenAt: iso, updatedAt: nextStamp(this.state.logs[key]?.updatedAt, new Date(iso)) }; },
    untake(key, iso) { this.state.logs[key] = { takenAt: null, updatedAt: nextStamp(this.state.logs[key]?.updatedAt, new Date(iso)) }; },
  };
}

test('first device creates the gist; second device merges into it without dropping anything', () => {
  const gist = { data: null };
  const phone = device(state([med('warf')], { [K]: { takenAt: at('08:00:00'), updatedAt: at('08:00:00') } }));
  const mac = device(state([med('asa')]));
  assert.equal(phone.sync(gist).remoteNeedsWrite, true);
  mac.sync(gist);
  phone.sync(gist);
  same(phone.state, mac.state);
  same(gist.data, mac.state);
  assert.equal(mac.state.meds.length, 2);
  assert.equal(takenCount(mac.state), 1);
});

test('both devices write at the same moment: the clobbered dose comes back on the next sync', () => {
  const gist = { data: null };
  const phone = device(state([med('warf'), med('asa')]));
  const mac = device(state());
  phone.sync(gist); mac.sync(gist); phone.sync(gist);

  const K2 = '2026-09-26|morning|asa';
  phone.take(K, at('08:00:00'));
  mac.take(K2, at('08:00:02'));
  // Race: both read the same gist, then both write. The Mac's write replaces the phone's.
  phone.read(gist); mac.read(gist);
  phone.write(gist); mac.write(gist);
  assert.equal(gist.data.logs[K], undefined, 'the race really did clobber the phone dose on the gist');
  assert.equal(phone.state.logs[K].takenAt, at('08:00:00'), 'but the phone still has it locally');

  // The phone's follow-up check (app.js runs one ~10 s after every write) puts it back.
  assert.equal(phone.sync(gist).remoteNeedsWrite, true);
  mac.sync(gist);
  same(phone.state, mac.state);
  assert.equal(takenCount(mac.state), 2);
  // And from here it is quiet: nobody needs to write again.
  assert.equal(phone.sync(gist).remoteNeedsWrite, false);
  assert.equal(mac.sync(gist).remoteNeedsWrite, false);
});

test('tap on phone, undo on Mac a minute later: undo wins everywhere', () => {
  const gist = { data: null };
  const phone = device(state([med('warf')]));
  const mac = device(state());
  phone.sync(gist); mac.sync(gist);
  phone.take(K, at('08:00:00')); phone.sync(gist);
  mac.sync(gist);
  mac.untake(K, at('08:01:00')); mac.sync(gist);
  phone.sync(gist);
  assert.equal(phone.state.logs[K].takenAt, null);
  same(phone.state, mac.state);
});

test('reconcile reports no work when nothing changed', () => {
  const s = state([med('warf')]);
  const r = reconcile(s, JSON.parse(JSON.stringify(s)), NOW);
  assert.equal(r.localChanged, false);
  assert.equal(r.remoteNeedsWrite, false);
  assert.equal(reconcile(emptyState(), null, NOW).remoteNeedsWrite, true, 'no gist yet: create it');
});

// ---------- encryption ----------

test('encrypt/decrypt round trip, fresh salt and IV each time, nothing readable in the blob', async () => {
  const data = state([med('warf', { name: 'Warfarin' })], { [K]: { takenAt: at('08:00:00'), updatedAt: at('08:00:00') } });
  const a = await encrypt(data, 'correct horse battery');
  const b = await encrypt(data, 'correct horse battery');
  assert.deepEqual(Object.keys(a).sort(), ['ciphertext', 'iv', 'salt', 'v']);
  assert.equal(a.v, 1);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.ok(!JSON.stringify(a).includes('Warfarin'));
  assert.deepEqual(await decrypt(a, 'correct horse battery'), data);
  assert.deepEqual(await decrypt(JSON.parse(JSON.stringify(b)), 'correct horse battery'), data);
});

test('wrong passphrase or tampered file fails loudly with the Settings message', async () => {
  const blob = await encrypt(state([med('warf')]), 'right one');
  await assert.rejects(decrypt(blob, 'wrong one'), (e) => e instanceof DecryptError && e.message === "Couldn't decrypt. Check the passphrase.");
  const bytes = Buffer.from(blob.ciphertext, 'base64'); bytes[3] ^= 1;
  await assert.rejects(decrypt({ ...blob, ciphertext: bytes.toString('base64') }, 'right one'), DecryptError);
  await assert.rejects(decrypt({ v: 2 }, 'right one'), DecryptError);
});
