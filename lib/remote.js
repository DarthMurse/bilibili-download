// Sequential reader over a remote file, fetched as HTTP Range chunks.
//
// Large videos can't be fetched as one response held in memory: a single connection lasting
// many minutes breaks easily, and Chrome won't allocate a multi-GB buffer. Instead the file is
// pulled in fixed-size chunks with a few prefetched ahead; each chunk is retried on its own,
// rotating through the CDN mirrors, and the URLs are re-requested if they expire mid-download.

const CHUNK_SIZE = 8 * 1024 * 1024;
const PREFETCH = 4;
const MAX_ATTEMPTS = 10;
const IDLE_TIMEOUT_MS = 30_000;

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class RemoteFile {
  /**
   * @param {string[]} urls mirrors serving identical bytes
   * @param {{ refreshUrls?: () => Promise<string[]>, onBytes?: (delta: number) => void }} options
   */
  constructor(urls, { refreshUrls, onBytes } = {}) {
    this.urls = urls;
    this.urlIndex = 0;
    this.refreshUrls = refreshUrls;
    this.onBytes = onBytes ?? (() => {});
    this.denied = 0;
    this.lastRefresh = 0;
    this.refreshing = null;
    this.size = 0;
    this.pos = 0;
    this.chunks = new Map();
  }

  /** Fetch the first chunk, which also tells us the total size. */
  async open() {
    const { data, total } = await this.fetchWithRetry(0, CHUNK_SIZE - 1);
    this.size = total;
    this.chunks.set(0, Promise.resolve(data));
    return this;
  }

  async fetchRange(url, start, end) {
    const ctrl = new AbortController();
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(new Error(`No data for ${IDLE_TIMEOUT_MS / 1000} s`)), IDLE_TIMEOUT_MS);
    };
    let received = 0;
    arm();
    try {
      const res = await fetch(url, {
        headers: { Range: `bytes=${start}-${end}` },
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (res.status !== 206) {
        throw new HttpError(res.status === 200 ? 'Server does not support range requests' : `HTTP ${res.status}`, res.status);
      }
      const total = Number(res.headers.get('content-range')?.split('/')[1]);
      const length = Number(res.headers.get('content-length')) || end - start + 1;
      const data = new Uint8Array(length);
      const reader = res.body.getReader();
      for (;;) {
        arm();
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.length > length) throw new Error('Server sent more data than announced');
        data.set(value, received);
        received += value.length;
        this.onBytes(value.length);
      }
      if (received !== length) throw new Error(`Connection closed early (${received} of ${length} bytes)`);
      if (!Number.isFinite(total)) {
        if (length < end - start + 1) return { data, total: start + length };
        throw new Error('Server did not report the file size');
      }
      return { data, total };
    } catch (e) {
      this.onBytes(-received); // this chunk will be fetched again; keep progress honest
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchWithRetry(start, end) {
    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const url = this.urls[this.urlIndex % this.urls.length];
      try {
        const result = await this.fetchRange(url, start, end);
        this.denied = 0;
        return result;
      } catch (e) {
        lastError = e;
        console.warn(`Range ${start}-${end} failed on ${new URL(url).host} (attempt ${attempt + 1})`, e);
        this.urlIndex++;
        // 403/404 from every mirror usually means the signed URLs expired.
        if ([403, 404, 410].includes(e.status) && ++this.denied >= this.urls.length) await this.refresh();
        await sleep(Math.min(500 * 2 ** attempt, 10_000));
      }
    }
    throw new Error(`Download failed at byte ${start}: ${lastError?.message}`);
  }

  refresh() {
    if (!this.refreshUrls || Date.now() - this.lastRefresh < 60_000) return Promise.resolve();
    this.refreshing ??= this.refreshUrls()
      .then((urls) => { this.urls = urls; this.urlIndex = 0; })
      .catch((e) => console.warn('Could not refresh stream URLs', e))
      .finally(() => { this.lastRefresh = Date.now(); this.denied = 0; this.refreshing = null; });
    return this.refreshing;
  }

  chunk(k) {
    if (!this.chunks.has(k)) {
      const start = k * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, this.size) - 1;
      const p = this.fetchWithRetry(start, end).then((r) => r.data);
      p.catch(() => {}); // surfaced when the chunk is actually read
      this.chunks.set(k, p);
    }
    return this.chunks.get(k);
  }

  /** Up to `max` bytes at the current position, as a view (no copy). Empty only at end of file. */
  async readSome(max) {
    if (this.pos >= this.size) return new Uint8Array(0);
    const k = Math.floor(this.pos / CHUNK_SIZE);
    for (let j = k; j < k + PREFETCH && j * CHUNK_SIZE < this.size; j++) this.chunk(j);
    const data = await this.chunk(k);
    const offset = this.pos - k * CHUNK_SIZE;
    const view = data.subarray(offset, Math.min(data.length, offset + max));
    this.pos += view.length;
    if (offset + view.length >= data.length) this.chunks.delete(k);
    return view;
  }

  /** Exactly `n` bytes, copied into a new array. */
  async read(n) {
    const out = new Uint8Array(n);
    for (let o = 0; o < n;) {
      const view = await this.readSome(n - o);
      if (!view.length) throw new Error('Unexpected end of file');
      out.set(view, o);
      o += view.length;
    }
    return out;
  }

  async skip(n) {
    while (n > 0) {
      const view = await this.readSome(n);
      if (!view.length) throw new Error('Unexpected end of file');
      n -= view.length;
    }
  }
}
