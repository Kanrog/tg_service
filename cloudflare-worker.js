// ─── Cloudflare Worker: Service Sjekkliste Push Notifications ──────────────
//
// Environment variables (set as Worker secrets in Cloudflare dashboard):
//   VAPID_PUBLIC_KEY   - base64url VAPID public key
//   VAPID_PRIVATE_KEY  - base64url VAPID private key
//   VAPID_SUBJECT      - mailto:you@example.com
//   SHEET_ID           - Google Sheet ID
//   SHEET_GID          - Google Sheet tab GID
//
// KV namespace binding (set in Worker settings):
//   SUBSCRIPTIONS      - KV namespace for storing push subscriptions
//
// Cron trigger: * * * * * (every minute)
//

const SHIFTS = {
  day:     { name: 'Dag',   start: '08:00', end: '16:00' },
  evening: { name: 'Kveld', start: '16:00', end: '00:00' },
  night:   { name: 'Natt',  start: '00:00', end: '08:00' }
};

// ─── Entry points ──────────────────────────────────────────────────────────

export default {
  // Cron trigger - runs every minute
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNotificationCheck(env));
  },

  // HTTP handler - used by the app to register/unregister subscriptions
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers for all responses
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // POST /subscribe  - save a push subscription
    if (request.method === 'POST' && url.pathname === '/subscribe') {
      try {
        const body = await request.json();
        const { subscription, shift } = body;
        if (!subscription || !subscription.endpoint || !shift) {
          return new Response(JSON.stringify({ error: 'Missing subscription or shift' }), {
            status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
          });
        }
        // Use endpoint URL as the key (hashed to keep it short)
        const key = await hashEndpoint(subscription.endpoint);
        await env.SUBSCRIPTIONS.put(key, JSON.stringify({ subscription, shift, updatedAt: Date.now() }));
        console.log('Saved subscription:', key, 'shift:', shift);
        return new Response(JSON.stringify({ ok: true, key }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
    }

    // DELETE /subscribe  - remove a push subscription
    if (request.method === 'DELETE' && url.pathname === '/subscribe') {
      try {
        const body = await request.json();
        const key = await hashEndpoint(body.endpoint);
        await env.SUBSCRIPTIONS.delete(key);
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
    }

    // GET /vapid-public-key  - return public key so app can subscribe
    if (request.method === 'GET' && url.pathname === '/vapid-public-key') {
      return new Response(JSON.stringify({ key: env.VAPID_PUBLIC_KEY }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // GET /test-push  - manually trigger a push to all subscribers (for testing)
    if (request.method === 'GET' && url.pathname === '/test-push') {
      await runNotificationCheck(env, true);
      return new Response(JSON.stringify({ ok: true, message: 'Test push triggered' }), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // GET /debug  - show current time, tasks, and subscriptions
    if (request.method === 'GET' && url.pathname === '/debug') {
      const now = new Date();
      const osloTime = new Intl.DateTimeFormat('no-NO', {
        timeZone: 'Europe/Oslo', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(now);
      const [hh, mm] = osloTime.split(':');
      const nowStr = `${hh.padStart(2,'0')}:${mm.padStart(2,'0')}`;

      let tasks = [];
      let taskError = null;
      try { tasks = await fetchSheetTasks(env); } catch(e) { taskError = e.message; }

      const subs = await loadAllSubscriptions(env);

      const tasksByShift = {};
      for (const [shiftKey, shift] of Object.entries(SHIFTS)) {
        tasksByShift[shiftKey] = getTasksDueAt(tasks, shiftKey, shift, nowStr);
      }

      // Show all task times for each shift
      const allTimes = {};
      for (const [shiftKey] of Object.entries(SHIFTS)) {
        allTimes[shiftKey] = tasks
          .filter(t => t.enabled)
          .map(t => shiftKey === 'day' ? t.dayTime : shiftKey === 'evening' ? t.eveningTime : t.nightTime)
          .filter(Boolean);
      }

      return new Response(JSON.stringify({
        osloTime: nowStr,
        utcTime: now.toISOString(),
        taskError,
        totalTasks: tasks.length,
        enabledTasks: tasks.filter(t => t.enabled).length,
        dueNow: tasksByShift,
        allTaskTimes: allTimes,
        subscriptions: subs.map(s => ({ shift: s.shift, key: s.key }))
      }, null, 2), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    return new Response('Service Sjekkliste Push Worker', { headers: cors });
  }
};

// ─── Main notification logic ───────────────────────────────────────────────

async function runNotificationCheck(env, forceAll = false) {
  const now = new Date();
  // Use Intl to get correct Oslo time automatically (handles CET/CEST switchover)
  const osloTime = new Intl.DateTimeFormat('no-NO', {
    timeZone: 'Europe/Oslo',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false
  }).format(now);
  // osloTime is "HH:MM" in 24h format
  const [hh, mm] = osloTime.split(':');
  const nowStr = `${hh.padStart(2,'0')}:${mm.padStart(2,'0')}`;

  console.log('Cron check at', nowStr, '(Oslo time), UTC was', now.toISOString());

  // Load tasks from Google Sheet
  let tasks;
  try {
    tasks = await fetchSheetTasks(env);
  } catch (e) {
    console.error('Failed to fetch sheet:', e.message);
    return;
  }

  console.log('Loaded', tasks.length, 'tasks from sheet');

  // For each shift, find tasks due right now
  const notifications = {};
  for (const [shiftKey, shift] of Object.entries(SHIFTS)) {
    const due = getTasksDueAt(tasks, shiftKey, shift, nowStr, forceAll);
    if (due.length > 0) {
      notifications[shiftKey] = due;
      console.log('Shift', shiftKey, '- due tasks:', due.join(', '));
    }
  }

  if (Object.keys(notifications).length === 0 && !forceAll) {
    console.log('No notifications due at', nowStr);
    return;
  }

  // Load all subscriptions from KV
  const subs = await loadAllSubscriptions(env);
  console.log('Found', subs.length, 'subscriptions');

  // Send to matching subscribers
  let sent = 0, failed = 0;
  for (const { key, subscription, shift } of subs) {
    const tasks = forceAll
      ? ['Testvarsel fra Service Sjekkliste']
      : notifications[shift];

    if (!tasks || tasks.length === 0) continue;

    const title = forceAll ? '🔔 Testvarsel' : `Oppgaver kl ${nowStr}`;
    const body  = tasks.map(t => `• ${t}`).join('\n');

    try {
      await sendPushNotification(env, subscription, title, body, `task-${nowStr}`);
      sent++;
    } catch (e) {
      console.error('Push failed for', key, ':', e.message);
      // If subscription is expired/invalid, remove it
      if (e.message.includes('410') || e.message.includes('404')) {
        await env.SUBSCRIPTIONS.delete(key);
        console.log('Removed expired subscription:', key);
      }
      failed++;
    }
  }

  console.log(`Sent: ${sent}, Failed: ${failed}`);
}

// ─── Sheet parsing ─────────────────────────────────────────────────────────

async function fetchSheetTasks(env) {
  const url = `https://docs.google.com/spreadsheets/d/${env.SHEET_ID}/export?format=csv&gid=${env.SHEET_GID}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const csv = await res.text();
  return parseCSV(csv);
}

function parseCSV(csvText) {
  const lines = csvText.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase());
  const idx = {
    enabled:     headers.findIndex(h => h === 'enabled'),
    category:    headers.findIndex(h => h === 'category'),
    task:        headers.findIndex(h => h === 'task'),
    dayTime:     headers.findIndex(h => h === 'day time'),
    eveningTime: headers.findIndex(h => h === 'evening time'),
    nightTime:   headers.findIndex(h => h === 'night time'),
    interval:    headers.findIndex(h => h === 'interval'),
  };

  if (idx.enabled < 0 || idx.category < 0 || idx.task < 0) return [];

  const tasks = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCSVLine(lines[i].trim());
    if (!f[idx.task]) continue;
    tasks.push({
      enabled:     (f[idx.enabled] || '').toUpperCase() === 'TRUE',
      category:    f[idx.category] || '',
      task:        f[idx.task] || '',
      dayTime:     normalizeTime(f[idx.dayTime]     || ''),
      eveningTime: normalizeTime(f[idx.eveningTime] || ''),
      nightTime:   normalizeTime(f[idx.nightTime]   || ''),
      interval:    idx.interval >= 0 && f[idx.interval] ? parseInt(f[idx.interval], 10) : null,
    });
  }
  return tasks;
}

function parseCSVLine(line) {
  const fields = [];
  let field = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i], n = line[i + 1];
    if (c === '"') { if (n === '"' && inQ) { field += '"'; i++; } else inQ = !inQ; }
    else if (c === ',' && !inQ) { fields.push(field.trim()); field = ''; }
    else field += c;
  }
  fields.push(field.trim());
  return fields;
}

function normalizeTime(s) {
  if (!s || !s.trim()) return '';
  const parts = s.trim().split(':');
  if (parts.length !== 2) return s.trim();
  return parts[0].padStart(2, '0') + ':' + parts[1].padStart(2, '0');
}

function getTasksDueAt(tasks, shiftKey, shift, nowStr, forceAll = false) {
  const [shiftStartH] = shift.start.split(':').map(Number);
  const [shiftEndH]   = shift.end.split(':').map(Number);
  const [nowH]        = nowStr.split(':').map(Number);
  const due = [];

  tasks.forEach(item => {
    if (!item.enabled) return;

    // Time-specific tasks
    let taskTime = '';
    if (shiftKey === 'day')     taskTime = item.dayTime;
    if (shiftKey === 'evening') taskTime = item.eveningTime;
    if (shiftKey === 'night')   taskTime = item.nightTime;

    if (taskTime && taskTime === nowStr && !item.interval) {
      due.push(item.task);
    }

    // Interval tasks
    if (item.interval && item.interval > 0) {
      let h = shiftStartH;
      for (let i = 0; i < 48; i++) {
        if (h === nowH && nowStr.endsWith(':00')) {
          due.push(`${item.task} (hver ${item.interval}. time)`);
          break;
        }
        h += item.interval;
        if (shiftEndH > shiftStartH) { if (h >= shiftEndH) break; }
        else { if (h >= 24) h -= 24; if (h >= shiftEndH && h < shiftStartH) break; }
      }
    }
  });

  return due;
}

// ─── KV helpers ───────────────────────────────────────────────────────────

async function loadAllSubscriptions(env) {
  const list = await env.SUBSCRIPTIONS.list();
  const results = [];
  for (const { name } of list.keys) {
    const raw = await env.SUBSCRIPTIONS.get(name);
    if (raw) {
      try {
        const { subscription, shift } = JSON.parse(raw);
        results.push({ key: name, subscription, shift });
      } catch (e) { /* skip malformed */ }
    }
  }
  return results;
}

async function hashEndpoint(endpoint) {
  const data   = new TextEncoder().encode(endpoint);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ─── Web Push (VAPID) ──────────────────────────────────────────────────────

async function sendPushNotification(env, subscription, title, body, tag) {
  const payload = JSON.stringify({ title, body, tag, icon: './icons/icon-192x192.png' });

  const vapidHeaders = await buildVapidHeaders(
    env.VAPID_PRIVATE_KEY,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_SUBJECT,
    subscription.endpoint
  );

  const headers = {
    'Content-Type':  'application/octet-stream',
    'Content-Encoding': 'aes128gcm',
    'TTL': '86400',
    ...vapidHeaders,
  };

  // Encrypt the payload using the subscription's keys
  const encrypted = await encryptPayload(payload, subscription.keys);
  headers['Content-Length'] = String(encrypted.byteLength);

  const res = await fetch(subscription.endpoint, {
    method:  'POST',
    headers,
    body:    encrypted,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Push failed ${res.status}: ${text}`);
  }
}

// ─── VAPID JWT ─────────────────────────────────────────────────────────────

async function buildVapidHeaders(privateKeyB64, publicKeyB64, subject, endpoint) {
  const audience   = new URL(endpoint).origin;
  const expiration = Math.floor(Date.now() / 1000) + 12 * 3600;

  const header  = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64url(JSON.stringify({ aud: audience, exp: expiration, sub: subject }));
  const sigInput = `${header}.${payload}`;

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    base64urlToBuffer(privateKeyB64),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(sigInput)
  );

  const jwt = `${sigInput}.${bufToB64url(sig)}`;

  return {
    'Authorization': `vapid t=${jwt}, k=${publicKeyB64}`,
  };
}

// ─── AES-128-GCM Web Push Encryption (RFC 8291) ───────────────────────────

async function encryptPayload(plaintext, keys) {
  const clientPublicKey  = base64urlToBuffer(keys.p256dh);
  const clientAuthSecret = base64urlToBuffer(keys.auth);

  // Server ephemeral ECDH key pair
  const serverKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits']
  );

  const serverPublicKeyBuffer = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);

  // Import client public key
  const clientKey = await crypto.subtle.importKey(
    'raw', clientPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );

  // ECDH shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: clientKey },
    serverKeyPair.privateKey,
    256
  );

  // Salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // HKDF key derivation
  const prk = await hkdf(clientAuthSecret, sharedSecret,
    concat(new TextEncoder().encode('WebPush: info\0'), clientPublicKey, serverPublicKeyBuffer), 32);

  const cek = await hkdf(salt, prk,
    concat(new TextEncoder().encode('Content-Encoding: aes128gcm\0'), new Uint8Array(1)), 16);

  const nonce = await hkdf(salt, prk,
    concat(new TextEncoder().encode('Content-Encoding: nonce\0'), new Uint8Array(1)), 12);

  // Encrypt
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const data   = concat(new TextEncoder().encode(plaintext), new Uint8Array([2])); // padding delimiter
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, data);

  // Build RFC 8291 header
  const serverPublicKeyBytes = new Uint8Array(serverPublicKeyBuffer);
  const header = concat(
    salt,
    new Uint8Array([0, 0, 16, 0]),           // rs = 4096 (big-endian), keyid_len = 65
    new Uint8Array([serverPublicKeyBytes.length]),
    serverPublicKeyBytes,
    new Uint8Array(ciphertext)
  );

  return header;
}

// ─── Crypto helpers ────────────────────────────────────────────────────────

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key, length * 8
  );
  return new Uint8Array(bits);
}

function concat(...arrays) {
  const total  = arrays.reduce((n, a) => n + a.byteLength, 0);
  const result = new Uint8Array(total);
  let offset   = 0;
  for (const a of arrays) { result.set(new Uint8Array(a), offset); offset += a.byteLength; }
  return result;
}

function b64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bufToB64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(b64) {
  const padded = b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(b64.length + (4 - b64.length % 4) % 4, '=');
  const binary = atob(padded);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buffer[i] = binary.charCodeAt(i);
  return buffer.buffer;
}
