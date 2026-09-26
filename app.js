/* Meds v1.0
 * A single-file, no-build web app. Everything lives in localStorage on this device.
 * Sections: storage, date helpers, rendering per tab, medication form, calendar export, backup.
 */
(() => {
  'use strict';

  const APP_VERSION = '1.0';
  const STORE_KEY = 'meds.v1';
  const SLOTS = [
    { id: 'morning', title: 'Morning', meal: 'with breakfast', icon: '☀️', settingKey: 'breakfast', defaultTime: '08:00' },
    { id: 'evening', title: 'Evening', meal: 'with dinner', icon: '🌙', settingKey: 'dinner', defaultTime: '18:00' },
  ];

  // ---------- storage ----------
  const defaultState = () => ({
    meds: [],
    logs: {},            // "YYYY-MM-DD|slot|medId" -> ISO timestamp taken
    settings: { breakfast: '08:00', dinner: '18:00' },
  });

  let state = load();

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return { ...defaultState(), ...parsed, settings: { ...defaultState().settings, ...(parsed.settings || {}) } };
    } catch (e) {
      console.warn('Could not read saved data, starting fresh', e);
      return defaultState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('Could not save. Storage may be full or blocked.');
    }
  }

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

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
  const activeMeds = () => state.meds.filter((m) => m.active).sort((a, b) => a.order - b.order);
  const medsFor = (slot) => activeMeds().filter((m) => m[slot.id]);
  const logKey = (key, slotId, medId) => `${key}|${slotId}|${medId}`;
  const isTaken = (key, slotId, medId) => Boolean(state.logs[logKey(key, slotId, medId)]);

  function slotStatus(key, slot) {
    const meds = medsFor(slot);
    const taken = meds.filter((m) => isTaken(key, slot.id, m.id)).length;
    return { total: meds.length, taken };
  }

  function setTaken(key, slotId, medId, taken, when) {
    const k = logKey(key, slotId, medId);
    if (taken) state.logs[k] = (when || new Date()).toISOString();
    else delete state.logs[k];
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

  function render() {
    const tab = currentTab();
    document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    actionsEl.innerHTML = '';
    ({ today: renderToday, meds: renderMeds, history: renderHistory, settings: renderSettings })[tab]();
    window.scrollTo(0, 0);
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
    if (!isToday) {
      const back = el(`<button class="btn subtle block" style="margin:-6px 0 12px">Jump to today</button>`);
      back.onclick = () => { viewDay = new Date(); render(); };
      screen.appendChild(back);
    }

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
        const takenAt = state.logs[logKey(key, slot.id, m.id)];
        const row = el(`
          <button class="dose-row ${takenAt ? 'taken' : ''}" aria-pressed="${takenAt ? 'true' : 'false'}">
            <span class="box">✓</span>
            <span class="body">
              <div class="name">${esc(m.name)}</div>
              <div class="meta">${esc(m.dosage || '')}</div>
            </span>
            ${takenAt ? `<span class="when">${esc(shortTime(takenAt))}</span>` : ''}
          </button>`);
        row.onclick = () => {
          const nowTaken = !isTaken(key, slot.id, m.id);
          setTaken(key, slot.id, m.id, nowTaken, stampFor(key, slot));
          if (nowTaken && navigator.vibrate) navigator.vibrate(10);
          render();
        };
        card.appendChild(row);
      }

      if (taken < total) {
        const foot = el(`<div class="card-foot"><button class="btn primary">Take all ${slot.title.toLowerCase()} meds</button></div>`);
        foot.firstElementChild.onclick = () => {
          const when = stampFor(key, slot);
          meds.forEach((m) => { if (!isTaken(key, slot.id, m.id)) setTaken(key, slot.id, m.id, true, when); });
          toast(`${slot.title} meds logged`);
          render();
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

    const meds = [...state.meds].sort((a, b) => a.order - b.order);
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
    const meds = [...state.meds].sort((a, b) => a.order - b.order);
    const i = meds.findIndex((m) => m.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= meds.length) return;
    [meds[i], meds[j]] = [meds[j], meds[i]];
    meds.forEach((m, idx) => { m.order = idx; });
    save(); render();
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
    if (id) {
      const m = state.meds.find((x) => x.id === id);
      Object.assign(m, data);
    } else {
      state.meds.push({ id: uid(), order: state.meds.length, createdAt: new Date().toISOString(), ...data });
    }
    save(); dialog.close(); render();
    toast(id ? 'Saved' : `${name} added`);
  });

  delBtn.onclick = () => {
    const id = form.elements.id.value;
    const m = state.meds.find((x) => x.id === id);
    if (!m) return;
    if (!confirm(`Delete ${m.name} and its history? Pausing it instead keeps the record.`)) return;
    state.meds = state.meds.filter((x) => x.id !== id);
    for (const k of Object.keys(state.logs)) if (k.endsWith(`|${id}`)) delete state.logs[k];
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
      ...state.meds.map((m) => m.createdAt ? dayKey(new Date(m.createdAt)) : todayKey()),
      ...Object.keys(state.logs).map((k) => k.split('|')[0]),
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
        state.settings[slot.settingKey] = e.target.value; save(); toast('Saved');
      };
      times.appendChild(row);
    }
    screen.appendChild(el(`<h2 style="font-size:15px;color:var(--muted);margin:6px 0 8px">Reminder times</h2>`));
    screen.appendChild(times);

    // Reminders
    const rem = el(`
      <div class="card">
        <div class="settings-row"><div class="l">Calendar reminders <small>Two daily alerts at the times above. Each one opens this app.</small></div>
          <button class="btn primary">Get file</button></div>
        <div class="note">
          On iPhone: tap Get file, open it from Files or the download bar, then <strong>Add All</strong>. Do this from Safari rather than the home-screen app.
          On Mac: the file opens straight into Calendar. Change the times above? Delete the old events and get a fresh file.
        </div>
      </div>`);
    rem.querySelector('button').onclick = downloadICS;
    screen.appendChild(el(`<h2 style="font-size:15px;color:var(--muted);margin:16px 0 8px">Reminders</h2>`));
    screen.appendChild(rem);

    // Notifications test (only useful while the app is open; iOS web apps can't schedule on their own)
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
        <div class="settings-row"><div class="l">Restore <small>Replaces what's on this device with a backup file.</small></div>
          <label class="btn" style="margin:0">Import<input type="file" accept="application/json,.json" hidden></label></div>
        <div class="note">Data lives only on this device. Export now and then, and use Export/Import to move your list to the Mac.</div>
      </div>`);
    bk.querySelectorAll('button')[0].onclick = exportJSON;
    bk.querySelector('input[type=file]').onchange = importJSON;
    screen.appendChild(el(`<h2 style="font-size:15px;color:var(--muted);margin:16px 0 8px">Backup</h2>`));
    screen.appendChild(bk);

    const installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    screen.appendChild(el(`
      <div class="note" style="margin-top:8px">
        Meds v${APP_VERSION} · ${installed ? 'Installed as an app' : 'Running in the browser. On iPhone: Share → Add to Home Screen. On Mac Safari: File → Add to Dock.'}
        <br>${esc(medsCountLabel())}
      </div>`));
  }

  function medsCountLabel() {
    const n = state.meds.length, l = Object.keys(state.logs).length;
    return `${n} medication${n === 1 ? '' : 's'}, ${l} dose${l === 1 ? '' : 's'} logged.`;
  }

  // ---------- calendar export ----------
  function downloadICS() {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York';
    const appUrl = location.origin + location.pathname.replace(/[^/]*$/, '') + '#today';
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const today = new Date();
    const dt = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
    const escText = (s) => String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);

    const events = SLOTS.filter((s) => medsFor(s).length > 0).map((s) => {
      const list = medsFor(s).map((m) => m.name + (m.dosage ? ` (${m.dosage})` : '')).join(', ');
      return [
        'BEGIN:VEVENT',
        `UID:meds-${s.id}-daily@srichards`,
        `DTSTAMP:${stamp}`,
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

  function importJSON(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.meds) || typeof data.logs !== 'object') throw new Error('Not a Meds backup');
        if (!confirm(`Replace this device's data with ${data.meds.length} medications and ${Object.keys(data.logs).length} logged doses?`)) return;
        state = { ...defaultState(), meds: data.meds, logs: data.logs, settings: { ...defaultState().settings, ...(data.settings || {}) } };
        save(); render(); toast('Restored');
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
    toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }

  // ---------- boot ----------
  window.addEventListener('hashchange', render);
  // Re-render when coming back to the app so "Today" rolls over at midnight and "due" status is fresh.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (pinnedToToday && !sameDay(viewDay, new Date())) viewDay = new Date();
      render();
    }
  });
  setInterval(() => { if (document.visibilityState === 'visible' && currentTab() === 'today') render(); }, 60 * 1000);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
  }

  render();
})();
