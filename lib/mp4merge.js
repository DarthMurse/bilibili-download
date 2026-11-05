// Merge a video-only and an audio-only fragmented MP4 (Bilibili DASH .m4s) into one MP4,
// streaming: neither input nor output is ever held in memory as a whole.
//
// Both inputs look like: ftyp, moov(mvhd, trak, mvex(trex)), sidx, then moof+mdat pairs.
// Output: ftyp, moov(mvhd, video trak #1, audio trak #2, mvex(trex #1, trex #2)),
// then the fragments of both inputs interleaved by decode time. Media data is never decoded:
// only the small moov/moof boxes are rewritten, mdat payloads are copied through in pieces.

const COPY_PIECE = 4 * 1024 * 1024;

function readBoxes(buf, start, end) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = dv.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(pos + 8)); header = 16; }
    else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) throw new Error(`Corrupt or truncated MP4: box "${type}" at ${pos}`);
    boxes.push({ type, start: pos, size, header, end: pos + size, body: pos + header });
    pos += size;
  }
  return boxes;
}

const children = (buf, box) => readBoxes(buf, box.body, box.end);
const child = (buf, box, type) => children(buf, box).find((b) => b.type === type);
const dataView = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const wholeBox = (bytes) => readBoxes(bytes, 0, bytes.length)[0];

function getUint(dv, off, size) {
  return size === 8 ? Number(dv.getBigUint64(off)) : dv.getUint32(off);
}
function setUint(dv, off, size, value) {
  if (size === 8) dv.setBigUint64(off, BigInt(Math.round(value)));
  else dv.setUint32(off, Math.round(value));
}

function makeBox(type, parts) {
  const size = 8 + parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(size);
  dataView(out).setUint32(0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let o = 8;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Copy a box out of its source buffer; returns the copy and the box re-addressed inside it.
function copyBox(buf, box) {
  const bytes = buf.slice(box.start, box.end);
  return { bytes, box: { ...box, start: 0, end: box.size, body: box.header } };
}

// mvhd duration field offsets depend on the full-box version.
function mvhdFields(buf, box) {
  return buf[box.body] === 1
    ? { timescale: box.body + 20, duration: box.body + 24, size: 8 }
    : { timescale: box.body + 12, duration: box.body + 16, size: 4 };
}

// ---- Streaming box I/O over a RemoteFile ----------------------------------------------------

async function readBoxHeader(file) {
  if (file.pos >= file.size) return null;
  const start = file.pos;
  let head = await file.read(8);
  let size = dataView(head).getUint32(0);
  const type = String.fromCharCode(...head.subarray(4, 8));
  if (size === 1) {
    const ext = await file.read(8);
    size = Number(dataView(ext).getBigUint64(0));
    const full = new Uint8Array(16);
    full.set(head);
    full.set(ext, 8);
    head = full;
  } else if (size === 0) {
    size = file.size - start;
  }
  if (size < head.length || start + size > file.size) throw new Error(`Corrupt or truncated MP4: box "${type}" at ${start}`);
  return { type, start, size, head };
}

async function readWholeBox(file, h) {
  const out = new Uint8Array(h.size);
  out.set(h.head);
  out.set(await file.read(h.size - h.head.length), h.head.length);
  return out;
}

function fragmentFrom(bytes, start, timescale) {
  const moof = wholeBox(bytes);
  const tfdt = child(bytes, child(bytes, moof, 'traf'), 'tfdt');
  const time = tfdt
    ? getUint(dataView(bytes), tfdt.body + 4, bytes[tfdt.body] === 1 ? 8 : 4) / timescale
    : NaN;
  return { bytes, start, time };
}

/** Read the init segment (ftyp + moov) and the first moof of one input. */
async function openTrack(file, label) {
  let ftyp, moov, first;
  for (;;) {
    const h = await readBoxHeader(file);
    if (!h) throw new Error(`${label} stream has no media fragments`);
    if (h.type === 'ftyp') ftyp = await readWholeBox(file, h);
    else if (h.type === 'moov') moov = await readWholeBox(file, h);
    else if (h.type === 'moof') { first = { bytes: await readWholeBox(file, h), start: h.start }; break; }
    else if (h.type === 'mdat') throw new Error(`${label} stream is not a fragmented MP4`);
    else await file.skip(h.size - h.head.length); // sidx, free, styp…
  }
  if (!moov) throw new Error(`${label} stream has no moov box`);

  const moovBox = wholeBox(moov);
  const moovKids = children(moov, moovBox);
  const mvhd = moovKids.find((b) => b.type === 'mvhd');
  const traks = moovKids.filter((b) => b.type === 'trak');
  const mvex = moovKids.find((b) => b.type === 'mvex');
  if (!mvhd) throw new Error(`${label} stream has no mvhd box`);
  if (traks.length !== 1) throw new Error(`${label} stream has ${traks.length} tracks, expected 1`);
  if (!mvex) throw new Error(`${label} stream is not a fragmented MP4`);

  const trak = traks[0];
  const mdhd = child(moov, child(moov, trak, 'mdia'), 'mdhd');
  const timescale = dataView(moov).getUint32(mdhd.body + (moov[mdhd.body] === 1 ? 20 : 12));
  const mvexKids = children(moov, mvex);
  const trex = mvexKids.find((b) => b.type === 'trex');
  const mehd = mvexKids.find((b) => b.type === 'mehd');
  if (!trex) throw new Error(`${label} stream has no trex box`);
  const movieTimescale = dataView(moov).getUint32(mvhdFields(moov, mvhd).timescale);

  return {
    file, buf: moov, ftyp, mvhd, trak, trex, mehd, timescale, movieTimescale,
    next: fragmentFrom(first.bytes, first.start, timescale),
  };
}

// ---- Header rewriting ----------------------------------------------------------------------

function setTrackId(trakCopy, id) {
  const { bytes, box } = trakCopy;
  const tkhd = child(bytes, box, 'tkhd');
  const off = tkhd.body + 4 + (bytes[tkhd.body] === 1 ? 16 : 8);
  dataView(bytes).setUint32(off, id);
}

// Convert a trak's movie-timescale durations (tkhd + edit list) from one movie timescale to another.
function rescaleTrak(trakCopy, from, to) {
  if (from === to) return;
  const { bytes, box } = trakCopy;
  const dv = dataView(bytes);
  const scale = (off, size) => setUint(dv, off, size, (getUint(dv, off, size) * to) / from);

  const tkhd = child(bytes, box, 'tkhd');
  if (bytes[tkhd.body] === 1) scale(tkhd.body + 28, 8);
  else scale(tkhd.body + 20, 4);

  const edts = child(bytes, box, 'edts');
  const elst = edts && child(bytes, edts, 'elst');
  if (elst) {
    const v1 = bytes[elst.body] === 1;
    const count = dv.getUint32(elst.body + 4);
    const entrySize = v1 ? 20 : 12;
    for (let i = 0; i < count; i++) scale(elst.body + 8 + i * entrySize, v1 ? 8 : 4);
  }
}

/** ftyp + moov describing both tracks. */
function buildHeader(V, A) {
  // Movie header: keep the video one, point next_track_ID past our two tracks,
  // and stretch the duration if the audio is longer.
  const mvhd = copyBox(V.buf, V.mvhd);
  const mvhdDv = dataView(mvhd.bytes);
  mvhdDv.setUint32(mvhd.bytes.length - 4, 3);
  const vf = mvhdFields(mvhd.bytes, mvhd.box);
  const af = mvhdFields(A.buf, A.mvhd);
  const audioDuration = (getUint(dataView(A.buf), af.duration, af.size) * V.movieTimescale) / A.movieTimescale;
  if (audioDuration > getUint(mvhdDv, vf.duration, vf.size)) setUint(mvhdDv, vf.duration, vf.size, audioDuration);

  const vTrak = copyBox(V.buf, V.trak);
  const aTrak = copyBox(A.buf, A.trak);
  setTrackId(vTrak, 1);
  setTrackId(aTrak, 2);
  rescaleTrak(aTrak, A.movieTimescale, V.movieTimescale);

  const vTrex = copyBox(V.buf, V.trex);
  const aTrex = copyBox(A.buf, A.trex);
  dataView(vTrex.bytes).setUint32(vTrex.box.body + 4, 1);
  dataView(aTrex.bytes).setUint32(aTrex.box.body + 4, 2);

  const mvexParts = [];
  if (V.mehd) {
    const mehd = copyBox(V.buf, V.mehd);
    const size = mehd.bytes[mehd.box.body] === 1 ? 8 : 4;
    const mdv = dataView(mehd.bytes);
    let longest = getUint(mdv, mehd.box.body + 4, size);
    if (A.mehd) {
      const asize = A.buf[A.mehd.body] === 1 ? 8 : 4;
      const a = (getUint(dataView(A.buf), A.mehd.body + 4, asize) * V.movieTimescale) / A.movieTimescale;
      longest = Math.max(longest, a);
    }
    setUint(mdv, mehd.box.body + 4, size, longest);
    mvexParts.push(mehd.bytes);
  }
  mvexParts.push(vTrex.bytes, aTrex.bytes);

  const ftyp = V.ftyp ?? makeBox('ftyp', [new TextEncoder().encode('iso5\0\0\0\x01iso6mp41')]);
  const moov = makeBox('moov', [mvhd.bytes, vTrak.bytes, aTrak.bytes, makeBox('mvex', mvexParts)]);
  const out = new Uint8Array(ftyp.length + moov.length);
  out.set(ftyp);
  out.set(moov, ftyp.length);
  return out;
}

function patchMoof(bytes, sequence, trackId, positionDelta) {
  const dv = dataView(bytes);
  for (const b of children(bytes, wholeBox(bytes))) {
    if (b.type === 'mfhd') dv.setUint32(b.body + 4, sequence);
    if (b.type !== 'traf') continue;
    const tfhd = child(bytes, b, 'tfhd');
    dv.setUint32(tfhd.body + 4, trackId);
    const flags = dv.getUint32(tfhd.body) & 0xffffff;
    // base-data-offset-present: an absolute file position, so shift it to the new location.
    if (flags & 0x1) setUint(dv, tfhd.body + 8, 8, getUint(dv, tfhd.body + 8, 8) + positionDelta);
  }
}

/**
 * Stream-merge two opened RemoteFiles (see remote.js) into `write`.
 * @param {import('./remote.js').RemoteFile} videoFile
 * @param {import('./remote.js').RemoteFile} audioFile
 * @param {(chunk: Uint8Array) => Promise<void>} write called sequentially with the output bytes
 */
export async function mergeStreams(videoFile, audioFile, write) {
  const V = await openTrack(videoFile, 'Video');
  const A = await openTrack(audioFile, 'Audio');

  const header = buildHeader(V, A);
  await write(header);
  let position = header.length;
  let sequence = 0;
  const tracks = [{ t: V, id: 1 }, { t: A, id: 2 }];

  for (;;) {
    // Take whichever pending fragment starts first, so the output is interleaved and streamable.
    // Without decode times we can't order them: all video, then all audio (still a valid MP4).
    const live = tracks.filter((x) => x.t.next);
    if (!live.length) break;
    let pick = live[0];
    if (live.length === 2 && live[1].t.next.time < live[0].t.next.time) pick = live[1];

    const { t, id } = pick;
    const frag = t.next;
    t.next = null;
    // Data offsets in the moof are relative to it (or absolute, fixed by positionDelta), and
    // everything up to the next moof is copied verbatim, so the layout around it is preserved.
    patchMoof(frag.bytes, ++sequence, id, position - frag.start);
    await write(frag.bytes);
    position += frag.bytes.length;

    for (;;) {
      const h = await readBoxHeader(t.file);
      if (!h) break;
      if (h.type === 'moof') {
        t.next = fragmentFrom(await readWholeBox(t.file, h), h.start, t.timescale);
        break;
      }
      let left = h.size - h.head.length;
      // Index boxes would point at the wrong offsets in the merged file.
      if (h.type === 'sidx' || h.type === 'mfra') { await t.file.skip(left); continue; }
      await write(h.head);
      position += h.head.length;
      while (left > 0) {
        const piece = await t.file.readSome(Math.min(left, COPY_PIECE));
        if (!piece.length) throw new Error('Unexpected end of file');
        await write(piece);
        position += piece.length;
        left -= piece.length;
      }
    }
  }
  return position;
}
