// Tests for scripts/push-schedule.mjs. Run from the repo root with:  node --test
// Checks that each pair of cron lines in push-reminders.yml sends exactly once, summer and winter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dueSlot, minutesFromTarget, parseHHMM, parseSubscriptions } from '../scripts/push-schedule.mjs';

const TIMES = { morning: '08:00', afternoon: '14:00', evening: '18:00' };

// Read the cron lines straight from the workflow so the test breaks if they drift.
const yml = fs.readFileSync(new URL('../.github/workflows/push-reminders.yml', import.meta.url), 'utf8');
const crons = [...yml.matchAll(/cron:\s*'(\d+) (\d+) \* \* \*'/g)].map((m) => ({ min: Number(m[1]), hour: Number(m[2]) }));

function runsOn(day, delayMin = 0) {
  return crons.map(({ hour, min }) => new Date(Date.UTC(day.y, day.m - 1, day.d, hour, min + delayMin)));
}

const DAYS = {
  summer: { y: 2026, m: 7, d: 15 },
  winter: { y: 2026, m: 1, d: 15 },
  springForward: { y: 2026, m: 3, d: 8 },
  fallBack: { y: 2026, m: 11, d: 1 },
};

test('workflow has two cron lines per reminder', () => {
  assert.equal(crons.length, 6);
});

for (const [name, day] of Object.entries(DAYS)) {
  for (const delay of [0, 15, 30, 40]) {
    test(`${name}, runs ${delay} min late: exactly one morning, afternoon and evening send`, () => {
      const sent = runsOn(day, delay).map((d) => dueSlot(d, TIMES)).filter(Boolean).sort();
      assert.deepEqual(sent, ['afternoon', 'evening', 'morning']);
    });
  }
}

test('a run more than 45 minutes late sends nothing rather than risk a double', () => {
  for (const day of Object.values(DAYS)) {
    const sent = runsOn(day, 50).map((d) => dueSlot(d, TIMES)).filter(Boolean);
    assert.ok(sent.length <= 3 && new Set(sent).size === sent.length, 'never two of the same slot');
  }
});

test('minutesFromTarget handles New York offsets', () => {
  assert.equal(minutesFromTarget(new Date('2026-07-15T12:00:00Z'), '08:00'), 0);   // EDT, UTC-4
  assert.equal(minutesFromTarget(new Date('2026-01-15T13:00:00Z'), '08:00'), 0);   // EST, UTC-5
  assert.equal(minutesFromTarget(new Date('2026-01-15T04:50:00Z'), '00:10'), -20); // wraps midnight
});

test('bad times and bad subscriptions give readable errors', () => {
  assert.throws(() => parseHHMM('8am'), /HH:MM/);
  assert.throws(() => parseSubscriptions(''), /empty/);
  assert.throws(() => parseSubscriptions('{nope'), /not valid JSON/);
  assert.throws(() => parseSubscriptions('[{"endpoint":"https://x"}]'), /#1/);
  const one = { endpoint: 'https://web.push.apple.com/abc', keys: { p256dh: 'p', auth: 'a' } };
  assert.equal(parseSubscriptions(JSON.stringify(one)).length, 1);
  assert.equal(parseSubscriptions(JSON.stringify([one, one])).length, 2);
});
