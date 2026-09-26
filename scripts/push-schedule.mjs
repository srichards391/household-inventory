// Decides whether a scheduled run should send a reminder, and which one.
// Kept separate from send-push.mjs so it can be tested without any packages (tests/push-schedule.test.mjs).
//
// GitHub cron runs in UTC, and New York moves between UTC-4 (summer) and UTC-5 (winter).
// The workflow fires twice per slot, one hour apart, and exactly one of those lands near
// the target in New York time. This file tells them apart.
//
// Window: from 10 minutes before the target to 45 minutes after it. The late side is wide
// on purpose: GitHub often starts scheduled runs 10 to 30 minutes late, and a late reminder
// is better than none. It stays under 55 minutes so the other cron line of the pair
// (which fires an hour later) can never also send.

export const TIME_ZONE = 'America/New_York';
export const WINDOW_BEFORE_MIN = 10;
export const WINDOW_AFTER_MIN = 45;

// Minutes since midnight in the given time zone.
export function localMinutes(date, timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get('hour') * 60 + get('minute');
}

export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`Bad time "${s}". Use HH:MM, like 08:00.`);
  return Number(m[1]) * 60 + Number(m[2]);
}

// How many minutes "now" is after the target (negative = before), wrapped to -720..720.
export function minutesFromTarget(date, hhmm, timeZone = TIME_ZONE) {
  let d = localMinutes(date, timeZone) - parseHHMM(hhmm);
  if (d > 720) d -= 1440;
  if (d < -720) d += 1440;
  return d;
}

// Returns 'morning', 'evening', or null.
export function dueSlot(date, times, timeZone = TIME_ZONE) {
  for (const slot of ['morning', 'evening']) {
    const d = minutesFromTarget(date, times[slot], timeZone);
    if (d >= -WINDOW_BEFORE_MIN && d <= WINDOW_AFTER_MIN) return slot;
  }
  return null;
}

export const MESSAGES = {
  morning: { title: 'Morning meds', body: 'With breakfast. Tap to log.' },
  evening: { title: 'Evening meds', body: 'With dinner. Tap to log.' },
};

// PUSH_SUBSCRIPTION may hold one subscription object or a JSON array of them (one per device).
export function parseSubscriptions(text) {
  if (!text || !text.trim()) throw new Error('The PUSH_SUBSCRIPTION secret is empty. Enable push in Meds Settings and paste what it shows into that secret.');
  let v;
  try { v = JSON.parse(text); } catch { throw new Error('The PUSH_SUBSCRIPTION secret is not valid JSON. Copy it again from Meds Settings.'); }
  const list = Array.isArray(v) ? v : [v];
  list.forEach((s, i) => {
    if (!s || typeof s.endpoint !== 'string' || !s.keys || !s.keys.p256dh || !s.keys.auth) {
      throw new Error(`Subscription #${i + 1} in PUSH_SUBSCRIPTION is missing endpoint or keys. Copy it again from Meds Settings.`);
    }
  });
  return list;
}
