# Handoff: Meds v1.1, real push reminders

**For:** a Claude Code cloud session (Dispatch) on `srichards391/household-inventory`
**From:** the v1.0 build session
**Owner:** Steve Richards. Ask him before anything irreversible or public.

## Context, read first

`Meds` is a no-build PWA (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`) that logs breakfast and dinner medications. v1.0 lives on branch `claude/medication-tracking-app-6j4756` and deploys to GitHub Pages via `.github/workflows/pages.yml`. Data is localStorage only. Read `README.md`, `CHANGELOG.md`, and `app.js` end to end before changing anything. Keep the app plain HTML, CSS and JS with no build step: Steve is learning to code and reads this repo.

v1.0 reminders are a calendar (.ics) export because iPhone web apps cannot schedule their own notifications. v1.1 replaces that limitation with real Web Push notifications sent on a schedule by GitHub Actions. No server to run, no cost.

## Goal

At breakfast time and dinner time, Steve's iPhone (and Mac, if installed there) gets a push notification from the Meds app. Tapping it opens the app on Today.

## How it works

1. **VAPID keys.** Generate once with the `web-push` npm package. Public key is committed into the app (`config.js` or a constant in `app.js`). Private key goes in a repo secret `VAPID_PRIVATE_KEY`. Never commit the private key.
2. **Subscribe in the app.** Settings gets an "Enable push reminders" button. On tap (must be a user gesture): `Notification.requestPermission()`, then `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`. Show the resulting subscription JSON with a "Copy" button and a one-line instruction: paste it into the repo secret `PUSH_SUBSCRIPTION`. Support more than one device by letting the secret hold a JSON array as well as a single object.
3. **Send on a schedule.** New workflow `.github/workflows/push-reminders.yml` runs `scripts/send-push.mjs` (Node, `web-push` dependency, tiny `package.json`). Crons are UTC, Steve is in Erie, PA (America/New_York, which flips between UTC-4 and UTC-5). Use two cron lines per slot (one per offset) and have the script exit quietly unless the current New York time is within 10 minutes of the target. Targets come from workflow env vars `MORNING_TIME=08:00` and `EVENING_TIME=18:00`. Add a `workflow_dispatch` input `slot` (morning|evening) that forces an immediate send for testing.
4. **Receive.** `sw.js` handles `push` (show notification: title "Morning meds", body "With breakfast. Tap to log.", icon, `data.url`) and `notificationclick` (focus an open window or open `./#today`). Bump `CACHE_VERSION`.
5. **Expiry.** If the push service returns 404 or 410, fail the job with a clear log line: "Subscription expired. Re-enable push in Meds Settings and update the PUSH_SUBSCRIPTION secret." Do not retry silently.

## Constraints and gotchas

- iOS needs 16.4 or later and the app must be added to the Home Screen. Permission must be requested from a tap. Say so in the Settings copy.
- GitHub disables scheduled workflows after 60 days with no repo activity. Note this in the README. Do not add a fake-commit heartbeat.
- Push body cannot list the meds (the workflow can't see localStorage). Keep the body generic.
- Reminder times now live in two places (app Settings for "due" status, workflow env for push). Make the Settings screen say the push times are set in the repo, or drop the app-side times entirely if that is simpler. Pick one and be consistent.
- The push cannot be tested from a cloud session. Acceptance is on Steve's phone. Give him the exact steps.
- Keep the calendar (.ics) export. It still works and it is the fallback.

## Deliverables

- Code on the same branch, or a new branch off it if Steve says so. Do not push to any other branch without asking.
- `CHANGELOG.md` gets a `v1.1 (MM/DD/YYYY)` entry. `README.md` Reminders section updated. Bump `APP_VERSION` in `app.js` and `CACHE_VERSION` in `sw.js`.
- A short "do this on your phone" checklist for Steve in the final message: generate keys, add two secrets, deploy, enable push in Settings, paste subscription, run the workflow with `slot=morning`, confirm the notification landed.
- Run the app in headless Chromium (Playwright is preinstalled at `/opt/pw-browsers`) to confirm no console errors before pushing. The v1.0 session did this by serving with `python3 -m http.server 8080`.

## Out of scope

- iPhone-to-Mac sync (v1.2, needs a backend; propose options, do not build).
- Any change to how doses are logged or stored.
- App Store or native anything.
