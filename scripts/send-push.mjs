// Sends the Meds breakfast or dinner push reminder to every subscribed device.
// Run by .github/workflows/push-reminders.yml. Reads:
//   VAPID_PRIVATE_KEY  repo secret, private half of the key pair (public half is in ../config.js)
//   PUSH_SUBSCRIPTION  repo secret, one subscription object or an array of them
//   MORNING_TIME, EVENING_TIME  HH:MM in New York time
//   FORCE_SLOT         morning or evening: send right now (manual test run). Empty on scheduled runs.
import { createRequire } from 'node:module';
import webpush from 'web-push';
import { dueSlot, MESSAGES, parseSubscriptions, TIME_ZONE } from './push-schedule.mjs';

const config = createRequire(import.meta.url)('../config.js');
const env = process.env;

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

const forced = (env.FORCE_SLOT || '').trim();
const now = new Date();
const slot = forced || dueSlot(now, { morning: env.MORNING_TIME || '08:00', evening: env.EVENING_TIME || '18:00' });
const nyTime = now.toLocaleTimeString('en-US', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit' });

if (!slot) {
  console.log(`Nothing to send: it is ${nyTime} in New York, not near a reminder time. (This is normal; each reminder has two cron lines and only one matches.)`);
  process.exit(0);
}
if (!MESSAGES[slot]) fail(`Unknown slot "${slot}". Use morning or evening.`);
if (!env.VAPID_PRIVATE_KEY) fail('The VAPID_PRIVATE_KEY secret is missing. Add it under repo Settings → Secrets and variables → Actions.');

let subs;
try { subs = parseSubscriptions(env.PUSH_SUBSCRIPTION); } catch (e) { fail(e.message); }

webpush.setVapidDetails(config.pushSubject, config.vapidPublicKey, env.VAPID_PRIVATE_KEY);

const payload = JSON.stringify({ slot, ...MESSAGES[slot], url: './#today' });
console.log(`Sending "${MESSAGES[slot].title}" at ${nyTime} New York time${forced ? ' (manual run)' : ''} to ${subs.length} device(s).`);

const problems = [];
for (const [i, sub] of subs.entries()) {
  const label = `Device #${i + 1} (${new URL(sub.endpoint).host})`;
  try {
    // TTL: if the phone is off, keep trying for an hour; after that the reminder is stale.
    const res = await webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high', topic: `meds-${slot}` });
    console.log(`${label}: sent (${res.statusCode}).`);
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) {
      problems.push(`${label}: Subscription expired. Re-enable push in Meds Settings and update the PUSH_SUBSCRIPTION secret.`);
    } else if (e.statusCode === 403 || e.statusCode === 401) {
      problems.push(`${label}: push service refused the key (${e.statusCode}). Check that VAPID_PRIVATE_KEY matches the public key in config.js. ${e.body || ''}`);
    } else {
      problems.push(`${label}: send failed${e.statusCode ? ` (${e.statusCode})` : ''}: ${e.body || e.message}`);
    }
  }
}

// Fail the run loudly so GitHub emails Steve. Never swallow a failed reminder.
if (problems.length) {
  problems.forEach((p) => console.error(`::error::${p}`));
  process.exit(1);
}
