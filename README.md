# Bilibili Downloader (Chrome extension)

Download videos from bilibili.com as a single MP4. Bilibili serves video and audio as separate
DASH streams; this extension downloads both and merges them **inside the browser** — no ffmpeg,
no server, no re-encoding.

## Install (developer mode)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the pink download icon to the toolbar.

## Use

1. Open any video page, e.g. `https://www.bilibili.com/video/BV…` (multi-part videos and `?p=N` work).
2. Click the extension icon.
3. Pick the part, video quality/codec and audio quality.
4. Click **Download MP4**. A tab opens showing progress; keep it open until it says *Done*.

Other buttons:

- **Video only / Audio only** – saves the raw stream straight to disk (lowest memory use).
- **Cover** – saves the thumbnail image.

### Quality

The extension uses your bilibili.com login in this browser. Without logging in, Bilibili usually
caps you at 480P–720P; logged in you get 1080P; 1080P+/4K/HDR/Dolby need 大会员 (VIP). The popup
tells you when a higher quality exists but isn't available to your account.

**AVC** is the default codec because it plays everywhere. **HEVC / AV1** are much smaller but some
players (e.g. older Windows Media Player without the HEVC extension) can't play them.

## How it works

| File | Role |
| --- | --- |
| `lib/api.js` | Bilibili web API: video info, WBI-signed `playurl`, stream sorting/labels |
| `lib/md5.js` | MD5 for WBI request signing |
| `lib/remote.js` | Reads a CDN file as 8 MB HTTP Range chunks (4 prefetched), retrying each chunk across mirrors and re-requesting expired URLs |
| `lib/mp4merge.js` | Stream-merges the video-only and audio-only fragmented MP4s into one MP4 by rewriting the `moov`/`moof` headers; media data is copied through untouched, fragment by fragment |
| `rules.json` | `declarativeNetRequest` rule that sets `Referer: https://www.bilibili.com/` on CDN requests (the CDN returns 403 without it). Requests made by bilibili.com pages themselves are excluded |
| `popup/` | The toolbar popup |
| `task/` | The download/merge progress page |

## Limits

- Any size works: memory use stays around 100 MB. The merged file is written to a temporary file in
  the extension's private storage, then copied to your Downloads folder, so you briefly need
  **twice the video's size** in free disk space. The temp file is deleted afterwards (leftovers from
  a closed tab are cleaned up after 24 h).
- If saving is cancelled (e.g. you dismiss a "Save as" dialog) the progress tab offers
  **Save again** without re-downloading.
- Only regular `/video/` pages are supported — not bangumi/番剧, courses, or live streams.
  DRM-protected content is out of scope.
- Respect the uploaders' rights: download for personal, offline viewing only.
