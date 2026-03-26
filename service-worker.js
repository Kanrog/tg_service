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
// The page sends a SCHEDULE_NOTIFICATIONS message with the full task list and
// settings. The SW stores them and uses setTimeout chains to fire at the right
// times. This works even when the page tab is closed or the screen is locked
// (on Android; iOS requires PWA installed to home screen, iOS 16.4+).
//
// Message format from page:
// {
//   type: 'SCHEDULE_NOTIFICATIONS',
//   settings: { shift, shiftStartReminder, shiftStartMinutes, hourlyReminders },
//   tasks: [{ category, task, dayTime, eveningTime, nightTime, enabled, interval }],
//   shifts: { day: { start, end }, evening: { start, end }, night: { start, end } }
// }

let scheduledTimeouts = [];

function clearAllTimeouts() {
  scheduledTimeouts.forEach(id => clearTimeout(id));
  scheduledTimeouts = [];
}

function scheduleTimeout(fn, delayMs) {
  // Split into chunks to work around the ~24.8-day 32-bit int limit
  // and to avoid browser throttling of very long timeouts.
  const MAX_DELAY = 30 * 60 * 1000; // 30 minutes max per chunk
  if (delayMs <= 0) return;
  if (delayMs <= MAX_DELAY) {
    const id = setTimeout(fn, delayMs);
    scheduledTimeouts.push(id);
  } else {
    const id = setTimeout(() => {
      scheduleTimeout(fn, delayMs - MAX_DELAY);
    }, MAX_DELAY);
    scheduledTimeouts.push(id);
  }
}

function fireNotification(title, body, tag) {
  self.registration.showNotification(title, {
    body,
    icon: './icons/icon-192x192.png',
    badge: './icons/icon-72x72.png',
    tag: tag || 'service-reminder',
    requireInteraction: true,
    renotify: true
  });
}

function parseTime(str) {
  // Returns { hours, minutes } from "08:00" or "8:0"
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

function buildSchedule(settings, tasks, shifts) {
  clearAllTimeouts();

  if (!settings.shift) return;

  const shift = shifts[settings.shift];
  if (!shift) return;

  const shiftStart = parseTime(shift.start);
  const shiftEnd   = parseTime(shift.end);

  // ── 1. Shift-start reminder ──────────────────────────────────────────────
  if (settings.shiftStartReminder) {
    const leadMin = parseInt(settings.shiftStartMinutes, 10) || 15;
    const startDate = nextOccurrenceOfTime(shiftStart.hours, shiftStart.minutes);
    const reminderDate = new Date(startDate.getTime() - leadMin * 60 * 1000);
    const delay = msUntil(reminderDate);

    if (delay > 0) {
      scheduleTimeout(() => {
        fireNotification(
          'Skiftet ditt starter snart!',
          `${shiftStart.hours.toString().padStart(2,'0')}:${shiftStart.minutes.toString().padStart(2,'0')}-skiftet starter om ${leadMin} minutter`,
          'shift-start'
        );
        // Re-schedule for next day
        buildSchedule(settings, tasks, shifts);
      }, delay);
    }
  }

  // ── 2. Hourly task reminders ─────────────────────────────────────────────
  if (settings.hourlyReminders) {
    // Build a map of time → [task names] for this shift
    const tasksByTime = {};

    const addTask = (timeStr, label) => {
      if (!timeStr) return;
      if (!tasksByTime[timeStr]) tasksByTime[timeStr] = [];
      tasksByTime[timeStr].push(label);
    };

    tasks.forEach(item => {
      if (!item.enabled) return;

      // Time-specific tasks
      let taskTime = '';
      if (settings.shift === 'day')     taskTime = item.dayTime;
      if (settings.shift === 'evening') taskTime = item.eveningTime;
      if (settings.shift === 'night')   taskTime = item.nightTime;

      if (taskTime && !item.interval) {
        addTask(taskTime, item.task);
      }

      // Interval tasks: enumerate every occurrence during the shift
      if (item.interval && item.interval > 0) {
        let h = shiftStart.hours;
        const maxIter = 48;
        for (let i = 0; i < maxIter; i++) {
          const t = `${String(h).padStart(2,'0')}:00`;
          addTask(t, `${item.task} (hver ${item.interval}. time)`);
          h += item.interval;
          // Check if we've passed the shift end
          if (shiftEnd.hours > shiftStart.hours) {
            if (h >= shiftEnd.hours) break;
          } else {
            // Overnight
            if (h >= 24) h -= 24;
            if (h >= shiftEnd.hours && h < shiftStart.hours) break;
          }
        }
      }
    });

    // For each time slot, schedule a notification 10 minutes before
    const sentToday = new Set();

    Object.entries(tasksByTime).forEach(([timeStr, taskNames]) => {
      const { hours, minutes } = parseTime(timeStr);

      // Notification fires 10 min early
      let notifHours   = hours;
      let notifMinutes = minutes - 10;
      if (notifMinutes < 0) { notifMinutes += 60; notifHours -= 1; }
      if (notifHours < 0)   notifHours += 24;

      const fireDate = nextOccurrenceOfTime(notifHours, notifMinutes);
      const delay    = msUntil(fireDate);
      const tag      = `task-${timeStr}`;

      // Only schedule if it's within the next 24 hours and not already sent
      if (delay <= 24 * 60 * 60 * 1000 && !sentToday.has(tag)) {
        sentToday.add(tag);
        scheduleTimeout(() => {
          const body = taskNames.map(n => `• ${n}`).join('\n');
          fireNotification(
            `Oppgaver kl ${timeStr}`,
            body,
            tag
          );
        }, delay);
      }
    });
  }
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
