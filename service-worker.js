const CACHE_NAME = 'service-sjekkliste-v3';
const RUNTIME_CACHE = 'service-sjekkliste-runtime-v3';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// ─── Install ───────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate ──────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.map(name => {
          if (name !== CACHE_NAME && name !== RUNTIME_CACHE) {
            return caches.delete(name);
          }
        })
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch (caching strategy unchanged) ───────────────────────────────────
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.hostname === 'docs.google.com' && url.pathname.includes('/export')) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(cache =>
        cache.match(request).then(cached => {
          const fresh = fetch(request).then(res => {
            if (res && res.status === 200) {
              cache.put(request, res.clone());
              self.clients.matchAll().then(clients =>
                clients.forEach(c => c.postMessage({ type: 'DATA_UPDATED', message: 'Ny data tilgjengelig fra Google Sheets' }))
              );
            }
            return res;
          }).catch(() => cached);
          return cached || fresh;
        })
      )
    );
    return;
  }

  if (request.headers.get('accept') && request.headers.get('accept').includes('text/html')) {
    event.respondWith(
      fetch(request)
        .then(res => {
          caches.open(CACHE_NAME).then(c => c.put(request, res.clone()));
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (!res || res.status !== 200 || res.type === 'error') return res;
        caches.open(RUNTIME_CACHE).then(c => c.put(request, res.clone()));
        return res;
      });
    })
  );
});

// ─── Notification click ────────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url === self.registration.scope && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});

// ─── Notification scheduling ───────────────────────────────────────────────
//
// Strategy: store the full schedule in SW state (lastSchedule). On each
// SCHEDULE_NOTIFICATIONS message, rebuild all timeouts. Also re-check every
// minute via a keepalive interval so that if the SW was restarted and timeouts
// were lost, they get rescheduled automatically from stored state.
//

let scheduledTimeouts = [];
let lastSchedule = null;  // { settings, tasks, shifts } - persists in SW memory
let keepaliveInterval = null;

function clearAllTimeouts() {
  scheduledTimeouts.forEach(id => clearTimeout(id));
  scheduledTimeouts = [];
}

function scheduleTimeout(fn, delayMs) {
  if (delayMs <= 0) { fn(); return; }
  // Chrome throttles SW timeouts aggressively beyond a few minutes.
  // We work around this by storing the schedule and re-checking every minute.
  const id = setTimeout(fn, delayMs);
  scheduledTimeouts.push(id);
}

function fireNotification(title, body, tag) {
  console.log('[SW] Firing notification:', title, tag);
  return self.registration.showNotification(title, {
    body,
    icon: './icons/icon-192x192.png',
    badge: './icons/icon-72x72.png',
    tag: tag || 'service-reminder',
    requireInteraction: true,
    renotify: true
  });
}

function parseTime(str) {
  const [h, m] = (str || '').split(':').map(Number);
  return { hours: h || 0, minutes: m || 0 };
}

function nextOccurrenceOfTime(hours, minutes) {
  const now = new Date();
  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);
  if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function msUntil(date) {
  return Math.max(0, date.getTime() - Date.now());
}

function buildTasksByTime(settings, tasks, shifts) {
  const shift = shifts[settings.shift];
  const shiftStart = parseTime(shift.start);
  const shiftEnd   = parseTime(shift.end);
  const tasksByTime = {};

  const addTask = (timeStr, label) => {
    if (!timeStr) return;
    if (!tasksByTime[timeStr]) tasksByTime[timeStr] = [];
    if (!tasksByTime[timeStr].includes(label)) tasksByTime[timeStr].push(label);
  };

  tasks.forEach(item => {
    if (!item.enabled) return;
    let taskTime = '';
    if (settings.shift === 'day')     taskTime = item.dayTime;
    if (settings.shift === 'evening') taskTime = item.eveningTime;
    if (settings.shift === 'night')   taskTime = item.nightTime;

    if (taskTime && !item.interval) addTask(taskTime, item.task);

    if (item.interval && item.interval > 0) {
      let h = shiftStart.hours;
      for (let i = 0; i < 48; i++) {
        addTask(`${String(h).padStart(2,'0')}:00`, `${item.task} (hver ${item.interval}. time)`);
        h += item.interval;
        if (shiftEnd.hours > shiftStart.hours) {
          if (h >= shiftEnd.hours) break;
        } else {
          if (h >= 24) h -= 24;
          if (h >= shiftEnd.hours && h < shiftStart.hours) break;
        }
      }
    }
  });

  return tasksByTime;
}

function buildSchedule(settings, tasks, shifts) {
  clearAllTimeouts();
  if (!settings.shift) { console.log('[SW] No shift selected, skipping schedule'); return; }
  const shift = shifts[settings.shift];
  if (!shift) { console.log('[SW] Unknown shift:', settings.shift); return; }

  console.log('[SW] Building schedule for shift:', settings.shift, 'time now:', new Date().toLocaleTimeString());

  const shiftStart = parseTime(shift.start);
  let scheduledCount = 0;

  // ── 1. Shift-start reminder ────────────────────────────────────────────
  if (settings.shiftStartReminder) {
    const leadMin = parseInt(settings.shiftStartMinutes, 10) || 15;
    const startDate = nextOccurrenceOfTime(shiftStart.hours, shiftStart.minutes);
    const reminderDate = new Date(startDate.getTime() - leadMin * 60 * 1000);
    const delay = msUntil(reminderDate);
    console.log('[SW] Shift-start reminder in', Math.round(delay/60000), 'min at', reminderDate.toLocaleTimeString());
    if (delay > 0) {
      scheduleTimeout(() => {
        fireNotification(
          'Skiftet ditt starter snart!',
          `Skiftet starter om ${leadMin} minutter (kl ${String(shiftStart.hours).padStart(2,'0')}:${String(shiftStart.minutes).padStart(2,'0')})`,
          'shift-start'
        );
        if (lastSchedule) buildSchedule(lastSchedule.settings, lastSchedule.tasks, lastSchedule.shifts);
      }, delay);
      scheduledCount++;
    }
  }

  // ── 2. Hourly task reminders ───────────────────────────────────────────
  if (settings.hourlyReminders) {
    const tasksByTime = buildTasksByTime(settings, tasks, shifts);
    const now = new Date();

    Object.entries(tasksByTime).forEach(([timeStr, taskNames]) => {
      const { hours, minutes } = parseTime(timeStr);

      // Fire 10 min before the task time
      let notifHours   = hours;
      let notifMinutes = minutes - 10;
      if (notifMinutes < 0) { notifMinutes += 60; notifHours--; }
      if (notifHours < 0)   notifHours += 24;

      const fireDate = nextOccurrenceOfTime(notifHours, notifMinutes);
      const delay    = msUntil(fireDate);
      const tag      = `task-${timeStr}`;

      console.log('[SW] Task slot', timeStr, '→ notify at', fireDate.toLocaleTimeString(), 'in', Math.round(delay/60000), 'min');

      if (delay <= 24 * 60 * 60 * 1000) {
        scheduleTimeout(() => {
          const body = taskNames.map(n => `• ${n}`).join('\n');
          fireNotification(`Oppgaver kl ${timeStr}`, body, tag);
        }, delay);
        scheduledCount++;
      }
    });
  }

  console.log('[SW] Scheduled', scheduledCount, 'notifications total');

  // ── 3. Keepalive: re-check every 5 min in case SW was restarted ───────
  if (keepaliveInterval) clearInterval(keepaliveInterval);
  keepaliveInterval = setInterval(() => {
    if (lastSchedule && scheduledTimeouts.length === 0) {
      console.log('[SW] Keepalive: rescheduling lost timeouts');
      buildSchedule(lastSchedule.settings, lastSchedule.tasks, lastSchedule.shifts);
    }
  }, 5 * 60 * 1000);
}

// ─── Message handler ───────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (data.type === 'SCHEDULE_NOTIFICATIONS') {
    buildSchedule(data.settings, data.tasks, data.shifts);
  }

  if (data.type === 'CLEAR_NOTIFICATIONS') {
    clearAllTimeouts();
  }

  if (data.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys()
        .then(names => Promise.all(names.map(n => caches.delete(n))))
        .then(() => self.clients.matchAll())
        .then(clients => clients.forEach(c => c.postMessage({ type: 'CACHE_CLEARED' })))
    );
  }
});
