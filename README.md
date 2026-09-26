# Meds

A small, installable web app for one job: knowing what to take with breakfast and dinner, and whether you already did.

- **Today**: two cards, Morning and Evening. Tap a med to mark it taken (it stamps the time). Tap again to undo. "Take all" logs the whole slot. Use ‹ to fix a day you forgot to log.
- **Meds**: add, edit, reorder, pause, delete. Once a day or twice a day, tied to meals.
- **History**: last 30 days, adherence percent, day streak. Tap a day to open it.
- **Settings**: breakfast and dinner times, calendar reminders, JSON backup and restore.

No accounts, no server, no build step. Data stays in the browser on the device you use it on. Plain HTML, CSS and JavaScript, so it's readable end to end.

## Where it runs

Deploys to GitHub Pages from `main` via `.github/workflows/pages.yml`. After the first merge to `main`, the app lives at:

```
https://srichards391.github.io/household-inventory/
```

If the first deploy fails with a Pages permissions error, turn on Pages once: repo **Settings → Pages → Source: GitHub Actions**, then re-run the workflow.

## Install it

**iPhone (Safari):** open the URL, Share → **Add to Home Screen**. It opens full screen like a native app and works offline.

**Mac (Safari):** open the URL, File → **Add to Dock**. Chrome also works: the install icon in the address bar.

## Reminders

iPhone web apps can't schedule their own notifications, so reminders go through Calendar:

1. Settings → Reminders → **Get file** (do this in Safari, not the home-screen app).
2. Open the downloaded `meds-reminders.ics` and tap **Add All**.

You get two daily events with alerts at your breakfast and dinner times. Each one links back to the app. If you change the times later, delete the two events and get a fresh file.

## Moving data between iPhone and Mac

Data is per device. Settings → Backup → **Export** on one, **Import** on the other. Real sync would need a server and is a possible v2.

## Local development

Any static server works:

```
python3 -m http.server 8080
```

then open `http://localhost:8080/`. When you change files, bump `CACHE_VERSION` in `sw.js` so installed copies refresh.

## Versioning

See `CHANGELOG.md`. Point releases add, whole numbers change something an old edition would notice.
