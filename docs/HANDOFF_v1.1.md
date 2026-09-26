# Handoff: Meds v1.1, push reminders and iPhone/Mac sync

**For:** a Claude Code cloud session (Dispatch) on `srichards391/household-inventory`
**From:** the v1.0 build session
**Owner:** Steve Richards. Ask him before anything irreversible or public.

## Context, read first

`Meds` is a no-build PWA (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`) that logs breakfast and dinner medications. v1.0 lives on branch `claude/medication-tracking-app-6j4756` and deploys to GitHub Pages via `.github/workflows/pages.yml`. Data is localStorage only. Read `README.md`, `CHANGELOG.md`, and `app.js` end to end before changing anything. Keep the app plain HTML, CSS and JS with no build step: Steve is learning to code and reads this repo.

v1.0 reminders are a calendar (.ics) export because iPhone web apps cannot schedule their own notifications, and data is per device. v1.1 fixes both: real Web Push notifications sent on a schedule by GitHub Actions, and sync between iPhone and Mac through a private GitHub Gist. No server to run, no cost.

## Goals

1. At breakfast time and dinner time, Steve's iPhone (and Mac, if installed there) gets a push notification from the Meds app. Tapping it opens the app on Today.
2. Log a dose on the phone, see it on the Mac a moment later, and the other way round. Either device is a full copy.

Build sync first (Part A), then push (Part B). Sync touches the data layer and push depends on nothing in it.

## Part A: sync via a private Gist

**Why a Gist.** No backend to host, free, works from a static site, and the app already lives on GitHub. Steve is the only user. Alternatives considered and rejected for v1.1: Firebase or Supabase (auth setup and a third account for a one-person app), CloudKit JS (needs a paid Apple developer account).

**Setup Steve does once.** Create a classic personal access token with only the `gist` scope. Paste it into Meds Settings → Sync on each device, plus a passphrase of his choosing. The app creates the gist on first sync and stores its id alongside the token in localStorage. On the second device, the app finds the gist by its description (`meds-sync`) so nothing else needs pasting.

**Encrypt before upload.** A secret gist is unlisted, not private: anyone with the URL can read it. Medication names are health data, so encrypt the whole blob client side with Web Crypto: PBKDF2 (SHA-256, 200k iterations, random salt) from the passphrase to an AES-GCM key, random IV per write. The gist file holds `{ v: 1, salt, iv, ciphertext }` as base64. Wrong passphrase on a device: show "Couldn't decrypt. Check the passphrase." and do not overwrite the remote.

**Data model changes in `app.js`.** Bump `STORE_KEY` to `meds.v2` and migrate v1 on load.
- Every med gets `updatedAt` (ISO). Deleting a med sets `deleted: true` and `updatedAt` instead of removing it; all views filter deleted meds out. Purge tombstones older than 90 days.
- `logs` stays a map of `dayKey|slot|medId` to an ISO timestamp. Untaking a dose needs to survive sync, so store `{ takenAt, updatedAt }` or a tombstone value such as `null` with an `updatedAt`. Pick one, document it in a comment.
- `settings` gets `updatedAt`.

**Merge rule (deterministic, both directions).** Meds and settings: newest `updatedAt` wins per record. Logs: newest `updatedAt` wins per key. Never drop a record that only one side has. Merge remote into local, then write the merged result to both.

**When to sync.** On app open, on `visibilitychange` to visible, and 2 seconds after any change (debounced). Read, merge, write each time. Show a small status line in Settings: "Synced 8:14 AM", "Syncing", "Offline, will retry", or the error. Never block the UI on the network; logging a dose must feel instant with or without sync. Handle 401 (bad token), 404 (gist gone; recreate), and rate limits (back off, retry on next trigger).

**Settings UI.** New Sync card: token field (password type), passphrase field, "Connect" button, status line, "Disconnect" (forgets token and passphrase on this device only, keeps local data). Keep the JSON Export/Import as a manual fallback.

## Part B: push reminders

### How it works

1. **VAPID keys.** Generate once with the `web-push` npm package. Public key is committed into the app (`config.js` or a constant in `app.js`). Private key goes in a repo secret `VAPID_PRIVATE_KEY`. Never commit the private key.
2. **Subscribe in the app.** Settings gets an "Enable push reminders" button. On tap (must be a user gesture): `Notification.requestPermission()`, then `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`. Show the resulting subscription JSON with a "Copy" button and a one-line instruction: paste it into the repo secret `PUSH_SUBSCRIPTION`. Support more than one device by letting the secret hold a JSON array as well as a single object.
3. **Send on a schedule.** New workflow `.github/workflows/push-reminders.yml` runs `scripts/send-push.mjs` (Node, `web-push` dependency, tiny `package.json`). Crons are UTC, Steve is in Erie, PA (America/New_York, which flips between UTC-4 and UTC-5). Use two cron lines per slot (one per offset) and have the script exit quietly unless the current New York time is within 10 minutes of the target. Targets come from workflow env vars `MORNING_TIME=08:00` and `EVENING_TIME=18:00`. Add a `workflow_dispatch` input `slot` (morning|evening) that forces an immediate send for testing.
4. **Receive.** `sw.js` handles `push` (show notification: title "Morning meds", body "With breakfast. Tap to log.", icon, `data.url`) and `notificationclick` (focus an open window or open `./#today`). Bump `CACHE_VERSION`.
5. **Expiry.** If the push service returns 404 or 410, fail the job with a clear log line: "Subscription expired. Re-enable push in Meds Settings and update the PUSH_SUBSCRIPTION secret." Do not retry silently.

## Constraints and gotchas (both parts)

- iOS needs 16.4 or later and the app must be added to the Home Screen. Permission must be requested from a tap. Say so in the Settings copy.
- GitHub disables scheduled workflows after 60 days with no repo activity. Note this in the README. Do not add a fake-commit heartbeat.
- Push body cannot list the meds (the workflow can't see localStorage). Keep the body generic.
- Reminder times now live in two places (app Settings for "due" status, workflow env for push). Make the Settings screen say the push times are set in the repo, or drop the app-side times entirely if that is simpler. Pick one and be consistent.
- The push cannot be tested from a cloud session. Acceptance is on Steve's phone. Give him the exact steps.
- Keep the calendar (.ics) export. It still works and it is the fallback.
- Sync conflicts are rare with one user but real: he can tap "taken" on the Mac and the phone within seconds. The merge rule above must handle that without duplicating or losing a dose.
- The token and passphrase live in localStorage on each device. Say so plainly in the Settings copy. Do not put either in the gist, the repo, or a URL.
- Test the merge logic with a small Node script (no browser needed): two states diverge, merge both ways, assert the same result. Test the encrypt/decrypt round trip the same way (Node 22 has Web Crypto).

## Deliverables

- Code on the same branch, or a new branch off it if Steve says so. Do not push to any other branch without asking.
- `CHANGELOG.md` gets a `v1.1 (MM/DD/YYYY)` entry. `README.md` Reminders section updated. Bump `APP_VERSION` in `app.js` and `CACHE_VERSION` in `sw.js`.
- A short "do this on your phone and Mac" checklist for Steve in the final message: create the gist token, connect both devices with the same passphrase and confirm a dose logged on one shows on the other; then generate VAPID keys, add the secrets, deploy, enable push in Settings, paste the subscription, run the workflow with `slot=morning`, confirm the notification landed.
- Run the app in headless Chromium (Playwright is preinstalled at `/opt/pw-browsers`) to confirm no console errors before pushing. The v1.0 session did this by serving with `python3 -m http.server 8080`.

## Out of scope

- Multi-user sync or sharing with Sarah. One person, one gist.
- Live sync that pushes changes instantly between devices. Read-on-open plus a debounce is enough.
- Any change to how doses are logged or stored.
- App Store or native anything.
