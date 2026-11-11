// Repackage fragmented MP4 into ftyp + mdat(s) + moov. Encoded media is copied,
// never decoded. Only sample indexes and small headers stay in memory.
const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const typeAt = (b, p) => String.fromCharCode(...b.subarray(p, p + 4));
const fail = (message) => { throw new Error(`Cannot finalize MP4: ${message}`); };
const safe = (n) => Number.isSafeInteger(n) && n >= 0 ? n : fail('invalid size or timestamp');
const u64 = (d, p) => safe(Number(d.getBigUint64(p)));

function boxes(b, start = 0, end = b.length) {
  const result = [], d = view(b);
  for (let p = start; p < end;) {
    if (p + 8 > end) fail('truncated box header');
    let size = d.getUint32(p), header = 8;
    if (size === 1) { size = u64(d, p + 8); header = 16; }
    else if (!size) size = end - p;
    if (size < header || p + size > end) fail('truncated box');
    result.push({ type: typeAt(b, p + 4), start: p, body: p + header, end: p + size });
    p += size;
  }
  return result;
}
const kids = (b, box) => boxes(b, box.body, box.end);
const get = (b, box, type) => kids(b, box).find((x) => x.type === type);
const raw = (b, box) => b.slice(box.start, box.end);
function box(type, parts) {
  const b = new Uint8Array(8 + parts.reduce((n, x) => n + x.length, 0));
  view(b).setUint32(0, b.length);
  b.set(new TextEncoder().encode(type), 4);
  let p = 8;
  for (const part of parts) { b.set(part, p); p += part.length; }
  return b;
}
function table(type, rows, width, version = 0) {
  const b = new Uint8Array(8 + rows.length * width * 4), d = view(b);
  b[0] = version;
  d.setUint32(4, rows.length);
  rows.forEach((row, i) => row.forEach((n, j) => d.setUint32(8 + (i * width + j) * 4, n)));
  return box(type, [b]);
}
function rle(rows, value) {
  const last = rows.at(-1);
  if (last && last[1] === value) last[0]++;
  else rows.push([1, value]);
}

async function header(file, p) {
  const b = new Uint8Array(await file.slice(p, p + 16).arrayBuffer());
  if (b.length < 8) fail('truncated file');
  let size = view(b).getUint32(0), length = 8;
  if (size === 1) { size = u64(view(b), 8); length = 16; }
  else if (!size) size = file.size - p;
  if (size < length || p + size > file.size) fail('invalid top-level box');
  return { type: typeAt(b, 4), start: p, body: p + length, end: p + size, size, length };
}

function initTracks(b) {
  const root = boxes(b)[0], d = view(b), mvex = get(b, root, 'mvex');
  if (!mvex) fail('expected a fragmented MP4');
  const tracks = new Map();
  for (const trak of kids(b, root).filter((x) => x.type === 'trak')) {
    const tkhd = get(b, trak, 'tkhd'), mdia = get(b, trak, 'mdia');
    const mdhd = get(b, mdia, 'mdhd'), stbl = get(b, get(b, mdia, 'minf'), 'stbl');
    const id = d.getUint32(tkhd.body + (b[tkhd.body] === 1 ? 20 : 12));
    const trex = kids(b, mvex).find((x) => x.type === 'trex' && d.getUint32(x.body + 4) === id);
    if (!trex) fail('missing track defaults');
    const stsz = get(b, stbl, 'stsz');
    if (stsz && d.getUint32(stsz.body + 8)) fail('hybrid fragmented files are not supported');
    tracks.set(id, { trak, tkhd, mdia, mdhd, stbl,
      timescale: d.getUint32(mdhd.body + (b[mdhd.body] === 1 ? 20 : 12)),
      description: d.getUint32(trex.body + 8), duration: d.getUint32(trex.body + 12),
      size: d.getUint32(trex.body + 16), flags: d.getUint32(trex.body + 20),
      sizes: [], timing: [], composition: [], sync: [], chunks: [],
      firstDts: null, endDts: 0, presentationEnd: 0, negativeCts: false, maxCts: 0 });
  }
  return tracks;
}

function addFragment(b, fileOffset, tracks) {
  const d = view(b), root = boxes(b)[0];
  let previousEnd = fileOffset;
  for (const traf of kids(b, root).filter((x) => x.type === 'traf')) {
    const children = kids(b, traf);
    if (children.some((x) => ['senc', 'saiz', 'saio', 'sbgp', 'sgpd'].includes(x.type))) {
      fail('encrypted media or fragment sample groups are not supported');
    }
    const tfhd = get(b, traf, 'tfhd');
    if (!tfhd) fail('missing fragment track header');
    const t = tracks.get(d.getUint32(tfhd.body + 4));
    if (!t) fail('unknown fragment track');
    const flags = d.getUint32(tfhd.body) & 0xffffff;
    let p = tfhd.body + 8;
    const read = () => { const n = d.getUint32(p); p += 4; return n; };
    let base = flags & 0x20000 ? fileOffset : previousEnd;
    if (flags & 1) { base = u64(d, p); p += 8; }
    const description = flags & 2 ? read() : t.description;
    const duration = flags & 8 ? read() : t.duration;
    const size = flags & 16 ? read() : t.size;
    const sampleFlags = flags & 32 ? read() : t.flags;
    if (p !== tfhd.end) fail('invalid track defaults');
    const stsd = get(t.source, t.stbl, 'stsd');
    if (!description || description > view(t.source).getUint32(stsd.body + 4)) fail('invalid sample description');
    const tfdt = get(b, traf, 'tfdt');
    let time = tfdt ? (b[tfdt.body] === 1 ? u64(d, tfdt.body + 4) : d.getUint32(tfdt.body + 4)) : t.endDts;
    if (t.firstDts === null) t.firstDts = time;
    else if (time !== t.endDts) fail('discontinuous fragment timestamps');
    let dataEnd = base;
    for (const trun of children.filter((x) => x.type === 'trun')) {
      const f = d.getUint32(trun.body) & 0xffffff, count = d.getUint32(trun.body + 4);
      if (b[trun.body] > 1 || ((f & 4) && (f & 0x400))) fail('invalid sample run');
      p = trun.body + 8;
      let offset = dataEnd;
      if (f & 1) { offset = base + d.getInt32(p); p += 4; }
      const firstFlags = f & 4 ? read() : sampleFlags;
      const fields = [0x100, 0x200, 0x400, 0x800].filter((mask) => f & mask).length;
      if (p + count * fields * 4 !== trun.end) fail('truncated sample run');
      if (flags & 0x10000 && count) fail('nonempty duration-is-empty fragment');
      const chunk = { source: safe(offset), count, description, size: 0 };
      for (let i = 0; i < count; i++) {
        const dur = f & 0x100 ? read() : duration;
        const len = f & 0x200 ? read() : size;
        const sf = f & 0x400 ? read() : i === 0 ? firstFlags : sampleFlags;
        let cts = 0;
        if (f & 0x800) { cts = b[trun.body] === 1 ? d.getInt32(p) : d.getUint32(p); p += 4; }
        if (!dur || !len) fail('missing sample duration or size');
        t.sizes.push(len);
        rle(t.timing, dur);
        rle(t.composition, cts);
        t.negativeCts ||= cts < 0;
        t.maxCts = Math.max(t.maxCts, cts);
        if (!(sf & 0x10000)) t.sync.push([t.sizes.length]);
        t.presentationEnd = Math.max(t.presentationEnd, time - t.firstDts + cts + dur);
        time = safe(time + dur);
        chunk.size = safe(chunk.size + len);
      }
      if (count) t.chunks.push(chunk);
      dataEnd = safe(offset + chunk.size);
    }
    t.endDts = time;
    previousEnd = dataEnd;
  }
}

// Upgrade version-0 duration headers when a long movie needs 64-bit durations.
function durationBox(b, source, duration, trackHeader = false) {
  let bytes = raw(b, source), v = bytes[8];
  const oldOffset = trackHeader ? 28 : 24;
  if (v === 0 && duration > 0xffffffff) {
    const expanded = new Uint8Array(bytes.length + 12), d = view(expanded), old = view(bytes);
    expanded.set(bytes.subarray(0, 12)); expanded[8] = 1;
    d.setUint32(0, expanded.length);
    d.setBigUint64(12, BigInt(old.getUint32(12)));
    d.setBigUint64(20, BigInt(old.getUint32(16)));
    expanded.set(bytes.subarray(20, oldOffset), 28);
    expanded.set(bytes.subarray(oldOffset + 4), oldOffset + 16);
    bytes = expanded; v = 1;
  }
  const offset = oldOffset + (v === 1 ? 8 : 0);
  if (v === 1) view(bytes).setBigUint64(offset, BigInt(safe(duration)));
  else view(bytes).setUint32(offset, duration);
  return bytes;
}

function buildTrack(b, t, movieScale) {
  if (!t.sizes.length || !t.timescale) fail('empty track or invalid timescale');
  if (t.negativeCts && t.maxCts > 0x7fffffff) fail('composition offsets exceed signed range');
  const stsz = new Uint8Array(12 + t.sizes.length * 4), sd = view(stsz);
  sd.setUint32(8, t.sizes.length);
  t.sizes.forEach((n, i) => sd.setUint32(12 + i * 4, n));
  const co64 = new Uint8Array(8 + t.chunks.length * 8), cd = view(co64);
  cd.setUint32(4, t.chunks.length);
  const stsc = [];
  t.chunks.forEach((c, i) => {
    cd.setBigUint64(8 + i * 8, BigInt(c.output));
    const last = stsc.at(-1);
    if (!last || last[1] !== c.count || last[2] !== c.description) stsc.push([i + 1, c.count, c.description]);
  });
  const parts = [raw(b, get(b, t.stbl, 'stsd')), table('stts', t.timing, 2),
    table('stsc', stsc, 3), box('stsz', [stsz]), box('co64', [co64])];
  if (t.composition.some((x) => x[1])) parts.push(table('ctts', t.composition, 2, t.negativeCts ? 1 : 0));
  if (t.sync.length !== t.sizes.length) parts.push(table('stss', t.sync, 1));
  const stbl = box('stbl', parts);
  const minf = get(b, t.mdia, 'minf');
  const newMinf = box('minf', kids(b, minf).map((x) => x.type === 'stbl' ? stbl : raw(b, x)));
  const mediaDuration = Math.max(t.endDts - t.firstDts, t.presentationEnd);
  const newMdia = box('mdia', kids(b, t.mdia).map((x) => x.type === 'minf' ? newMinf :
    x.type === 'mdhd' ? durationBox(b, x, mediaDuration) : raw(b, x)));
  let movieDuration = Math.ceil(mediaDuration * movieScale / t.timescale);
  const edts = get(b, t.trak, 'edts');
  let newEdts;
  if (edts) {
    if (t.firstDts) fail('nonzero initial timestamps with an existing edit list');
    newEdts = raw(b, edts);
    const elst = get(newEdts, boxes(newEdts)[0], 'elst');
    if (!elst) fail('missing edit list');
    const d = view(newEdts), wide = newEdts[elst.body] === 1;
    const count = d.getUint32(elst.body + 4);
    let total = 0;
    for (let i = 0; i < count; i++) {
      const p = elst.body + 8 + i * (wide ? 20 : 12);
      let duration = wide ? u64(d, p) : d.getUint32(p);
      const mediaTime = wide ? Number(d.getBigInt64(p + 8)) : d.getInt32(p + 4);
      const rate = p + (wide ? 16 : 8);
      if (d.getInt16(rate) !== 1 || d.getInt16(rate + 2) !== 0) fail('unsupported edit rate');
      if (!duration) {
        // DASH initialization can include an empty lead-in followed by an
        // open-ended media edit. Resolve only that final media edit.
        if (i !== count - 1 || mediaTime < 0) fail('ambiguous zero-duration edit');
        duration = Math.ceil(Math.max(0, mediaDuration - mediaTime) * movieScale / t.timescale);
        if (!wide && duration > 0xffffffff) fail('edit duration exceeds 32-bit range');
        if (wide) d.setBigUint64(p, BigInt(duration)); else d.setUint32(p, duration);
      }
      total += duration;
    }
    movieDuration = total;
  } else if (t.firstDts) {
    const delay = Math.round(t.firstDts * movieScale / t.timescale);
    const bytes = new Uint8Array(48), d = view(bytes);
    bytes[0] = 1; d.setUint32(4, 2);
    d.setBigUint64(8, BigInt(delay)); d.setBigInt64(16, -1n); d.setInt16(24, 1);
    d.setBigUint64(28, BigInt(movieDuration)); d.setBigInt64(36, 0n); d.setInt16(44, 1);
    newEdts = box('edts', [box('elst', [bytes])]);
    movieDuration += delay;
  }
  const trakParts = kids(b, t.trak).filter((x) => x.type !== 'edts').map((x) =>
    x.type === 'tkhd' ? durationBox(b, x, movieDuration, true) : x.type === 'mdia' ? newMdia : raw(b, x));
  if (newEdts) trakParts.push(newEdts);
  return { bytes: box('trak', trakParts), duration: movieDuration };
}

/** File/Blob -> sequential async writer. Progress covers indexing and copying. */
export async function regularizeMp4(file, write, onProgress = () => {}) {
  let moov, tracks;
  const mdats = [];
  // A generic ISO MP4 brand, without the old DASH/fragmented compatibility brands.
  const ftyp = box('ftyp', [new TextEncoder().encode('isom\0\0\x02\0isomiso6mp41')]);
  let outputPosition = ftyp.length;
  for (let p = 0; p < file.size;) {
    const h = await header(file, p);
    if (h.type === 'moov' || h.type === 'moof') {
      if (h.size > 64 * 1024 * 1024) fail('metadata box exceeds 64 MB');
      const b = new Uint8Array(await file.slice(p, h.end).arrayBuffer());
      if (h.type === 'moov') {
        if (moov) fail('multiple movie headers');
        moov = b; tracks = initTracks(b);
        for (const t of tracks.values()) t.source = b;
      } else {
        if (!tracks) fail('fragment precedes movie header');
        addFragment(b, p, tracks);
      }
    } else if (h.type === 'mdat') {
      mdats.push({ ...h, output: outputPosition });
      outputPosition = safe(outputPosition + h.size);
    }
    p = h.end;
    onProgress(0.1 * p / file.size);
  }
  if (!tracks || !mdats.length) fail('missing movie header or media');
  // Locate each run in an mdat and translate its absolute offset into the output.
  for (const t of tracks.values()) for (const c of t.chunks) {
    let lo = 0, hi = mdats.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (mdats[mid].body <= c.source) lo = mid + 1; else hi = mid; }
    const m = mdats[lo - 1];
    if (!m || c.source + c.size > m.end) fail('sample run points outside media data');
    c.output = m.output + c.source - m.start;
  }
  const root = boxes(moov)[0], mvhd = get(moov, root, 'mvhd');
  const scale = view(moov).getUint32(mvhd.body + (moov[mvhd.body] === 1 ? 20 : 12));
  if (!scale) fail('invalid movie timescale');
  const built = [...tracks.values()].map((t) => buildTrack(moov, t, scale));
  const newMoov = box('moov', [durationBox(moov, mvhd, Math.max(...built.map((t) => t.duration))),
    ...built.map((t) => t.bytes), ...kids(moov, root).filter((x) => !['mvhd', 'trak', 'mvex'].includes(x.type)).map((x) => raw(moov, x))]);
  await write(ftyp);
  let copied = 0;
  for (const m of mdats) {
    // Write an explicit length even if the source used an mdat extending to EOF;
    // the new moov must remain a separate box after it.
    const bytes = new Uint8Array(m.length), d = view(bytes);
    d.setUint32(0, m.length === 16 ? 1 : m.size);
    bytes.set(new TextEncoder().encode('mdat'), 4);
    if (m.length === 16) d.setBigUint64(8, BigInt(m.size));
    await write(bytes);
    for (let p = m.body; p < m.end;) {
      const end = Math.min(p + 4 * 1024 * 1024, m.end);
      await write(new Uint8Array(await file.slice(p, end).arrayBuffer()));
      copied += end - p; p = end;
      onProgress(0.1 + 0.9 * copied / (outputPosition - ftyp.length));
    }
  }
  await write(newMoov);
  onProgress(1);
  return outputPosition + newMoov.length;
}
