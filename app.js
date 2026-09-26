/* Meds v1.1
 * A single-file, no-build web app. Data lives in localStorage on this device and, if sync is
 * turned on, in an encrypted private GitHub Gist shared by your devices.
 * Sections: storage, date helpers, rendering per tab, medication form, sync, push,
 * calendar export, backup.
 * The data format and merge rule are documented at the top of sync-core.js.
 */
(() => {
  'use strict';

  const APP_VERSION = '1.1';
  const STORE_KEY = 'meds.v2';
  const OLD_STORE_KEY = 'meds.v1'; // left in place after migrating, as a just-in-case copy
  const SYNC_KEY = 'meds.sync';    // token, passphrase, gist id. This device only: never synced or exported.
  const Core = window.MedsSyncCore;
  const SLOTS = [
    { id: 'morning', title: 'Morning', meal: 'with breakfast', icon: '☀️', settingKey: 'breakfast', defaultTime: '08:00' },
    { id: 'evening', title: 'Evening', meal: 'with dinner', icon: '🌙', settingKey: 'dinner', defaultTime: '18:00' },
  ];

  // ---------- storage ----------
  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) return Core.purge(Core.migrate(JSON.parse(raw)));
      const old = localStorage.getItem(OLD_STORE_KEY);
      if (old) {
        const migrated = Core.migrate(JSON.parse(old));
        localStorage.setItem(STORE_KEY, JSON.stringify(migrated));
        return migrated;
      }
    } catch (e) {
      console.warn('Could not read saved data, starting fresh', e);
    }
    return Core.emptyState();
  }

  // Save on this device only. Used by sync itself.
  function saveLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save. Storage may be full or blocked.');
    }
  }

  // Save after a change you made, then sync it a couple of seconds later.
  function save() {
    saveLocal();
    scheduleSync();
  }

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const stamp = (prev) => Core.nextStamp(prev);

  // ---------- date helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromDayKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const sameDay = (a, b) => dayKey(a) === dayKey(b);
  const todayKey = () => dayKey(new Date());

  function friendlyDay(d) {
    const now = new Date();
    if (sameDay(d, now)) return 'Today';
    if (sameDay(d, addDays(now, -1))) return 'Yesterday';
    if (sameDay(d, addDays(now, 1))) return 'Tomorrow';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }
  const longDate = (d) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const shortTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  function slotTime(slot, day) {
    const [h, m] = (state.settings[slot.settingKey] || slot.defaultTime).split(':').map(Number);
    const d = new Date(day); d.setHours(h, m, 0, 0); return d;
  }

  // ---------- derived data ----------
  const byOrder = (a, b) => (a.order - b.order) || (a.id < b.id ? -1 : 1);
  const liveMeds = () => state.meds.filter((m) => !m.deleted).sort(byOrder); // everything except deleted
  const activeMeds = () => liveMeds().filter((m) => m.active);
  const medsFor = (slot) => activeMeds().filter((m) => m[slot.id]);
  const logKey = (key, slotId, medId) => `${key}|${slotId}|${medId}`;
  const takenAt = (key, slotId, medId) => (state.logs[logKey(key, slotId, medId)] || {}).takenAt || null;
  const isTaken = (key, slotId, medId) => Boolean(takenAt(key, slotId, medId));

  function slotStatus(key, slot) {
    const meds = medsFor(slot);
    const taken = meds.filter((m) => isTaken(key, slot.id, m.id)).length;
    return { total: meds.length, taken };
  }

  // Un-taking writes { takenAt: null } rather than deleting, so the undo reaches your other device.
  function setTaken(key, slotId, medId, taken, when) {
    const k = logKey(key, slotId, medId);
    const prev = state.logs[k];
    if (!taken && !(prev && prev.takenAt)) return;
    state.logs[k] = { takenAt: taken ? (when || new Date()).toISOString() : null, updatedAt: stamp(prev && prev.updatedAt) };
    save();
  }

  // When logging for a past day, stamp it at that day's slot time rather than "now".
  function stampFor(key, slot) {
    if (key === todayKey()) return new Date();
    return slotTime(slot, fromDayKey(key));
  }

  // ---------- routing ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const screen = $('#screen');
  const titleEl = $('#screen-title');
  const actionsEl = $('#topbar-actions');

  let viewDay = new Date();
  let pinnedToToday = true; // true while the user is looking at "today"; lets the view roll over at midnight

  function currentTab() {
    const h = (location.hash || '#today').replace('#', '');
    return ['today', 'meds', 'history', 'settings'].includes(h) ? h : 'today';
  }

  // keepScroll: for background refreshes (sync, the minute timer) so the page doesn't jump.
  function render(opts) {
    const keepScroll = opts && opts.keepScroll;
    const y = window.scrollY;
    const tab = currentTab();
    document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    actionsEl.innerHTML = '';
    ({ today: renderToday, meds: renderMeds, history: renderHistory, settings: renderSettings })[tab]();
    window.scrollTo(0, keepScroll ? y : 0);
  }

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- Today ----------
  function renderToday() {
    titleEl.textContent = 'Today';
    const key = dayKey(viewDay);
    const isToday = key === todayKey();
    pinnedToToday = isToday;
    screen.innerHTML = '';

    const nav = el(`
      <div class="day-nav">
        <button class="btn icon" id="day-prev" aria-label="Previous day">‹</button>
        <div class="label" style="text-align:center">${esc(friendlyDay(viewDay))}<small>${esc(longDate(viewDay))}</small></div>
        <button class="btn icon" id="day-next" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
      </div>`);
    screen.appendChild(nav);
    $('#day-prev', nav).onclick = () => { viewDay = addDays(viewDay, -1); render(); };
    $('#day-next', nav).onclick = () => { if (!isToday) { viewDay = addDays(viewDay, 1); render(); } };
    if (syncCfg) screen.appendChild(el(`<div class="sync-line" id="today-sync"></div>`));
    if (!isToday) {
      const back = el(`<button class="btn subtle block" style="margin:-6px 0 12px">Jump to today</button>`);
      back.onclick = () => { viewDay = new Date(); render(); };
      screen.appendChild(back);
    }
    updateSyncUI();

    if (activeMeds().length === 0) {
      screen.appendChild(el(`
        <div class="card"><div class="empty">
          <strong>No medications yet</strong>
          Add your meds under the Meds tab and they will show up here, sorted into breakfast and dinner.
        </div></div>`));
      const go = el(`<button class="btn primary block">Add a medication</button>`);
      go.onclick = () => { location.hash = '#meds'; setTimeout(openMedForm, 50); };
      screen.appendChild(go);
      return;
    }

    for (const slot of SLOTS) {
      const meds = medsFor(slot);
      if (meds.length === 0) continue;
      const { total, taken } = slotStatus(key, slot);
      const now = new Date();
      const overdue = isToday && taken < total && now > slotTime(slot, now);
      const countClass = taken === total ? 'done' : (overdue ? 'overdue' : '');
      const countText = taken === total ? 'All taken ✓' : (overdue ? `${taken} of ${total} · due` : `${taken} of ${total}`);

      const card = el(`
        <section class="card">
          <div class="card-head">
            <h2>${slot.icon} ${slot.title} <span class="sub">${slot.meal}</span></h2>
            <span class="count ${countClass}">${countText}</span>
          </div>
        </section>`);

      for (const m of meds) {
        const shownTakenAt = takenAt(key, slot.id, m.id);
        const row = el(`
          <button class="dose-row ${shownTakenAt ? 'taken' : ''}" aria-pressed="${shownTakenAt ? 'true' : 'false'}">
            <span class="box">✓</span>
            <span class="body">
              <div class="name">${esc(m.name)}</div>
              <div class="meta">${esc(m.dosage || '')}</div>
            </span>
            ${shownTakenAt ? `<span class="when">${esc(shortTime(shownTakenAt))}</span>` : ''}
          </button>`);
        row.onclick = () => {
          // Act on what the screen showed, not on data a background sync may have changed since.
          // That way a tap always does what you meant: mark taken if it looked untaken, and the reverse.
          const nowTaken = !shownTakenAt;
          setTaken(key, slot.id, m.id, nowTaken, stampFor(key, slot));
          if (nowTaken && navigator.vibrate) navigator.vibrate(10);
          render({ keepScroll: true });
        };
        card.appendChild(row);
      }

      if (taken < total) {
        const foot = el(`<div class="card-foot"><button class="btn primary">Take all ${slot.title.toLowerCase()} meds</button></div>`);
        foot.firstElementChild.onclick = () => {
          const when = stampFor(key, slot);
          meds.forEach((m) => { if (!isTaken(key, slot.id, m.id)) setTaken(key, slot.id, m.id, true, when); });
          toast(`${slot.title} meds logged`);
          render({ keepScroll: true });
        };
        card.appendChild(foot);
      }
      screen.appendChild(card);
    }

    screen.appendChild(el(`<div class="note">Tap a med to mark it taken. Tap again to undo. Use ‹ to log a day you forgot to record.</div>`));
  }

  // ---------- Meds ----------
  function renderMeds() {
    titleEl.textContent = 'Meds';
    const add = el(`<button class="btn primary">+ Add</button>`);
    add.onclick = () => openMedForm();
    actionsEl.appendChild(add);
    screen.innerHTML = '';

    const meds = liveMeds();
    if (meds.length === 0) {
      screen.appendChild(el(`<div class="card"><div class="empty"><strong>Nothing here yet</strong>Tap + Add to enter your first medication.</div></div>`));
      return;
    }

    const card = el(`<div class="card"></div>`);
    meds.forEach((m, i) => {
      const when = [m.morning ? 'Breakfast' : null, m.evening ? 'Dinner' : null].filter(Boolean).join(' + ') || 'No schedule';
      const row = el(`
        <div class="list-row ${m.active ? '' : 'inactive'}">
          <div class="body">
            <div class="name">${esc(m.name)} ${m.active ? '' : '<span class="pill off">Paused</span>'}</div>
            <div class="meta">${esc(m.dosage || '')}${m.dosage ? ' · ' : ''}${when}</div>
          </div>
          <div class="actions">
            <button class="btn icon" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn icon" title="Move down" ${i === meds.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn icon" title="Edit">✎</button>
          </div>
        </div>`);
      const [up, down, edit] = row.querySelectorAll('button');
      up.onclick = () => move(m.id, -1);
      down.onclick = () => move(m.id, 1);
      edit.onclick = () => openMedForm(m);
      card.appendChild(row);
    });
    screen.appendChild(card);
    screen.appendChild(el(`<div class="note">Order here is the order on Today. Pausing a med keeps its history but hides it from Today.</div>`));
  }

  function move(id, dir) {
    const meds = liveMeds();
    const i = meds.findIndex((m) => m.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= meds.length) return;
    [meds[i], meds[j]] = [meds[j], meds[i]];
    meds.forEach((m, idx) => { if (m.order !== idx) { m.order = idx; m.updatedAt = stamp(m.updatedAt); } });
    save(); render({ keepScroll: true });
  }

  // ---------- medication form ----------
  const dialog = $('#med-dialog');
  const form = $('#med-form');
  const delBtn = $('#med-delete');

  function openMedForm(med) {
    form.reset();
    $('#med-dialog-title').textContent = med ? 'Edit medication' : 'Add medication';
    form.elements.id.value = med ? med.id : '';
    form.elements.name.value = med ? med.name : '';
    form.elements.dosage.value = med ? med.dosage : '';
    form.elements.morning.checked = med ? Boolean(med.morning) : true;
    form.elements.evening.checked = med ? Boolean(med.evening) : false;
    form.elements.notes.value = med ? med.notes || '' : '';
    form.elements.active.checked = med ? Boolean(med.active) : true;
    delBtn.hidden = !med;
    dialog.showModal();
    setTimeout(() => form.elements.name.focus(), 50);
  }

  $('#med-cancel').onclick = () => dialog.close();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = form.elements;
    const name = f.name.value.trim();
    if (!name) return;
    if (!f.morning.checked && !f.evening.checked) {
      toast('Pick breakfast, dinner, or both.');
      return;
    }
    const id = f.id.value;
    const data = {
      name, dosage: f.dosage.value.trim(), morning: f.morning.checked, evening: f.evening.checked,
      notes: f.notes.value.trim(), active: f.active.checked,
    };
    const m = id && state.meds.find((x) => x.id === id && !x.deleted);
    if (id && !m) {
      // Deleted on your other device while this form was open.
      dialog.close(); render(); toast('That med was deleted on another device');
      return;
    }
    if (m) {
      Object.assign(m, data, { updatedAt: stamp(m.updatedAt) });
    } else {
      const now = new Date().toISOString();
      const order = liveMeds().reduce((max, x) => Math.max(max, x.order + 1), 0);
      state.meds.push({ id: uid(), order, createdAt: now, updatedAt: now, ...data });
    }
    save(); dialog.close(); render();
    toast(id ? 'Saved' : `${name} added`);
  });

  // Deleting leaves a tombstone so the delete reaches your other device instead of the med coming back.
  delBtn.onclick = () => {
    const id = form.elements.id.value;
    const i = state.meds.findIndex((x) => x.id === id);
    const m = state.meds[i];
    if (!m) return;
    if (!confirm(`Delete ${m.name} and its history? Pausing it instead keeps the record.`)) return;
    state.meds[i] = { id, deleted: true, order: m.order, updatedAt: stamp(m.updatedAt) };
    for (const [k, v] of Object.entries(state.logs)) {
      if (k.endsWith(`|${id}`) && v.takenAt) state.logs[k] = { takenAt: null, updatedAt: stamp(v.updatedAt) };
    }
    save(); dialog.close(); render();
    toast('Deleted');
  };

  // ---------- History ----------
  function renderHistory() {
    titleEl.textContent = 'History';
    screen.innerHTML = '';
    const days = 30;
    const now = new Date();
    let sumTaken = 0, sumTotal = 0, streak = 0, streakAlive = true;
    const rows = [];

    // Don't count days before the app was in use as misses.
    const firstKeys = [
      ...liveMeds().map((m) => m.createdAt ? dayKey(new Date(m.createdAt)) : todayKey()),
      ...Object.entries(state.logs).filter(([, v]) => v.takenAt).map(([k]) => k.split('|')[0]),
    ].filter(Boolean).sort();
    const firstKey = firstKeys[0] || todayKey();

    for (let i = 0; i < days; i++) {
      const d = addDays(now, -i);
      const key = dayKey(d);
      if (key < firstKey) break;
      const perSlot = SLOTS.map((s) => ({ slot: s, ...slotStatus(key, s) })).filter((x) => x.total > 0);
      const total = perSlot.reduce((a, x) => a + x.total, 0);
      const taken = perSlot.reduce((a, x) => a + x.taken, 0);
      // Only count slots whose time has passed today, so a morning-only record doesn't look like a miss at noon.
      const due = perSlot.filter((x) => i > 0 || now > slotTime(x.slot, now));
      const dueTotal = due.reduce((a, x) => a + x.total, 0);
      const dueTaken = due.reduce((a, x) => a + x.taken, 0);
      sumTotal += dueTotal; sumTaken += dueTaken;
      if (streakAlive && dueTotal > 0) { if (dueTaken === dueTotal) streak++; else streakAlive = false; }
      rows.push({ d, key, perSlot, total, taken, dueTotal, dueTaken, isToday: i === 0 });
    }

    const pct = sumTotal ? Math.round((sumTaken / sumTotal) * 100) : 0;
    screen.appendChild(el(`
      <div class="summary">
        <div class="stat"><div class="n">${pct}%</div><div class="l">30-day adherence</div></div>
        <div class="stat"><div class="n">${streak}</div><div class="l">Day streak</div></div>
      </div>`));

    if (activeMeds().length === 0) {
      screen.appendChild(el(`<div class="card"><div class="empty"><strong>No history yet</strong>Add meds and start logging on Today.</div></div>`));
      return;
    }

    const card = el(`<div class="card"></div>`);
    for (const r of rows) {
      const cls = r.dueTotal === 0 ? '' : r.dueTaken === r.dueTotal ? 'full' : r.dueTaken === 0 ? 'none' : 'part';
      const dots = r.perSlot.map((x) => {
        const passed = !r.isToday || now > slotTime(x.slot, now);
        const c = x.taken === x.total ? 'on' : (passed ? 'miss' : '');
        return `<span class="dot ${c}" title="${x.slot.title}: ${x.taken}/${x.total}"></span>`;
      }).join('');
      const row = el(`
        <div class="hist-row" role="button" tabindex="0">
          <div class="d">${esc(friendlyDay(r.d))}<small>${esc(r.d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}</small></div>
          <div class="dots">${dots}</div>
          <div class="score ${cls}">${r.taken}/${r.total}</div>
        </div>`);
      row.onclick = () => { viewDay = r.d; location.hash = '#today'; };
      card.appendChild(row);
    }
    screen.appendChild(card);
    screen.appendChild(el(`<div class="note">Expected doses are based on your current active meds. Tap a day to view or fix it.</div>`));
  }

  // ---------- Settings ----------
  const sectionTitle = (text, first) => el(`<h2 style="font-size:15px;color:var(--muted);margin:${first ? 6 : 16}px 0 8px">${text}</h2>`);

  function renderSettings() {
    titleEl.textContent = 'Settings';
    screen.innerHTML = '';

    const times = el(`<div class="card"></div>`);
    for (const slot of SLOTS) {
      const row = el(`
        <div class="settings-row">
          <div class="l">${slot.icon} ${slot.title} <small>${slot.meal}. Used for "due" status and calendar reminders.</small></div>
          <input type="time" value="${esc(state.settings[slot.settingKey] || slot.defaultTime)}">
        </div>`);
      row.querySelector('input').onchange = (e) => {
        if (!e.target.value) return;
        state.settings = { ...state.settings, [slot.settingKey]: e.target.value, updatedAt: stamp(state.settings.updatedAt) };
        save(); toast('Saved');
      };
      times.appendChild(row);
    }
    times.appendChild(el(`<div class="note">Push reminder times are not set here. They live in the repo, in <code>.github/workflows/push-reminders.yml</code>. If you change a time above, change it there too.</div>`));
    screen.appendChild(sectionTitle('Reminder times', true));
    screen.appendChild(times);

    screen.appendChild(sectionTitle('Sync'));
    screen.appendChild(syncCard());

    // Reminders
    screen.appendChild(sectionTitle('Reminders'));
    screen.appendChild(pushCard());
    const rem = el(`
      <div class="card">
        <div class="settings-row"><div class="l">Calendar reminders <small>Two daily alerts at the times above. Each one opens this app. Works even if push doesn't.</small></div>
          <button class="btn">Get file</button></div>
        <div class="note">
          On iPhone: tap Get file, open it from Files or the download bar, then <strong>Add All</strong>. Do this from Safari rather than the home-screen app.
          On Mac: the file opens straight into Calendar. Change the times above? Delete the old events and get a fresh file.
        </div>
      </div>`);
    rem.querySelector('button').onclick = downloadICS;
    screen.appendChild(rem);

    // Notifications test (a local notification, to check this device allows alerts)
    if ('Notification' in window) {
      const n = el(`
        <div class="card">
          <div class="settings-row"><div class="l">Test notification <small>Confirms this device allows alerts from the app.</small></div>
            <button class="btn">Test</button></div>
        </div>`);
      n.querySelector('button').onclick = async () => {
        try {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') { toast('Notifications not allowed'); return; }
          const reg = await navigator.serviceWorker?.getRegistration();
          if (reg) reg.showNotification('Meds', { body: 'Notifications work on this device.', icon: './icons/icon-192.png' });
          else new Notification('Meds', { body: 'Notifications work on this device.' });
        } catch (e) { toast('Could not show a notification here'); }
      };
      screen.appendChild(n);
    }

    // Backup
    const bk = el(`
      <div class="card">
        <div class="settings-row"><div class="l">Back up <small>Downloads everything as a JSON file.</small></div><button class="btn">Export</button></div>
        <div class="settings-row"><div class="l">Restore <small>${syncCfg ? 'Merges a backup file into your synced data. Newer changes win; nothing is deleted.' : "Replaces what's on this device with a backup file."}</small></div>
          <label class="btn" style="margin:0">Import<input type="file" accept="application/json,.json" hidden></label></div>
        <div class="note">A manual fallback to sync. Export now and then and keep the file somewhere safe.</div>
      </div>`);
    bk.querySelectorAll('button')[0].onclick = exportJSON;
    bk.querySelector('input[type=file]').onchange = importJSON;
    screen.appendChild(sectionTitle('Backup'));
    screen.appendChild(bk);

    const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    screen.appendChild(el(`
      <div class="note" style="margin-top:8px">
        Meds v${APP_VERSION} · ${installed ? 'Installed as an app' : 'Running in the browser. On iPhone: Share → Add to Home Screen. On Mac Safari: File → Add to Dock.'}
        <br>${esc(medsCountLabel())}
      </div>`));
    updateSyncUI();
  }

  function medsCountLabel() {
    const n = liveMeds().length, l = Object.values(state.logs).filter((v) => v.takenAt).length;
    return `${n} medication${n === 1 ? '' : 's'}, ${l} dose${l === 1 ? '' : 's'} logged.`;
  }

  // ---------- sync ----------
  // Read the gist, merge it with this device (sync-core.js), write the result back if it changed.
  // Runs on open, when the app comes back on screen, every 2 minutes while on screen, and
  // 2 seconds after any change. Never blocks the UI: logging a dose saves locally first.
  const GIST_DESC = 'meds-sync';
  const GIST_FILE = 'meds-sync.json';
  const STALE_MIN = 10;

  let syncCfg = loadSyncCfg();
  const syncStatus = { kind: syncCfg ? 'idle' : 'off', text: '' };
  let syncing = false, syncAgain = false, syncTimer = null, verifyTimer = null, gistChecked = false;

  function loadSyncCfg() {
    try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || null; } catch (e) { return null; }
  }
  function saveSyncCfg() {
    try {
      if (syncCfg) localStorage.setItem(SYNC_KEY, JSON.stringify(syncCfg));
      else localStorage.removeItem(SYNC_KEY);
    } catch (e) { /* storage blocked; sync just won't remember */ }
  }

  class SyncError extends Error {
    constructor(kind, message) { super(message); this.kind = kind; }
  }

  async function gh(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch('https://api.github.com' + path, {
        method, cache: 'no-store',
        headers: {
          Authorization: `Bearer ${syncCfg.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new SyncError('offline', 'Offline, will retry');
    }
    if (res.status === 401) throw new SyncError('auth', 'GitHub rejected the token. Check it, or make a new one with the gist scope.');
    if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after')))) {
      throw new SyncError('rate', 'GitHub asked us to slow down. Will retry.');
    }
    if (res.status === 403) throw new SyncError('auth', 'GitHub refused. The token needs the gist scope.');
    if (res.status === 404) throw new SyncError('gone', 'Sync gist not found');
    if (!res.ok) throw new SyncError('other', `GitHub error ${res.status}. Will retry.`);
    return res.json();
  }

  // The oldest gist with our description, so two devices always pick the same one.
  async function findGist() {
    const found = [];
    for (let page = 1; page <= 10; page++) {
      const list = await gh(`/gists?per_page=100&page=${page}`);
      found.push(...list.filter((g) => g.description === GIST_DESC && g.files && g.files[GIST_FILE]));
      if (list.length < 100) break;
    }
    found.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return found.length ? found[0].id : null;
  }

  async function readRemote(gistId, passphrase) {
    const g = await gh(`/gists/${gistId}`);
    const f = g.files && g.files[GIST_FILE];
    if (!f) throw new SyncError('gone', 'Sync file missing from the gist');
    let text = f.content;
    if (f.truncated) {
      try { text = await (await fetch(f.raw_url, { cache: 'no-store' })).text(); }
      catch (e) { throw new SyncError('offline', 'Offline, will retry'); }
    }
    let blob;
    try { blob = JSON.parse(text); } catch (e) { throw new SyncError('passphrase', "The sync file is damaged. Nothing was overwritten."); }
    try {
      return Core.migrate(await Core.decrypt(blob, passphrase));
    } catch (e) {
      throw new SyncError('passphrase', e.message);
    }
  }

  async function syncNow() {
    if (!syncCfg) return;
    if (syncing) { syncAgain = true; return; }
    syncing = true;
    const cfg = syncCfg; // if you disconnect mid-sync, stop before writing anything
    setSyncStatus('syncing');
    try {
      let gistId = cfg.gistId;
      // Once per app open, make sure we're on the oldest meds-sync gist. If both devices ever
      // created one at the same moment, this moves them onto the same gist instead of each
      // syncing with its own copy forever.
      if (!gistId || !gistChecked) {
        gistId = (await findGist()) || gistId;
        gistChecked = true;
      }
      let remote = null;
      if (gistId) {
        try {
          remote = await readRemote(gistId, cfg.passphrase);
        } catch (e) {
          if (e.kind !== 'gone') throw e;
          // Gist was deleted. Look for another one before making a new one.
          const other = await findGist();
          gistId = other && other !== gistId ? other : null;
          if (gistId) remote = await readRemote(gistId, cfg.passphrase);
        }
      }
      if (syncCfg !== cfg) return;

      // From here to saveLocal is synchronous, so a tap can't slip in between merge and save.
      const r = Core.reconcile(state, remote);
      state = r.merged;
      saveLocal();
      if (r.localChanged) refreshAfterSync();

      if (r.remoteNeedsWrite) {
        const content = JSON.stringify(await Core.encrypt(r.merged, cfg.passphrase));
        if (syncCfg !== cfg) return;
        const files = { [GIST_FILE]: { content } };
        if (gistId) {
          try { await gh(`/gists/${gistId}`, { method: 'PATCH', body: { files } }); }
          catch (e) { if (e.kind === 'gone') gistId = null; else throw e; }
        }
        if (!gistId) gistId = (await gh('/gists', { method: 'POST', body: { description: GIST_DESC, public: false, files } })).id;
        // Your other device may have written at the same moment and replaced this write.
        // Check again shortly; if anything of ours is missing, it gets written back.
        clearTimeout(verifyTimer);
        verifyTimer = setTimeout(syncNow, 10000);
      }

      cfg.gistId = gistId;
      cfg.lastSyncAt = new Date().toISOString();
      saveSyncCfg();
      setSyncStatus('ok');
    } catch (e) {
      console.warn('Sync failed', e);
      if (syncCfg === cfg) setSyncStatus(e.kind || 'other', e instanceof SyncError ? e.message : 'Sync failed. Will retry.');
    } finally {
      syncing = false;
      if (syncAgain) { syncAgain = false; syncNow(); }
    }
  }

  function scheduleSync() {
    if (!syncCfg) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, 2000);
  }

  // After sync brought in changes, redraw, unless you're typing in Settings.
  function refreshAfterSync() {
    if (currentTab() !== 'settings') render({ keepScroll: true });
  }

  function setSyncStatus(kind, text = '') {
    syncStatus.kind = kind;
    syncStatus.text = text;
    updateSyncUI();
  }

  function syncStatusText() {
    const last = syncCfg && syncCfg.lastSyncAt;
    switch (syncStatus.kind) {
      case 'syncing': return 'Syncing';
      case 'ok': return `Synced ${shortTime(last)}`;
      case 'idle': return last ? `Last synced ${shortTime(last)}` : 'Not synced yet';
      default: return syncStatus.text;
    }
  }

  // Today shows a warning when this device may be missing doses logged on the other one.
  function updateSyncUI() {
    const s = $('#sync-status');
    if (s) {
      s.textContent = syncStatusText();
      s.classList.toggle('bad', ['auth', 'passphrase'].includes(syncStatus.kind));
    }
    const t = $('#today-sync');
    if (t && syncCfg) {
      const last = syncCfg.lastSyncAt;
      // "Fresh" = the last attempt worked and was recent. Any failed attempt shows the warning.
      const fresh = last && Date.now() - Date.parse(last) < STALE_MIN * 60000 && ['ok', 'idle', 'syncing'].includes(syncStatus.kind);
      if (syncStatus.kind === 'syncing') t.textContent = 'Syncing';
      else if (fresh) t.textContent = `Synced ${shortTime(last)}`;
      else {
        const why = ['auth', 'passphrase'].includes(syncStatus.kind) ? 'Sync is failing (see Settings). '
          : syncStatus.kind === 'offline' ? 'Offline. ' : syncStatus.kind === 'off' || syncStatus.kind === 'idle' ? '' : 'Sync hit a problem, will retry. ';
        t.textContent = `${why}${last ? `Last synced ${shortTime(last)}${sameDay(new Date(last), new Date()) ? '' : ' ' + friendlyDay(new Date(last)).toLowerCase()}` : 'Not synced yet'}. A dose logged on your other device may not show here yet.`;
      }
      t.classList.toggle('warn', !fresh && syncStatus.kind !== 'syncing');
    }
  }

  function syncCard() {
    if (syncCfg) {
      const card = el(`
        <div class="card">
          <div class="settings-row"><div class="l">Sync is on <small id="sync-status" class="status"></small></div><button class="btn">Sync now</button></div>
          <div class="settings-row"><div class="l">Disconnect <small>Forgets the token and passphrase on this device. Your data stays here.</small></div><button class="btn danger">Disconnect</button></div>
          <div class="note">Your meds and doses are encrypted with your passphrase before they leave this device, then stored in a private GitHub Gist.
            The token and passphrase are saved in this browser's storage on this device only. They are never put in the gist, the repo, or a link.</div>
        </div>`);
      const [now, off] = card.querySelectorAll('button');
      now.onclick = () => syncNow();
      off.onclick = () => {
        if (!confirm('Stop syncing on this device? Your data stays here, and the other device keeps its copy.')) return;
        disconnectSync(); render(); toast('Sync is off on this device');
      };
      return card;
    }

    const card = el(`
      <div class="card">
        <div class="settings-row"><div class="l">Sync iPhone and Mac <small>Keeps the same meds and doses on each device through a private, encrypted GitHub Gist.</small></div></div>
        <form class="form" style="padding:0 14px" autocomplete="off">
          <label>GitHub token (classic, gist scope only)<input type="password" name="token" placeholder="ghp_…" spellcheck="false" autocapitalize="off"></label>
          <label>Passphrase<input type="password" name="pass" autocomplete="new-password"></label>
          <label>Passphrase again<input type="password" name="pass2" autocomplete="new-password"></label>
          <div class="sync-error" role="alert"></div>
          <div class="form-actions" style="margin-bottom:12px"><span class="spacer"></span><button class="btn primary" type="submit">Connect</button></div>
        </form>
        <div class="note">Use the same passphrase on every device. It encrypts your list before it leaves this device, and nobody can recover it for you, so write it down somewhere safe.
          The token and passphrase are saved in this browser's storage on this device only. They are never put in the gist, the repo, or a link.</div>
      </div>`);
    const f = card.querySelector('form');
    const err = card.querySelector('.sync-error');
    f.onsubmit = async (e) => {
      e.preventDefault();
      const token = f.elements.token.value.trim(), pass = f.elements.pass.value;
      err.textContent = '';
      if (!token) { err.textContent = 'Paste your GitHub token.'; return; }
      if (pass.length < 8) { err.textContent = 'Use a passphrase of at least 8 characters.'; return; }
      if (pass !== f.elements.pass2.value) { err.textContent = "The two passphrases don't match."; return; }
      const btn = f.querySelector('button');
      btn.disabled = true; btn.textContent = 'Connecting';
      syncCfg = { token, passphrase: pass, gistId: null, lastSyncAt: null };
      saveSyncCfg();
      await syncNow();
      if (['auth', 'passphrase', 'other'].includes(syncStatus.kind)) {
        // Didn't work: forget the details so a wrong passphrase can't linger, and say why.
        const msg = syncStatus.text;
        disconnectSync();
        err.textContent = msg;
        btn.disabled = false; btn.textContent = 'Connect';
        return;
      }
      render();
      toast(syncStatus.kind === 'ok' ? 'Sync is on' : 'Saved. Will sync when back online.');
    };
    return card;
  }

  function disconnectSync() {
    clearTimeout(syncTimer); clearTimeout(verifyTimer);
    syncCfg = null;
    gistChecked = false;
    saveSyncCfg();
    setSyncStatus('off');
  }

  // ---------- push ----------
  // The app only subscribes. GitHub Actions (scripts/send-push.mjs) sends the reminders,
  // using the subscription you paste into the PUSH_SUBSCRIPTION repo secret.
  function b64urlToBytes(s) {
    const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }
  function sameBytes(a, b) {
    if (!a || !b) return false;
    const x = new Uint8Array(a), y = new Uint8Array(b);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }

  function pushCard() {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const card = el(`
      <div class="card">
        <div class="settings-row"><div class="l">Push reminders <small>A notification at breakfast and dinner, sent by GitHub. Tap it to open Today.</small></div>
          <button class="btn primary" ${supported ? '' : 'disabled'}>Enable</button></div>
        <div class="push-out" hidden>
          <div class="note">Copy this and paste it into the repo secret <code>PUSH_SUBSCRIPTION</code> (GitHub → household-inventory → Settings → Secrets and variables → Actions).
            Using push on both iPhone and Mac? Put both in the secret as a list: <code>[</code> first <code>,</code> second <code>]</code>.</div>
          <textarea readonly rows="5" class="code-box"></textarea>
          <div class="card-foot"><button class="btn">Copy</button></div>
        </div>
        <div class="note">${supported
          ? 'iPhone needs iOS 16.4 or later, and Meds must be opened from its Home Screen icon. Tap Enable, then Allow.'
          : 'Push isn\'t available here. On iPhone: add Meds to the Home Screen (Share → Add to Home Screen), open it from that icon, and come back here. Needs iOS 16.4 or later.'}
          Push times are set in the repo, not on this screen. The calendar file below is the backup if push ever stops.</div>
      </div>`);
    if (!supported) return card;

    const [enable, copy] = card.querySelectorAll('button');
    const out = card.querySelector('.push-out');
    const box = card.querySelector('textarea');
    const show = (sub) => { box.value = JSON.stringify(sub); out.hidden = false; enable.textContent = 'Show again'; };

    // Already subscribed on this device? Show it without asking again.
    if (Notification.permission === 'granted') {
      navigator.serviceWorker.getRegistration().then((reg) => reg && reg.pushManager.getSubscription()).then((sub) => {
        if (sub) enable.textContent = 'Show subscription';
      }).catch(() => {});
    }

    enable.onclick = async () => {
      try {
        // Must be the first thing in the tap handler, or iOS ignores it.
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { toast('Notifications are off for Meds. Turn them on in Settings → Notifications → Meds.'); return; }
        const reg = await navigator.serviceWorker.ready;
        const key = b64urlToBytes(MedsConfig.vapidPublicKey);
        let sub = await reg.pushManager.getSubscription();
        if (sub && !sameBytes(sub.options.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        show(sub);
      } catch (e) {
        console.warn('Push subscribe failed', e);
        toast('Could not turn on push here. ' + (e.message || ''));
      }
    };
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(box.value); toast('Copied'); }
      catch (e) { box.select(); toast('Selected. Copy it from the menu.'); }
    };
    return card;
  }

  // ---------- calendar export ----------
  function downloadICS() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
    const appUrl = location.origin + location.pathname.replace(/[^/]*$/, '') + '#today';
    const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const today = new Date();
    const dt = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    const escText = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);

    const events = SLOTS.filter((s) => medsFor(s).length > 0).map((s) => {
      const list = medsFor(s).map((m) => m.name + (m.dosage ? ` (${m.dosage})` : '')).join(', ');
      return [
        'BEGIN:VEVENT',
        `UID:meds-${s.id}-daily@srichards`,
        `DTSTAMP:${dtstamp}`,
        `DTSTART;TZID=${tz}:${dt(slotTime(s, today))}`,
        'DURATION:PT15M',
        'RRULE:FREQ=DAILY',
        `SUMMARY:${escText(`${s.title} meds ${s.meal}`)}`,
        `DESCRIPTION:${escText(list + '\nLog them: ' + appUrl)}`,
        `URL:${appUrl}`,
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        `DESCRIPTION:${escText(`${s.title} meds: ${list}`)}`,
        'TRIGGER:PT0S',
        'END:VALARM',
        'END:VEVENT',
      ].join('\r\n');
    });

    if (events.length === 0) { toast('Add some meds first'); return; }

    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Meds//Daily reminders//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
    downloadFile('meds-reminders.ics', ics, 'text/calendar');
  }

  // ---------- backup ----------
  function exportJSON() {
    const payload = { app: 'meds', version: APP_VERSION, exportedAt: new Date().toISOString(), ...state };
    downloadFile(`meds-backup-${todayKey()}.json`, JSON.stringify(payload, null, 2), 'application/json');
  }

  // Accepts v1.0 and v1.1 backups. With sync on, a restore merges (newer wins, nothing deleted)
  // because replacing would just be undone by the next sync anyway.
  function importJSON(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.meds) || typeof data.logs !== 'object') throw new Error('Not a Meds backup');
        const incoming = Core.migrate(data);
        const nMeds = incoming.meds.filter((m) => !m.deleted).length;
        const nDoses = Object.values(incoming.logs).filter((v) => v.takenAt).length;
        if (syncCfg) {
          if (!confirm(`Merge a backup with ${nMeds} medications and ${nDoses} logged doses into your synced data? Newer changes win and nothing is deleted.`)) return;
          state = Core.merge(state, incoming);
        } else {
          if (!confirm(`Replace this device's data with ${nMeds} medications and ${nDoses} logged doses?`)) return;
          state = incoming;
        }
        save(); render(); toast(syncCfg ? 'Merged' : 'Restored');
      } catch (err) {
        toast('That file is not a Meds backup');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function downloadFile(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  // ---------- boot ----------
  window.addEventListener('hashchange', () => render());
  // Coming back to the app: roll "Today" over at midnight, refresh "due" status, and sync.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (pinnedToToday && !sameDay(viewDay, new Date())) viewDay = new Date();
      render({ keepScroll: true });
      syncNow();
    }
  });
  window.addEventListener('online', () => syncNow());
  setInterval(() => { if (document.visibilityState === 'visible' && currentTab() === 'today') render({ keepScroll: true }); }, 60 * 1000);
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 2 * 60 * 1000);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
    // Tapping a push notification while the app is already open: jump to today.
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-today') {
        viewDay = new Date();
        if (location.hash !== '#today') location.hash = '#today'; else render();
      }
    });
  }

  render();
  syncNow();
})();
