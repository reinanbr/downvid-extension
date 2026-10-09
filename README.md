<p align="center"><img src="icons/logo.svg" width="96" alt="DownVid"></p>

<h1 align="center">DownVid browser extension</h1>

<p align="center">
  <a href="https://github.com/reinanbr/downvid-extension/actions/workflows/ci.yml"><img src="https://github.com/reinanbr/downvid-extension/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/reinanbr/downvid-extension/releases/latest"><img src="https://img.shields.io/github/v/release/reinanbr/downvid-extension" alt="Release"></a>
</p>

Download videos, music and photos from **YouTube, YouTube Music, Instagram,
Threads, TikTok, X/Twitter, Facebook and SoundCloud**, from **Spotify, Deezer
and Apple Music** links (the same recording, found on YouTube Music) and from
any page with an MP4/HLS video. It is the browser version of the
[DownVid](https://github.com/reinanbr/downvid) Android app, built on the
[DownVid API](https://reinanbr.com/labs/downvid/api).

> Use DownVid only with content that is your own, public, or that you are
> authorized to download, respecting each platform's terms of service and
> copyright.

## Download

| Browser | Package |
|---|---|
| Chrome, Edge, Brave, Opera | [downvid-extension-chrome.zip](https://github.com/reinanbr/downvid-extension/releases/latest/download/downvid-extension-chrome.zip) |
| Firefox 128+ | [downvid-extension-firefox.zip](https://github.com/reinanbr/downvid-extension/releases/latest/download/downvid-extension-firefox.zip) |

Every push also builds both zips as a
[CI](https://github.com/reinanbr/downvid-extension/actions/workflows/ci.yml)
artifact (`downvid-extension`).

### Install

- **Chrome / Edge / Brave**: unzip the package, open `chrome://extensions`,
  turn on *Developer mode*, click *Load unpacked* and pick the folder.
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary
  Add-on…* → pick the zip (or `manifest.json`). In `about:addons` → DownVid →
  *Permissions*, allow access to all sites.

## Screenshots

| YouTube | Music (Spotify → YouTube Music) | TikTok |
|---|---|---|
| ![YouTube](docs/screenshots/youtube.png) | ![Music](docs/screenshots/music.png) | ![TikTok](docs/screenshots/tiktok.png) |

| Downloads (running on the server) | Downloads finished |
|---|---|
| ![Downloads](docs/screenshots/downloads.png) | ![Finished](docs/screenshots/downloads-done.png) |

<img src="docs/screenshots/options.png" width="520" alt="Settings">

## Usage

- **Toolbar button**: looks up the current tab (or paste a link). Pick a
  quality, or *Audio only* (original M4A, MP3 320 or MP3 V0, with tags and
  cover art), and click *Download*. Instagram and Threads carousels have
  checkboxes.
- **Context menu**: "Download link with DownVid" on links, "Download from
  this page with DownVid" on pages and videos, and "Download selected link
  with DownVid" on selected text.
- **Downloads**: the queue with its progress (downloading, merging,
  converting), cancel, show in folder and save again. Files go to
  `Downloads/DownVid/`. A failed download (for example a YouTube link that
  expired) can be retried: the extension extracts the link again and
  restarts the same choice, like the app's link renewal.
- **Settings**: default video quality, audio format, music links in *Audio
  only*, subfolder, ask where to save, notifications, the video detector and
  the API address.

## How it works

Everything goes through the [DownVid API](https://reinanbr.com/labs/downvid/api):
`POST /v1/extract` lists the options, `POST /v1/jobs` downloads on the server
(merges video and audio, converts to MP3/M4A with tags and cover art), and the
extension follows the job and saves `GET /v1/jobs/{id}/file` with the
browser's download manager. What changes per link is how the options are
found (as in the app's `ExtractController`):

| Link | Route |
|---|---|
| **YouTube, YouTube Music, TikTok, X, Facebook, SoundCloud…** | `/v1/extract` (yt-dlp on the server). If nothing is found and the link is the open tab, the videos the tab loaded go to `/v1/probe`. |
| **Spotify / Deezer / Apple Music** | `/v1/extract` reads the track and finds the same recording on YouTube Music (same duration ±5 s). Opens in *Audio only*, with album, year and cover art (`/v1/music/meta`). |
| **Instagram** | `/v1/extract` (the logged-out query, made by the server). If Instagram refuses the server, the same logged-out query runs on the post page, in the browser. Private posts and stories use the user's own session (`/api/v1/media/{id}/info/`, `reels_media`) and only the response goes to `/v1/parse/instagram`. |
| **Threads** | `/v1/extract`; if the post is hidden from visitors, the data the post page embeds or fetches → `/v1/parse/threads`. |
| **Any other page** | `/v1/extract` (page scan + yt-dlp) and, in parallel, `/v1/probe` with the MP4/HLS requests the tab made (network sniffer, like the app's `PageSniffer`) and the page's `<video>`/`og:video`. |

### YouTube and the server

YouTube asks datacenter addresses for a bot check. The API server handles it
with yt-dlp, a PO token provider
([bgutil-ytdlp-pot-provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider))
and the cookies of a YouTube account dedicated to it. The extension never
stores or sends YouTube sessions.

### Privacy

Instagram and Threads sessions never leave the browser: the extension sends
the API only the post's response. The sniffer keeps media URLs in
`storage.session` (cleared when the browser closes) and sends them only when
you ask for a download from that tab. The limits (1 GB files, 120 min, 4
simultaneous server downloads, requests per minute) come from
`GET /v1/info`; when the server refuses because of too many jobs, the
extension waits in its local queue.

## Development

```bash
npm ci
npm test            # links, Instagram ids, titles
npm run lint        # web-ext lint
npm run build       # dist/downvid-extension-chrome.zip and -firefox.zip
npx web-ext run     # opens Firefox with the extension
```

CI (`.github/workflows/ci.yml`) runs a syntax check, the tests, the lint and
the build on every push and pull request, and uploads the zips as an
artifact. `v*` tags (e.g. `v0.2.0`, equal to `version` in `manifest.json`)
create a GitHub Release with the zips, which the download links point to.

```
manifest.json
src/background.js       network sniffer, job queue, downloads, context menu
src/extract.js          picks the extraction route (port of the app's ExtractController)
src/api.js              DownVid API client
src/links.js            platforms, Instagram media ids
src/page_scripts.js     Instagram/Threads queries run in tabs (port of InstagramQuery.kt)
src/threads_hook.js     keeps the responses that carry media on Threads pages
popup/, options/        user interface
_locales/en, pt_BR      translations (English is the default)
test/                   tests (node --test)
```

## Limitations

- Live streams, DRM and DASH `.mpd` manifests on generic pages are not
  supported.
- What the server cannot download (for example when YouTube blocks its
  address), the extension cannot either: it shows the API's error.
- Instagram or Threads content that only signed-in users can see needs you
  to be signed in in the browser; stories always do.

## License

[GPL-3.0](LICENSE), like the DownVid app.
