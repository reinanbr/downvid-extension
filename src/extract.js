// Picks the extraction route for a link, like the app's ExtractController:
//
//   Instagram  public query on the server (/v1/extract); if Instagram refuses
//              the server, the same logged-out query from a post tab; when
//              only signed-in users can see it (private posts, stories), the
//              user's own session → /v1/parse/instagram.
//   Threads    /v1/extract; when hidden from visitors, the post page read in
//              the user's browser → /v1/parse/threads.
//   Platforms  YouTube, YouTube Music, Spotify/Deezer/Apple Music (matched on
//              YouTube Music), TikTok, X...: /v1/extract (yt-dlp on the
//              server); if nothing is found and the link is the
//              open tab, the media requests the tab made → /v1/probe.
//   Any page   /v1/extract (page scan + yt-dlp) and, in parallel, the media
//              the tab requested or references in its DOM → /v1/probe.
//
// The extension plays the role of the app's hidden WebViews (InstagramQuery,
// PageSniffer): it reads what the user's browser can see and lets the API
// parse it and hand out download tickets.

import { ApiError } from './api.js';
import { detectPlatform, igQuery, threadsShortcode, PLATFORM_LABELS } from './links.js';
import { instagramPublicQuery, instagramSessionQuery, threadsPageData, domMediaCandidates } from './page_scripts.js';

const TAB_TIMEOUT_MS = 25_000;

const hasOptions = (ex) => !!ex && (ex.options?.length > 0 || ex.audioOptions?.length > 0);

function empty(url, platform, error, errorCode) {
  return {
    url,
    pageUrl: url,
    platform,
    platformLabel: PLATFORM_LABELS[platform] ?? 'Link',
    mode: 'video',
    options: [],
    audioOptions: [],
    skipped: [],
    error,
    errorCode,
  };
}

function sameDocument(a, b) {
  const norm = (u) => {
    try {
      const x = new URL(u);
      x.hash = '';
      return x.href.replace(/\/$/, '');
    } catch {
      return u;
    }
  };
  return !!a && !!b && norm(a) === norm(b);
}

function hostIs(url, ...domains) {
  try {
    const h = new URL(url).hostname;
    return domains.some((d) => h === d || h.endsWith('.' + d));
  } catch {
    return false;
  }
}

/** Media requests the background sniffer saw in a tab. */
async function sniffed(tabId) {
  try {
    const r = await chrome.runtime.sendMessage({ type: 'candidates', tabId });
    return r?.candidates ?? [];
  } catch {
    return [];
  }
}

function waitComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('timeout'));
    }, TAB_TIMEOUT_MS);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && listener(tabId, { status: 'complete' }), () => {});
  });
}

/**
 * Runs `func(...args)` in the page world of a tab: `tab` when given, else
 * a background tab opened at `openUrl` and closed afterwards.
 */
async function runInTab(tab, openUrl, func, args) {
  let tabId = tab?.id;
  let created = false;
  if (tabId == null) {
    const t = await chrome.tabs.create({ url: openUrl, active: false });
    tabId = t.id;
    created = true;
  }
  try {
    if (created) await waitComplete(tabId);
    const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
    return res?.result;
  } finally {
    if (created) chrome.tabs.remove(tabId).catch(() => {});
  }
}

async function findTab(pred) {
  const tabs = await chrome.tabs.query({});
  return tabs.find((t) => t.url && pred(t.url)) ?? null;
}

function mergeOptions(base, extra) {
  if (!extra) return base;
  if (!base) return extra;
  const seen = new Set(base.options.map((o) => o.url));
  const options = [...base.options, ...extra.options.filter((o) => !seen.has(o.url))];
  return {
    ...base,
    title: base.title || extra.title,
    thumbnail: base.thumbnail || extra.thumbnail,
    options,
    skipped: [...(base.skipped ?? []), ...(extra.skipped ?? [])],
    ...(options.length || base.audioOptions.length ? { error: undefined, errorCode: undefined } : {}),
  };
}

/** API errors that mean "try again later", not "nothing here". */
const transient = (e) => e instanceof ApiError && (e.status === 0 || e.status === 429 || e.status === 503);

async function extractOrNull(api, url) {
  try {
    return await api.extract(url);
  } catch (e) {
    if (transient(e)) throw e;
    return empty(url, detectPlatform(url), e.message, e.code);
  }
}

async function instagram(api, url, tab, onStatus) {
  const q = igQuery(url);
  let ex = null;
  if (q?.kind !== 'story') {
    ex = await extractOrNull(api, url);
    if (hasOptions(ex) || !q) return ex;
    // Instagram often refuses the server's address: the same public query
    // from the user's browser, on the post page (it needs the page's token).
    onStatus?.('statusBrowser');
    const isPost = (u) => hostIs(u, 'instagram.com') && u.includes(`/${q.shortcode}`);
    const postTab = tab && isPost(tab.url) ? tab : await findTab(isPost);
    const r = await runInTab(postTab, q.referer, instagramPublicQuery, [q]).catch(() => null);
    if (r?.body) {
      try {
        const pub = await api.parseInstagram(r.body, undefined, url);
        if (hasOptions(pub)) return pub;
      } catch (e) {
        if (transient(e)) throw e;
      }
    }
  }
  onStatus?.('statusSession');
  const igTab = tab && hostIs(tab.url, 'instagram.com') ? tab : await findTab((u) => hostIs(u, 'instagram.com'));
  const r = await runInTab(igTab, 'https://www.instagram.com/', instagramSessionQuery, [q]);
  if (!r?.body) return ex ?? empty(url, 'instagram', r?.error ?? 'Instagram did not answer', 'extract_failed');
  try {
    return await api.parseInstagram(r.body, q.storyPk, url);
  } catch (e) {
    if (transient(e)) throw e;
    return empty(url, 'instagram', e.message, e.code);
  }
}

async function threads(api, url, tab, onStatus) {
  const ex = await extractOrNull(api, url);
  if (hasOptions(ex)) return ex;
  const code = threadsShortcode(url);
  onStatus?.('statusSession');
  const isPost = (u) => hostIs(u, 'threads.com', 'threads.net') && (code ? u.includes(`/post/${code}`) : sameDocument(u, url));
  const postTab = tab && isPost(tab.url) ? tab : await findTab(isPost);
  const r = await runInTab(postTab, url, threadsPageData, [code]);
  if (!r?.body) return ex;
  try {
    return await api.parseThreads(r.body, url);
  } catch (e) {
    if (transient(e)) throw e;
    return ex.errorCode ? ex : empty(url, 'threads', e.message, e.code);
  }
}

/** Sniffed + DOM media of the open tab, as /v1/probe candidates. */
async function tabCandidates(tab) {
  const list = (await sniffed(tab.id)).map((c) => c.url);
  try {
    const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: domMediaCandidates });
    list.push(...(res?.result ?? []));
  } catch {
    // Pages the extension cannot script (store, browser pages).
  }
  return [...new Set(list)].slice(0, 40).map((url) => ({ url, referer: tab.url, source: 'extension' }));
}

async function probe(api, url, candidates) {
  if (!candidates.length) return null;
  try {
    const ex = await api.probe(url, candidates);
    return hasOptions(ex) ? ex : null;
  } catch {
    return null;
  }
}

// Real videos first, then resolution, bitrate and size; best first
// (ExtractController._compare). Carousel items keep the post order.
function compare(a, b) {
  if (!!a.small !== !!b.small) return a.small ? 1 : -1;
  if ((a.height ?? 0) !== (b.height ?? 0)) return (b.height ?? 0) - (a.height ?? 0);
  if ((a.bandwidth ?? 0) !== (b.bandwidth ?? 0)) return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  return (b.size ?? 0) - (a.size ?? 0);
}

/**
 * Drops options for media the server itself lists as `skipped` (yt-dlp's
 * generic extractor can offer a WebM/OGG source the page scan rejects, and
 * the job then fails converting it to MP4) and sorts the rest.
 */
function finish(ex) {
  if (!ex) return ex;
  const skipped = new Set((ex.skipped ?? []).map((s) => s.url));
  let options = (ex.options ?? []).filter((o) => !skipped.has(o.url));
  if (!options.some((o) => (o.itemCount ?? 0) > 1)) options = options.sort(compare);
  // Some extractors keep HTML entities in titles ("Scramble &amp; guess").
  return { ...ex, title: unescapeHtml(ex.title), uploader: unescapeHtml(ex.uploader), options, audioOptions: ex.audioOptions ?? [] };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function unescapeHtml(s) {
  if (!s || !s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * @param api      createApi() client
 * @param url      the link
 * @param tab      the browser tab the popup was opened for (optional)
 * @param onStatus called with an i18n key while the route changes
 */
export async function extractLink(api, url, opts = {}) {
  return finish(await route(api, url, opts));
}

async function route(api, url, { tab, onStatus }) {
  const platform = detectPlatform(url);
  const isTab = tab && sameDocument(tab.url, url);

  if (platform === 'instagram') return instagram(api, url, isTab ? tab : null, onStatus);
  if (platform === 'threads') return threads(api, url, isTab ? tab : null, onStatus);

  if (platform === 'generic' && isTab) {
    const candidates = await tabCandidates(tab);
    const [ex, pr] = await Promise.allSettled([api.extract(url), probe(api, url, candidates)]);
    const probed = pr.status === 'fulfilled' ? pr.value : null;
    if (ex.status === 'rejected') {
      if (probed) return probed;
      throw ex.reason;
    }
    return mergeOptions(ex.value, probed);
  }

  const ex = await extractOrNull(api, url);
  if (hasOptions(ex) || !isTab) return ex;
  onStatus?.('statusSniffer');
  return mergeOptions(ex, await probe(api, url, await tabCandidates(tab)));
}
