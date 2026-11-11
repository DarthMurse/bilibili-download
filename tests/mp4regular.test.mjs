import test from 'node:test';
import assert from 'node:assert/strict';
import { openAsBlob } from 'node:fs';
import { mkdtemp, open, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { regularizeMp4 } from '../lib/mp4regular.js';
import { mergeStreams } from '../lib/mp4merge.js';

const words = (...values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
const box = (type, ...parts) => { const data = Buffer.concat(parts); return Buffer.concat([words(data.length + 8), Buffer.from(type), data]); };
function list(b, start = 0, end = b.length) {
  const result = [];
  for (let p = start; p < end;) {
    let size = b.readUInt32BE(p), header = 8;
    if (size === 1) { size = Number(b.readBigUInt64BE(p + 8)); header = 16; }
    if (!size) size = end - p;
    assert.ok(size >= header && p + size <= end);
    result.push({ type: b.toString('ascii', p + 4, p + 8), start: p, body: p + header, end: p + size });
    p += size;
  }
  return result;
}
const child = (b, parent, type) => list(b, parent.body, parent.end).find((x) => x.type === type);
function at(b, ...path) {
  let parent = { body: 0, end: b.length };
  for (const type of path) { parent = child(b, parent, type); assert.ok(parent, `missing ${type}`); }
  return parent;
}
function init({ id = 1, scale = 1000, duration = 10, size = 2, edits = false } = {}) {
  const tkhd = box('tkhd', words(7, 0, 0, id, 0, 0), Buffer.alloc(60));
  const mdhd = box('mdhd', words(0, 0, 0, scale, 0, 0));
  const stsd = box('stsd', words(0, 1), box('avc1', Buffer.alloc(78)));
  const stbl = box('stbl', stsd, box('stts', words(0, 0)), box('stsc', words(0, 0)),
    box('stsz', words(0, 0, 0)), box('stco', words(0, 0)));
  const edit = edits ? [box('edts', box('elst', edits === 'delay'
    ? words(0, 2, 33, -1, 0x10000, 0, 10, 0x10000)
    : words(0, 1, 0, 0, 0x10000)))] : [];
  const trak = box('trak', tkhd, ...edit, box('mdia', mdhd, box('hdlr', words(0, 0), Buffer.from('vide'), Buffer.alloc(12)),
    box('minf', box('vmhd', words(1, 0, 0)), stbl)));
  return box('moov', box('mvhd', words(0, 0, 0, 1000, 0), Buffer.alloc(76), words(id + 1)),
    trak, box('mvex', box('trex', words(0, id, 1, duration, size, 0))));
}
const ftyp = box('ftyp', Buffer.from('iso5'), words(0), Buffer.from('iso6dash'));
function fragment({ id = 1, time = 0, cts = [20, -10, 0], absolute, defaults = false, invalidOffset = false, extended = false, toEof = false } = {}) {
  const tfdt = box('tfdt', words(0x1000000, Math.floor(time / 2 ** 32), time >>> 0));
  const sampleCount = cts.length;
  const payload = Buffer.from(Array.from({ length: sampleCount * 2 }, (_, i) => (i + time) & 255));
  const makeMoof = (offset) => {
    const base = absolute === undefined ? [] : [words(Math.floor(absolute / 2 ** 32), absolute >>> 0)];
    const tfhd = box('tfhd', words(absolute === undefined ? 0x20000 : 1, id), ...base);
    const fields = defaults ? [] : cts.flatMap((c, i) => [10, 2, i === 0 ? 0 : 0x10000, c]);
    const trun = box('trun', words(defaults ? 5 : 0x1000f01, sampleCount, offset, ...(defaults ? [0] : []), ...fields));
    return box('moof', box('mfhd', words(0, 1)), box('traf', tfhd, tfdt, trun));
  };
  const initial = makeMoof(0);
  const offset = invalidOffset ? 0 : initial.length + (extended ? 16 : 8);
  const moof = makeMoof(offset);
  const mdat = extended ? Buffer.concat([words(1), Buffer.from('mdat'), words(0, payload.length + 16), payload]) : box('mdat', payload);
  if (toEof) mdat.writeUInt32BE(0, 0);
  return { bytes: Buffer.concat([moof, mdat]), payload };
}
async function convert(input) {
  const chunks = [], progress = [];
  const length = await regularizeMp4(new Blob([input]), async (b) => chunks.push(Buffer.from(b)), (p) => progress.push(p));
  const output = Buffer.concat(chunks);
  assert.equal(output.length, length);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((p, i) => !i || p >= progress[i - 1]));
  return output;
}
function rows(b, x, width) {
  return Array.from({ length: b.readUInt32BE(x.body + 4) }, (_, i) =>
    Array.from({ length: width }, (_, j) => b.readUInt32BE(x.body + 8 + (i * width + j) * 4)));
}

test('regular MP4 preserves media, B-frame timing, sync samples and chunk offsets', async () => {
  const a = fragment(), b = fragment({ time: 30 });
  const out = await convert(Buffer.concat([ftyp, init(), a.bytes, b.bytes]));
  assert.deepEqual(list(out).map((x) => x.type), ['ftyp', 'mdat', 'mdat', 'moov']);
  const moov = at(out, 'moov');
  assert.equal(child(out, moov, 'mvex'), undefined);
  const stbl = at(out, 'moov', 'trak', 'mdia', 'minf', 'stbl');
  assert.deepEqual(rows(out, child(out, stbl, 'stts'), 2), [[6, 10]]);
  assert.deepEqual(rows(out, child(out, stbl, 'stsc'), 3), [[1, 3, 1]]);
  assert.deepEqual(rows(out, child(out, stbl, 'stss'), 1), [[1], [4]]);
  const ctts = child(out, stbl, 'ctts');
  assert.equal(out[ctts.body], 1);
  assert.equal(out.readInt32BE(ctts.body + 20), -10);
  const offsets = child(out, stbl, 'co64');
  list(out).filter((x) => x.type === 'mdat').forEach((m, i) => {
    assert.equal(Number(out.readBigUInt64BE(offsets.body + 8 + i * 8)), m.body);
    assert.deepEqual(out.subarray(m.body, m.end), i ? b.payload : a.payload);
  });
  const mvhd = child(out, moov, 'mvhd');
  assert.equal(out.readUInt32BE(mvhd.body + 16), 60);
});

test('trex defaults, absolute base offsets, and EOF-sized mdat', async () => {
  const moov = init();
  const f = fragment({ absolute: ftyp.length + moov.length, defaults: true, toEof: true });
  const out = await convert(Buffer.concat([ftyp, moov, f.bytes]));
  assert.deepEqual(list(out).map((x) => x.type), ['ftyp', 'mdat', 'moov']);
  assert.deepEqual(out.subarray(at(out, 'mdat').body, at(out, 'mdat').end), f.payload);
  const stss = child(out, at(out, 'moov', 'trak', 'mdia', 'minf', 'stbl'), 'stss');
  assert.equal(stss, undefined);
});

test('extended mdat and nonzero starting decode time preserve the start delay', async () => {
  const f = fragment({ time: 500, extended: true, defaults: true });
  const out = await convert(Buffer.concat([ftyp, init(), f.bytes]));
  assert.equal(at(out, 'mdat').body - at(out, 'mdat').start, 16);
  const elst = at(out, 'moov', 'trak', 'edts', 'elst');
  assert.equal(out[elst.body], 1);
  assert.equal(out.readBigUInt64BE(elst.body + 8), 500n);
  assert.equal(out.readBigInt64BE(elst.body + 16), -1n);
  assert.equal(out.readUInt32BE(at(out, 'moov', 'mvhd').body + 16), 530);
});

test('zero-duration initialization edit is completed', async () => {
  const out = await convert(Buffer.concat([ftyp, init({ edits: true }), fragment({ defaults: true }).bytes]));
  assert.equal(out.readUInt32BE(at(out, 'moov', 'trak', 'edts', 'elst').body + 8), 30);
});

test('Bilibili lead-in and open-ended media edit preserve audio/video alignment', async () => {
  const out = await convert(Buffer.concat([ftyp, init({ edits: 'delay' }), fragment({ defaults: true }).bytes]));
  const elst = at(out, 'moov', 'trak', 'edts', 'elst');
  assert.equal(out.readUInt32BE(elst.body + 8), 33);
  assert.equal(out.readInt32BE(elst.body + 12), -1);
  assert.equal(out.readUInt32BE(elst.body + 20), 20);
  assert.equal(out.readInt32BE(elst.body + 24), 10);
  assert.equal(out.readUInt32BE(at(out, 'moov', 'mvhd').body + 16), 53);
});

test('very long track promotes duration headers to version 1', async () => {
  const out = await convert(Buffer.concat([ftyp, init({ duration: 0xffffffff }), fragment({ defaults: true }).bytes]));
  const mvhd = at(out, 'moov', 'mvhd'), tkhd = at(out, 'moov', 'trak', 'tkhd');
  assert.equal(out[mvhd.body], 1);
  assert.equal(out.readBigUInt64BE(mvhd.body + 24), 3n * 0xffffffffn);
  assert.equal(out.readBigUInt64BE(tkhd.body + 28), 3n * 0xffffffffn);
});

test('malformed offsets and discontinuous timestamps are rejected before writing', async () => {
  for (const fragments of [fragment({ invalidOffset: true }).bytes,
    Buffer.concat([fragment().bytes, fragment({ time: 100 }).bytes])]) {
    let writes = 0;
    await assert.rejects(regularizeMp4(new Blob([ftyp, init(), fragments]), async () => writes++), /Cannot finalize MP4/);
    assert.equal(writes, 0);
  }
  await assert.rejects(convert(Buffer.concat([ftyp, init(), fragment().bytes]).subarray(0, -1)), /Cannot finalize MP4/);
});

test('existing streaming merger feeds two tracks into regularization', async () => {
  function remote(bytes) {
    return { pos: 0, size: bytes.length,
      async read(n) { const result = bytes.subarray(this.pos, this.pos + n); assert.equal(result.length, n); this.pos += n; return result; },
      async readSome(n) { return this.read(Math.min(n, this.size - this.pos)); },
      async skip(n) { this.pos += n; } };
  }
  const video = Buffer.concat([ftyp, init(), fragment().bytes, fragment({ time: 30 }).bytes]);
  const audio = Buffer.concat([ftyp, init({ scale: 48000 }), fragment({ defaults: true }).bytes]);
  const merged = [];
  await mergeStreams(remote(video), remote(audio), async (b) => merged.push(Buffer.from(b)));
  const out = await convert(Buffer.concat(merged)), root = at(out, 'moov');
  const tracks = list(out, root.body, root.end).filter((x) => x.type === 'trak');
  assert.equal(tracks.length, 2);
  tracks.forEach((t, i) => {
    assert.equal(out.readUInt32BE(child(out, t, 'tkhd').body + 12), i + 1);
    const stbl = child(out, child(out, child(out, t, 'mdia'), 'minf'), 'stbl');
    assert.equal(out.readUInt32BE(child(out, stbl, 'stsz').body + 8), i ? 3 : 6);
    const co64 = child(out, stbl, 'co64');
    const firstSample = Number(out.readBigUInt64BE(co64.body + 8));
    assert.deepEqual(out.subarray(firstSample, firstSample + 6), Buffer.from([0, 1, 2, 3, 4, 5]));
  });
});

// Opt-in real-world regression: MP4_FIXTURE points to the downloaded Bilibili file.
// Media hashes are checked independently without loading the whole recording into RAM.
test('real download: regular output, identical media payload, populated audio/video indexes',
  { skip: !process.env.MP4_FIXTURE }, async (t) => {
    const input = await openAsBlob(process.env.MP4_FIXTURE);
    const directory = await mkdtemp(join(tmpdir(), 'bilibili-mp4-'));
    const filename = join(directory, 'regular.mp4');
    t.after(async () => { await unlink(filename); await rmdir(directory); });
    const dest = await open(filename, 'w');
    try {
      await regularizeMp4(input, async (chunk) => {
        for (let p = 0; p < chunk.length;) { const { bytesWritten } = await dest.write(chunk.subarray(p)); p += bytesWritten; }
      });
    } finally { await dest.close(); }
    async function inspect(blob) {
      const types = [], hash = createHash('sha256');
      let moov;
      for (let p = 0; p < blob.size;) {
        const h = Buffer.from(await blob.slice(p, p + 16).arrayBuffer());
        let size = h.readUInt32BE(0), header = 8;
        if (size === 1) { size = Number(h.readBigUInt64BE(8)); header = 16; }
        if (!size) size = blob.size - p;
        assert.ok(size >= header && p + size <= blob.size);
        const type = h.toString('ascii', 4, 8); types.push(type);
        if (type === 'mdat') for await (const chunk of blob.slice(p + header, p + size).stream()) hash.update(chunk);
        if (type === 'moov') moov = Buffer.from(await blob.slice(p, p + size).arrayBuffer());
        p += size;
      }
      return { types, moov, hash: hash.digest('hex') };
    }
    const original = await inspect(input), output = await inspect(await openAsBlob(filename));
    assert.equal(original.hash, output.hash);
    assert.ok(original.types.includes('moof'));
    assert.ok(!output.types.includes('moof'));
    const root = list(output.moov)[0];
    assert.equal(child(output.moov, root, 'mvex'), undefined);
    const tracks = list(output.moov, root.body, root.end).filter((x) => x.type === 'trak');
    assert.equal(tracks.length, 2);
    for (const t of tracks) {
      const b = output.moov, mdia = child(b, t, 'mdia');
      const stbl = child(b, child(b, mdia, 'minf'), 'stbl');
      const count = b.readUInt32BE(child(b, stbl, 'stsz').body + 8);
      assert.ok(count > 0);
      assert.equal(rows(b, child(b, stbl, 'stts'), 2).reduce((n, [samples]) => n + samples, 0), count);
      assert.ok(b.readUInt32BE(child(b, stbl, 'co64').body + 4) > 0);
    }
    console.log(`Verified real file: ${input.size} -> ${(await openAsBlob(filename)).size} bytes; media SHA-256 ${output.hash}`);
  });
