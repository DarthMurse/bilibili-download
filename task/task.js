// Download page for "Download MP4": streams the video and audio DASH files through
// mp4merge.js into a temporary file on disk (the extension's origin-private file system),
// then hands that file to chrome.downloads. Memory use stays at a few dozen MB regardless of
// video size. It lives in a tab (not the popup) because the popup dies when it loses focus.

import { mergeStreams } from '../lib/mp4merge.js';
import { RemoteFile } from '../lib/remote.js';
import { buildStreams, getPlayUrl, formatSize } from '../lib/api.js';

const $ = (id) => document.getElementById(id);
const TEMP_DIR = 'downloads';
const STALE_MS = 24 * 60 * 60 * 1000;

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

function progressReporter(kind) {
  const bar = $(`${kind}Bar`);
  const text = $(`${kind}Text`);
  const start = performance.now();
  let received = 0;
  let lastPaint = 0;
  const reporter = (delta) => {
    received += delta;
    const now = performance.now();
    if (now - lastPaint < 150 && received !== reporter.total) return;
    lastPaint = now;
    const speed = received / Math.max(0.001, (now - start) / 1000);
    bar.value = reporter.total ? received / reporter.total : 0;
    text.textContent = `${formatSize(received)} / ${formatSize(reporter.total)} · ${formatSize(speed)}/s`;
  };
  reporter.total = 0;
  return reporter;
}

// Signed CDN URLs expire after a while; long downloads ask for fresh ones of the same stream.
function urlRefresher(task, kind) {
  return async () => {
    const s = buildStreams(await getPlayUrl(task.bvid, task.cid));
    const match = kind === 'video'
      ? s.video.find((v) => v.id === task.video.id && v.codec === task.video.codec)
      : s.audio.find((a) => a.id === task.audio.id);
    if (!match) throw new Error(`The selected ${kind} stream is no longer offered`);
    return match.urls;
  };
}

async function tempDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(TEMP_DIR, { create: true });
}

// Temp files left behind by crashed or closed tasks.
async function removeStaleTempFiles(dir) {
  for await (const [name, handle] of dir.entries()) {
    try {
      if (handle.kind !== 'file') continue;
      const file = await handle.getFile();
      if (Date.now() - file.lastModified > STALE_MS) await dir.removeEntry(name);
    } catch (e) {
      console.warn(`Could not clean up ${name}`, e);
    }
  }
}

/** Resolves with the final download state ('complete' or 'interrupted'). */
async function saveFile(file, filename) {
  const url = URL.createObjectURL(file);
  try {
    const downloadId = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
    return await new Promise((resolve) => {
      const onChanged = (delta) => {
        if (delta.id !== downloadId || !delta.state) return;
        if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
          chrome.downloads.onChanged.removeListener(onChanged);
          resolve(delta.state.current);
        }
      };
      chrome.downloads.onChanged.addListener(onChanged);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

let running = false;
window.addEventListener('beforeunload', (e) => {
  if (running) e.preventDefault();
});

async function run() {
  const id = new URLSearchParams(location.search).get('id');
  const key = `task:${id}`;
  const task = (await chrome.storage.session.get(key))[key];
  if (!task) {
    setStatus('This download task has expired. Start it again from the extension popup.', 'error');
    return;
  }

  document.title = `Downloading ${task.filename}`;
  $('filename').textContent = task.filename;
  $('description').textContent = task.description;
  running = true;

  const dir = await tempDir();
  await removeStaleTempFiles(dir);

  setStatus('Connecting…');
  const videoProgress = progressReporter('video');
  const audioProgress = progressReporter('audio');
  const [video, audio] = await Promise.all([
    new RemoteFile(task.video.urls, { onBytes: videoProgress, refreshUrls: urlRefresher(task, 'video') }).open(),
    new RemoteFile(task.audio.urls, { onBytes: audioProgress, refreshUrls: urlRefresher(task, 'audio') }).open(),
  ]);
  videoProgress.total = video.size;
  audioProgress.total = audio.size;

  const needed = video.size + audio.size;
  const { quota, usage } = await navigator.storage.estimate();
  if (quota - usage < needed) {
    throw new Error(`Not enough free disk space: need ${formatSize(needed)}, have ${formatSize(quota - usage)}`);
  }

  const tempName = `${id}.mp4`;
  const handle = await dir.getFileHandle(tempName, { create: true });
  const writable = await handle.createWritable();
  setStatus('Downloading and merging…');
  try {
    await mergeStreams(video, audio, (chunk) => writable.write(chunk));
    setStatus('Finishing…');
    await writable.close();
  } catch (e) {
    await writable.abort().catch(() => {});
    await dir.removeEntry(tempName).catch(() => {});
    throw e;
  }
  await chrome.storage.session.remove(key);

  const file = await handle.getFile();
  const discard = () => dir.removeEntry(tempName).catch((e) => console.warn(e));
  const save = async () => {
    running = true;
    $('actions').hidden = true;
    setStatus('Saving to your Downloads folder…');
    const state = await saveFile(file, task.filename);
    running = false;
    if (state === 'complete') {
      await discard();
      setStatus(`Done — ${formatSize(file.size)} saved. You can close this tab.`, 'done');
      document.title = `✓ ${task.filename}`;
      return;
    }
    // Cancelled "Save as" dialog, disk full, … The merged file is still here; let the user retry.
    setStatus('Saving was interrupted. The merged file is kept until you save or discard it.', 'error');
    const retry = document.createElement('button');
    retry.className = 'primary';
    retry.textContent = 'Save again';
    retry.onclick = () => save().catch(fail);
    const drop = document.createElement('button');
    drop.textContent = 'Discard';
    drop.onclick = async () => { await discard(); $('actions').hidden = true; setStatus('Discarded.'); };
    $('actions').replaceChildren(retry, drop);
    $('actions').hidden = false;
  };
  await save();
}

function fail(e) {
  console.error(e);
  running = false;
  setStatus(`Failed: ${e.message}`, 'error');
}

run().catch(fail);
