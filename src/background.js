// Background worker:
//  - network sniffer: the media requests (MP4, HLS) each tab makes, like the
//    app's PageSniffer, offered to /v1/probe for generic pages;
//  - download queue: server jobs (/v1/jobs) started from the popup, followed
//    until done, then saved with the browser's download manager. The queue
//    lives in storage.local so it survives the worker being stopped;
//  - context menu "Download with DownVid" on links, videos and pages.

import { createApi, ApiError } from './api.js';
import { loadSettings } from './settings.js';
import { findUrl } from './links.js';

// ---------------------------------------------------------------- sniffer

const MAX_CANDIDATES = 40;
const MEDIA_PATH = /\.(m3u8|mp4|m4v|mov)$/i;
const MEDIA_TYPES = [
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];
// Streams handled by the platform extractors, and fragments of DASH/HLS
// streams that are useless on their own.
const SKIP_HOSTS = /(^|\.)(googlevideo\.com|youtube\.com|ytimg\.com)$/i;
const SKIP_QUERY = /[?&](bytestart|byteend|range)=/i;
const SKIP_PATH = /\.(ts|m4s|aac|vtt|webvtt|key|jpg|png|webp|gif)$/i;

/** tabId → [{url, type, size, at}] (newest last). */
const sniffed = new Map();
let sniffedLoaded = null;

function loadSniffed() {
  sniffedLoaded ??= chrome.storage.session
    .get('sniffed')
    .then(({ sniffed: s }) => {
      for (const [k, v] of Object.entries(s ?? {})) if (!sniffed.has(+k)) sniffed.set(+k, v);
    })
    .catch(() => {});
  return sniffedLoaded;
}

let persistTimer = 0;
function persistSniffed() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.session.set({ sniffed: Object.fromEntries(sniffed) }).catch(() => {});
  }, 500);
}

function updateBadge(tabId) {
  const n = sniffed.get(tabId)?.length ?? 0;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}

function header(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
}

function isMedia(url, contentType) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (SKIP_HOSTS.test(u.hostname) || SKIP_QUERY.test(u.search) || SKIP_PATH.test(u.pathname)) return false;
  const type = contentType.split(';')[0].trim().toLowerCase();
  return MEDIA_PATH.test(u.pathname) || MEDIA_TYPES.includes(type);
}

function sizeOf(details) {
  const range = header(details.responseHeaders, 'content-range').match(/\/(\d+)$/);
  if (range) return +range[1];
  return details.statusCode === 200 ? +header(details.responseHeaders, 'content-length') || -1 : -1;
}

let snifferOn = true;
loadSettings().then((s) => (snifferOn = s.sniffer));
chrome.storage.onChanged.addListener((c, area) => {
  if (area === 'sync' && c.sniffer) snifferOn = c.sniffer.newValue !== false;
});

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    // A new document in the tab: forget the previous page's media.
    if (d.type === 'main_frame' && d.tabId >= 0 && sniffed.has(d.tabId)) {
      sniffed.delete(d.tabId);
      updateBadge(d.tabId);
      persistSniffed();
    }
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (!snifferOn || d.tabId < 0 || d.statusCode >= 400) return;
    const type = header(d.responseHeaders, 'content-type');
    if (!isMedia(d.url, type)) return;
    loadSniffed().then(() => {
      const list = sniffed.get(d.tabId) ?? [];
      if (list.some((c) => c.url === d.url)) return;
      list.push({ url: d.url, type: type.split(';')[0], size: sizeOf(d), at: Date.now() });
      // Playlists first when trimming: they expand into every quality.
      while (list.length > MAX_CANDIDATES) {
        const i = list.findIndex((c) => !/\.m3u8/i.test(c.url));
        list.splice(i >= 0 ? i : 0, 1);
      }
      sniffed.set(d.tabId, list);
      updateBadge(d.tabId);
      persistSniffed();
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders'],
);

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sniffed.delete(tabId)) persistSniffed();
});

// ------------------------------------------------------------------ jobs

const ACTIVE = new Set(['queued', 'running']);
const POLL_MS = 1000;
const KEEP_FINISHED = 60;

let jobsCache = null;
let maxJobs = 4;

async function getJobs() {
  jobsCache ??= (await chrome.storage.local.get({ jobs: [] })).jobs;
  return jobsCache;
}

const isOpen = (j) => j.state === 'pending' || ACTIVE.has(j.state);

async function saveJobs() {
  const jobs = await getJobs();
  // Keep everything unfinished and the most recent finished ones.
  const finished = jobs.filter((j) => !isOpen(j));
  if (finished.length > KEEP_FINISHED) {
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED));
    jobsCache = jobs.filter((j) => !drop.has(j));
  }
  await chrome.storage.local.set({ jobs: jobsCache });
}

const localId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/** Adds jobs to the queue: {title, label, thumb, kind, request}; they get a server job when a slot frees up. */
async function enqueue(items) {
  const jobs = await getJobs();
  for (const it of items) {
    jobs.push({
      key: localId(),
      id: null,
      state: 'pending',
      phase: 'queued',
      percent: 0,
      bytes: 0,
      total: -1,
      speedBps: 0,
      createdAt: Date.now(),
      ...it,
    });
  }
  await saveJobs();
  pump();
}

function sanitize(name) {
  return (
    (name || 'downvid')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 180) || 'downvid'
  );
}

async function saveFile(api, settings, job) {
  try {
    job.downloadId = await download(settings, api.fileUrl(job), job.fileName);
    job.state = 'saved';
  } catch (e) {
    job.saveError = String(e?.message ?? e);
  }
}

async function download(settings, url, fileName) {
  const folder = settings.folder.replace(/[\\:*?"<>|]+/g, '_').replace(/^\/+|\/+$/g, '');
  const name = sanitize(fileName);
  return chrome.downloads.download({
    url,
    filename: folder ? `${folder}/${name}` : name,
    saveAs: settings.saveAs,
    conflictAction: 'uniquify',
  });
}

function notify(settings, job) {
  if (!settings.notify) return;
  const ok = job.state === 'saved';
  chrome.notifications
    .create(job.key, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: chrome.i18n.getMessage(ok ? 'notifyDone' : 'notifyFailed'),
      message: ok ? job.fileName || job.title || '' : `${job.title || ''}\n${job.message || job.saveError || ''}`,
    })
    .catch(() => {});
}

function fail(settings, job, message) {
  job.state = 'error';
  job.message = message;
  notify(settings, job);
}

function apply(job, status) {
  const keep = {
    key: job.key, title: job.title, label: job.label, thumb: job.thumb, kind: job.kind, createdAt: job.createdAt,
    source: job.source, lastRequest: job.lastRequest,
  };
  Object.assign(job, status, keep);
}

// ---- the loop

let pumping = false;

/** Starts pending jobs, follows running ones and saves finished files. */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const settings = await loadSettings();
      const api = createApi(settings.apiBase);
      const jobs = await getJobs();
      let wait = POLL_MS;

      // Start pending jobs while the server allows more for this client.
      for (const job of jobs.filter((j) => j.state === 'pending')) {
        if (jobs.filter((j) => ACTIVE.has(j.state)).length >= maxJobs) break;
        // What a retry needs besides a fresh ticket (title, tags).
        const { ticket: _, ...rest } = job.request ?? {};
        job.lastRequest = rest;
        try {
          apply(job, await api.startJob(job.request));
          delete job.request;
        } catch (e) {
          if (e instanceof ApiError && (e.code === 'too_many_jobs' || e.code === 'busy' || e.status === 0)) break;
          if (e instanceof ApiError && e.code === 'rate_limited') {
            wait = Math.max(wait, (e.retryAfter || 5) * 1000);
            break;
          }
          delete job.request;
          fail(settings, job, e.message);
        }
      }

      for (const job of jobs.filter((j) => ACTIVE.has(j.state))) {
        try {
          apply(job, await api.job(job.id));
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) fail(settings, job, chrome.i18n.getMessage('jobExpired'));
          continue; // network: try again on the next round
        }
        if (job.state === 'done') {
          await saveFile(api, settings, job);
          notify(settings, job);
        } else if (job.state === 'error') {
          notify(settings, job);
        }
      }

      await saveJobs();
      if (!jobs.some(isOpen)) break;
      await new Promise((r) => setTimeout(r, wait));
    }
  } finally {
    pumping = false;
  }
}

async function cancel(key) {
  const jobs = await getJobs();
  const job = jobs.find((j) => j.key === key);
  if (!job || !isOpen(job)) return;
  if (job.id) {
    const api = createApi((await loadSettings()).apiBase);
    await api.cancelJob(job.id).catch(() => {});
  }
  job.state = 'canceled';
  await saveJobs();
}

async function remove(keys) {
  const set = new Set(keys);
  jobsCache = (await getJobs()).filter((j) => !set.has(j.key) || isOpen(j));
  await saveJobs();
}

/**
 * Retries a failed job like the app's link renewal: extracts the link again,
 * finds the same choice (id, else label) and starts it with the new ticket.
 */
async function retry(key) {
  const job = (await getJobs()).find((j) => j.key === key);
  if (!job?.source?.url || isOpen(job)) return;
  const settings = await loadSettings();
  const api = createApi(settings.apiBase);
  try {
    const ex = await api.extract(job.source.url);
    const list = job.source.audio ? ex.audioOptions : ex.options;
    const o = list?.find((x) => x.id === job.source.id) ?? list?.find((x) => x.label === job.source.label);
    if (!o) throw new Error(ex.error || chrome.i18n.getMessage('errNoMedia'));
    Object.assign(job, {
      id: null, state: 'pending', phase: 'queued', percent: 0, bytes: 0, total: -1, speedBps: 0,
      message: undefined, saveError: undefined, fileUrl: undefined,
      request: { ...(job.lastRequest ?? {}), ticket: o.ticket },
    });
  } catch (e) {
    job.message = String(e?.message ?? e);
  }
  await saveJobs();
  pump();
}

async function saveAgain(key) {
  const job = (await getJobs()).find((j) => j.key === key);
  if (!job?.fileUrl) return;
  const settings = await loadSettings();
  delete job.saveError;
  await saveFile(createApi(settings.apiBase), settings, job);
  await saveJobs();
}

// Resume after the worker was stopped (browser restart, idle).
chrome.alarms.create('dv-pump', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => a.name === 'dv-pump' && pump());
chrome.runtime.onStartup.addListener(() => pump());

loadSettings()
  .then((s) => createApi(s.apiBase).info())
  .then((info) => (maxJobs = info?.limits?.maxJobsPerClient || maxJobs))
  .catch(() => {});

// -------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run = async () => {
    switch (msg?.type) {
      case 'candidates':
        await loadSniffed();
        return { candidates: sniffed.get(msg.tabId) ?? [] };
      case 'enqueue':
        await enqueue(msg.items);
        return { ok: true };
      case 'cancel':
        await cancel(msg.key);
        return { ok: true };
      case 'remove':
        await remove(msg.keys);
        return { ok: true };
      case 'saveAgain':
        await saveAgain(msg.key);
        return { ok: true };
      case 'retry':
        await retry(msg.key);
        return { ok: true };
    }
    return null;
  };
  run().then(reply, (e) => reply({ error: String(e) }));
  return true;
});

// ---------------------------------------------------------- context menu

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'dv-link', title: chrome.i18n.getMessage('menuLink'), contexts: ['link'] });
    chrome.contextMenus.create({
      id: 'dv-page',
      title: chrome.i18n.getMessage('menuPage'),
      contexts: ['page', 'video', 'audio', 'frame', 'image'],
    });
    chrome.contextMenus.create({ id: 'dv-selection', title: chrome.i18n.getMessage('menuSelection'), contexts: ['selection'] });
  });
}

chrome.runtime.onInstalled.addListener((d) => {
  createMenus();
  if (d.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(createMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let url;
  if (info.menuItemId === 'dv-link') url = info.linkUrl;
  else if (info.menuItemId === 'dv-selection') url = findUrl(info.selectionText);
  else url = info.frameUrl && info.frameUrl !== info.pageUrl && info.mediaType ? info.frameUrl : info.pageUrl;
  if (!url) return;
  const q = new URLSearchParams({ url });
  if (tab?.id >= 0) q.set('tabId', String(tab.id));
  chrome.windows.create({ url: chrome.runtime.getURL('popup/popup.html?' + q), type: 'popup', width: 440, height: 660 });
});
