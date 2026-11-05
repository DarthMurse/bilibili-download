import {
  parseVideoUrl, getVideoInfo, getPlayUrl, getNav, buildStreams, baseFilename, formatSize,
} from '../lib/api.js';

const $ = (id) => document.getElementById(id);
const state = { info: null, page: null, streams: null };

function showMessage(text, isError = false) {
  $('main').hidden = true;
  const el = $('message');
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function setStatus(text, isError = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', isError);
}

function setBusy(busy) {
  for (const el of document.querySelectorAll('button, select')) el.disabled = busy;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const id = parseVideoUrl(tab?.url ?? '');
  if (!id) {
    showMessage('Open a Bilibili video page (bilibili.com/video/BV…) and click the icon again.');
    return;
  }

  showMessage('Loading…');
  const [info, nav] = await Promise.all([getVideoInfo(id), getNav().catch(() => ({}))]);
  state.info = info;
  state.nav = nav;

  $('cover').src = info.pic ? `${info.pic}@224w_140h_1c.webp` : '';
  $('title').textContent = info.title;
  $('title').title = info.title;
  $('owner').textContent = `UP: ${info.owner ?? '?'} · ${nav.isLogin ? `logged in as ${nav.uname}` : 'not logged in'}`;

  if (info.pages.length > 1) {
    $('partRow').hidden = false;
    $('part').replaceChildren(...info.pages.map((p) => new Option(`P${p.page} ${p.part}`, p.page)));
    $('part').value = String(id.p);
    $('part').onchange = () => loadPage(Number($('part').value)).catch((e) => setStatus(e.message, true));
  }

  $('message').hidden = true;
  $('main').hidden = false;
  await loadPage(id.p);
}

async function loadPage(pageNo) {
  const { info } = state;
  state.page = info.pages.find((p) => p.page === pageNo) ?? info.pages[0];
  setBusy(true);
  setStatus('Fetching stream list…');
  try {
    state.streams = buildStreams(await getPlayUrl(info.bvid, state.page.cid));
    renderStreams();
    setStatus('');
  } finally {
    setBusy(false);
    $('downloadMerged').disabled = $('downloadVideo').disabled = $('downloadAudio').disabled = !state.streams?.dash;
  }
}

function renderStreams() {
  const s = state.streams;
  $('dashControls').hidden = !s.dash;
  $('segments').hidden = s.dash;
  for (const id of ['downloadMerged', 'downloadVideo', 'downloadAudio']) $(id).hidden = !s.dash;

  const hints = [];
  if (s.dash) {
    $('video').replaceChildren(...s.video.map((v, i) =>
      new Option(`${v.label} · ${v.codec} · ${v.width}×${v.height} · ~${formatSize(v.size)}`, i)));
    $('audio').replaceChildren(...s.audio.map((a, i) => new Option(`${a.label} · ~${formatSize(a.size)}`, i)));
    if (s.bestOffered > s.bestAvailable) {
      const best = s.names.get(s.bestOffered) ?? s.bestOffered;
      hints.push(state.nav.isLogin
        ? `${best} needs a 大会员 (VIP) account.`
        : `Log in to bilibili.com in this browser to unlock higher qualities (up to ${best}).`);
    }
    if (s.video[0]?.codec !== 'AVC' && s.video.some((v) => v.codec === 'AVC')) {
      hints.push('Tip: AVC plays on almost every device; HEVC/AV1 files are smaller.');
    }
  } else {
    $('segments').replaceChildren(...s.segments.map((seg, i) => {
      const b = document.createElement('button');
      b.textContent = s.segments.length > 1 ? `Segment ${i + 1} (${formatSize(seg.size)})` : `Download ${s.label} (${formatSize(seg.size)})`;
      b.onclick = () => directDownload(seg.urls[0], `${baseFilename(state.info, state.page)}${s.segments.length > 1 ? `.${i + 1}` : ''}${extOf(seg.urls[0], '.flv')}`);
      return b;
    }));
    hints.push('This is an old upload with only a progressive stream; it is saved as-is.');
  }
  $('hint').hidden = !hints.length;
  $('hint').textContent = hints.join(' ');
}

function extOf(url, fallback) {
  return new URL(url).pathname.match(/\.(mp4|flv|m4s|jpg|jpeg|png|webp)$/i)?.[0].toLowerCase() ?? fallback;
}

async function directDownload(url, filename) {
  try {
    await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
    setStatus(`Started: ${filename}`);
  } catch (e) {
    setStatus(`Download failed: ${e.message}`, true);
  }
}

const selectedVideo = () => state.streams.video[Number($('video').value)];
const selectedAudio = () => state.streams.audio[Number($('audio').value)];

$('downloadMerged').onclick = async () => {
  const video = selectedVideo();
  const audio = selectedAudio();
  const task = {
    filename: `${baseFilename(state.info, state.page)}.mp4`,
    description: `${video.label} · ${video.codec} + ${audio.label}`,
    bvid: state.info.bvid,
    cid: state.page.cid,
    video: { id: video.id, codec: video.codec, urls: video.urls },
    audio: { id: audio.id, urls: audio.urls },
  };
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`task:${id}`]: task });
  await chrome.tabs.create({ url: chrome.runtime.getURL(`task/task.html?id=${id}`), active: true });
  window.close();
};

$('downloadVideo').onclick = () =>
  directDownload(selectedVideo().urls[0], `${baseFilename(state.info, state.page)}.video.mp4`);

$('downloadAudio').onclick = () =>
  directDownload(selectedAudio().urls[0], `${baseFilename(state.info, state.page)}.audio.m4a`);

$('downloadCover').onclick = () =>
  directDownload(state.info.pic, `${baseFilename(state.info, state.page)}${extOf(state.info.pic, '.jpg')}`);

init().catch((e) => showMessage(e.message, true));
