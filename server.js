'use strict';
/**
 * YouTube Remote - server (v3)
 * Tanpa dependensi (hanya modul bawaan Node.js; Node 22+ dibutuhkan untuk fitur Chrome debug).
 *
 * Alur:
 *  - Userscript di browser PC mengirim status ke /api/pc/report. Server menahan balasan
 *    sampai ~0,6 detik; bila ada perintah dari HP, balasan langsung dikirim (hampir instan).
 *  - Halaman HP membaca status dari /api/state, mengirim perintah ke /api/cmd dan /api/skip.
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cdp = require('./lib/cdp');
const yt = require('./lib/yt');
const control = require('./lib/control');

const PORT = parseInt(process.env.PORT || '3737', 10);
const CONFIG_FILE = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const STATIC = { '/app.js': 'application/javascript; charset=utf-8', '/style.css': 'text/css; charset=utf-8' };

const TAB_TTL = 5000;      // tab dianggap offline bila tidak melapor selama 5 detik
const PENDING_TTL = 3000;  // perintah skip iklan kedaluwarsa setelah 3 detik
const CMD_TTL = 6000;      // perintah remote kedaluwarsa setelah 6 detik
const HOLD_MS = 600;       // lama maksimal server menahan balasan laporan (long-poll)
const REPEATS = ['off', 'all', 'one'];
const SERVER_VERSION = '3.0';
const SKIP_RUN_TTL = 12000; // batas waktu menunggu hasil skip dari userscript

// ---------- PIN ----------
function loadPin() {
  if (process.env.PIN) return String(process.env.PIN);
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (cfg && cfg.pin) return String(cfg.pin);
  } catch (_) { /* belum ada */ }
  const pin = String(crypto.randomInt(100000, 1000000));
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ pin }, null, 2)); } catch (_) {}
  return pin;
}
const PIN = loadPin();

function pinOk(given) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(PIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Pembatasan percobaan PIN salah per IP
const fails = new Map();
function isLocked(ip) {
  const f = fails.get(ip);
  return !!(f && f.until && f.until > Date.now());
}
function registerFail(ip) {
  const f = fails.get(ip) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 8) { f.until = Date.now() + 60000; f.count = 0; }
  fails.set(ip, f);
}

// ---------- Klik tepercaya lewat Chrome DevTools Protocol ----------
// YouTube mengabaikan klik buatan skrip (isTrusted=false). Lewat port debugging Chrome,
// server mengirim klik mouse sungguhan ke tombol skip (Input.dispatchMouseEvent).
const FIND_SKIP_EXPR = `(() => {
  const sels = ['.ytp-skip-ad-button','.ytp-ad-skip-button-modern','.ytp-ad-skip-button','.ytp-ad-skip-button-container button',
    '.ytp-skip-ad button','button[class*="skip-ad"]','button[id^="skip-button"]','.videoAdUiSkipButton'];
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0 && !el.disabled && el.getAttribute('aria-disabled') !== 'true'; };
  let b = null;
  for (const s of sels) { for (const n of document.querySelectorAll(s)) { const x = n.closest('button') || n; if (vis(x)) { b = x; break; } } if (b) break; }
  if (!b) { for (const el of document.querySelectorAll('.video-ads button, .ytp-ad-module button, .ytp-ad-player-overlay-layout button'))
    if (/^\\s*(skip|lewati)\\b/i.test((el.textContent || '').trim()) && vis(el)) { b = el; break; } }
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

// true bila klik tepercaya terkirim ke tombol skip
let cdpLast = '';
async function cdpClickSkip() {
  let pages;
  try { pages = await cdp.listPages(); } catch (_) { return false; }
  if (!pages.length) { cdp.info.status = 'tab YouTube tidak ada'; return false; }
  for (const pg of pages) {
    let sess;
    try {
      sess = await cdp.session(pg.webSocketDebuggerUrl);
      const pos = await cdp.evalIn(sess, FIND_SKIP_EXPR);
      if (!pos) continue;
      await cdp.clickAt(sess, pos.x, pos.y);
      cdpLast = 'klik tepercaya @' + Math.round(pos.x) + ',' + Math.round(pos.y);
      return true;
    } catch (e) { cdpLast = 'error: ' + e.message; }
    finally { if (sess) sess.close(); }
  }
  return false;
}
// Ulangi klik tepercaya selama perintah skip masih diproses (maks 5x)
async function cdpRetryLoop(job) {
  for (let i = 0; i < 5 && skipJob === job; i++) {
    const ok = await cdpClickSkip();
    if (cdp.info.status !== 'aktif' && cdp.info.status !== 'tab YouTube tidak ada') return;
    if (ok) await new Promise((r) => setTimeout(r, 1500)); else await new Promise((r) => setTimeout(r, 500));
  }
}
cdp.probe();
setInterval(cdp.probe, 10000).unref();

// ---------- State ----------
const tabs = new Map();     // tabId -> status terakhir
const waiters = new Map();  // tabId -> { res, timer } (laporan yang sedang ditahan)
let skipSeq = 0;            // nomor perintah skip
let skipJob = null;         // { id, at, sent, sentAt } perintah skip yang sedang diproses
let skipsDone = 0;
let lastSkipAt = 0;
let skipFailAt = 0;         // waktu terakhir skip gagal
let lastPrimaryId = '';
let cmdQueue = [];          // perintah remote untuk tab utama

function primaryTab() {
  const now = Date.now();
  for (const [id, t] of tabs) if (now - t.seen > TAB_TTL) tabs.delete(id);
  const list = [...tabs.values()];
  if (!list.length) return null;
  const score = (t) => (t.skippable ? 4 : t.adPlaying ? 3 : t.playing ? 2 : 1);
  list.sort((a, b) =>
    score(b) - score(a) ||
    ((b.id === lastPrimaryId) - (a.id === lastPrimaryId)) ||
    b.seen - a.seen);
  lastPrimaryId = list[0].id;
  return list[0];
}

function pickState() {
  const t = primaryTab();
  const base = { skipsDone, lastSkipAt, skipFailAt, serverVersion: SERVER_VERSION };
  if (!t) return Object.assign({ online: false }, base);
  return Object.assign({
    online: true,
    site: t.site,
    title: t.title,
    artist: t.artist,
    thumb: t.thumb,
    thumbShape: t.thumbShape,
    playing: t.playing,
    adPlaying: t.adPlaying,
    skippable: t.skippable,
    countdown: t.countdown,
    volume: t.volume,
    muted: t.muted,
    currentTime: t.currentTime,
    duration: t.duration,
    repeat: t.repeat,
    repeatModes: t.repeatModes,
    skipPending: !!skipJob && !skipJob.sent,
    skipRunning: !!skipJob && skipJob.sent,
    cdp: cdp.info.status,
    cdpLast,
    videoId: t.videoId,
    like: t.like,
    subscribed: t.subscribed,
    canSubscribe: t.canSubscribe,
    shuffle: t.shuffle,
    rate: t.rate,
    rqCount: rq.length,
    sleepLeft: sleepAt ? Math.max(0, Math.round((sleepAt - Date.now()) / 1000)) : 0,
    queueVer: t.id + ':' + t.qv,
    queueCount: t.queue ? t.queue.length : 0,
    scriptVersion: t.ver,
    dbg: t.dbg,
  }, base);
}

// Balasan untuk userscript: skip iklan + daftar perintah remote
function buildReply(t) {
  const now = Date.now();
  let skip = false, skipId = 0;
  if (skipJob && !skipJob.sent) {
    if (now - skipJob.at >= PENDING_TTL || !(t.skippable || t.adPlaying)) skipJob = null; // iklan sudah hilang
    else { skip = true; skipId = skipJob.id; skipJob.sent = true; skipJob.sentAt = now; }
  }
  cmdQueue = cmdQueue.filter((c) => now - c.ts < CMD_TTL);
  let cmds = [];
  const p = primaryTab();
  if (p && p.id === t.id && cmdQueue.length) {
    cmds = cmdQueue.map((c) => ({ type: c.type, value: c.value, title: c.title }));
    cmdQueue = [];
  }
  // bila klik tepercaya tersedia, beri waktu lebih sebelum skrip memakai cara loncat
  return { skip, skipId, seekDelay: cdp.info.status === 'aktif' ? 2500 : 500, needQueue: t.queue === null, cmds };
}

function flush(id) {
  const w = waiters.get(id);
  if (!w) return;
  clearTimeout(w.timer);
  waiters.delete(id);
  const t = tabs.get(id);
  sendJson(w.res, 200, t ? buildReply(t) : { skip: false, cmds: [] });
}

// Bangunkan laporan tab utama yang sedang ditahan agar perintah langsung terkirim
function wake() {
  const p = primaryTab();
  if (p) flush(p.id);
}

// ---------- Perintah remote ----------
const num = (v, min, max, def = 0) => {
  v = Number(v);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;
};

function sanitizeCmd(b) {
  if (!b || typeof b !== 'object') return null;
  switch (b.type) {
    case 'playpause':
      return { type: 'playpause', value: (b.value === 'play' || b.value === 'pause') ? b.value : 'toggle' };
    case 'next':
    case 'prev':
      return { type: b.type, value: null };
    case 'mute':
      return { type: 'mute', value: typeof b.value === 'boolean' ? b.value : null };
    case 'volume':
      if (!Number.isFinite(Number(b.value))) return null;
      return { type: 'volume', value: Math.round(num(b.value, 0, 100)) };
    case 'seek':
      if (!Number.isFinite(Number(b.value))) return null;
      return { type: 'seek', value: num(b.value, 0, 1) };
    case 'repeat':
      return REPEATS.includes(b.value) ? { type: 'repeat', value: b.value } : null;
    case 'rate':
      if (!Number.isFinite(Number(b.value))) return null;
      return { type: 'rate', value: Math.round(num(b.value, 0.25, 2) * 100) / 100 };
    case 'seekby': // lompat maju/mundur (detik), mis. +10 / -10
      if (!Number.isFinite(Number(b.value))) return null;
      return { type: 'seekby', value: Math.round(num(b.value, -300, 300)) };
    case 'playqueue': // pilih item daftar putar (indeks + judul untuk verifikasi)
      if (!Number.isFinite(Number(b.value))) return null;
      return { type: 'playqueue', value: Math.round(num(b.value, 0, 999)), title: str(b.title, 120) };
    default:
      return null;
  }
}

const COALESCE = new Set(['volume', 'seek', 'mute', 'repeat', 'playqueue', 'rate', 'open']); // hanya nilai terbaru yang dipakai
function enqueue(c) {
  if (COALESCE.has(c.type)) cmdQueue = cmdQueue.filter((x) => x.type !== c.type);
  cmdQueue.push({ type: c.type, value: c.value, title: c.title || '', ts: Date.now() });
  if (cmdQueue.length > 20) cmdQueue = cmdQueue.slice(-20);
}

// ---------- Antrean HP (antrean buatan sendiri, berlaku untuk YouTube dan YouTube Music) ----------
// Item di sini diputar otomatis saat lagu/video sekarang hampir habis, atau saat tombol Berikutnya ditekan.
let rq = [];
let rqSeq = 0;
let rqLock = 0;      // mencegah pemicu ganda
let sleepAt = 0;     // waktu timer tidur berakhir (ms), 0 = mati

function cleanItem(b) {
  if (!b || typeof b !== 'object') return null;
  const videoId = /^[\w-]{6,20}$/.test(b.videoId || '') ? b.videoId : '';
  const playlistId = /^[\w-]{5,80}$/.test(b.playlistId || '') ? b.playlistId : '';
  if (!videoId && !playlistId) return null;
  return {
    id: ++rqSeq,
    site: b.site === 'music' ? 'music' : 'yt',
    videoId, playlistId,
    kind: b.kind === 'playlist' ? 'playlist' : 'video',
    title: str(b.title, 120) || 'Tanpa judul',
    sub: str(b.sub, 100),
    dur: str(b.dur, 12),
    thumb: typeof b.thumb === 'string' && b.thumb.startsWith('https://') ? b.thumb.slice(0, 400) : '',
  };
}
function primaryRef() {
  const t = primaryTab();
  return t ? { id: t.id, site: t.site === 'YouTube Music' ? 'music' : 'yt', tab: t } : { id: '', site: 'yt', tab: null };
}
// Memutar item di tab yang sedang dipantau userscript (Chrome biasa maupun Chrome debug).
// Server hanya mengirim perintah 'open'; tab itu sendiri yang berpindah ke lagu/video baru,
// sehingga Chrome debug tidak ikut terbuka atau dipakai.
const ALLOW_DEBUG_OPEN = process.env.ALLOW_DEBUG_OPEN === '1';
function scriptSupportsOpen(v) {
  const m = /^(\d+)\.(\d+)/.exec(String(v || ''));
  return !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 1));
}
// Jeda tab di Chrome debug selain tab utama agar suaranya tidak bertumpuk (setara pauseOthers lama)
const MEDIA_PAUSE = "(() => { document.querySelectorAll('video,audio').forEach((m) => { try { m.pause(); } catch (_) {} }); return true; })()";
async function pauseDebugTabsExcept(primaryTabId) {
  try {
    if (cdp.info.status !== 'aktif') return;
    const all = await cdp.identify();
    await Promise.all(all.filter((x) => x.tabId !== primaryTabId).map((x) => cdp.evalOnPage(x.page, MEDIA_PAUSE).catch(() => {})));
  } catch (_) { /* abaikan */ }
}
async function playItem(it) {
  const p = primaryTab();
  if (p) {
    if (!scriptSupportsOpen(p.ver)) throw new Error('Userscript di Chrome masih versi lama. Ganti isinya dengan versi 3.1.0 di Tampermonkey, lalu muat ulang tab YouTube.');
    const url = control.watchUrl(it);
    enqueue({ type: 'open', value: url });
    pauseDebugTabsExcept(p.id); // tanpa menunggu
    wake();
    return { url, via: 'userscript' };
  }
  if (ALLOW_DEBUG_OPEN) return control.play(it, '');
  throw new Error('Belum ada tab YouTube yang terhubung. Buka YouTube atau YouTube Music di Chrome biasa (userscript harus aktif).');
}

async function advanceRemote() {
  const it = rq.shift();
  if (!it) return false;
  rqLock = Date.now() + 5000;
  try {
    await playItem(it);
    return true;
  } catch (e) { rq.unshift(it); throw e; }
}
function maybeAdvance(t) {
  if (!rq.length || Date.now() < rqLock) return;
  const p = primaryTab();
  if (!p || p.id !== t.id) return;
  if (t.adPlaying || !t.playing || !(t.duration > 3)) return;
  if (t.duration - t.currentTime > 1.2) return;
  advanceRemote().catch(() => {});
}
setInterval(() => {
  if (sleepAt && Date.now() >= sleepAt) {
    sleepAt = 0;
    enqueue({ type: 'playpause', value: 'pause' });
    wake();
  }
}, 1000).unref();

// ---------- Antrean / daftar putar ----------
function cleanQueue(arr) {
  if (!Array.isArray(arr)) return null;
  return arr.slice(0, 300).map((q) => ({
    t: str(q && q.t, 120),
    s: str(q && q.s, 100),
    d: str(q && q.d, 12),
    th: q && typeof q.th === 'string' && q.th.startsWith('https://') ? q.th.slice(0, 300) : '',
    cur: !!(q && q.cur),
  }));
}

// ---------- Util ----------
function clientIp(req) { return req.socket.remoteAddress || ''; }
function isLoopback(req) {
  const a = clientIp(req);
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function sendJson(res, code, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch (_) { /* koneksi sudah putus */ }
}
function readBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const str = (v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : '');

function requirePin(req, res) {
  const ip = clientIp(req);
  if (isLocked(ip)) { sendJson(res, 429, { error: 'Terlalu banyak percobaan. Coba lagi 1 menit lagi.' }); return false; }
  if (!pinOk(req.headers['x-pin'])) {
    registerFail(ip);
    sendJson(res, 401, { error: 'PIN salah' });
    return false;
  }
  fails.delete(ip);
  return true;
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      fs.readFile(INDEX_FILE, (err, data) => {
        if (err) { res.writeHead(500); res.end('public/index.html tidak ditemukan'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }

    if (req.method === 'GET' && STATIC[p]) {
      fs.readFile(path.join(PUBLIC_DIR, p.slice(1)), (err, data) => {
        if (err) { res.writeHead(404); res.end('tidak ditemukan'); return; }
        res.writeHead(200, { 'Content-Type': STATIC[p], 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }

    // Dari userscript di PC (hanya dari localhost)
    if (req.method === 'POST' && p === '/api/pc/report') {
      if (!isLoopback(req)) return sendJson(res, 403, { error: 'Hanya dari komputer ini' });
      let b = {};
      try { b = JSON.parse(await readBody(req, 400000)); } catch (_) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const id = str(b.tabId, 40) || 'x';
      const modes = Array.isArray(b.repeatModes) ? b.repeatModes.filter((m) => REPEATS.includes(m)).slice(0, 3) : [];
      const t = {
        id,
        seen: Date.now(),
        site: str(b.site, 40),
        title: str(b.title, 150),
        artist: str(b.artist, 150),
        countdown: str(b.countdown, 80),
        thumb: typeof b.thumb === 'string' && b.thumb.startsWith('https://') ? b.thumb.slice(0, 400) : '',
        thumbShape: b.thumbShape === 'square' ? 'square' : 'wide',
        adPlaying: !!b.adPlaying,
        skippable: !!b.skippable,
        playing: !!b.playing,
        muted: !!b.muted,
        volume: Math.round(num(b.volume, 0, 100)),
        currentTime: num(b.currentTime, 0, 1e7),
        duration: num(b.duration, 0, 1e7),
        repeat: REPEATS.includes(b.repeat) ? b.repeat : 'off',
        repeatModes: modes.length ? modes : ['off'],
        adKey: str(b.adKey, 30),
        videoId: str(b.videoId, 20),
        like: ['LIKE', 'DISLIKE', 'NONE'].includes(b.like) ? b.like : '',
        subscribed: typeof b.subscribed === 'boolean' ? b.subscribed : null,
        canSubscribe: !!b.canSubscribe,
        shuffle: typeof b.shuffle === 'boolean' ? b.shuffle : null,
        rate: num(b.rate, 0.25, 2, 1),
        ver: str(b.ver, 20),
        dbg: str(b.dbg, 700),
      };
      // antrean: hanya dikirim userscript bila berubah; simpan yang lama bila tidak ada
      const prev = tabs.get(id);
      const q = cleanQueue(b.queue);
      if (q) {
        t.queue = q;
        t.qv = (prev ? prev.qv : 0) + ((prev && prev.queue && JSON.stringify(prev.queue) === JSON.stringify(q)) ? 0 : 1);
      } else {
        t.queue = prev ? prev.queue : null;
        t.qv = prev ? prev.qv : 0;
      }
      tabs.set(id, t);
      maybeAdvance(t);

      // Hasil skip dilaporkan langsung oleh userscript (skipDoneId + skipOk)
      if (skipJob && skipJob.sent) {
        if (Number(b.skipDoneId) === skipJob.id) {
          if (b.skipOk) { skipsDone += 1; lastSkipAt = Date.now(); } else skipFailAt = Date.now();
          skipJob = null;
        } else if (Date.now() - skipJob.sentAt > SKIP_RUN_TTL) {
          skipFailAt = Date.now(); skipJob = null;
        }
      }

      // Laporan lama dari tab yang sama (jika ada) dibalas dulu
      if (waiters.has(id)) flush(id);

      const reply = buildReply(t);
      if (reply.skip || reply.cmds.length) return sendJson(res, 200, reply);

      // Tidak ada perintah: tahan sebentar, bangunkan bila ada perintah baru
      const timer = setTimeout(() => flush(id), HOLD_MS);
      waiters.set(id, { res, timer });
      res.on('close', () => {
        const w = waiters.get(id);
        if (w && w.res === res) { clearTimeout(w.timer); waiters.delete(id); }
      });
      return;
    }

    // Dari HP
    if (req.method === 'GET' && p === '/api/state') {
      if (!requirePin(req, res)) return;
      return sendJson(res, 200, pickState());
    }

    if (req.method === 'GET' && p === '/api/queue') {
      if (!requirePin(req, res)) return;
      const t = primaryTab();
      if (!t) return sendJson(res, 200, { online: false, items: [], cur: -1, site: '' });
      const items = t.queue || [];
      return sendJson(res, 200, { online: true, site: t.site, ver: t.id + ':' + t.qv, items, cur: items.findIndex((x) => x.cur) });
    }

    if (req.method === 'POST' && p === '/api/skip') {
      if (!requirePin(req, res)) return;
      const s = pickState();
      if (!s.online) return sendJson(res, 409, { error: 'Komputer belum terhubung' });
      if (skipJob) return sendJson(res, 200, { ok: true, already: true }); // skip sedang diproses
      if (!s.skippable) return sendJson(res, 409, { error: 'Iklan belum bisa di-skip' });
      skipJob = { id: ++skipSeq, at: Date.now(), sent: false, sentAt: 0 };
      cdpRetryLoop(skipJob);
      wake();
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/cmd') {
      if (!requirePin(req, res)) return;
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch (_) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const c = sanitizeCmd(b);
      if (!c) return sendJson(res, 400, { error: 'Perintah tidak valid' });
      if (!primaryTab()) return sendJson(res, 409, { error: 'Komputer belum terhubung' });
      if (c.type === 'next' && rq.length) {
        try { await advanceRemote(); return sendJson(res, 200, { ok: true, fromQueue: true }); }
        catch (e) { return sendJson(res, 502, { error: e.message || 'Gagal memutar antrean' }); }
      }
      enqueue(c);
      wake();
      return sendJson(res, 200, { ok: true });
    }

    // ----- Jelajah akun (YouTube / YouTube Music) -----
    if (req.method === 'GET' && p.startsWith('/api/') && ['/api/browse', '/api/search', '/api/detail', '/api/more', '/api/lyrics', '/api/diag'].includes(p)) {
      if (!requirePin(req, res)) return;
      const site = url.searchParams.get('site') === 'music' ? 'music' : 'yt';
      const pid = primaryRef().id;
      try {
        if (p === '/api/browse') return sendJson(res, 200, await yt.getFeed(site, url.searchParams.get('feed') || 'home', pid));
        if (p === '/api/search') return sendJson(res, 200, await yt.search(site, url.searchParams.get('q'), url.searchParams.get('filter') || 'all', pid));
        if (p === '/api/detail') return sendJson(res, 200, await yt.detail(site, url.searchParams.get('id'), pid));
        if (p === '/api/more') return sendJson(res, 200, await yt.more(site, url.searchParams.get('cursor'), pid));
        if (p === '/api/lyrics') return sendJson(res, 200, await yt.lyrics(url.searchParams.get('id'), pid));
        return sendJson(res, 200, await yt.diag(pid));
      } catch (e) { return sendJson(res, 502, { error: e.message || 'Gagal membaca YouTube' }); }
    }

    // ----- Putar item dari HP -----
    if (req.method === 'POST' && p === '/api/play') {
      if (!requirePin(req, res)) return;
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch (_) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const it = cleanItem(b);
      if (!it) return sendJson(res, 400, { error: 'Item tidak valid' });
      try { await playItem(it); return sendJson(res, 200, { ok: true }); }
      catch (e) { return sendJson(res, 502, { error: e.message || 'Gagal memutar' }); }
    }

    // ----- Antrean HP -----
    if (p === '/api/rq') {
      if (!requirePin(req, res)) return;
      if (req.method === 'GET') return sendJson(res, 200, { items: rq });
      if (req.method === 'POST') {
        let b = {};
        try { b = JSON.parse(await readBody(req)); } catch (_) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
        if (b.action === 'clear') rq = [];
        else if (b.action === 'remove') rq = rq.filter((x) => x.id !== Number(b.id));
        else if (b.action === 'add' || b.action === 'next') {
          const it = cleanItem(b.item);
          if (!it) return sendJson(res, 400, { error: 'Item tidak valid' });
          if (b.action === 'next') rq.unshift(it); else rq.push(it);
          if (rq.length > 100) rq = rq.slice(0, 100);
        } else return sendJson(res, 400, { error: 'Aksi tidak dikenal' });
        return sendJson(res, 200, { ok: true, items: rq });
      }
    }

    // ----- Tombol di halaman (suka, subscribe, layar penuh, acak) lewat klik tepercaya -----
    if (req.method === 'POST' && p === '/api/ui') {
      if (!requirePin(req, res)) return;
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch (_) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const ref = primaryRef();
      if (!ref.tab) return sendJson(res, 409, { error: 'Komputer belum terhubung' });
      if (ref.tab.adPlaying && b.what !== 'fullscreen') return sendJson(res, 409, { error: 'Tunggu iklan selesai dulu' });
      try {
        if (b.what === 'subscribe') await control.subscribe(ref.site, ref.id, !!ref.tab.subscribed);
        else if (['like', 'dislike', 'fullscreen', 'shuffle'].includes(b.what)) await control.ui(b.what, ref.site, ref.id);
        else return sendJson(res, 400, { error: 'Aksi tidak dikenal' });
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 502, { error: e.message || 'Gagal' }); }
    }

    // ----- Timer tidur -----
    if (req.method === 'POST' && p === '/api/sleep') {
      if (!requirePin(req, res)) return;
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch (_) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const m = Math.round(num(b.minutes, 0, 480));
      sleepAt = m > 0 ? Date.now() + m * 60000 : 0;
      return sendJson(res, 200, { ok: true, minutes: m });
    }

    // ----- Mode layar langsung -----
    if (req.method === 'GET' && p === '/api/screen') {
      if (!requirePin(req, res)) return;
      const ref = primaryRef();
      const site = url.searchParams.get('site') === 'music' ? 'music' : url.searchParams.get('site') === 'yt' ? 'yt' : ref.site;
      try {
        const buf = await control.screen(site, ref.id, Math.round(num(url.searchParams.get('w'), 320, 1280, 720)));
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
        return res.end(buf);
      } catch (e) { return sendJson(res, 502, { error: e.message || 'Gagal mengambil layar' }); }
    }
    if (req.method === 'POST' && p === '/api/screen/input') {
      if (!requirePin(req, res)) return;
      let b = {};
      try { b = JSON.parse(await readBody(req)); } catch (_) { return sendJson(res, 400, { error: 'JSON tidak valid' }); }
      const ref = primaryRef();
      const site = b.site === 'music' ? 'music' : b.site === 'yt' ? 'yt' : ref.site;
      try { await control.screenInput(site, ref.id, b); return sendJson(res, 200, { ok: true }); }
      catch (e) { return sendJson(res, 502, { error: e.message || 'Gagal' }); }
    }

    sendJson(res, 404, { error: 'Tidak ditemukan' });
  } catch (e) {
    sendJson(res, 500, { error: 'Kesalahan server' });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} sudah dipakai. Jalankan dengan PORT=3838 node server.js (dan ubah SERVER di userscript).`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
  }
  console.log('\n=== YouTube Remote berjalan ===');
  console.log(`PIN        : ${PIN}`);
  console.log('Buka di HP (satu WiFi dengan komputer):');
  if (!ips.length) console.log(`  http://<IP-komputer>:${PORT}/?pin=${PIN}`);
  ips.forEach((ip) => console.log(`  http://${ip}:${PORT}/?pin=${PIN}`));
  console.log('\nTekan Ctrl+C untuk berhenti.\n');
});

server.cdpClickSkip = cdpClickSkip; // untuk pengujian
server._test = { cleanItem, get rq() { return rq; } };
module.exports = server;
