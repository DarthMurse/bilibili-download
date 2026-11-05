// Bilibili web API helpers: video info, play URLs (with WBI signing), stream selection.
// Requests go out with the user's bilibili.com cookies, so logged-in / VIP qualities work.

import { md5 } from './md5.js';

const MIXIN_KEY_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
];

const CODEC_NAMES = { 7: 'AVC', 12: 'HEVC', 13: 'AV1' };
// Lower rank = preferred. AVC plays everywhere, so it is the default.
const CODEC_RANK = { 7: 0, 12: 1, 13: 2 };
const AUDIO_NAMES = { 30216: '64K', 30232: '132K', 30280: '192K', 30250: 'Dolby Atmos', 30251: 'Hi-Res FLAC' };

async function getJSON(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(`Bilibili API error ${json.code}: ${json.message}`);
  return json.data ?? json.result;
}

/** Extract { bvid } or { aid } plus part number from a bilibili.com URL. Returns null if not a video page. */
export function parseVideoUrl(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (!/(^|\.)bilibili\.com$/.test(u.hostname)) return null;
  const p = parseInt(u.searchParams.get('p'), 10) || 1;
  const bvid = u.pathname.match(/\/(BV[0-9A-Za-z]{10})/)?.[1] ?? u.searchParams.get('bvid');
  if (bvid && /^BV[0-9A-Za-z]{10}$/.test(bvid)) return { bvid, p };
  const aid = u.pathname.match(/\/av(\d+)/i)?.[1];
  if (aid) return { aid, p };
  return null;
}

/** Login state plus the WBI keys. The endpoint answers code -101 when logged out, but still includes wbi_img. */
export async function getNav() {
  const res = await fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' });
  const json = await res.json();
  return json.data ?? {};
}

let mixinKeyCache = null;

async function getMixinKey() {
  const day = new Date().toDateString();
  if (mixinKeyCache?.day === day) return mixinKeyCache.key;
  const img = (await getNav()).wbi_img;
  if (!img) throw new Error('Could not read WBI keys');
  const stem = (u) => u.slice(u.lastIndexOf('/') + 1).split('.')[0];
  const raw = stem(img.img_url) + stem(img.sub_url);
  const key = MIXIN_KEY_TABLE.map((i) => raw[i]).join('').slice(0, 32);
  mixinKeyCache = { day, key };
  return key;
}

export async function signWbi(params) {
  const key = await getMixinKey();
  const all = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${md5(query + key)}`;
}

/** Title, cover, uploader and the list of parts (each part has its own cid). */
export async function getVideoInfo({ bvid, aid }) {
  const q = bvid ? `bvid=${bvid}` : `aid=${aid}`;
  const d = await getJSON(`https://api.bilibili.com/x/web-interface/view?${q}`);
  return {
    bvid: d.bvid,
    aid: d.aid,
    title: d.title,
    pic: d.pic?.replace(/^http:/, 'https:'),
    owner: d.owner?.name,
    pages: (d.pages ?? []).map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration })),
  };
}

/** Raw playurl response. Asks for every DASH variant (HDR, 4K, 8K, Dolby, AV1). */
export async function getPlayUrl(bvid, cid) {
  const params = { bvid, cid, qn: 127, fnval: 4048, fnver: 0, fourk: 1 };
  try {
    return await getJSON(`https://api.bilibili.com/x/player/wbi/playurl?${await signWbi(params)}`);
  } catch (e) {
    console.warn('WBI playurl failed, falling back to legacy endpoint', e);
    return getJSON(`https://api.bilibili.com/x/player/playurl?${new URLSearchParams(params)}`);
  }
}

// PCDN hosts (mcdn / custom ports) are often slow or refuse foreign clients; try the main CDN first.
function orderUrls(base, backups) {
  const urls = [base, ...(backups ?? [])].filter(Boolean);
  const isPcdn = (u) => /mcdn\.bilivideo|szbdyd\.com|:\d{4,5}\//.test(u);
  return [...urls.filter((u) => !isPcdn(u)), ...urls.filter(isPcdn)];
}

/** Turn a playurl response into sorted, labelled video/audio stream lists. */
export function buildStreams(play) {
  const names = new Map();
  for (const f of play.support_formats ?? []) names.set(f.quality, f.new_description || f.display_desc);
  (play.accept_quality ?? []).forEach((q, i) => names.has(q) || names.set(q, play.accept_description?.[i]));
  const bestOffered = Math.max(0, ...(play.accept_quality ?? []));

  if (!play.dash) {
    // Very old uploads only have progressive FLV/MP4 segments.
    return {
      dash: false,
      label: names.get(play.quality) ?? String(play.quality),
      segments: (play.durl ?? []).map((d) => ({ urls: orderUrls(d.url, d.backup_url), size: d.size })),
      bestOffered,
    };
  }

  const { dash } = play;
  const duration = dash.duration || play.timelength / 1000 || 0;
  const estimate = (bandwidth) => (bandwidth && duration ? Math.round((bandwidth * duration) / 8) : 0);

  const video = dash.video
    .map((v) => ({
      id: v.id,
      label: names.get(v.id) ?? `${v.height}P`,
      codec: CODEC_NAMES[v.codecid] ?? v.codecs,
      codecRank: CODEC_RANK[v.codecid] ?? 9,
      width: v.width,
      height: v.height,
      size: estimate(v.bandwidth),
      urls: orderUrls(v.baseUrl ?? v.base_url, v.backupUrl ?? v.backup_url),
    }))
    .sort((a, b) => b.id - a.id || a.codecRank - b.codecRank);

  const mapAudio = (kind) => (a) => ({
    id: a.id,
    kind,
    label: AUDIO_NAMES[a.id] ?? `${Math.round(a.bandwidth / 1000)}K`,
    bandwidth: a.bandwidth,
    size: estimate(a.bandwidth),
    urls: orderUrls(a.baseUrl ?? a.base_url, a.backupUrl ?? a.backup_url),
  });
  const audio = [
    ...(dash.audio ?? []).map(mapAudio('aac')).sort((a, b) => b.bandwidth - a.bandwidth),
    ...(dash.dolby?.audio ?? []).map(mapAudio('dolby')),
    ...(dash.flac?.audio ? [dash.flac.audio] : []).map(mapAudio('flac')),
  ];

  return { dash: true, duration, video, audio, bestOffered, bestAvailable: video[0]?.id ?? 0, names };
}

export function sanitizeFilename(name) {
  return name
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 150) || 'bilibili';
}

export function baseFilename(info, page) {
  const name = info.pages.length > 1 ? `${info.title} - P${page.page} ${page.part}` : info.title;
  return sanitizeFilename(name);
}

export function formatSize(bytes) {
  if (!bytes) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}
