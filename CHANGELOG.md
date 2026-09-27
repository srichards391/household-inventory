# Meds changelog

Point releases add. Whole numbers change something an old edition would notice.

## v2.0 (09/26/2026)
A whole-number release: the data format changed in ways a v1.1 device would notice. Update both devices.
- **Day-of-week doses.** A med can have a different dose each weekday (e.g. warfarin 8 mg Thu and Sun, 6 mg other days). Today shows the dose for the date you're looking at, tagged with the weekday.
- **Schedule history.** Changing a dose or schedule starts on a chosen day (default today). Earlier days keep the dose that applied then. The edit form lists the history.
- **Doses are recorded when logged.** Each log saves the dose it was taken at, so a later schedule edit never changes what the record says. If the schedule for a logged day has since changed, Today says so.
- **As-needed (PRN) meds.** Log them any time, several times a day, at a chosen time and dose. Never due, never missed, never in a reminder. Shown on Today and in History.
- **Push reminders name the meds and doses** still to take for that slot today, built on the device from its own data when the reminder arrives.
- **Updates can't leave you on old code.** The app checks for a new version on every open and shows an "Update now" banner; files load with version-stamped addresses; the service worker always checks with the server; a half-updated app refuses to show doses. Settings → App → Check for updates.
- Sync merges schedule changes one version at a time, so a dose change on one device and a note edit on the other both survive. A v1.1 device syncing in the meantime can't erase recorded doses or schedules.
- Tests: 59 (`node --test`), including a real v1.1 device (tests/fixtures) syncing with v2.0.

## v1.1 (09/26/2026)
- Sync between iPhone and Mac through a private GitHub Gist, encrypted on the device (PBKDF2 + AES-GCM). Settings → Sync: token, passphrase, Connect, status, Disconnect.
- Newest-change-wins merge per med, per dose, and for settings. Deletes and un-takes are kept as markers so they reach the other device. Tested in Node (`node --test`).
- Today shows when it last synced, and turns orange if this device might be missing doses from the other one.
- Push reminders at breakfast and dinner, sent by GitHub Actions (`push-reminders.yml`) with Web Push. Settings → Reminders → Enable. Tapping the notification opens Today.
- Data format bumped to `meds.v2`. v1.0 data and backups migrate automatically; the old copy is left in place.
- Import merges instead of replacing when sync is on.
- Service worker no longer caches requests to other sites (sync must always be live).
- Pages deploys from this branch as well as `main`.

## v1.0 (09/26/2026)
- First edition. Today screen with breakfast and dinner slots, one-tap "taken" logging, "take all" per slot.
- Medication list with add, edit, reorder, deactivate, delete.
- 30-day history with per-slot dots and a daily score.
- Settings: breakfast and dinner reminder times, calendar reminder export (.ics), JSON backup and restore.
- Installable web app (iPhone home screen, Mac dock) with offline support via service worker.
- Deploys to GitHub Pages from `main` via GitHub Actions.
