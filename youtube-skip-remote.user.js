// ==UserScript==
// @name         YouTube Skip Remote
// @namespace    local.youtube-skip-remote
// @version      3.1.0
// @description  Remote YouTube / YouTube Music dari HP: skip iklan, volume, mute, next/prev, pause/play, seek, ulang, kecepatan, status suka/subscribe.
// @match        https://www.youtube.com/*
// @match        https://music.youtube.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @connect      localhost
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ====== PENGATURAN ======
  const SERVER = 'http://127.0.0.1:3737'; // ubah jika PORT server diganti
  const LOOP_DELAY_MS = 120;              // jeda antar laporan (server menahan balasan hingga ~0,6 dtk)
  const SHOW_DOT = true;                  // titik kecil indikator koneksi (kiri-bawah)
  const DEBUG = false;                    // true = log ke console (F12)

  // Tombol skip iklan (jika YouTube mengubah tampilan, tambahkan di sini)
  const SKIP_SELECTORS = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button',
    '.ytp-ad-skip-button-container button',
    '.ytp-skip-ad button',
    'button[class*="skip-ad"]',
    'button[id^="skip-button"]',
    '.videoAdUiSkipButton',
  ];
  const SKIP_TEXT_RE = /^\s*(skip|lewati)\b/i;
  const COUNTDOWN_SELECTORS = [
    '.ytp-ad-preview-text',
    '.ytp-ad-preview-text-modern',
    '.ytp-preskip-ad-slot',
    '.ytp-ad-text',
  ];

  // Tombol pemutar
  const PLAY_SELECTORS = ['ytmusic-player-bar #play-pause-button', '.ytp-play-button'];
  const NEXT_SELECTORS = ['ytmusic-player-bar .next-button', '.ytp-next-button'];
  const PREV_SELECTORS = ['ytmusic-player-bar .previous-button', '.ytp-prev-button'];
  const MUSIC_REPEAT_SELECTOR = 'ytmusic-player-bar .repeat';
  const YT_PLAYLIST_LOOP_SELECTOR = 'ytd-playlist-loop-button-renderer button';
  // ========================

  const VERSION = '3.1.0';
  let lastDbg = '';   // catatan teknis percobaan skip terakhir (tampil di halaman HP)
  const IS_MUSIC = location.hostname === 'music.youtube.com';
  const TAB_ID = Math.random().toString(36).slice(2, 10);
  // Penanda tab agar server (lewat port debug Chrome) tahu tab mana yang dipantau skrip ini
  try { document.documentElement.setAttribute('data-skip-remote-tab', TAB_ID); } catch (_) {}
  const log = (...a) => { if (DEBUG) console.log('[SkipRemote]', ...a); };
  const txt = (el) => (el && el.textContent ? el.textContent.trim().replace(/\s+/g, ' ') : '');

  // ---------- Util DOM ----------
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0;
  }
  function isUsable(btn) {
    return !!btn && isVisible(btn) && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true';
  }
  function findUsable(selectors) {
    for (const sel of selectors) {
      let nodes;
      try { nodes = document.querySelectorAll(sel); } catch (_) { continue; }
      for (const n of nodes) {
        const btn = n.closest('button') || n;
        if (isUsable(btn)) return btn;
      }
    }
    return null;
  }
  function getVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video');
  }
  function getPlayer() {
    return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  }
  function adShowing() {
    const p = getPlayer();
    return !!p && (p.classList.contains('ad-showing') || p.classList.contains('ad-interrupting'));
  }

  // ---------- Iklan ----------
  function findSkipButton() {
    const b = findUsable(SKIP_SELECTORS);
    if (b) return b;
    const scope = document.querySelectorAll('.video-ads button, .ytp-ad-module button, .ytp-ad-player-overlay-layout button');
    for (const el of scope) {
      if (SKIP_TEXT_RE.test((el.textContent || '').trim()) && isUsable(el)) return el;
    }
    return null;
  }
  function readCountdown() {
    for (const sel of COUNTDOWN_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) {
        const t = txt(el);
        if (t) return t.slice(0, 60);
      }
    }
    return '';
  }
  function clickElement(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try { el.dispatchEvent(new PointerEvent('pointerdown', o)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mousedown', o));
    try { el.dispatchEvent(new PointerEvent('pointerup', o)); } catch (_) {}
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  }
  // Pelacak iklan: setiap iklan baru (termasuk iklan berurutan yang durasinya sama) mendapat nomor baru
  let adSeq = 0, lastAdShowing = false, lastAdDur = 0, lastAdCur = 0, mainRate = 1;
  function trackAd() {
    const showing = adShowing();
    const v = getVideo();
    if (showing && v) {
      const dur = Number.isFinite(v.duration) ? v.duration : 0;
      const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
      if (!lastAdShowing || (dur && Math.abs(dur - lastAdDur) > 0.05) || cur + 1 < lastAdCur) adSeq += 1;
      lastAdDur = dur; lastAdCur = cur;
    }
    else if (v && v.playbackRate && !skipJob) mainRate = v.playbackRate;
    lastAdShowing = showing;
  }

  // Skip bertahap. YouTube mengabaikan klik buatan skrip (isTrusted=false) pada tombol skip,
  // jadi klik hanya percobaan pertama; cara yang andal adalah memajukan video iklan ke akhir.
  // Hasil (berhasil/gagal) ditentukan di sini dan dilaporkan ke server, bukan ditebak server.
  const SKIP_TIMEOUT_MS = 9000;
  let skipJob = null;                 // { id, t0, seq, clicks, lastClick, lastSeek, notes }
  let skipResult = { id: 0, ok: false }; // hasil terakhir, dilaporkan terus ke server

  function startSkip(id, seekDelay) {
    if (skipJob) { skipJob.id = id; return; } // sedang berjalan: hasilnya dilaporkan atas id terbaru
    trackAd();
    skipJob = { id, seekDelay, t0: Date.now(), seq: adSeq, clicks: 0, lastClick: 0, lastSeek: 0, notes: [] };
    try {
      const v0 = getVideo(), b0 = findSkipButton(), pl = getPlayer();
      skipJob.notes.push('awal[show=' + adShowing() + ' btn=' + (b0 ? (b0.className || b0.id || 'ya').toString().slice(0, 30) : 'tidak') +
        ' dur=' + (v0 ? v0.duration : 'x') + ' t=' + (v0 ? v0.currentTime.toFixed(1) : 'x') + ' rs=' + (v0 ? v0.readyState : 'x') +
        ' cls=' + (pl ? (pl.className || '').toString().split(/\s+/).filter((c) => /ad/.test(c)).join(',') : 'noplayer') + ']');
    } catch (_) {}
    lastDbg = 'skip dimulai';
    stepSkip();
  }
  function finishSkip(ok, note) {
    if (!skipJob) return;
    try { const v = getVideo(); if (v && skipJob.boosted) v.playbackRate = mainRate; } catch (_) {}
    lastDbg = skipJob.notes.concat(note).join(' > ');
    skipResult = { id: skipJob.id, ok };
    log('skip selesai', ok, lastDbg);
    skipJob = null;
  }
  function stepSkip() {
    if (!skipJob) return;
    const j = skipJob;
    trackAd();
    const btn = findSkipButton();
    const showing = adShowing();
    const el = Date.now() - j.t0;

    // Berhasil: iklan sudah berganti / selesai, atau tidak ada lagi iklan yang tampil
    if (adSeq !== j.seq) return finishSkip(true, 'iklan berganti/selesai (' + el + ' ms)');
    if (!showing && !btn) return finishSkip(true, 'iklan selesai (' + el + ' ms)');
    if (el > SKIP_TIMEOUT_MS + (j.seekDelay > 500 ? 2000 : 0)) return finishSkip(false, 'GAGAL: iklan masih ada setelah ' + SKIP_TIMEOUT_MS + ' ms');

    // 1) klik tombol (cukup sekali di awal, lalu sesekali diulang)
    if (btn && (j.clicks === 0 || (el > 2500 && Date.now() - j.lastClick > 2000))) {
      j.clicks += 1; j.lastClick = Date.now();
      if (j.clicks === 1) j.notes.push('klik');
      clickElement(btn);
      try { btn.click(); } catch (_) {}
    }

    // 2) iklan masih ada setelah 0,5 dtk: majukan video iklan ke akhir (diulang tiap 0,8 dtk).
    //    Dijalankan juga bila penanda "ad-showing" tidak ada tetapi tombol skip terlihat.
    if (el >= j.seekDelay && Date.now() - j.lastSeek >= 800 && (showing || btn)) {
      const v = getVideo();
      if (v) {
        j.lastSeek = Date.now();
        let end = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
        if (!end) { try { if (v.seekable && v.seekable.length) end = v.seekable.end(v.seekable.length - 1); } catch (_) {} }
        if (end > 0) {
          const before = v.currentTime;
          try { v.currentTime = end; } catch (_) {}
          j.seeks = (j.seeks || 0) + 1;
          if (j.seeks <= 3) j.notes.push('loncat#' + j.seeks + ' ' + before.toFixed(1) + '->' + end.toFixed(1) + ' sekarang=' + v.currentTime.toFixed(1));
        } else if (!j.noDur) { j.noDur = true; j.notes.push('durasi tidak valid'); }
        // cadangan: percepat putaran iklan agar cepat habis jika loncat tidak menempel
        if (el >= j.seekDelay + 1500 && !j.boosted) { j.boosted = true; try { v.playbackRate = 16; } catch (_) {} j.notes.push('x16'); }
        if (v.paused) { try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
      }
    }
    setTimeout(stepSkip, 150);
  }

  // ---------- Info lagu ----------
  function readMeta() {
    const docTitle = document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube( Music)?$/i, '').trim();
    const videoId = new URLSearchParams(location.search).get('v') || '';
    let title = docTitle;
    let artist = '';
    let thumb = '';
    let shape = 'wide';

    if (IS_MUSIC) {
      const bar = document.querySelector('ytmusic-player-bar');
      const t = txt(bar && bar.querySelector('.title'));
      if (t) title = t;
      artist = txt(bar && bar.querySelector('.byline')).split('•')[0].trim();
      const img = bar && bar.querySelector('img.image, .image img, img');
      if (img && typeof img.src === 'string' && img.src.startsWith('https://')) {
        thumb = img.src.replace(/=w\d+-h\d+.*$/, '=w600-h600-l90-rj');
        shape = 'square';
      }
    } else {
      artist = txt(document.querySelector('ytd-watch-metadata #owner #channel-name a, #owner #channel-name a, ytd-video-owner-renderer #channel-name a'));
    }
    if (!thumb && videoId) thumb = 'https://i.ytimg.com/vi/' + encodeURIComponent(videoId) + '/hqdefault.jpg';
    return { title, artist, thumb, shape };
  }

  // ---------- Mode ulang ----------
  function ytLoopButton() {
    return document.querySelector(YT_PLAYLIST_LOOP_SELECTOR);
  }
  function readRepeat(v) {
    if (IS_MUSIC) {
      const bar = document.querySelector('ytmusic-player-bar');
      let mode = 'off';
      if (bar) {
        const a = (bar.getAttribute('repeat-mode_') || '').toUpperCase();
        if (a === 'ONE') mode = 'one';
        else if (a === 'ALL') mode = 'all';
        else if (!a) {
          const btn = bar.querySelector('.repeat');
          const label = ((btn && (btn.getAttribute('aria-label') || btn.title)) || '').toLowerCase();
          if (/\b(one|satu|1)\b/.test(label)) mode = 'one';
          else if (/\b(all|semua)\b/.test(label)) mode = 'all';
        }
      }
      return { mode, modes: ['off', 'all', 'one'] };
    }
    const lb = ytLoopButton();
    const modes = ['off', 'one'];
    if (lb) modes.splice(1, 0, 'all');
    let mode = 'off';
    if (v && v.loop) mode = 'one';
    else if (lb && lb.getAttribute('aria-pressed') === 'true') mode = 'all';
    return { mode, modes };
  }
  function setRepeat(target) {
    if (IS_MUSIC) {
      let tries = 0;
      const step = () => {
        const cur = readRepeat(getVideo()).mode;
        if (cur === target || tries >= 3) return;
        const btn = document.querySelector(MUSIC_REPEAT_SELECTOR);
        if (!btn) return;
        btn.click();
        tries += 1;
        setTimeout(step, 250);
      };
      step();
      return;
    }
    const v = getVideo();
    const lb = ytLoopButton();
    const pressed = !!lb && lb.getAttribute('aria-pressed') === 'true';
    if (target === 'one') {
      if (lb && pressed) lb.click();
      if (v) v.loop = true;
    } else if (target === 'all') {
      if (v) v.loop = false;
      if (lb && !pressed) lb.click();
    } else {
      if (v) v.loop = false;
      if (lb && pressed) lb.click();
    }
  }

  // ---------- Daftar putar / antrean ----------
  const Q_ITEMS = IS_MUSIC ? 'ytmusic-player-queue-item' : 'ytd-playlist-panel-renderer ytd-playlist-panel-video-renderer';
  const Q_TITLE = IS_MUSIC ? '.song-title' : '#video-title';
  function queueEls() { return Array.prototype.slice.call(document.querySelectorAll(Q_ITEMS)); }
  function ytId(href) {
    try { return new URL(href, location.href).searchParams.get('v') || ''; } catch (_) { return ''; }
  }
  function readQueue() {
    const items = [];
    for (const el of queueEls()) {
      const title = txt(el.querySelector(Q_TITLE));
      if (!title) continue;
      let thumb = '', sub = '', dur = '';
      if (IS_MUSIC) {
        sub = txt(el.querySelector('.byline'));
        dur = txt(el.querySelector('.duration'));
        const img = el.querySelector('img');
        if (img && typeof img.src === 'string' && img.src.startsWith('https://')) thumb = img.src;
      } else {
        sub = txt(el.querySelector('#byline'));
        dur = txt(el.querySelector('ytd-thumbnail-overlay-time-status-renderer #text, ytd-thumbnail-overlay-time-status-renderer .badge-shape-wiz__text'));
        const a = el.querySelector('a#wc-endpoint, a#thumbnail, a');
        const id = a ? ytId(a.href) : '';
        if (id) thumb = 'https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/mqdefault.jpg';
      }
      items.push({ t: title.slice(0, 120), s: sub.slice(0, 100), d: dur.slice(0, 12), th: thumb.slice(0, 300), cur: el.hasAttribute('selected') });
    }
    return items;
  }
  // Kirim antrean hanya bila berubah (atau diminta server), dibatasi tiap 1,5 dtk
  let lastQueueSent = '', queueCache = null, queueAt = 0;
  function queueForReport() {
    const now = Date.now();
    if (!queueCache || now - queueAt > 1500) {
      queueAt = now;
      let items = [];
      try { items = readQueue(); } catch (e) { log('gagal baca antrean', e); }
      queueCache = { items, json: JSON.stringify(items) };
    }
    return queueCache.json !== lastQueueSent ? queueCache : null;
  }

  function isCurrentEl(el) { return el.hasAttribute('selected'); }
  function cmdPlayQueue(idx, title) {
    if (adShowing()) return;
    const els = queueEls();
    const titleOf = (e) => txt(e.querySelector(Q_TITLE));
    let el = els[idx];
    if (title && (!el || titleOf(el) !== title)) el = els.find((e) => titleOf(e) === title) || el;
    if (!el) { lastDbg = 'daftar putar: item tidak ditemukan'; return; }
    const startId = new URLSearchParams(location.search).get('v') || '';
    lastDbg = 'pilih: ' + titleOf(el).slice(0, 40);
    if (IS_MUSIC) {
      const pb = el.querySelector('ytmusic-play-button-renderer');
      clickElement(pb || el);
      setTimeout(() => { if (!isCurrentEl(el)) { try { el.click(); } catch (_) {} } }, 900);
      setTimeout(() => {
        if (isCurrentEl(el)) return;
        try { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window })); } catch (_) {}
      }, 1800);
    } else {
      const a = el.querySelector('a#wc-endpoint, a#thumbnail, a');
      if (!a) return;
      a.click();
      // cadangan: jika navigasi bawaan YouTube tidak jalan, buka langsung tautannya
      setTimeout(() => {
        const nowId = new URLSearchParams(location.search).get('v') || '';
        if (nowId === startId && a.href) { lastDbg += ' > navigasi langsung'; location.href = a.href; }
      }, 1800);
    }
  }
  function cmdSeekBy(n) {
    if (adShowing()) return;
    const v = getVideo();
    const d = Number(n);
    if (!v || !Number.isFinite(d) || !Number.isFinite(v.duration) || v.duration <= 0) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 0.5, v.currentTime + d));
  }

  // ---------- Perintah remote ----------
  function pressKey(key, shift) {
    const o = { key, code: 'Key' + key.toUpperCase(), shiftKey: !!shift, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', o));
    document.dispatchEvent(new KeyboardEvent('keyup', o));
  }

  function cmdPlayPause(value) {
    const v = getVideo();
    if (!v) return;
    const wantPlay = value === 'play' ? true : value === 'pause' ? false : v.paused;
    if (wantPlay === !v.paused) return; // sudah sesuai
    const btn = findUsable(PLAY_SELECTORS);
    if (btn) btn.click();
    setTimeout(() => {
      // Jika tombol tidak berpengaruh, pakai kontrol bawaan video
      if (v.paused === !wantPlay) return;
      if (wantPlay) { const p = v.play(); if (p && p.catch) p.catch(() => {}); } else v.pause();
    }, 450);
  }

  function cmdNext() {
    if (adShowing()) return;
    const btn = findUsable(NEXT_SELECTORS);
    if (btn) btn.click(); else pressKey('N', true);
  }

  function cmdPrev() {
    if (adShowing()) return;
    const v = getVideo();
    const btn = findUsable(PREV_SELECTORS);
    if (btn) btn.click();
    else if (v && v.currentTime > 3) v.currentTime = 0;
    else pressKey('P', true);
  }

  function cmdMute(value) {
    const v = getVideo();
    if (!v) return;
    const target = typeof value === 'boolean' ? value : !v.muted;
    v.muted = target;
    if (!target && v.volume === 0) v.volume = 0.5;
  }

  function cmdVolume(n) {
    const v = getVideo();
    if (!v) return;
    const vol = Math.max(0, Math.min(100, Number(n))) / 100;
    if (!Number.isFinite(vol)) return;
    v.volume = vol;
    if (vol > 0 && v.muted) v.muted = false;
  }

  function cmdSeek(frac) {
    if (adShowing()) return;
    const v = getVideo();
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    const f = Math.max(0, Math.min(1, Number(frac)));
    if (!Number.isFinite(f)) return;
    v.currentTime = Math.min(v.duration - 0.5, f * v.duration);
  }

  // ---------- Buka lagu/video di tab ini (dipakai saat memilih item dari HP) ----------
  // Tab ini sendiri yang berpindah, jadi tetap di Chrome yang sedang dipakai (bukan Chrome debug).
  const AUTOPLAY_KEY = 'autoplayUntil';
  function cmdOpen(url) {
    let u;
    try { u = new URL(String(url || '')); } catch (_) { return; }
    if (u.protocol !== 'https:' || (u.hostname !== 'www.youtube.com' && u.hostname !== 'music.youtube.com') || u.pathname !== '/watch') return;
    try { GM_setValue(AUTOPLAY_KEY, Date.now() + 25000); } catch (_) {}
    lastDbg = 'buka: ' + u.hostname + u.search.slice(0, 40);
    location.assign(u.href);
  }
  // Setelah berpindah halaman, pastikan video benar-benar berputar (dicoba sampai 25 detik)
  function startAutoplayWatch() {
    let until = 0;
    try { until = Number(GM_getValue(AUTOPLAY_KEY, 0)) || 0; } catch (_) {}
    if (!until || until < Date.now()) return;
    let ok = 0, tries = 0;
    const tick = () => {
      let u = 0;
      try { u = Number(GM_getValue(AUTOPLAY_KEY, 0)) || 0; } catch (_) {}
      if (!u || u < Date.now()) return;
      tries += 1;
      const v = getVideo();
      if (v && !v.paused && !v.ended && v.readyState >= 2) ok += 1; else ok = 0;
      if (ok >= 3) { try { GM_setValue(AUTOPLAY_KEY, 0); } catch (_) {} return; }
      if (v && v.paused && v.readyState >= 2) {
        try { const p = v.play(); if (p && p.catch) p.catch(() => {}); } catch (_) {}
        if (tries % 4 === 0) { const b = findUsable(PLAY_SELECTORS); if (b) { try { b.click(); } catch (_) {} } }
      }
      setTimeout(tick, 700);
    };
    setTimeout(tick, 1200);
  }

  function runCommands(cmds) {
    for (const c of cmds) {
      try {
        log('perintah', c);
        switch (c.type) {
          case 'playpause': cmdPlayPause(c.value); break;
          case 'next': cmdNext(); break;
          case 'prev': cmdPrev(); break;
          case 'mute': cmdMute(c.value); break;
          case 'volume': cmdVolume(c.value); break;
          case 'seek': cmdSeek(c.value); break;
          case 'seekby': cmdSeekBy(c.value); break;
          case 'rate': cmdRate(c.value); break;
          case 'playqueue': cmdPlayQueue(Number(c.value), c.title || ''); break;
          case 'open': cmdOpen(c.value); break;
          case 'repeat': setRepeat(c.value); break;
          default: break;
        }
      } catch (e) { log('gagal menjalankan perintah', c, e); }
    }
  }

  // ---------- Suka / subscribe / acak (hanya dibaca; kliknya dilakukan server lewat klik tepercaya) ----------
  const YT_LIKE_SEL = 'ytd-watch-metadata like-button-view-model button, #segmented-like-button button, ytd-segmented-like-dislike-button-renderer like-button-view-model button, like-button-view-model button, ytd-toggle-button-renderer#like-button button';
  const YT_DISLIKE_SEL = 'ytd-watch-metadata dislike-button-view-model button, #segmented-dislike-button button, ytd-segmented-like-dislike-button-renderer dislike-button-view-model button, dislike-button-view-model button';
  const YT_SUB_SEL = 'ytd-watch-metadata #subscribe-button button, ytd-watch-metadata yt-subscribe-button-view-model button, ytd-watch-metadata ytd-subscribe-button-renderer button, #owner #subscribe-button button, #subscribe-button-shape button, yt-subscribe-button-view-model button';
  function readReactions() {
    try {
      if (IS_MUSIC) {
        const lb = document.querySelector('ytmusic-player-bar ytmusic-like-button-renderer');
        const st = lb ? (lb.getAttribute('like-status') || '').toUpperCase() : '';
        return { like: st === 'LIKE' ? 'LIKE' : st === 'DISLIKE' ? 'DISLIKE' : lb ? 'NONE' : '', subscribed: null, canSubscribe: false };
      }
      const lk = document.querySelector(YT_LIKE_SEL), dl = document.querySelector(YT_DISLIKE_SEL);
      let like = '';
      if (lk) like = lk.getAttribute('aria-pressed') === 'true' ? 'LIKE' : (dl && dl.getAttribute('aria-pressed') === 'true') ? 'DISLIKE' : 'NONE';
      const sb = document.querySelector(YT_SUB_SEL);
      let subscribed = null;
      if (sb) {
        const cls = (sb.className || '').toString(), lab = ((sb.getAttribute('aria-label') || '') + ' ' + txt(sb)).toLowerCase();
        if (/unsubscribe|berhenti|subscribed|disubscribe|tersubscribe/.test(lab) && !/^\s*subscribe\b/.test(lab)) subscribed = true;
        else if (/tonal/.test(cls)) subscribed = true;
        else if (/mono|filled/.test(cls) || /^\s*(subscribe|langganan)/.test(lab)) subscribed = false;
      }
      return { like, subscribed, canSubscribe: !!sb };
    } catch (_) { return { like: '', subscribed: null, canSubscribe: false }; }
  }
  function readShuffle() {
    if (!IS_MUSIC) return null;
    try {
      for (const el of document.querySelectorAll('ytmusic-player-bar [aria-label], ytmusic-player-queue [aria-label]')) {
        const lab = (el.getAttribute('aria-label') || '').toLowerCase();
        if (/shuffle|acak/.test(lab)) {
          const b = el.closest('button, tp-yt-paper-icon-button') || el;
          const on = b.getAttribute('aria-pressed') === 'true' || b.hasAttribute('active') || /\bactive\b/.test((b.className || '').toString());
          return !!on;
        }
      }
    } catch (_) {}
    return null;
  }
  function cmdRate(n) {
    const v = getVideo();
    const r = Number(n);
    if (!v || !Number.isFinite(r) || r < 0.25 || r > 2) return;
    v.playbackRate = r;
    mainRate = r;
  }

  // ---------- Status ----------
  function readState() {
    trackAd();
    const btn = findSkipButton();
    const showing = adShowing();
    const v = getVideo();
    const meta = readMeta();
    const rep = readRepeat(v);
    const rx = readReactions();
    return {
      tabId: TAB_ID,
      site: IS_MUSIC ? 'YouTube Music' : 'YouTube',
      title: meta.title,
      artist: meta.artist,
      thumb: meta.thumb,
      thumbShape: meta.shape,
      adPlaying: showing || !!btn,
      skippable: !!btn,
      countdown: showing && !btn ? readCountdown() : '',
      playing: !!v && !v.paused && !v.ended,
      volume: v ? Math.round(v.volume * 100) : 0,
      muted: v ? !!v.muted : false,
      currentTime: v && Number.isFinite(v.currentTime) ? v.currentTime : 0,
      duration: v && Number.isFinite(v.duration) ? v.duration : 0,
      repeat: rep.mode,
      repeatModes: rep.modes,
      adKey: showing || btn ? 'a' + adSeq : '',
      videoId: new URLSearchParams(location.search).get('v') || '',
      like: rx.like,
      subscribed: rx.subscribed,
      canSubscribe: rx.canSubscribe,
      shuffle: readShuffle(),
      rate: v && Number.isFinite(v.playbackRate) && !adShowing() ? v.playbackRate : mainRate,
      skipRunning: !!skipJob,
      skipDoneId: skipResult.id,
      skipOk: skipResult.ok,
      ver: VERSION,
      dbg: lastDbg,
    };
  }

  // ---------- Indikator koneksi ----------
  let dot = null;
  function setDot(ok) {
    if (!SHOW_DOT) return;
    if (!dot) {
      dot = document.createElement('div');
      dot.style.cssText = 'position:fixed;left:6px;bottom:6px;width:8px;height:8px;border-radius:50%;z-index:2147483647;pointer-events:none;opacity:.7;';
      (document.body || document.documentElement).appendChild(dot);
    }
    dot.style.background = ok ? '#22c55e' : '#ef4444';
    dot.title = ok ? 'Skip Remote: terhubung ke server' : 'Skip Remote: server tidak terjangkau';
  }

  // ---------- Loop laporan (long-poll) ----------
  function loop() {
    let data, sentQ = null;
    try {
      const st = readState();
      sentQ = queueForReport();
      if (sentQ) st.queue = sentQ.items;
      data = JSON.stringify(st);
    } catch (e) { log('gagal membaca status', e); setTimeout(loop, 1000); return; }
    GM_xmlhttpRequest({
      method: 'POST',
      url: SERVER + '/api/pc/report',
      headers: { 'Content-Type': 'application/json' },
      data,
      timeout: 4000,
      onload: (res) => {
        setDot(res.status === 200);
        if (res.status === 200 && sentQ) lastQueueSent = sentQ.json;
        try {
          const j = JSON.parse(res.responseText);
          if (j && j.needQueue) lastQueueSent = '';
          if (j && Array.isArray(j.cmds) && j.cmds.length) runCommands(j.cmds);
          if (j && j.skip) startSkip(Number(j.skipId) || 0, Number(j.seekDelay) || 500);
        } catch (_) {}
        setTimeout(loop, LOOP_DELAY_MS);
      },
      onerror: () => { setDot(false); setTimeout(loop, 1500); },
      ontimeout: () => { setDot(false); setTimeout(loop, 1500); },
    });
  }

  startAutoplayWatch();
  loop();
  log('aktif (v' + VERSION + '), tab', TAB_ID);
})();
