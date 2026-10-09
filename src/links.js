// Link classification, as in the app (lib/core/url/link_parser.dart).

export const PLATFORM_LABELS = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  threads: 'Threads',
  tiktok: 'TikTok',
  kwai: 'Kwai',
  x: 'X / Twitter',
  facebook: 'Facebook',
  soundcloud: 'SoundCloud',
  spotify: 'Spotify',
  deezer: 'Deezer',
  applemusic: 'Apple Music',
  generic: 'Link',
};

const URL_RE = /https?:\/\/[^\s<>"']+/i;
// Trailing punctuation that share texts often glue onto the URL.
const TRAILING_JUNK = /[).,;:!?\]}>]+$/;

/** First http(s) URL in arbitrary text ("Olha isso https://youtu.be/abc !"). */
export function findUrl(text) {
  const m = text?.match(URL_RE);
  if (!m) return null;
  try {
    const u = new URL(m[0].replace(TRAILING_JUNK, ''));
    return u.host ? u.href : null;
  } catch {
    return null;
  }
}

export function detectPlatform(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'generic';
  }
  const is = (...domains) => domains.some((d) => host === d || host.endsWith('.' + d));
  if (is('youtube.com', 'youtu.be', 'youtube-nocookie.com')) return 'youtube';
  if (is('instagram.com', 'instagr.am')) return 'instagram';
  if (is('threads.net', 'threads.com')) return 'threads';
  if (is('tiktok.com')) return 'tiktok';
  if (is('kwai.com', 'kw.ai', 'kwai.net')) return 'kwai';
  if (is('x.com', 'twitter.com', 't.co')) return 'x';
  if (is('facebook.com', 'fb.watch', 'fb.com')) return 'facebook';
  if (is('soundcloud.com', 'snd.sc')) return 'soundcloud';
  if (is('spotify.com', 'spotify.link')) return 'spotify';
  if (is('deezer.com', 'deezer.page.link', 'dzr.page.link')) return 'deezer';
  if (is('music.apple.com')) return 'applemusic';
  return 'generic';
}

/** Links that are about the song, not the video: open in "audio only". */
export function prefersAudio(url) {
  const p = detectPlatform(url);
  if (p === 'spotify' || p === 'deezer' || p === 'applemusic' || p === 'soundcloud') return true;
  try {
    return new URL(url).hostname.toLowerCase() === 'music.youtube.com';
  } catch {
    return false;
  }
}

// ---- Instagram (go/internal/instagram)

const IG_SHORTCODE = /instagram\.com\/(?:[\w.]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]{6,})/;
const IG_STORY = /instagram\.com\/stories\/([\w.]+)\/(\d+)/;

export const IG_APP_ID = '936619743392459';
// Fallback only: the page's current id is read from the post page (Instagram rotates it).
const IG_DOC_ID = '28256812867323632';
const IG_FRIENDLY_NAME = 'PolarisLoggedOutDesktopWWWPostRootContentQuery';

/** Shortcode → numeric media id (base64 alphabet; only the first 11 chars). */
export function igMediaId(code) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = 0n;
  for (const c of code.slice(0, 11)) n = n * 64n + BigInt(abc.indexOf(c));
  return n.toString();
}

/** What the logged-in request needs: a post's media id or a story. */
export function igQuery(url) {
  const s = url.match(IG_STORY);
  if (s) return { kind: 'story', username: s[1], storyPk: s[2], appId: IG_APP_ID };
  const m = url.match(IG_SHORTCODE);
  if (m) {
    const mediaId = igMediaId(m[1]);
    return {
      kind: 'post',
      shortcode: m[1],
      mediaId,
      appId: IG_APP_ID,
      docId: IG_DOC_ID,
      friendlyName: IG_FRIENDLY_NAME,
      variables: JSON.stringify({ media_id: mediaId }),
      referer: `https://www.instagram.com/p/${m[1]}/`,
    };
  }
  return null;
}

export function threadsShortcode(url) {
  return url.match(/\/post\/([A-Za-z0-9_-]+)/)?.[1] ?? '';
}
