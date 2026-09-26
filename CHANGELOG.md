# Meds changelog

Point releases add. Whole numbers change something an old edition would notice.

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
