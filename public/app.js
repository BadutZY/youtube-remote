(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  var SKIP_ICON = '<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>';
  var ICON = {
    play: 'M8 5v14l11-7z',
    pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
    volOn: 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0014 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    volOff: 'M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.796 8.796 0 0021 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.99 8.99 0 003.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z'
  };

  // ---------- PIN ----------
  var pin = '';
  try { pin = localStorage.getItem('skip_pin') || ''; } catch (e) {}
  var qp = new URLSearchParams(location.search).get('pin');
  if (qp) { pin = qp; try { localStorage.setItem('skip_pin', pin); } catch (e) {} history.replaceState(null, '', location.pathname); }

  // ---------- State lokal ----------
  var S = { online: false, volume: 50, muted: false, playing: false, repeat: 'off', repeatModes: ['off'], duration: 0, currentTime: 0 };
  var lock = { play: 0, mute: 0, vol: 0, rep: 0, seek: 0, like: 0, sub: 0, rate: 0 };
  var ref = { t: 0, at: Date.now(), playing: false, dur: 0 };
  var seeking = false, lastSkipsDone = null, lastSkipFail = null, sending = false, sendingTimer = null, lastThumb = '', sentAt = 0;

  function now() { return Date.now(); }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  function showPin(err) { document.body.classList.add('needpin'); $('pinErr').textContent = err || ''; }
  function hidePin() { document.body.classList.remove('needpin'); }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? h + ':' + (m < 10 ? '0' : '') + m : m) + ':' + (s < 10 ? '0' : '') + s;
  }
  function fill(el, pct) { el.parentNode.style.setProperty('--v', pct); }

  // ---------- Kirim perintah ----------
  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'x-pin': pin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    });
  }
  function cmd(type, value, extra) {
    var body = { type: type, value: value };
    if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k]; });
    return api('/api/cmd', body)
      .then(function (x) { if (!x.ok) toast(x.j.error || 'Gagal'); return x.ok; })
      .catch(function () { toast('Gagal terhubung ke server'); return false; });
  }

  // ---------- Render ----------
  function renderPlay() {
    $('playPath').setAttribute('d', S.playing ? ICON.pause : ICON.play);
  }
  function renderMute() {
    $('mutePath').setAttribute('d', S.muted || S.volume === 0 ? ICON.volOff : ICON.volOn);
    $('btnMute').classList.toggle('on', !!S.muted);
    $('muteCap').textContent = S.muted ? 'Bisu' : 'Suara';
  }
  function renderRepeat() {
    var b = $('btnRepeat');
    b.classList.toggle('on', S.repeat !== 'off');
    b.classList.toggle('one', S.repeat === 'one');
    $('repCap').textContent = S.repeat === 'all' ? 'Ulang playlist' : S.repeat === 'one' ? 'Ulang lagu' : 'Ulang: mati';
  }
  function renderVolume() {
    var v = $('vol'); v.value = S.volume; fill(v, S.volume); $('volPct').textContent = S.volume + '%';
  }
  function renderProgress() {
    if (seeking) return;
    var cur = ref.t + (ref.playing ? (now() - ref.at) / 1000 : 0);
    if (ref.dur) cur = Math.min(cur, ref.dur);
    var pct = ref.dur ? (cur / ref.dur) * 100 : 0;
    var sk = $('seek'); sk.value = Math.round(pct * 10); fill(sk, pct);
    $('tCur').textContent = fmt(cur);
    $('tDur').textContent = ref.dur ? fmt(ref.dur) : '--:--';
  }
  function setThumb(url, shape) {
    var cover = $('cover'), img = $('coverImg');
    cover.classList.toggle('square', shape === 'square');
    if (url === lastThumb) return;
    lastThumb = url;
    if (url && url.indexOf('https://') === 0) {
      img.onload = function () { cover.classList.add('has'); };
      img.onerror = function () { cover.classList.remove('has'); img.removeAttribute('src'); };
      img.src = url;
    } else {
      img.removeAttribute('src'); cover.classList.remove('has');
    }
  }

  function render(s) {
    var t = now();
    // sinkronkan state lokal dengan server, kecuali sedang ada aksi pengguna (kunci sementara)
    var prevPlaying = S.playing;
    Object.keys(s).forEach(function (k) { S[k] = s[k]; });
    if (t < lock.play) S.playing = prevPlaying;
    if (t < lock.mute) S.muted = lock._muted;
    if (t < lock.vol) S.volume = lock._vol;
    if (t < lock.rep) S.repeat = lock._rep;
    if (t < lock.like) S.like = lock._like;
    if (t < lock.sub) S.subscribed = lock._sub;
    if (t < lock.rate) S.rate = lock._rate;

    $('conn').className = 'dot' + (s.online ? ' on' : '');
    document.body.classList.toggle('offline', !s.online);
    $('diag').textContent = 'Versi: server ' + (s.serverVersion || 'lama') + ' · skrip ' + (s.scriptVersion || '-') + ' · halaman 3.0' +
      '\nKlik tepercaya (port debug Chrome): ' + (s.cdp || '-') + (s.cdpLast ? ' · ' + s.cdpLast : '') +
      (s.dbg ? '\nSkip terakhir: ' + s.dbg : '');

    if (sending && now() - sentAt > 1500 && !s.skipPending && !s.skipRunning) sending = false;
    if (lastSkipsDone !== null && s.skipsDone > lastSkipsDone) { toast('Iklan ter-skip ✔'); buzz([30, 40, 30]); sending = false; }
    lastSkipsDone = s.skipsDone;
    if (lastSkipFail !== null && s.skipFailAt > lastSkipFail) { toast('Skip belum berhasil, coba tekan lagi'); buzz([80]); sending = false; }
    lastSkipFail = s.skipFailAt || 0;

    renderExtras(s);

    if (!s.online) {
      $('site').textContent = '—';
      $('title').textContent = 'Menunggu komputer…'; $('artist').textContent = '';
      $('ad').classList.remove('show');
      setBtnSkip('', 'Lewati iklan', false);
      setDisabled(true, false);
      return;
    }

    $('site').textContent = s.site || 'YouTube';
    $('title').textContent = s.title || '—';
    $('artist').textContent = s.artist || '';
    setThumb(s.thumb || '', s.thumbShape);

    // banner iklan
    var ad = $('ad');
    if (s.skippable || s.adPlaying) {
      ad.classList.add('show'); ad.classList.toggle('ready', !!s.skippable);
      if (s.skippable) {
        $('adTitle').textContent = 'Iklan bisa di-skip!';
        var pend = sending || s.skipPending || s.skipRunning;
        $('adHint').textContent = s.skipRunning ? 'Sedang melewati iklan…' : pend ? 'Mengirim perintah skip…' : 'Tekan tombol di bawah untuk melewati iklan.';
        if (pend) setBtnSkip('wait', s.skipRunning ? 'Melewati…' : 'Mengirim…', false); else setBtnSkip('ready', 'Lewati iklan', true);
      } else {
        $('adTitle').textContent = 'Iklan sedang diputar';
        $('adHint').textContent = s.countdown || 'Tombol aktif setelah iklan bisa di-skip. Iklan tanpa tombol skip tidak bisa dilewati.';
        setBtnSkip('', 'Menunggu tombol skip…', false);
      }
    } else {
      ad.classList.remove('show');
      setBtnSkip('', 'Lewati iklan', false);
    }

    renderPlay(); renderMute(); renderRepeat();
    if (!volDragging && t >= lock.vol) renderVolume();
    else if (!volDragging) renderVolume();

    if (t >= lock.seek) { ref = { t: s.currentTime || 0, at: t, playing: !!S.playing && !seeking, dur: s.duration || 0 }; }
    else { ref.dur = s.duration || ref.dur; }
    if (t >= lock.play) ref.playing = !!s.playing;

    setDisabled(false, !!s.adPlaying);
    $('qBtnTxt').textContent = 'Daftar putar' + (s.queueCount ? ' (' + s.queueCount + ')' : '');
    if (qOpen && s.queueVer && s.queueVer !== qVer) loadQueue(false);
    if (s.skipsDone) $('foot').textContent = 'Total iklan di-skip sesi ini: ' + s.skipsDone;
    renderProgress();
  }

  function setBtnSkip(cls, text, enabled) {
    var b = $('skipBtn'); b.className = cls; b.disabled = !enabled;
    b.innerHTML = (cls === 'ready' ? SKIP_ICON : '') + '<span></span>';
    b.lastChild.textContent = text;
  }
  function setDisabled(offline, ad) {
    ['btnPlay', 'btnRepeat', 'btnMute', 'vol'].forEach(function (id) { $(id).disabled = offline; });
    $('btnPrev').disabled = offline || ad;
    $('btnNext').disabled = offline || ad;
    $('seek').disabled = offline || ad || !(S.duration > 0);
    $('btnBack').disabled = $('btnFwd').disabled = offline || ad || !(S.duration > 0);
    $('btnList').disabled = offline;
  }

  // ---------- Polling ----------
  var polling = false;
  function poll() {
    if (polling || !pin) return;
    polling = true;
    var ctl = new AbortController(); var to = setTimeout(function () { ctl.abort(); }, 4000);
    fetch('/api/state', { headers: { 'x-pin': pin }, cache: 'no-store', signal: ctl.signal })
      .then(function (r) {
        if (r.status === 401) { pin = ''; try { localStorage.removeItem('skip_pin'); } catch (e) {} showPin('PIN salah'); return null; }
        if (r.status === 429) { showPin('Terlalu banyak percobaan, tunggu 1 menit'); return null; }
        return r.json();
      })
      .then(function (s) { if (s) { hidePin(); render(s); } })
      .catch(function () {
        $('conn').className = 'dot';
        document.body.classList.add('offline');
        $('offTitle').textContent = 'Server tidak terjangkau';
        $('offHint').textContent = 'Cek WiFi HP dan pastikan server masih berjalan di komputer.';
      })
      .then(function () { clearTimeout(to); polling = false; });
  }

  // ---------- Aksi pengguna ----------
  $('skipBtn').addEventListener('click', function () {
    if ($('skipBtn').disabled) return;
    sending = true; sentAt = now(); setBtnSkip('wait', 'Mengirim…', false); buzz(20);
    clearTimeout(sendingTimer);
    sendingTimer = setTimeout(function () { sending = false; poll(); }, 14000);
    api('/api/skip')
      .then(function (x) { if (!x.ok) { sending = false; toast(x.j.error || 'Gagal'); } poll(); })
      .catch(function () { sending = false; toast('Gagal terhubung ke server'); });
  });

  $('btnPlay').addEventListener('click', function () {
    buzz(15);
    S.playing = !S.playing; lock.play = now() + 1500;
    ref = { t: ref.t + (ref.playing ? (now() - ref.at) / 1000 : 0), at: now(), playing: S.playing, dur: ref.dur };
    renderPlay();
    cmd('playpause', S.playing ? 'play' : 'pause');
  });
  $('btnNext').addEventListener('click', function () { buzz(15); cmd('next'); });
  $('btnPrev').addEventListener('click', function () { buzz(15); cmd('prev'); });

  $('btnMute').addEventListener('click', function () {
    buzz(15);
    S.muted = !S.muted; lock.mute = now() + 1500; lock._muted = S.muted;
    renderMute();
    cmd('mute', S.muted);
  });

  $('btnRepeat').addEventListener('click', function () {
    var order = ['off', 'all', 'one'].filter(function (m) { return (S.repeatModes || ['off']).indexOf(m) >= 0; });
    if (order.length < 2) { toast('Mode ulang tidak tersedia di halaman ini'); return; }
    var next = order[(order.indexOf(S.repeat) + 1) % order.length];
    buzz(15);
    S.repeat = next; lock.rep = now() + 2500; lock._rep = next;
    renderRepeat();
    cmd('repeat', next);
  });

  // Volume (seret), dikirim berkala agar halus
  var volDragging = false, volTimer = null, volLastSent = 0;
  function sendVol(v) { cmd('volume', v); volLastSent = now(); }
  $('vol').addEventListener('input', function () {
    var v = parseInt(this.value, 10) || 0;
    volDragging = true; S.volume = v; lock.vol = now() + 2000; lock._vol = v;
    if (v > 0 && S.muted) { S.muted = false; lock.mute = now() + 1500; lock._muted = false; }
    fill(this, v); $('volPct').textContent = v + '%'; renderMute();
    clearTimeout(volTimer);
    if (now() - volLastSent > 90) sendVol(v);
    else volTimer = setTimeout(function () { sendVol(v); }, 90);
  });
  $('vol').addEventListener('change', function () {
    var v = parseInt(this.value, 10) || 0;
    clearTimeout(volTimer); sendVol(v); volDragging = false; lock.vol = now() + 1500; lock._vol = v;
  });

  // Seek
  $('seek').addEventListener('input', function () {
    seeking = true;
    var f = (parseInt(this.value, 10) || 0) / 1000;
    fill(this, f * 100); $('tCur').textContent = fmt(f * (ref.dur || 0));
  });
  $('seek').addEventListener('change', function () {
    var f = (parseInt(this.value, 10) || 0) / 1000;
    lock.seek = now() + 1500;
    ref = { t: f * (ref.dur || 0), at: now(), playing: S.playing, dur: ref.dur };
    seeking = false; buzz(10);
    cmd('seek', f);
  });


  // ---------- Lompat ±detik ----------
  var fxAcc = 0, fxTimer = null;
  function showTapFx(n) {
    var fx = $('tapfx');
    fxAcc = (fx.classList.contains('show') && (fxAcc < 0) === (n < 0)) ? fxAcc + n : n;
    fx.className = 'tapfx show ' + (n < 0 ? 'left' : 'right');
    fx.textContent = (fxAcc < 0 ? '−' : '+') + Math.abs(fxAcc) + ' detik';
    clearTimeout(fxTimer);
    fxTimer = setTimeout(function () { fx.className = 'tapfx'; fxAcc = 0; }, 800);
  }
  function doSeekBy(n) {
    if (S.adPlaying) { toast('Tidak bisa saat iklan'); return; }
    if (!(S.duration > 0)) return;
    buzz(10);
    var cur = ref.t + (ref.playing ? (now() - ref.at) / 1000 : 0);
    var target = Math.max(0, Math.min(S.duration - 0.5, cur + n));
    lock.seek = now() + 1500;
    ref = { t: target, at: now(), playing: S.playing, dur: ref.dur };
    renderProgress();
    cmd('seekby', n);
    showTapFx(n);
  }
  $('btnBack').addEventListener('click', function () { doSeekBy(-10); });
  $('btnFwd').addEventListener('click', function () { doSeekBy(10); });

  // Ketuk dua kali sisi kiri/kanan cover (seperti YouTube); ketukan berikutnya menambah lagi
  var tapLast = 0, tapSide = 0, tapChain = false;
  $('cover').addEventListener('click', function (e) {
    var r = this.getBoundingClientRect();
    var side = (e.clientX - r.left) < r.width / 2 ? -1 : 1;
    var t = now(), gap = t - tapLast;
    if (side === tapSide && ((tapChain && gap < 650) || gap < 320)) { tapChain = true; doSeekBy(side * 10); }
    else tapChain = false;
    tapLast = t; tapSide = side;
  });

  // ---------- Lapisan (sheet) dengan tombol Kembali bawaan HP ----------
  var ovl = [], skipPop = 0;
  function ovOpen(id) {
    if (ovl.indexOf(id) >= 0) return;
    $(id).classList.add('open'); document.body.classList.add('noscroll'); ovl.push(id);
    try { history.pushState({ ov: ovl.length }, ''); } catch (e) {}
  }
  function ovHide(id) {
    $(id).classList.remove('open'); ovl = ovl.filter(function (x) { return x !== id; });
    if (!ovl.length) document.body.classList.remove('noscroll');
    if (id === 'sheet') qOpen = false;
    if (id === 'dsheet') dStack = [];
  }
  function ovCloseAll() {
    var n = ovl.length; if (!n) return;
    ovl.slice().forEach(ovHide);
    if (history.state && history.state.ov) { skipPop++; try { history.go(-n); } catch (e) { skipPop--; } }
  }
  function ovClose(id) {
    if (ovl.indexOf(id) < 0) return;
    ovHide(id);
    if (history.state && history.state.ov) { skipPop++; try { history.back(); } catch (e) { skipPop--; } }
  }
  window.addEventListener('popstate', function () {
    if (skipPop > 0) { skipPop--; return; }
    if (ovl.length) ovHide(ovl[ovl.length - 1]);
  });

  // ---------- Daftar putar + Antrean HP ----------
  var qOpen = false, qVer = '', qData = { items: [], cur: -1, site: '' }, qTab = 'play', hpItems = [];
  var PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
  var X_SVG = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
  function emptyMsg(box, text) { var d = document.createElement('div'); d.className = 'qempty'; d.textContent = text; box.appendChild(d); }
  function renderQueue(scrollToCur) {
    var box = $('qList'), keep = box.scrollTop;
    box.textContent = '';
    if (qTab === 'hp') { renderHp(box); return; }
    var items = qData.items || [], music = qData.site === 'YouTube Music';
    $('tabPlay').textContent = 'Daftar putar' + (items.length ? ' · ' + items.length : '');
    if (!items.length) {
      emptyMsg(box, music
        ? 'Belum ada daftar putar terbaca. Di YouTube Music, buka halaman pemutar sekali (klik gambar lagu di bar bawah) lalu coba lagi.'
        : 'Tidak ada playlist yang terbaca. Buka video yang berasal dari sebuah playlist di YouTube.');
      return;
    }
    var curEl = null;
    items.forEach(function (it, i) {
      var b = document.createElement('button'); b.className = 'qi' + (it.cur ? ' cur' : '');
      var n = document.createElement('div'); n.className = 'qn';
      if (it.cur) n.innerHTML = PLAY_SVG; else n.textContent = String(i + 1);
      var th = document.createElement('div'); th.className = 'qth' + (music ? ' sq' : '');
      if (it.th) { var im = document.createElement('img'); im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; im.src = it.th; th.appendChild(im); }
      if (!music && it.d) { var dd = document.createElement('span'); dd.className = 'qd'; dd.textContent = it.d; th.appendChild(dd); }
      var tx = document.createElement('div'); tx.className = 'qt';
      var tt = document.createElement('div'); tt.className = 'qtt'; tt.textContent = it.t;
      var ss = document.createElement('div'); ss.className = 'qs'; ss.textContent = [it.s, music ? it.d : ''].filter(Boolean).join(' · ');
      tx.appendChild(tt); tx.appendChild(ss);
      b.appendChild(n); b.appendChild(th); b.appendChild(tx);
      b.addEventListener('click', function () { pickQueue(i, it); });
      box.appendChild(b);
      if (it.cur) curEl = b;
    });
    if (scrollToCur && curEl) curEl.scrollIntoView({ block: 'center' }); else box.scrollTop = keep;
  }
  function renderHp(box) {
    $('tabHp').textContent = 'Antrean HP' + (hpItems.length ? ' · ' + hpItems.length : '');
    if (!hpItems.length) {
      emptyMsg(box, 'Antrean HP kosong. Dari hasil pencarian, beranda atau library, ketuk titik tiga lalu pilih Putar berikutnya atau Tambah ke antrean.');
      return;
    }
    hpItems.forEach(function (it, i) {
      var row = document.createElement('div'); row.className = 'row';
      var m = document.createElement('button'); m.className = 'rmain';
      var th = document.createElement('div'); th.className = 'rth' + (it.site === 'music' ? ' sq' : '');
      if (it.thumb) { var im = document.createElement('img'); im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; im.src = it.thumb; th.appendChild(im); }
      var tx = document.createElement('div'); tx.className = 'rtx';
      var t1 = document.createElement('div'); t1.className = 'rt'; t1.textContent = (i + 1) + '. ' + it.title;
      var t2 = document.createElement('div'); t2.className = 'rs'; t2.textContent = [it.kind === 'playlist' ? 'Playlist' : '', it.sub].filter(Boolean).join(' · ');
      tx.appendChild(t1); tx.appendChild(t2); m.appendChild(th); m.appendChild(tx);
      m.addEventListener('click', function () {
        api('/api/rq', { action: 'remove', id: it.id }).then(function () { return api('/api/play', it); })
          .then(function (x) { if (!x.ok) toast(x.j.error || 'Gagal memutar'); else { toast('Memutar: ' + it.title); ovCloseAll(); go('player'); } })
          .catch(function () { toast('Gagal terhubung ke server'); });
      });
      var rm = document.createElement('button'); rm.className = 'rbtn'; rm.setAttribute('aria-label', 'Hapus'); rm.innerHTML = X_SVG;
      rm.addEventListener('click', function () { api('/api/rq', { action: 'remove', id: it.id }).then(loadHp); });
      row.appendChild(m); row.appendChild(rm); box.appendChild(row);
    });
  }
  function loadHp() {
    return apiGet('/api/rq').then(function (j) { hpItems = j.items || []; if (qOpen && qTab === 'hp') renderQueue(false); $('tabHp').textContent = 'Antrean HP' + (hpItems.length ? ' · ' + hpItems.length : ''); })
      .catch(function () {});
  }
  function loadQueue(scrollToCur) {
    fetch('/api/queue', { headers: { 'x-pin': pin }, cache: 'no-store' })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .then(function (j) { if (j && qOpen) { qData = j; qVer = j.ver || ''; if (qTab === 'play') renderQueue(scrollToCur); else $('tabPlay').textContent = 'Daftar putar' + (j.items && j.items.length ? ' · ' + j.items.length : ''); } })
      .catch(function () {});
  }
  function setQTab(t) {
    qTab = t;
    $('tabPlay').classList.toggle('on', t === 'play'); $('tabHp').classList.toggle('on', t === 'hp');
    $('sheet').classList.toggle('hp', t === 'hp');
    renderQueue(true);
    if (t === 'hp') loadHp(); else loadQueue(true);
  }
  function openSheet(tab) {
    qOpen = true; ovOpen('sheet'); setQTab(tab || 'play'); loadHp();
  }
  function pickQueue(i, it) {
    buzz(15);
    if (S.adPlaying) { toast('Tunggu iklan selesai dulu'); return; }
    cmd('playqueue', i, { title: it.t }).then(function (ok) { if (ok) toast('Memutar: ' + it.t); });
    ovClose('sheet');
  }
  $('btnList').addEventListener('click', function () { openSheet('play'); });
  $('sheetClose').addEventListener('click', function () { ovClose('sheet'); });
  $('tabPlay').addEventListener('click', function () { setQTab('play'); });
  $('tabHp').addEventListener('click', function () { setQTab('hp'); });
  $('rqClear').addEventListener('click', function () { api('/api/rq', { action: 'clear' }).then(loadHp); });

  // ---------- Util v3 ----------
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function enc(x) { return encodeURIComponent(x); }
  function svgIcon(path) { return '<svg viewBox="0 0 24 24"><path d="' + path + '"/></svg>'; }
  var DOTS = 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z';
  function apiGet(path) {
    return fetch(path, { headers: { 'x-pin': pin }, cache: 'no-store' }).then(function (r) {
      if (r.status === 401) { pin = ''; try { localStorage.removeItem('skip_pin'); } catch (e) {} showPin('PIN salah'); throw new Error('PIN salah'); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('Gagal (' + r.status + ')'));
        return j;
      });
    });
  }
  function act(path, body, okMsg) {
    return api(path, body).then(function (x) {
      if (!x.ok) { toast(x.j.error || 'Gagal'); return false; }
      if (okMsg) toast(okMsg);
      return true;
    }).catch(function () { toast('Gagal terhubung ke server'); return false; });
  }

  // ---------- Navigasi ----------
  var VIEWS = ['player', 'search', 'home', 'library', 'screen'], view = 'player';
  var site = 'yt';
  try { site = localStorage.getItem('yr_site') === 'music' ? 'music' : 'yt'; } catch (e) {}
  function go(v) {
    view = v;
    VIEWS.forEach(function (id) { $('v-' + id).classList.toggle('on', id === v); });
    Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) { b.classList.toggle('on', b.getAttribute('data-v') === v); });
    updateMini();
    if (v === 'home') ensureLoaded('home');
    if (v === 'library') ensureLoaded('library');
    if (v === 'screen') startScreen(); else stopScreen();
    window.scrollTo(0, 0);
  }
  Array.prototype.forEach.call(document.querySelectorAll('#nav button'), function (b) {
    b.addEventListener('click', function () { if (ovl.length) ovCloseAll(); go(b.getAttribute('data-v')); });
  });

  // ---------- Tombol tambahan di pemutar ----------
  var RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
  function isMusic() { return S.site === 'YouTube Music'; }
  function renderExtras(s) {
    var on = !!s.online, music = isMusic();
    $('btnLike').classList.toggle('on', S.like === 'LIKE');
    $('btnDislike').classList.toggle('on', S.like === 'DISLIKE');
    $('btnSub').classList.toggle('hide', music || !S.canSubscribe);
    $('btnSub').classList.toggle('on', S.subscribed === true);
    $('subTxt').textContent = S.subscribed === true ? 'Subscribed' : 'Subscribe';
    $('btnShuffle').classList.toggle('hide', !music);
    $('btnShuffle').classList.toggle('on', S.shuffle === true);
    $('btnFull').classList.toggle('hide', music);
    $('btnLyrics').classList.toggle('hide', !music);
    $('btnLyrics').disabled = !on;
    if (ovl.indexOf('lsheet') >= 0) loadLyrics(false);
    var r = Number(S.rate) || 1;
    $('rateTxt').textContent = (Math.round(r * 100) / 100) + 'x';
    $('btnRate').classList.toggle('on', Math.abs(r - 1) > 0.01);
    var sl = Number(s.sleepLeft) || 0;
    $('sleepTxt').textContent = sl ? Math.ceil(sl / 60) + ' mnt' : 'Timer';
    $('btnSleep').classList.toggle('on', sl > 0);
    $('rqTxt').textContent = 'Antrean HP' + (s.rqCount ? ' (' + s.rqCount + ')' : '');
    var dis = !on || !!s.adPlaying;
    ['btnLike', 'btnDislike', 'btnSub', 'btnShuffle', 'btnFull'].forEach(function (id) { $(id).disabled = dis; });
    $('btnRate').disabled = dis;
    updateMini();
  }
  function updateMini() {
    var show = view !== 'player' && S.online && !!S.title;
    $('mini').classList.toggle('show', show);
    if (!show) return;
    $('miniTitle').textContent = S.title || '-';
    $('miniSub').textContent = S.artist || S.site || '';
    $('miniPath').setAttribute('d', S.playing ? ICON.pause : ICON.play);
    var img = $('miniImg'), u = (S.thumb && S.thumb.indexOf('https://') === 0) ? S.thumb : '';
    if (img.getAttribute('data-u') !== u) { img.setAttribute('data-u', u); if (u) img.src = u; else img.removeAttribute('src'); }
  }
  $('mini').addEventListener('click', function (e) { if (!e.target.closest('#miniPlay')) go('player'); });
  $('miniPlay').addEventListener('click', function () { $('btnPlay').click(); });

  $('btnLike').addEventListener('click', function () {
    buzz(15);
    S.like = S.like === 'LIKE' ? 'NONE' : 'LIKE'; lock.like = now() + 2500; lock._like = S.like; renderExtras(S);
    act('/api/ui', { what: 'like' });
  });
  $('btnDislike').addEventListener('click', function () {
    buzz(15);
    S.like = S.like === 'DISLIKE' ? 'NONE' : 'DISLIKE'; lock.like = now() + 2500; lock._like = S.like; renderExtras(S);
    act('/api/ui', { what: 'dislike' });
  });
  $('btnSub').addEventListener('click', function () {
    buzz(15);
    S.subscribed = !S.subscribed; lock.sub = now() + 3500; lock._sub = S.subscribed; renderExtras(S);
    act('/api/ui', { what: 'subscribe' });
  });
  $('btnShuffle').addEventListener('click', function () { buzz(15); act('/api/ui', { what: 'shuffle' }); });
  $('btnFull').addEventListener('click', function () { buzz(15); act('/api/ui', { what: 'fullscreen' }, 'Layar penuh di komputer'); });
  $('btnRate').addEventListener('click', function () {
    var cur = Number(S.rate) || 1, i = 0;
    for (var k = 0; k < RATES.length; k++) { if (Math.abs(RATES[k] - cur) < 0.01) { i = k; break; } }
    var next = RATES[(i + 1) % RATES.length];
    buzz(15); S.rate = next; lock.rate = now() + 2500; lock._rate = next; renderExtras(S);
    cmd('rate', next);
  });
  $('btnSleep').addEventListener('click', function () {
    var opts = [15, 30, 45, 60, 90].map(function (m) {
      return { label: m + ' menit', fn: function () { act('/api/sleep', { minutes: m }, 'Berhenti otomatis dalam ' + m + ' menit').then(poll); } };
    });
    if (S.sleepLeft) opts.push({ label: 'Matikan timer', dim: true, fn: function () { act('/api/sleep', { minutes: 0 }, 'Timer dimatikan').then(poll); } });
    openActions('Timer tidur (jeda otomatis)', opts);
  });
  $('btnRq').addEventListener('click', function () { openSheet('hp'); });

  // ---------- Menu aksi (bottom sheet) ----------
  function openActions(title, list) {
    $('aTitle').textContent = title || '';
    var box = $('aList'); box.textContent = '';
    list.forEach(function (a) {
      var b = el('button', 'aitem' + (a.dim ? ' dim' : ''), a.label);
      b.addEventListener('click', function () { ovClose('asheet'); a.fn(); });
      box.appendChild(b);
    });
    ovOpen('asheet');
  }
  $('aBack').addEventListener('click', function () { ovClose('asheet'); });

  // ---------- Daftar hasil (cari, beranda, library, detail) ----------
  function listState(box) { return { box: box, token: 0, cursor: '', site: 'yt' }; }
  var L = { search: listState($('qBox')), home: listState($('hBox')), library: listState($('lBox')), detail: listState($('dBox')) };
  function msgEl(text, cls) { return el('div', 'rmsg' + (cls ? ' ' + cls : ''), text); }

  function payload(it, s) {
    var pl = it.playlistId || (it.browseId && it.browseId.indexOf('VL') === 0 ? it.browseId.slice(2) : '');
    return {
      site: s, kind: it.kind === 'playlist' ? 'playlist' : 'video', videoId: it.kind === 'playlist' ? '' : (it.videoId || ''),
      playlistId: it.kind === 'playlist' ? pl : (it.playlistId || ''), title: it.title, sub: it.sub || '', dur: it.dur || '', thumb: it.thumb || ''
    };
  }
  function playItem(it, s) {
    var p = payload(it, s);
    if (!p.videoId && !p.playlistId) { toast('Item ini tidak bisa diputar'); return; }
    buzz(15);
    act('/api/play', p, 'Memutar: ' + it.title).then(function (ok) { if (ok) { ovCloseAll(); go('player'); setTimeout(poll, 1200); } });
  }
  function queueItem(it, s, mode) {
    var p = payload(it, s);
    if (!p.videoId && !p.playlistId) { toast('Item ini tidak bisa dimasukkan ke antrean'); return; }
    act('/api/rq', { action: mode, item: p }, mode === 'next' ? 'Akan diputar berikutnya' : 'Ditambahkan ke antrean HP').then(loadHp);
  }
  function openItem(it, st) {
    if (it.kind === 'video') return playItem(it, st.site);
    if (it.kind === 'playlist') {
      if (it.browseId) return openDetail(it.browseId, it.title, st.site);
      return playItem(it, st.site);
    }
    if (it.kind === 'channel') return openDetail(it.browseId, it.title, st.site);
  }
  function itemMenu(it, st) {
    var s = st.site, list = [];
    if (it.kind === 'video') {
      list.push({ label: 'Putar sekarang', fn: function () { playItem(it, s); } });
      list.push({ label: 'Putar berikutnya', fn: function () { queueItem(it, s, 'next'); } });
      list.push({ label: 'Tambah ke antrean HP', fn: function () { queueItem(it, s, 'add'); } });
    } else if (it.kind === 'playlist') {
      if (it.browseId) list.push({ label: 'Buka isi', fn: function () { openDetail(it.browseId, it.title, s); } });
      list.push({ label: 'Putar semua', fn: function () { playItem(it, s); } });
      list.push({ label: 'Putar berikutnya', fn: function () { queueItem(it, s, 'next'); } });
      list.push({ label: 'Tambah ke antrean HP', fn: function () { queueItem(it, s, 'add'); } });
    } else {
      list.push({ label: 'Buka', fn: function () { openDetail(it.browseId, it.title, s); } });
    }
    openActions(it.title, list);
  }
  function itemEl(it, st) {
    var music = st.site === 'music';
    var row = el('div', 'row');
    var m = el('button', 'rmain');
    var th = el('div', 'rth' + (it.kind === 'channel' ? ' ch' : (music ? ' sq' : '')));
    if (it.thumb) { var im = document.createElement('img'); im.alt = ''; im.loading = 'lazy'; im.referrerPolicy = 'no-referrer'; im.src = it.thumb; th.appendChild(im); }
    if (it.dur && it.kind === 'video' && !music) th.appendChild(el('span', 'rd', it.dur));
    var tx = el('div', 'rtx');
    tx.appendChild(el('div', 'rt', it.title));
    var sub = it.sub || '';
    if (music && it.dur) sub = [sub, it.dur].filter(Boolean).join(' · ');
    if (sub) tx.appendChild(el('div', 'rs', sub));
    m.appendChild(th); m.appendChild(tx);
    m.addEventListener('click', function () { openItem(it, st); });
    var more = el('button', 'rbtn'); more.setAttribute('aria-label', 'Menu'); more.innerHTML = svgIcon(DOTS);
    more.addEventListener('click', function () { itemMenu(it, st); });
    row.appendChild(m); row.appendChild(more);
    return row;
  }
  function renderRes(st, res, append) {
    var old = st.box.querySelector('.morebtn'); if (old) old.remove();
    var ld = st.box.querySelector('.rmsg.load'); if (ld) ld.remove();
    if (!res.count && !append) { st.box.appendChild(msgEl('Tidak ada hasil.')); return; }
    (res.sections || []).forEach(function (sec) {
      if (sec.title) st.box.appendChild(el('div', 'rhead', sec.title));
      sec.items.forEach(function (it) { st.box.appendChild(itemEl(it, st)); });
    });
    st.cursor = res.cursor || '';
    if (st.cursor) {
      var b = el('button', 'morebtn', 'Muat lebih banyak');
      b.addEventListener('click', function () { listMore(st); });
      st.box.appendChild(b);
    }
  }
  function listLoad(st, url, s, onDone) {
    var tk = ++st.token; st.site = s; st.cursor = '';
    st.box.textContent = ''; st.box.appendChild(msgEl('Memuat...', 'load'));
    apiGet(url).then(function (res) {
      if (tk !== st.token) return;
      st.box.textContent = ''; renderRes(st, res, false);
      if (onDone) onDone(res);
    }).catch(function (e) {
      if (tk !== st.token) return;
      st.box.textContent = ''; st.box.appendChild(msgEl(e.message || 'Gagal memuat', 'err'));
    });
  }
  function listMore(st) {
    if (!st.cursor) return;
    var tk = st.token, b = st.box.querySelector('.morebtn');
    if (b) { b.textContent = 'Memuat...'; b.disabled = true; }
    apiGet('/api/more?site=' + st.site + '&cursor=' + enc(st.cursor)).then(function (res) {
      if (tk !== st.token) return; renderRes(st, res, true);
    }).catch(function (e) { toast(e.message || 'Gagal memuat'); if (b) { b.textContent = 'Muat lebih banyak'; b.disabled = false; } });
  }

  // ---------- Pilih situs ----------
  function setSite(s) {
    if (s === site) return;
    site = s; try { localStorage.setItem('yr_site', s); } catch (e) {}
    renderSeg(); renderChips();
    loaded.home = loaded.library = false;
    if (view === 'home') ensureLoaded('home');
    if (view === 'library') ensureLoaded('library');
    if (view === 'search') { renderFilters(); if (sq.q) runSearch(); }
  }
  function renderSeg() {
    Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) { b.classList.toggle('on', b.getAttribute('data-site') === site); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
    b.addEventListener('click', function () { setSite(b.getAttribute('data-site')); });
  });

  // ---------- Beranda dan Library ----------
  var FEED_UI = {
    home: { yt: [['home', 'Beranda'], ['subs', 'Langganan'], ['history', 'Riwayat']],
      music: [['home', 'Beranda'], ['explore', 'Jelajah'], ['newreleases', 'Rilis baru'], ['history', 'Riwayat']] },
    library: { yt: [['playlists', 'Playlist'], ['liked', 'Video disukai'], ['watchlater', 'Tonton nanti'], ['history', 'Riwayat']],
      music: [['playlists', 'Playlist'], ['albums', 'Album'], ['artists', 'Artis'], ['liked', 'Lagu disukai'], ['history', 'Riwayat']] }
  };
  var feedSel = { home: 'home', library: 'playlists' }, loaded = { home: false, library: false };
  var CHIP_BOX = { home: 'hChips', library: 'lChips' };
  function renderChips() {
    ['home', 'library'].forEach(function (w) {
      var box = $(CHIP_BOX[w]); box.textContent = '';
      var opts = FEED_UI[w][site];
      if (!opts.some(function (o) { return o[0] === feedSel[w]; })) feedSel[w] = opts[0][0];
      opts.forEach(function (o) {
        var b = el('button', o[0] === feedSel[w] ? 'on' : '', o[1]);
        b.addEventListener('click', function () { feedSel[w] = o[0]; renderChips(); loadFeed(w); });
        box.appendChild(b);
      });
    });
  }
  function loadFeed(w) { loaded[w] = true; listLoad(L[w], '/api/browse?site=' + site + '&feed=' + enc(feedSel[w]), site); }
  function ensureLoaded(w) { if (!loaded[w]) loadFeed(w); }

  // ---------- Cari ----------
  var FILTERS = {
    yt: [['all', 'Semua'], ['video', 'Video'], ['playlist', 'Playlist'], ['channel', 'Kanal']],
    music: [['all', 'Semua'], ['song', 'Lagu'], ['video', 'Video'], ['album', 'Album'], ['artist', 'Artis'], ['playlist', 'Playlist']]
  };
  var sq = { q: '', filter: 'all' }, recent = [];
  try { recent = JSON.parse(localStorage.getItem('yr_recent') || '[]').filter(function (x) { return typeof x === 'string'; }).slice(0, 8); } catch (e) {}
  function renderFilters() {
    var box = $('qFilters'); box.textContent = '';
    var opts = FILTERS[site];
    if (!opts.some(function (o) { return o[0] === sq.filter; })) sq.filter = 'all';
    if (!sq.q) return;
    opts.forEach(function (o) {
      var b = el('button', o[0] === sq.filter ? 'on' : '', o[1]);
      b.addEventListener('click', function () { sq.filter = o[0]; renderFilters(); runSearch(); });
      box.appendChild(b);
    });
  }
  function renderRecent() {
    var box = $('qRecent'); box.textContent = '';
    if (sq.q) return;
    recent.forEach(function (q) {
      var b = el('button', '', q); b.addEventListener('click', function () { $('qInput').value = q; doSearch(q); }); box.appendChild(b);
    });
  }
  function runSearch() { listLoad(L.search, '/api/search?site=' + site + '&q=' + enc(sq.q) + '&filter=' + enc(sq.filter), site); }
  function doSearch(q) {
    q = (q || '').trim(); if (!q) return;
    sq.q = q;
    recent = [q].concat(recent.filter(function (x) { return x !== q; })).slice(0, 8);
    try { localStorage.setItem('yr_recent', JSON.stringify(recent)); } catch (e) {}
    renderFilters(); renderRecent(); runSearch();
    $('qInput').blur();
  }
  $('qGo').addEventListener('click', function () { doSearch($('qInput').value); });
  $('qInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(this.value); });
  $('qInput').addEventListener('input', function () { if (!this.value.trim()) { sq.q = ''; renderFilters(); renderRecent(); L.search.token++; L.search.box.textContent = ''; } });

  // ---------- Detail playlist, album, kanal, artis ----------
  var dStack = [], dListId = '';
  function openDetail(id, title, s) {
    if (!id) return;
    dStack.push({ id: id, title: title || '', site: s });
    if (ovl.indexOf('dsheet') < 0) ovOpen('dsheet');
    loadDetail();
  }
  function loadDetail() {
    var cur = dStack[dStack.length - 1]; if (!cur) return;
    dListId = ''; $('dTitle').textContent = cur.title || 'Memuat...'; $('dPlay').style.display = 'none';
    listLoad(L.detail, '/api/detail?site=' + cur.site + '&id=' + enc(cur.id), cur.site, function (res) {
      if (res.title) { $('dTitle').textContent = res.title; cur.title = res.title; }
      dListId = res.listId || '';
      $('dPlay').style.display = dListId ? 'block' : 'none';
      $('dBox').scrollTop = 0;
    });
  }
  $('dBack').addEventListener('click', function () {
    if (dStack.length > 1) { dStack.pop(); loadDetail(); } else ovClose('dsheet');
  });
  $('dClose').addEventListener('click', function () { ovClose('dsheet'); });
  $('dPlay').addEventListener('click', function () {
    var cur = dStack[dStack.length - 1]; if (!cur || !dListId) return;
    playItem({ kind: 'playlist', playlistId: dListId, title: cur.title || 'Playlist', sub: '', thumb: '' }, cur.site);
  });

  // ---------- Lirik (YouTube Music) ----------
  var lyKey = '', lyTok = 0, lyErr = false;
  function loadLyrics(force) {
    var box = $('lBox'), music = isMusic(), id = S.videoId || '';
    $('lTitle').textContent = S.title || 'Lirik';
    $('lArtist').textContent = S.artist || '';
    var key = (music ? 'm:' : 'x:') + id;
    if (!force && key === lyKey) return;
    lyKey = key; lyErr = false; var tk = ++lyTok;
    box.textContent = ''; box.scrollTop = 0;
    if (!music) { emptyMsg(box, 'Lirik hanya tersedia di YouTube Music.'); return; }
    if (!id) { emptyMsg(box, 'Belum ada lagu yang diputar.'); return; }
    emptyMsg(box, 'Memuat lirik...');
    apiGet('/api/lyrics?id=' + enc(id)).then(function (res) {
      if (tk !== lyTok) return;
      box.textContent = '';
      if (!res.available) { emptyMsg(box, 'Lirik tidak tersedia untuk lagu ini.'); return; }
      var t = document.createElement('div'); t.className = 'ltext'; t.textContent = res.text; box.appendChild(t);
      if (res.source) { var s = document.createElement('div'); s.className = 'lsrc'; s.textContent = res.source; box.appendChild(s); }
      box.scrollTop = 0;
    }).catch(function (e) {
      if (tk !== lyTok) return;
      lyErr = true; box.textContent = ''; emptyMsg(box, (e && e.message) || 'Gagal memuat lirik');
    });
  }
  $('btnLyrics').addEventListener('click', function () {
    buzz(15); ovOpen('lsheet'); loadLyrics(lyErr);
  });
  $('lClose').addEventListener('click', function () { ovClose('lsheet'); });

  // ---------- Layar langsung (cadangan untuk hal yang belum punya tombol sendiri) ----------
  var scrOn = false, scrTimer = null, scrUrl = '', scrSwiped = false;
  function scrLoop() {
    clearTimeout(scrTimer);
    if (!scrOn) return;
    if (document.hidden || !pin) { scrTimer = setTimeout(scrLoop, 800); return; }
    fetch('/api/screen?w=720&t=' + Date.now(), { headers: { 'x-pin': pin }, cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || 'Gagal mengambil layar'); });
        return r.blob();
      })
      .then(function (b) {
        var u = URL.createObjectURL(b), old = scrUrl;
        scrUrl = u; $('scrImg').src = u; $('scrMsg').textContent = '';
        if (old) setTimeout(function () { URL.revokeObjectURL(old); }, 1500);
      })
      .catch(function (e) { $('scrMsg').textContent = e.message || 'Gagal'; })
      .then(function () { if (scrOn) scrTimer = setTimeout(scrLoop, 450); });
  }
  function startScreen() { if (scrOn) return; scrOn = true; scrLoop(); }
  function stopScreen() { scrOn = false; clearTimeout(scrTimer); }
  function scrInput(body) {
    return act('/api/screen/input', body).then(function (ok) { if (ok && scrOn) { clearTimeout(scrTimer); scrTimer = setTimeout(scrLoop, 250); } return ok; });
  }
  (function () {
    var img = $('scrImg'), x0 = 0, y0 = 0;
    img.addEventListener('touchstart', function (e) { var t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; scrSwiped = false; }, { passive: true });
    img.addEventListener('touchend', function (e) {
      var t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0, r = img.getBoundingClientRect();
      if (Math.abs(dy) > 28 && Math.abs(dy) > Math.abs(dx)) {
        scrSwiped = true;
        scrInput({ type: 'scroll', dyf: -dy / r.height, fx: (t.clientX - r.left) / r.width, fy: (t.clientY - r.top) / r.height });
      }
    }, { passive: true });
    img.addEventListener('click', function (e) {
      if (scrSwiped) { scrSwiped = false; return; }
      var r = img.getBoundingClientRect(); buzz(10);
      scrInput({ type: 'tap', fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height });
    });
  })();
  $('scrUp').addEventListener('click', function () { scrInput({ type: 'scroll', dyf: -0.5 }); });
  $('scrDown').addEventListener('click', function () { scrInput({ type: 'scroll', dyf: 0.5 }); });
  $('scrBack').addEventListener('click', function () { scrInput({ type: 'key', key: 'Backspace' }); });
  $('scrEnter').addEventListener('click', function () { scrInput({ type: 'key', key: 'Enter' }); });
  function sendScrText() {
    var v = $('scrText').value; if (!v) return;
    scrInput({ type: 'text', text: v }).then(function (ok) { if (ok) $('scrText').value = ''; });
  }
  $('scrSend').addEventListener('click', sendScrText);
  $('scrText').addEventListener('keydown', function (e) { if (e.key === 'Enter') { sendScrText(); } });
  $('diagBtn').addEventListener('click', function () {
    var out = $('diagOut'); out.textContent = 'Memeriksa...';
    apiGet('/api/diag').then(function (d) {
      var lines = ['Port debug Chrome: ' + (d.cdp || '-')];
      if (d.error) lines.push('Masalah: ' + d.error);
      if (!d.tabs || !d.tabs.length) lines.push('Tab YouTube / YouTube Music tidak ditemukan di Chrome debug.');
      (d.tabs || []).forEach(function (t) {
        lines.push((t.site === 'music' ? 'YouTube Music' : 'YouTube') + ': ' + (t.login === true ? 'sudah login' : t.login === false ? 'BELUM login' : 'status login tidak diketahui') + (t.remote ? ' (tab remote aktif)' : ''));
      });
      out.textContent = lines.join('\n');
    }).catch(function (e) { out.textContent = e.message || 'Gagal'; });
  });

  renderSeg(); renderChips(); renderFilters(); renderRecent();

  // PIN
  function submitPin() {
    var v = $('pinInput').value.trim(); if (!v) return;
    pin = v; try { localStorage.setItem('skip_pin', pin); } catch (e) {}
    $('pinErr').textContent = ''; poll();
  }
  $('pinOk').addEventListener('click', submitPin);
  $('pinInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitPin(); });

  if (!pin) showPin(''); else poll();
  setInterval(poll, 600);
  setInterval(renderProgress, 250);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
})();
