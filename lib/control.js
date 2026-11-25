'use strict';
/**
 * Kontrol tab YouTube lewat CDP: memutar item, klik tombol (suka, subscribe, layar penuh, acak),
 * dan mode layar langsung (screenshot + ketuk + gulir + ketik).
 */
const cdp = require('./cdp');

const MEDIA_PAUSE = "(() => { document.querySelectorAll('video,audio').forEach((m) => { try { m.pause(); } catch (_) {} }); return true; })()";
const PLAY_EXPR = "(() => { const v = document.querySelector('video.html5-main-video') || document.querySelector('video');" +
  " if (!v) return 'none'; if (v.readyState < 2) return 'loading'; if (v.paused) { try { v.play(); } catch (_) {} return 'resumed'; } return 'playing'; })()";

// Selector tombol (jika YouTube mengubah tampilan, tambahkan di sini)
const UI = {
  like: {
    yt: ['ytd-watch-metadata like-button-view-model button', '#segmented-like-button button', 'ytd-segmented-like-dislike-button-renderer like-button-view-model button',
      'like-button-view-model button', 'ytd-toggle-button-renderer#like-button button'],
    music: ['ytmusic-player-bar ytmusic-like-button-renderer #button-shape-like button', 'ytmusic-player-bar ytmusic-like-button-renderer .like button', 'ytmusic-player-bar ytmusic-like-button-renderer .like'],
  },
  dislike: {
    yt: ['ytd-watch-metadata dislike-button-view-model button', '#segmented-dislike-button button', 'ytd-segmented-like-dislike-button-renderer dislike-button-view-model button', 'dislike-button-view-model button'],
    music: ['ytmusic-player-bar ytmusic-like-button-renderer #button-shape-dislike button', 'ytmusic-player-bar ytmusic-like-button-renderer .dislike button', 'ytmusic-player-bar ytmusic-like-button-renderer .dislike'],
  },
  subscribe: {
    yt: ['ytd-watch-metadata #subscribe-button button', 'ytd-watch-metadata yt-subscribe-button-view-model button', 'ytd-watch-metadata ytd-subscribe-button-renderer button',
      '#owner #subscribe-button button', '#subscribe-button-shape button', 'yt-subscribe-button-view-model button'],
  },
  fullscreen: { yt: ['.ytp-fullscreen-button'] },
};
const SHUFFLE_LABEL = 'shuffle|acak';
const SHUFFLE_SCOPE = 'ytmusic-player-bar, ytmusic-player-queue';
const UNSUB_LABEL = 'unsubscribe|berhenti berlangganan|batal berlangganan|batalkan langganan|hapus langganan|tidak subscribe|berhenti subscribe';

async function withSession(target, fn) {
  const sess = await cdp.session(target.page.webSocketDebuggerUrl);
  try { return await fn(sess); } finally { sess.close(); }
}

async function findTarget(site, primaryTabId) {
  const t = await cdp.pickPage(site, primaryTabId);
  if (!t) throw new Error('Tab ' + (site === 'music' ? 'YouTube Music' : 'YouTube') + ' tidak ditemukan');
  return t;
}

async function pauseOthers(exceptPageId) {
  try {
    const all = await cdp.identify();
    await Promise.all(all.filter((p) => p.page.id !== exceptPageId).map((p) => cdp.evalOnPage(p.page, MEDIA_PAUSE).catch(() => {})));
  } catch (_) { /* abaikan */ }
}

// Pastikan video mulai berputar setelah navigasi (evaluasi dengan user gesture)
async function ensurePlay(wsUrl) {
  let sess;
  try { sess = await cdp.session(wsUrl); } catch (_) { return; }
  try {
    await cdp.sleep(1500);
    let ok = 0;
    for (let i = 0; i < 11 && ok < 2; i++) {
      try {
        const r = await cdp.evalIn(sess, PLAY_EXPR, { userGesture: true });
        ok = r === 'playing' ? ok + 1 : 0;
      } catch (_) { ok = 0; }
      await cdp.sleep(700);
    }
  } finally { sess.close(); }
}

function watchUrl(spec) {
  const site = spec.site === 'music' ? 'music' : 'yt';
  const q = [];
  if (spec.videoId) q.push('v=' + encodeURIComponent(spec.videoId));
  if (spec.playlistId) q.push('list=' + encodeURIComponent(spec.playlistId));
  if (!q.length) throw new Error('Item tidak punya ID untuk diputar');
  return (site === 'music' ? 'https://music.youtube.com/watch?' : 'https://www.youtube.com/watch?') + q.join('&');
}

// Putar item di tab (situs sesuai). Tab situs lain dijeda agar tidak bertumpuk suaranya.
async function play(spec, primaryTabId) {
  const site = spec.site === 'music' ? 'music' : 'yt';
  const url = watchUrl(spec);
  const tgt = await cdp.pickPage(site, primaryTabId);
  let page;
  if (tgt) {
    page = tgt.page;
    await withSession(tgt, (s) => s.send('Page.navigate', { url }, 8000));
  } else {
    page = await cdp.openTab(url);
  }
  pauseOthers(page.id);
  ensurePlay(page.webSocketDebuggerUrl);
  return { url };
}

// Klik tepercaya pada tombol tertentu
async function ui(what, site, primaryTabId) {
  const tgt = await findTarget(site, primaryTabId);
  return withSession(tgt, async (sess) => {
    if (what === 'shuffle') {
      const pos = await cdp.evalIn(sess, cdp.finderExpr([], SHUFFLE_LABEL, SHUFFLE_SCOPE));
      if (!pos) throw new Error('Tombol acak tidak ditemukan. Buka halaman pemutar YouTube Music sekali.');
      await cdp.clickAt(sess, pos.x, pos.y);
      return true;
    }
    const sels = UI[what] && UI[what][site];
    if (!sels) throw new Error('Fitur ini tidak tersedia di ' + (site === 'music' ? 'YouTube Music' : 'YouTube'));
    const pos = await cdp.evalIn(sess, cdp.finderExpr(sels));
    if (!pos) throw new Error('Tombol tidak ditemukan (tampilan YouTube mungkin berubah)');
    await cdp.clickAt(sess, pos.x, pos.y);
    return true;
  });
}

// Subscribe / berhenti subscribe. Berhenti subscribe butuh klik menu dan konfirmasi.
async function subscribe(site, primaryTabId, currentlySubscribed) {
  if (site !== 'yt') throw new Error('Subscribe hanya untuk YouTube');
  const tgt = await findTarget(site, primaryTabId);
  return withSession(tgt, async (sess) => {
    const pos = await cdp.evalIn(sess, cdp.finderExpr(UI.subscribe.yt));
    if (!pos) throw new Error('Tombol subscribe tidak ditemukan (tampilan YouTube mungkin berubah)');
    await cdp.clickAt(sess, pos.x, pos.y);
    if (!currentlySubscribed) return 'subscribed';
    await cdp.sleep(700);
    const item = await cdp.evalIn(sess, cdp.finderExpr([], UNSUB_LABEL, 'ytd-popup-container, tp-yt-iron-dropdown'));
    if (!item) throw new Error('Menu berhenti subscribe tidak ditemukan');
    await cdp.clickAt(sess, item.x, item.y);
    await cdp.sleep(700);
    const ok = await cdp.evalIn(sess, cdp.finderExpr(['yt-confirm-dialog-renderer #confirm-button button', 'yt-confirm-dialog-renderer #confirm-button'], UNSUB_LABEL, 'yt-confirm-dialog-renderer'));
    if (ok) await cdp.clickAt(sess, ok.x, ok.y);
    return 'unsubscribed';
  });
}

// ---------- Layar langsung ----------
async function screen(site, primaryTabId, maxWidth) {
  const tgt = await findTarget(site, primaryTabId);
  return cdp.screenshot(tgt.page, maxWidth);
}
async function screenInput(site, primaryTabId, act) {
  const tgt = await findTarget(site, primaryTabId);
  return withSession(tgt, async (sess) => {
    const m = await cdp.metrics(sess);
    const f = (n) => Math.min(1, Math.max(0, Number(n) || 0));
    switch (act.type) {
      case 'tap': await cdp.clickAt(sess, f(act.fx) * m.w, f(act.fy) * m.h); break;
      case 'scroll': {
        const dy = Math.max(-3, Math.min(3, Number(act.dyf) || 0)) * m.h;
        await sess.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: f(act.fx || 0.5) * m.w, y: f(act.fy || 0.5) * m.h, deltaX: 0, deltaY: dy });
        break;
      }
      case 'text': {
        const text = String(act.text || '').slice(0, 300);
        if (text) await sess.send('Input.insertText', { text });
        break;
      }
      case 'key': await cdp.pressKey(sess, String(act.key || '')); break;
      default: throw new Error('Aksi layar tidak dikenal');
    }
    return true;
  });
}

module.exports = { play, ui, subscribe, screen, screenInput, watchUrl, ensurePlay, UI };
