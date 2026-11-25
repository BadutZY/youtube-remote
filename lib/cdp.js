'use strict';
/**
 * Primitif Chrome DevTools Protocol (CDP).
 * Tanpa dependensi: memakai fetch dan WebSocket bawaan Node.js 22+.
 * Dipakai untuk: membaca data akun YouTube, membuka/memutar item, klik tepercaya,
 * dan mode layar langsung.
 */
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
const URL_RE = process.env.CDP_URL_RE ? new RegExp(process.env.CDP_URL_RE) : /^https:\/\/(www|music)\.youtube\.com\//;

const info = { status: 'belum dicek', last: '' }; // status: aktif | mati | tab YouTube tidak ada | Node terlalu lama

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasWs = () => typeof WebSocket !== 'undefined';

function http(p, opts) {
  return fetch('http://127.0.0.1:' + CDP_PORT + p, Object.assign({ signal: AbortSignal.timeout(2500) }, opts || {}))
    .then((r) => r.text())
    .then((t) => { try { return t ? JSON.parse(t) : {}; } catch (_) { return { raw: t }; } });
}

function session(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pend = new Map();
    const to = setTimeout(() => { try { ws.close(); } catch (_) {} reject(new Error('timeout ws')); }, 4000);
    ws.onopen = () => {
      clearTimeout(to);
      resolve({
        send(method, params, ms) {
          return new Promise((res, rej) => {
            const i = ++id;
            const timer = setTimeout(() => { if (pend.has(i)) { pend.delete(i); rej(new Error('timeout ' + method)); } }, ms || 3000);
            pend.set(i, { res, rej, timer });
            try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { clearTimeout(timer); pend.delete(i); rej(e); }
          });
        },
        close() { try { ws.close(); } catch (_) {} },
      });
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (_) { return; }
      const p = pend.get(m.id);
      if (p) { clearTimeout(p.timer); pend.delete(m.id); if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result); }
    };
    ws.onclose = () => { for (const p of pend.values()) { clearTimeout(p.timer); p.rej(new Error('ws closed')); } pend.clear(); };
    ws.onerror = () => { clearTimeout(to); reject(new Error('ws error')); };
  });
}

async function probe() {
  if (!hasWs()) { info.status = 'Node terlalu lama (butuh v22+)'; return false; }
  try { await http('/json/version'); info.status = 'aktif'; return true; } catch (_) { info.status = 'mati'; return false; }
}

function requireCdp() {
  if (!hasWs()) throw new Error('Node.js terlalu lama (butuh v22 atau lebih baru)');
  if (info.status === 'mati') throw new Error('Chrome debug belum aktif. Jalankan start-chrome-debug.bat');
}

async function listPages() {
  requireCdp();
  let list;
  try { list = await http('/json/list'); } catch (_) { info.status = 'mati'; throw new Error('Chrome debug belum aktif. Jalankan start-chrome-debug.bat'); }
  info.status = 'aktif';
  return list.filter((t) => t.type === 'page' && URL_RE.test(t.url || '') && t.webSocketDebuggerUrl);
}

const siteOfUrl = (u) => (String(u).indexOf('https://music.youtube.com') === 0 ? 'music' : 'yt');

async function evalIn(sess, expression, opts) {
  const o = opts || {};
  const r = await sess.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: !!o.await, userGesture: !!o.userGesture,
  }, o.timeout || 3000);
  if (r && r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error((d.exception && d.exception.description) || d.text || 'evaluate gagal');
  }
  return r && r.result ? r.result.value : undefined;
}

async function evalOnPage(page, expression, opts) {
  const sess = await session(page.webSocketDebuggerUrl);
  try { return await evalIn(sess, expression, opts); } finally { sess.close(); }
}

// Daftar tab YouTube beserta ID tab dari userscript (atribut data-skip-remote-tab)
async function identify() {
  const pages = await listPages();
  return Promise.all(pages.map(async (page) => {
    let tabId = '';
    try { tabId = (await evalOnPage(page, "document.documentElement.getAttribute('data-skip-remote-tab')||''")) || ''; } catch (_) {}
    return { page, site: siteOfUrl(page.url), tabId };
  }));
}

// Pilih tab untuk situs tertentu: tab utama (yang dipantau userscript) lebih dulu
async function pickPage(site, primaryTabId) {
  const all = await identify();
  const same = all.filter((p) => p.site === site);
  if (primaryTabId) { const m = same.find((p) => p.tabId === primaryTabId); if (m) return m; }
  return same[0] || null;
}

async function openTab(url) {
  requireCdp();
  // Dibuka di latar belakang supaya jendela Chrome debug tidak melompat ke depan
  try {
    const v = await http('/json/version');
    if (v && v.webSocketDebuggerUrl) {
      const bs = await session(v.webSocketDebuggerUrl);
      try {
        const r = await bs.send('Target.createTarget', { url, background: true }, 4000);
        if (r && r.targetId) {
          for (let i = 0; i < 12; i++) {
            const list = await http('/json/list');
            const found = Array.isArray(list) && list.find((x) => x.id === r.targetId);
            if (found && found.webSocketDebuggerUrl) return found;
            await sleep(150);
          }
        }
      } finally { bs.close(); }
    }
  } catch (_) { /* lanjut ke cara biasa */ }
  let t;
  try { t = await http('/json/new?' + url, { method: 'PUT' }); } catch (_) { t = null; }
  if (!t || !t.webSocketDebuggerUrl) { try { t = await http('/json/new?' + url); } catch (_) { t = null; } }
  if (!t || !t.webSocketDebuggerUrl) throw new Error('Gagal membuka tab baru di Chrome');
  return t;
}

// ---------- Input ----------
async function clickAt(sess, x, y) {
  const base = { x, y, button: 'left', clickCount: 1 };
  await sess.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await sess.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', buttons: 1 }, base));
  await sess.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', buttons: 0 }, base));
}

const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' }, Backspace: { code: 'Backspace', vk: 8 }, Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 }, ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 }, ArrowRight: { code: 'ArrowRight', vk: 39 }, ' ': { code: 'Space', vk: 32, text: ' ' },
};
async function pressKey(sess, key) {
  const k = KEYS[key];
  if (!k) throw new Error('Tombol tidak dikenal');
  const p = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
  await sess.send('Input.dispatchKeyEvent', Object.assign({ type: k.text ? 'keyDown' : 'rawKeyDown' }, p, k.text ? { text: k.text } : {}));
  await sess.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, p));
}

// ---------- Pencari elemen (dievaluasi di halaman) ----------
// Mengembalikan pusat elemen yang terlihat, atau null. Bisa berdasarkan selector atau teks label.
function finderExpr(selectors, labelRe, scope) {
  return '(() => {' +
    'const sels = ' + JSON.stringify(selectors || []) + ';' +
    'const labelRe = ' + (labelRe ? 'new RegExp(' + JSON.stringify(labelRe) + ', "i")' : 'null') + ';' +
    'const scope = ' + JSON.stringify(scope || '') + ';' +
    'const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;' +
    ' const cs = getComputedStyle(el); return cs.display !== "none" && cs.visibility !== "hidden" && parseFloat(cs.opacity) !== 0 && !el.disabled; };' +
    'let b = null;' +
    'for (const s of sels) { let l; try { l = document.querySelectorAll(s); } catch (_) { continue; }' +
    ' for (const n of l) { const x = n.closest("button") || n; if (vis(x)) { b = x; break; } } if (b) break; }' +
    'if (!b && labelRe) { const root = scope ? document.querySelectorAll(scope) : [document];' +
    ' for (const r0 of root) { for (const n of r0.querySelectorAll("[aria-label], button, tp-yt-paper-item, ytd-menu-service-item-renderer, yt-list-item-view-model")) {' +
    '  const lab = (n.getAttribute("aria-label") || n.title || n.textContent || "").trim().replace(/\\s+/g, " ");' +
    '  if (lab && lab.length < 80 && labelRe.test(lab)) { const x = n.closest("button, tp-yt-paper-icon-button, tp-yt-paper-item") || n; if (vis(x)) { b = x; break; } } } if (b) break; } }' +
    'if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 };' +
    '})()';
}

// ---------- Layar ----------
async function metrics(sess) {
  const m = await sess.send('Page.getLayoutMetrics');
  const v = m.cssVisualViewport || m.visualViewport || {};
  return { w: v.clientWidth || 1280, h: v.clientHeight || 720, px: v.pageX || 0, py: v.pageY || 0 };
}
async function screenshot(page, maxWidth) {
  const sess = await session(page.webSocketDebuggerUrl);
  try {
    const m = await metrics(sess);
    const scale = Math.min(1, (maxWidth || 800) / m.w);
    const r = await sess.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 55, fromSurface: true,
      clip: { x: m.px, y: m.py, width: m.w, height: m.h, scale },
    }, 6000);
    return Buffer.from(r.data, 'base64');
  } finally { sess.close(); }
}

module.exports = {
  CDP_PORT, URL_RE, info, sleep, hasWs, http, session, probe, requireCdp, listPages, siteOfUrl,
  evalIn, evalOnPage, identify, pickPage, openTab, clickAt, pressKey, finderExpr, metrics, screenshot,
};
