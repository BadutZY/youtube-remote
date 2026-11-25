'use strict';
/**
 * Membaca data akun YouTube / YouTube Music yang sedang login di Chrome debug.
 * Permintaan InnerTube dikirim dari DALAM tab YouTube (cookie + SAPISIDHASH otomatis),
 * lalu JSON mentahnya diuraikan di sini menjadi daftar item sederhana untuk HP.
 */
const fs = require('fs');
const path = require('path');
const cdp = require('./cdp');

const FEEDS = {
  yt: { home: 'FEwhat_to_watch', subs: 'FEsubscriptions', history: 'FEhistory', playlists: 'FEplaylist_aggregation', liked: 'VLLL', watchlater: 'VLWL' },
  music: { home: 'FEmusic_home', explore: 'FEmusic_explore', newreleases: 'FEmusic_new_releases', history: 'FEmusic_history',
    playlists: 'FEmusic_liked_playlists', albums: 'FEmusic_liked_albums', artists: 'FEmusic_library_corpus_artists', liked: 'VLLM' },
};
const NEED_LOGIN = new Set(['subs', 'history', 'playlists', 'liked', 'watchlater', 'albums', 'artists']);
const HTML_PATHS = { home: '/', subs: '/feed/subscriptions', history: '/feed/history', playlists: '/feed/playlists', liked: '/playlist?list=LL', watchlater: '/playlist?list=WL' };

const SEARCH_YT = { all: '', video: 'EgIQAQ==', channel: 'EgIQAg==', playlist: 'EgIQAw==' };
const SEARCH_MUSIC = {
  all: '', song: 'EgWKAQIIAWoMEA4QChADEAQQCRAF', video: 'EgWKAQIQAWoMEA4QChADEAQQCRAF',
  album: 'EgWKAQIYAWoMEA4QChADEAQQCRAF', artist: 'EgWKAQIgAWoMEA4QChADEAQQCRAF', playlist: 'EgeKAQQoAEABagwQDhAKEAMQBBAJEAU=',
};

// ---------- Dijalankan di dalam halaman YouTube ----------
async function inpage(ep, body) {
  try {
    const cfg = window.ytcfg && window.ytcfg.get ? window.ytcfg : null;
    if (!cfg) return { err: 'Halaman YouTube belum siap (ytcfg tidak ada)' };
    const ctx = cfg.get('INNERTUBE_CONTEXT');
    if (!ctx) return { err: 'Konteks YouTube belum siap' };
    const key = cfg.get('INNERTUBE_API_KEY');
    const origin = location.origin;
    const headers = { 'Content-Type': 'application/json', 'X-Goog-AuthUser': '0', 'X-Origin': origin };
    const m = document.cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/) || document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/);
    if (m) {
      const ts = Math.floor(Date.now() / 1000);
      const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + m[1] + ' ' + origin));
      const hex = Array.prototype.map.call(new Uint8Array(buf), (b) => ('0' + b.toString(16)).slice(-2)).join('');
      headers.Authorization = 'SAPISIDHASH ' + ts + '_' + hex;
    }
    const cn = cfg.get('INNERTUBE_CONTEXT_CLIENT_NAME'), cv = cfg.get('INNERTUBE_CONTEXT_CLIENT_VERSION');
    if (cn) headers['X-Youtube-Client-Name'] = String(cn);
    if (cv) headers['X-Youtube-Client-Version'] = String(cv);
    if (ctx.client && ctx.client.visitorData) headers['X-Goog-Visitor-Id'] = ctx.client.visitorData;
    const url = '/youtubei/v1/' + ep + '?prettyPrint=false' + (key ? '&key=' + encodeURIComponent(key) : '');
    const r = await fetch(url, { method: 'POST', credentials: 'include', headers, body: JSON.stringify(Object.assign({ context: ctx }, body)) });
    return { status: r.status, text: await r.text(), loggedIn: !!cfg.get('LOGGED_IN') };
  } catch (e) { return { err: String(e && e.message || e) }; }
}
async function inpageHtml(p) {
  try {
    const r = await fetch(p, { credentials: 'include' });
    return { status: r.status, text: await r.text(), loggedIn: !!(window.ytcfg && window.ytcfg.get && window.ytcfg.get('LOGGED_IN')) };
  } catch (e) { return { err: String(e && e.message || e) }; }
}
const call = (fn, ...args) => '(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')';

// ---------- Halaman ----------
// Tab pembaca data hanya dibuka SATU kali per situs, walau ada beberapa permintaan sekaligus
const opening = new Map(); // site -> Promise<page>
async function openReaderTab(site, primaryTabId) {
  const again = await cdp.pickPage(site, primaryTabId); // mungkin sudah dibuka permintaan lain
  if (again) return again.page;
  const url = site === 'music' ? 'https://music.youtube.com/' : 'https://www.youtube.com/';
  const page = await cdp.openTab(url);
  for (let i = 0; i < 30; i++) {
    await cdp.sleep(500);
    try {
      const ok = await cdp.evalOnPage(page, '!!(window.ytcfg && window.ytcfg.get && window.ytcfg.get("INNERTUBE_CONTEXT"))');
      if (ok) return page;
    } catch (_) {}
  }
  throw new Error('Tab YouTube baru belum siap, coba lagi');
}
async function getPage(site, primaryTabId) {
  let t = await cdp.pickPage(site, primaryTabId);
  if (t) return t.page;
  if (!opening.has(site)) {
    const job = openReaderTab(site, primaryTabId);
    opening.set(site, job);
    const done = () => { if (opening.get(site) === job) opening.delete(site); };
    job.then(done, done);
  }
  return opening.get(site);
}

function dump(name, data) {
  if (!process.env.YT_DUMP) return;
  try {
    const dir = path.join(__dirname, '..', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name + '.json'), typeof data === 'string' ? data : JSON.stringify(data, null, 1));
  } catch (_) {}
}

async function innertube(site, ep, body, primaryTabId) {
  const page = await getPage(site, primaryTabId);
  const r = await cdp.evalOnPage(page, call(inpage, ep, body), { await: true, timeout: 25000 });
  if (!r) throw new Error('Tidak ada jawaban dari tab YouTube');
  if (r.err) throw new Error(r.err);
  if (r.status === 401 || r.status === 403) throw new Error('Sesi YouTube ditolak. Pastikan Chrome debug sudah login.');
  if (r.status !== 200) throw new Error('YouTube membalas kode ' + r.status);
  let j;
  try { j = JSON.parse(r.text); } catch (_) { throw new Error('Balasan YouTube tidak bisa dibaca'); }
  dump(site + '-' + ep.replace(/\W/g, '_') + '-' + Date.now(), r.text);
  return { data: j, loggedIn: r.loggedIn, page };
}

// Cadangan untuk YouTube biasa: baca ytInitialData dari HTML halaman
function extractInitialData(html) {
  const i = html.indexOf('ytInitialData');
  if (i < 0) return null;
  const s = html.indexOf('{', i);
  if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let k = s; k < html.length; k++) {
    const c = html[k];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(s, k + 1)); } catch (_) { return null; } } }
  }
  return null;
}
async function htmlFallback(page, p) {
  const r = await cdp.evalOnPage(page, call(inpageHtml, p), { await: true, timeout: 25000 });
  if (!r || r.err || r.status !== 200) return null;
  return extractInitialData(r.text);
}

// ---------- Uraian JSON ----------
const dig = (o, p) => { let c = o; for (const k of String(p).split('.')) { if (c == null) return undefined; c = c[k]; } return c; };
function T(o) {
  if (!o) return '';
  if (typeof o === 'string') return o;
  if (typeof o.simpleText === 'string') return o.simpleText;
  if (Array.isArray(o.runs)) return o.runs.map((r) => r.text || '').join('');
  if (typeof o.content === 'string') return o.content;
  return '';
}
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const subClean = (s) => clean(String(s || '').replace(/\s*•\s*/g, ' · '));
const TIME_RE = /^\d{1,2}(:\d{2}){1,2}$/;

function pickThumb(list, want) {
  if (!Array.isArray(list) || !list.length) return '';
  const w0 = want || 320;
  let best = null;
  for (const t of list) {
    if (!t || !t.url) continue;
    if (!best || Math.abs((t.width || 0) - w0) < Math.abs((best.width || 0) - w0)) best = t;
  }
  if (!best) return '';
  let u = best.url;
  if (u.indexOf('//') === 0) u = 'https:' + u;
  return u.indexOf('https://') === 0 ? u.slice(0, 400) : '';
}

function epInfo(ep) {
  const o = {};
  if (!ep || typeof ep !== 'object') return o;
  if (ep.watchEndpoint) { o.videoId = ep.watchEndpoint.videoId; o.playlistId = ep.watchEndpoint.playlistId; o.cfg = dig(ep.watchEndpoint, 'watchEndpointMusicSupportedConfigs.watchEndpointMusicConfig.musicVideoType'); }
  if (ep.watchPlaylistEndpoint) o.playlistId = o.playlistId || ep.watchPlaylistEndpoint.playlistId;
  if (ep.browseEndpoint) o.browseId = ep.browseEndpoint.browseId;
  if (ep.reelWatchEndpoint) o.videoId = ep.reelWatchEndpoint.videoId;
  return o;
}

function findBadge(o, depth) {
  if (!o || typeof o !== 'object' || depth > 9) return '';
  if (o.thumbnailBadgeViewModel) return T(o.thumbnailBadgeViewModel.text);
  for (const k of Object.keys(o)) { const r = findBadge(o[k], depth + 1); if (r) return r; }
  return '';
}

// ----- YouTube -----
function ytVideo(r, listId) {
  const id = r.videoId;
  if (!id) return null;
  let dur = T(r.lengthText);
  if (!dur && Array.isArray(r.thumbnailOverlays)) {
    for (const o of r.thumbnailOverlays) { if (o.thumbnailOverlayTimeStatusRenderer) { dur = T(o.thumbnailOverlayTimeStatusRenderer.text); break; } }
  }
  const sub = [T(r.ownerText || r.shortBylineText || r.longBylineText), T(r.viewCountText || r.shortViewCountText), T(r.publishedTimeText)].map(clean).filter(Boolean).join(' · ');
  return {
    kind: 'video', tag: 'video', videoId: id, title: clean(T(r.title) || T(r.headline)), sub, dur: clean(dur),
    thumb: pickThumb(dig(r, 'thumbnail.thumbnails'), 360) || ('https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/mqdefault.jpg'),
    playlistId: dig(r, 'navigationEndpoint.watchEndpoint.playlistId') || listId || '',
  };
}
function ytPlaylist(r) {
  const id = r.playlistId;
  if (!id) return null;
  const count = T(r.videoCountText) || (r.videoCount ? r.videoCount + ' video' : '');
  const thumbs = dig(r, 'thumbnails.0.thumbnails') || dig(r, 'thumbnail.thumbnails');
  return { kind: 'playlist', tag: 'playlist', playlistId: id, browseId: 'VL' + id, title: clean(T(r.title)),
    sub: [T(r.shortBylineText || r.longBylineText), count].map(clean).filter(Boolean).join(' · '), thumb: pickThumb(thumbs, 360) };
}
function ytChannel(r) {
  if (!r.channelId) return null;
  return { kind: 'channel', tag: 'channel', browseId: r.channelId, title: clean(T(r.title)),
    sub: [T(r.subscriberCountText || r.videoCountText)].map(clean).filter(Boolean).join(' · '), thumb: pickThumb(dig(r, 'thumbnail.thumbnails'), 176) };
}
function ytLockup(r, listId) {
  const type = String(r.contentType || ''), id = r.contentId || '';
  if (!id) return null;
  const md = dig(r, 'metadata.lockupMetadataViewModel') || {};
  const title = clean(T(md.title));
  const parts = [];
  for (const row of (dig(md, 'metadata.contentMetadataViewModel.metadataRows') || [])) {
    for (const p of (row.metadataParts || [])) { const s = clean(T(p.text)); if (s) parts.push(s); }
  }
  const img = r.contentImage || {};
  const thumbs = dig(img, 'thumbnailViewModel.image.sources') || dig(img, 'collectionThumbnailViewModel.primaryThumbnail.thumbnailViewModel.image.sources');
  const badge = clean(findBadge(img, 0));
  const thumb = pickThumb(thumbs, 360);
  if (type.indexOf('VIDEO') >= 0) {
    return { kind: 'video', tag: 'video', videoId: id, title, sub: parts.join(' · '), dur: TIME_RE.test(badge) ? badge : '',
      thumb: thumb || ('https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/mqdefault.jpg'), playlistId: listId || '' };
  }
  if (type.indexOf('PLAYLIST') >= 0 || type.indexOf('PODCAST') >= 0 || type.indexOf('ALBUM') >= 0) {
    return { kind: 'playlist', tag: 'playlist', playlistId: id, browseId: 'VL' + id, title, sub: [badge].concat(parts).filter(Boolean).join(' · '), thumb };
  }
  if (type.indexOf('CHANNEL') >= 0 || /^UC/.test(id)) return { kind: 'channel', tag: 'channel', browseId: id, title, sub: parts.join(' · '), thumb };
  return null;
}
function ytShort(r) {
  const id = dig(r, 'onTap.innertubeCommand.reelWatchEndpoint.videoId') || dig(r, 'inlinePlayerData.onVisible.innertubeCommand.watchEndpoint.videoId');
  if (!id) return null;
  return { kind: 'video', tag: 'video', videoId: id, title: clean(T(dig(r, 'overlayMetadata.primaryText'))), sub: clean(T(dig(r, 'overlayMetadata.secondaryText'))),
    dur: 'Shorts', thumb: pickThumb(dig(r, 'thumbnail.sources'), 360) || ('https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/mqdefault.jpg'), playlistId: '' };
}

// ----- YouTube Music -----
function musicPlayEp(r) {
  return dig(r, 'overlay.musicItemThumbnailOverlayRenderer.content.musicPlayButtonRenderer.playNavigationEndpoint');
}
function musicItem(r, listId) {
  let title = '', thumbs, nav = r.navigationEndpoint, dur = '';
  const parts = [];
  if (r.flexColumns) {
    const col = (i) => dig(r, 'flexColumns.' + i + '.musicResponsiveListItemFlexColumnRenderer.text');
    title = clean(T(col(0)));
    for (let i = 1; i < r.flexColumns.length; i++) { const s = subClean(T(col(i))); if (s) parts.push(s); }
    thumbs = dig(r, 'thumbnail.musicThumbnailRenderer.thumbnail.thumbnails');
    const fc = dig(r, 'fixedColumns.0.musicResponsiveListItemFixedColumnRenderer.text');
    if (fc) dur = clean(T(fc));
    if (!nav) nav = dig(col(0) || {}, 'runs.0.navigationEndpoint');
  } else {
    title = clean(T(r.title));
    const s = subClean(T(r.subtitle)); if (s) parts.push(s);
    thumbs = dig(r, 'thumbnailRenderer.musicThumbnailRenderer.thumbnail.thumbnails') || dig(r, 'thumbnail.musicThumbnailRenderer.thumbnail.thumbnails');
  }
  if (!title) return null;
  const n = epInfo(nav), p = epInfo(musicPlayEp(r)), pi = r.playlistItemData || {};
  let sub = parts.join(' · ');
  if (!dur) { const bits = sub.split(' · '); const last = bits[bits.length - 1]; if (TIME_RE.test(last)) { dur = last; bits.pop(); sub = bits.join(' · '); } }
  const thumb = pickThumb(thumbs, 320);
  const videoId = pi.videoId || (!n.browseId && (n.videoId || p.videoId)) || '';
  if (n.browseId && !videoId) {
    const b = n.browseId;
    if (/^(UC|MPLA)/.test(b)) return { kind: 'channel', tag: 'artist', browseId: b, title, sub, thumb };
    return { kind: 'playlist', tag: /^MPRE/.test(b) ? 'album' : 'playlist', browseId: b, playlistId: p.playlistId || n.playlistId || '', title, sub, thumb };
  }
  if (videoId) {
    const type = n.cfg || p.cfg || '';
    return { kind: 'video', tag: /ATV/.test(type) ? 'song' : /OMV|UGC/.test(type) ? 'video' : 'song', videoId, title, sub, dur,
      thumb, playlistId: n.playlistId || listId || '' };
  }
  const pl = p.playlistId || n.playlistId;
  if (pl) return { kind: 'playlist', tag: 'playlist', playlistId: pl, browseId: '', title, sub, thumb };
  return null;
}

function findTitle(root) {
  const paths = ['header.musicDetailHeaderRenderer.title', 'header.musicResponsiveHeaderRenderer.title', 'header.musicImmersiveHeaderRenderer.title',
    'header.musicVisualHeaderRenderer.title', 'header.playlistHeaderRenderer.title', 'header.pageHeaderRenderer.pageTitle',
    'header.c4TabbedHeaderRenderer.title', 'metadata.playlistMetadataRenderer.title', 'metadata.channelMetadataRenderer.title'];
  for (const p of paths) { const s = clean(T(dig(root, p))); if (s) return s; }
  return '';
}
function findListId(root) {
  let found = '';
  (function rec(o, d) {
    if (found || !o || typeof o !== 'object' || d > 40) return;
    if (o.watchPlaylistEndpoint && o.watchPlaylistEndpoint.playlistId) { found = o.watchPlaylistEndpoint.playlistId; return; }
    for (const k of Object.keys(o)) rec(o[k], d + 1);
  })(root, 0);
  if (found) return found;
  const u = dig(root, 'microformat.microformatDataRenderer.urlCanonical') || '';
  const m = /[?&]list=([\w-]+)/.exec(u);
  return m ? m[1] : '';
}

const MAX_ITEMS = 300;
function extract(root, opts) {
  const o = opts || {};
  const sections = [];
  let cur = { title: '', items: [] };
  sections.push(cur);
  let cursor = '', total = 0;
  const seen = new Set();
  const add = (it) => {
    if (!it || !it.title || total >= MAX_ITEMS) return;
    const key = it.kind + ':' + (it.videoId || '') + ':' + (it.browseId || '') + ':' + (it.playlistId || '');
    if (seen.has(key)) return;
    seen.add(key); cur.items.push(it); total++;
  };
  const section = (title, fn) => {
    cur = { title: clean(title), items: [] }; sections.push(cur);
    fn();
    cur = { title: '', items: [] }; sections.push(cur);
  };
  const listId = o.listId || '';
  (function walk(n, depth) {
    if (!n || typeof n !== 'object' || depth > 70) return;
    if (Array.isArray(n)) { for (const x of n) walk(x, depth + 1); return; }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (!v || typeof v !== 'object') continue;
      switch (k) {
        case 'videoRenderer': case 'compactVideoRenderer': case 'gridVideoRenderer': case 'playlistVideoRenderer':
        case 'playlistPanelVideoRenderer': case 'reelItemRenderer':
          add(ytVideo(v, listId)); break;
        case 'playlistRenderer': case 'gridPlaylistRenderer': case 'compactPlaylistRenderer': add(ytPlaylist(v)); break;
        case 'channelRenderer': case 'gridChannelRenderer': case 'compactChannelRenderer': add(ytChannel(v)); break;
        case 'lockupViewModel': add(ytLockup(v, listId)); break;
        case 'shortsLockupViewModel': add(ytShort(v)); break;
        case 'musicResponsiveListItemRenderer': case 'musicTwoRowItemRenderer': add(musicItem(v, listId)); break;
        case 'musicCardShelfRenderer': {
          const nav = dig(v, 'title.runs.0.navigationEndpoint') || v.onTap;
          const top = musicItem({ title: v.title, subtitle: v.subtitle, thumbnailRenderer: v.thumbnail, navigationEndpoint: nav }, listId);
          section('Hasil teratas', () => { add(top); walk(v.contents, depth + 1); });
          break;
        }
        case 'musicCarouselShelfRenderer':
          section(T(dig(v, 'header.musicCarouselShelfBasicHeaderRenderer.title')), () => walk(v.contents, depth + 1)); break;
        case 'musicShelfRenderer': case 'musicPlaylistShelfRenderer':
          section(T(v.title), () => { walk(v.contents, depth + 1); walk(v.continuations, depth + 1); }); break;
        case 'shelfRenderer': case 'richShelfRenderer': case 'reelShelfRenderer':
          section(T(v.title), () => walk(v, depth + 1)); break;
        case 'itemSectionRenderer': {
          const t = T(dig(v, 'header.itemSectionHeaderRenderer.title'));
          if (t) section(t, () => walk(v.contents, depth + 1)); else walk(v, depth + 1);
          break;
        }
        case 'continuationCommand': if (!cursor && v.token) cursor = v.token; break;
        case 'nextContinuationData': if (!cursor && v.continuation) cursor = v.continuation; break;
        case 'menu': case 'menuRenderer': case 'thumbnailOverlays': case 'overlay': case 'playbackTracking': case 'trackingParams': break;
        default: walk(v, depth + 1);
      }
    }
  })(root, 0);
  const out = sections.filter((s) => s.items.length);
  return { title: findTitle(root), sections: out, count: total, cursor, listId: listId || findListId(root) };
}

// ---------- API tingkat tinggi ----------
const countOf = (r) => r.count;
function wrap(r, ep, extra) { return Object.assign({ title: r.title, sections: r.sections, count: r.count, cursor: r.cursor ? ep + ':' + r.cursor : '', listId: r.listId }, extra || {}); }

async function getFeed(site, feed, primaryTabId) {
  const id = (FEEDS[site] || {})[feed];
  if (!id) throw new Error('Feed tidak dikenal');
  let res = await innertube(site, 'browse', { browseId: id }, primaryTabId);
  if (NEED_LOGIN.has(feed) && res.loggedIn === false) throw new Error('Chrome debug belum login ke akun YouTube');
  let r = extract(res.data, { listId: /^VL/.test(id) ? id.slice(2) : '' });
  if (!countOf(r) && site === 'yt' && HTML_PATHS[feed]) {
    const d = await htmlFallback(res.page, HTML_PATHS[feed]);
    if (d) r = extract(d, { listId: /^VL/.test(id) ? id.slice(2) : '' });
  }
  return wrap(r, 'browse');
}

async function search(site, q, filter, primaryTabId) {
  q = clean(q).slice(0, 200);
  if (!q) throw new Error('Kata kunci kosong');
  const table = site === 'music' ? SEARCH_MUSIC : SEARCH_YT;
  const params = table[filter] || '';
  let res = await innertube(site, 'search', params ? { query: q, params } : { query: q }, primaryTabId);
  let r = extract(res.data);
  if (!countOf(r) && params) { res = await innertube(site, 'search', { query: q }, primaryTabId); r = extract(res.data); }
  if (!countOf(r) && site === 'yt') {
    const d = await htmlFallback(res.page, '/results?search_query=' + encodeURIComponent(q) + (params ? '&sp=' + encodeURIComponent(params) : ''));
    if (d) r = extract(d);
  }
  return wrap(r, 'search');
}

async function detail(site, id, primaryTabId) {
  id = String(id || '');
  if (!/^[\w-]{3,80}$/.test(id)) throw new Error('ID tidak valid');
  const res = await innertube(site, 'browse', { browseId: id }, primaryTabId);
  const listId = /^VL/.test(id) ? id.slice(2) : '';
  const r = extract(res.data, { listId });
  if (!countOf(r) && site === 'yt') {
    const p = /^VL/.test(id) ? '/playlist?list=' + id.slice(2) : '/channel/' + id;
    const d = await htmlFallback(res.page, p);
    if (d) return wrap(extract(d, { listId }), 'browse');
  }
  return wrap(r, 'browse');
}

async function more(site, cursor, primaryTabId) {
  const i = String(cursor || '').indexOf(':');
  const ep = String(cursor || '').slice(0, i), token = String(cursor || '').slice(i + 1);
  if (!['search', 'browse'].includes(ep) || !token) throw new Error('Kursor tidak valid');
  const res = await innertube(site, ep, { continuation: token }, primaryTabId);
  return wrap(extract(res.data), ep);
}

// ---------- Lirik (hanya YouTube Music) ----------
// Lirik adalah tab di balik endpoint 'next' (browseId diawali MPLY), isinya diambil lewat 'browse'.
const lyricsCache = new Map(); // videoId -> { at, res }
function findLyricsTab(o, depth) {
  if (!o || typeof o !== 'object' || depth > 16) return '';
  if (Array.isArray(o)) { for (const x of o) { const r = findLyricsTab(x, depth + 1); if (r) return r; } return ''; }
  const tr = o.tabRenderer;
  if (tr && !tr.unselectable) {
    const id = dig(tr, 'endpoint.browseEndpoint.browseId');
    if (typeof id === 'string' && /^MPLY/.test(id)) return id;
  }
  for (const k of Object.keys(o)) { const r = findLyricsTab(o[k], depth + 1); if (r) return r; }
  return '';
}
function findShelf(o, depth) {
  if (!o || typeof o !== 'object' || depth > 16) return null;
  if (o.musicDescriptionShelfRenderer) return o.musicDescriptionShelfRenderer;
  const list = Array.isArray(o) ? o : Object.keys(o).map((k) => o[k]);
  for (const x of list) { const r = findShelf(x, depth + 1); if (r) return r; }
  return null;
}
async function lyrics(videoId, primaryTabId) {
  videoId = String(videoId || '');
  if (!/^[\w-]{6,20}$/.test(videoId)) throw new Error('ID lagu tidak valid');
  const hit = lyricsCache.get(videoId);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.res;
  let browseId = '';
  const bodies = [
    { videoId, isAudioOnly: true, enablePersistentPlaylistPanel: true, tunerSettingValue: 'AUTOMIX_SETTING_NORMAL' },
    { videoId },
  ];
  for (const b of bodies) {
    const nx = await innertube('music', 'next', b, primaryTabId);
    browseId = findLyricsTab(nx.data, 0);
    if (browseId) break;
  }
  let res = { available: false, text: '', source: '' };
  if (browseId) {
    const br = await innertube('music', 'browse', { browseId }, primaryTabId);
    const shelf = findShelf(br.data, 0);
    const text = shelf ? T(shelf.description).replace(/\r\n?/g, '\n').trim() : '';
    if (text) res = { available: true, text: text.slice(0, 20000), source: clean(T(shelf.footer)).slice(0, 120) };
  }
  lyricsCache.set(videoId, { at: Date.now(), res });
  if (lyricsCache.size > 60) lyricsCache.delete(lyricsCache.keys().next().value);
  return res;
}

async function diag(primaryTabId) {
  const out = { cdp: cdp.info.status, tabs: [] };
  try {
    const pages = await cdp.identify();
    for (const p of pages) {
      let login = null;
      try { login = await cdp.evalOnPage(p.page, '!!(window.ytcfg && window.ytcfg.get && window.ytcfg.get("LOGGED_IN"))'); } catch (_) {}
      out.tabs.push({ site: p.site, login, remote: p.tabId === primaryTabId });
    }
  } catch (e) { out.error = e.message; }
  return out;
}

module.exports = { FEEDS, extract, extractInitialData, getFeed, search, detail, more, lyrics, diag };
