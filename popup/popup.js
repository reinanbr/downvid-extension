// Popup (and the window opened from the context menu): finds the download
// options of a link, lets the user pick one (or carousel items) and hands
// the choice to the background queue; the Downloads tab follows the jobs.
// Mirrors the app's share sheet (lib/share/share_sheet.dart).

import { createApi, ApiError } from '../src/api.js';
import { extractLink } from '../src/extract.js';
import { loadSettings, saveSetting } from '../src/settings.js';
import { detectPlatform, prefersAudio, PLATFORM_LABELS } from '../src/links.js';
import { t, applyI18n, formatBytes, formatDuration } from '../src/i18n.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

let settings;
let api;
let tab = null;
let runId = 0;

/** Current extraction and the user's choices. */
const state = {
  ex: null,
  mode: 'video',
  selected: null, // option (single choice)
  items: new Set(), // carousel item numbers
  musicMeta: null,
  musicMetaFor: null,
};

// ------------------------------------------------------------------ init

async function init() {
  applyI18n();
  if (params.has('url')) document.body.classList.add('window');
  settings = await loadSettings();
  api = createApi(settings.apiBase);

  if (!settings.disclaimerAccepted) $('disclaimer').hidden = false;
  $('accept').onclick = () => {
    saveSetting('disclaimerAccepted', true);
    $('disclaimer').hidden = true;
  };

  $('open-settings').onclick = () => chrome.runtime.openOptionsPage();
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
  $('url-form').onsubmit = (e) => {
    e.preventDefault();
    run($('url').value.trim());
  };
  $('mode').querySelectorAll('button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));
  $('select-all').onclick = toggleAll;
  $('download').onclick = download;
  $('clear').onclick = clearFinished;

  try {
    if (params.has('tabId')) tab = await chrome.tabs.get(+params.get('tabId'));
    else [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
  }

  const jobs = (await chrome.storage.local.get({ jobs: [] })).jobs;
  renderJobs(jobs);
  chrome.storage.onChanged.addListener((c, area) => area === 'local' && c.jobs && renderJobs(c.jobs.newValue ?? []));

  const url = params.get('url') ?? (/^https?:/.test(tab?.url ?? '') ? tab.url : '');
  $('url').value = url;
  if (url) run(url);
  else {
    $('empty').textContent = t('emptyHint');
    $('empty').hidden = false;
    if (jobs.some(isRunning)) showView('jobs');
  }
}

function showView(name) {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('view-get').hidden = name !== 'get';
  $('view-jobs').hidden = name !== 'jobs';
}

// ----------------------------------------------------------- extraction

function showStatus(key) {
  $('status').hidden = !key;
  if (key) $('status-text').textContent = t(key);
}

function showError(text, actions = []) {
  $('error').hidden = !text;
  $('error-text').textContent = text ?? '';
  const box = $('error-actions');
  box.replaceChildren(
    ...actions.map(([label, fn]) => {
      const b = document.createElement('button');
      b.className = 'btn small';
      b.textContent = label;
      b.onclick = fn;
      return b;
    }),
  );
}

function apiErrorText(e) {
  if (!(e instanceof ApiError)) return String(e?.message ?? e);
  switch (e.code) {
    case 'network':
      return t('errNetwork');
    case 'rate_limited':
    case 'too_many_jobs':
      return e.retryAfter ? t('errRateLimitedRetry', e.retryAfter) : t('errRateLimited');
    case 'busy':
      return t('errBusy');
    case 'bad_url':
      return t('errBadUrl');
  }
  return e.message;
}

async function run(url) {
  if (!url) return;
  const id = ++runId;
  Object.assign(state, { ex: null, selected: null, items: new Set(), musicMeta: null, musicMetaFor: null });
  $('result').hidden = true;
  $('empty').hidden = true;
  showError(null);
  showView('get');
  showStatus(prefersAudio(url) && detectPlatform(url) !== 'soundcloud' ? 'statusMusic' : 'statusExtracting');

  try {
    const ex = await extractLink(api, url, { tab, onStatus: (k) => id === runId && showStatus(k) });
    if (id !== runId) return;
    showStatus(null);
    render(ex);
  } catch (e) {
    if (id !== runId) return;
    showStatus(null);
    showError(apiErrorText(e), [[t('retry'), () => run(url)]]);
  }
}

const hasVideo = (ex) => ex.options.length > 0;
const hasAudio = (ex) => ex.audioOptions.length > 0;

/** Video options to list: previews/fragments under 1 MB are hidden when there is a real video. */
function visibleVideo(ex) {
  const big = ex.options.filter((o) => !o.small);
  return big.length ? big : ex.options;
}

function isCarousel(ex) {
  return ex.options.some((o) => (o.itemCount ?? 0) > 1);
}

/** One option per carousel item (the best one, listed first). */
function carouselItems(ex) {
  const byItem = new Map();
  for (const o of ex.options) if (o.item && !byItem.has(o.item)) byItem.set(o.item, o);
  return [...byItem.values()];
}

function render(ex) {
  state.ex = ex;
  if (!hasVideo(ex) && !hasAudio(ex)) {
    const actions = [[t('retry'), () => run(ex.url)]];
    let text = ex.error || t('errNoMedia');
    if (ex.errorCode === 'login_required' && (ex.platform === 'instagram' || ex.platform === 'threads')) {
      const site = ex.platform === 'instagram' ? 'https://www.instagram.com/accounts/login/' : 'https://www.threads.com/login';
      text = t('errLoginRequired', PLATFORM_LABELS[ex.platform]);
      actions.unshift([t('signIn', PLATFORM_LABELS[ex.platform]), () => chrome.tabs.create({ url: site })]);
    }
    showError(text, actions);
    renderSkipped(ex);
    return;
  }

  $('result').hidden = false;
  const wantAudio = ex.mode === 'audio' && settings.musicAudioMode;
  setMode(hasAudio(ex) && (wantAudio || !hasVideo(ex)) ? 'audio' : 'video');
}

function renderHeader() {
  const ex = state.ex;
  const meta = state.mode === 'audio' ? state.musicMeta : null;
  const img = $('thumb');
  img.src = meta?.coverUrl || ex.thumbnail || '';
  img.classList.toggle('square', !!meta?.coverUrl);
  img.classList.toggle('none', !img.getAttribute('src'));
  img.onerror = () => img.classList.add('none');
  $('title').textContent = meta?.title || ex.title || ex.pageUrl;
  const sub = meta
    ? [meta.artist, meta.album, meta.year].filter(Boolean).join(' · ')
    : [ex.uploader, formatDuration(ex.options[0]?.durationSec ?? ex.music?.duration)].filter(Boolean).join(' · ');
  $('subtitle').textContent = sub;
  $('platform').textContent = ex.platformLabel || PLATFORM_LABELS[ex.platform] || 'Link';
}

function setMode(mode) {
  const ex = state.ex;
  state.mode = mode;
  $('mode').hidden = !(hasVideo(ex) && hasAudio(ex));
  $('mode')
    .querySelectorAll('button')
    .forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  renderHeader();
  renderOptions();
  renderSkipped(ex);
  if (mode === 'audio') loadMusicMeta();
}

function defaultVideo(list) {
  const max = settings.videoMaxHeight;
  if (!max) return list[0];
  return list.find((o) => o.height && o.height <= max) ?? list[list.length - 1];
}

function defaultAudio(list) {
  const [format, quality] = settings.audioFormat.split('_');
  return list.find((o) => o.audioFormat === format && o.audioQuality === quality) ?? list.find((o) => o.audioFormat === format) ?? list[0];
}

function sizeText(o) {
  const s = formatBytes(o.size);
  return s ? (o.sizeExact ? s : '~' + s) : '';
}

function renderOptions() {
  const ex = state.ex;
  const ul = $('options');
  const carousel = state.mode === 'video' && isCarousel(ex);
  $('carousel-tools').hidden = !carousel;

  if (carousel) {
    const items = carouselItems(ex);
    if (!state.items.size) items.forEach((o) => state.items.add(o.item));
    ul.replaceChildren(
      ...items.map((o) => {
        const li = optionRow(o, 'checkbox', state.items.has(o.item));
        if (o.itemThumb) {
          const img = document.createElement('img');
          img.src = o.itemThumb;
          img.alt = '';
          li.insertBefore(img, li.children[1]);
        }
        li.querySelector('.label').textContent = `${t('item', o.item)} · ${o.label}`;
        li.onclick = (e) => {
          if (e.target.tagName !== 'INPUT') li.querySelector('input').checked = !li.querySelector('input').checked;
          const on = li.querySelector('input').checked;
          on ? state.items.add(o.item) : state.items.delete(o.item);
          li.classList.toggle('selected', on);
          updateDownloadButton();
        };
        return li;
      }),
    );
  } else {
    const list = state.mode === 'audio' ? ex.audioOptions : visibleVideo(ex);
    if (!state.selected || !list.includes(state.selected)) {
      state.selected = state.mode === 'audio' ? defaultAudio(list) : defaultVideo(list);
    }
    ul.replaceChildren(
      ...list.map((o) => {
        const li = optionRow(o, 'radio', o === state.selected);
        li.onclick = () => {
          state.selected = o;
          ul.querySelectorAll('.option').forEach((x) => x.classList.remove('selected'));
          li.classList.add('selected');
          li.querySelector('input').checked = true;
        };
        return li;
      }),
    );
  }
  updateDownloadButton();
}

function optionRow(o, type, checked) {
  const li = document.createElement('li');
  li.className = 'option' + (checked ? ' selected' : '');
  const input = document.createElement('input');
  input.type = type;
  input.name = 'opt';
  input.checked = checked;
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = o.label;
  li.append(input, label);
  if (o.kind === 'hls') {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'HLS';
    li.append(tag);
  }
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = sizeText(o);
  li.append(size);
  return li;
}

function toggleAll() {
  const items = carouselItems(state.ex);
  if (state.items.size === items.length) state.items.clear();
  else items.forEach((o) => state.items.add(o.item));
  renderOptions();
}

function updateDownloadButton() {
  const btn = $('download');
  const ex = state.ex;
  if (state.mode === 'video' && isCarousel(ex)) {
    const n = state.items.size;
    $('carousel-count').textContent = t('selectedCount', n, carouselItems(ex).length);
    $('select-all').textContent = n === carouselItems(ex).length ? t('selectNone') : t('selectAll');
    btn.textContent = n > 1 ? t('downloadN', n) : t('download');
    btn.disabled = n === 0;
  } else {
    btn.textContent = state.mode === 'audio' ? t('downloadAudio') : t('download');
    btn.disabled = !state.selected;
  }
}

function renderSkipped(ex) {
  const hidden = state.mode === 'video' ? ex.options.filter((o) => o.small && !visibleVideo(ex).includes(o)) : [];
  const byUrl = new Map();
  for (const s of [...(ex.skipped ?? []), ...hidden.map((o) => ({ url: o.url, reason: t('preview', formatBytes(o.size)) }))]) {
    if (!byUrl.has(s.url)) byUrl.set(s.url, s);
  }
  const list = [...byUrl.values()];
  const box = $('skipped');
  box.hidden = !list.length || state.mode === 'audio';
  box.querySelector('summary').textContent = t('skipped', list.length);
  box.querySelector('ul').replaceChildren(
    ...list.map((s) => {
      const li = document.createElement('li');
      li.textContent = `${s.reason}: ${s.url}`;
      return li;
    }),
  );
}

/** Album, year, cover... shown before downloading, like the app's music header. */
async function loadMusicMeta() {
  const ex = state.ex;
  if (state.musicMetaFor === ex || (!ex.music && !ex.linkMeta)) return;
  state.musicMetaFor = ex;
  try {
    const meta = await api.musicMeta(ex.music, ex.linkMeta);
    if (state.ex !== ex) return;
    state.musicMeta = meta?.title ? meta : null;
    if (state.mode === 'audio') renderHeader();
  } catch {
    // The job resolves the tags itself.
  }
}

async function download() {
  const ex = state.ex;
  const thumb = ex.thumbnail || '';
  let items;
  if (state.mode === 'video' && isCarousel(ex)) {
    items = carouselItems(ex)
      .filter((o) => state.items.has(o.item))
      .map((o) => ({
        title: `${ex.title || 'downvid'} (${o.item})`,
        label: `${t('item', o.item)} · ${o.label}`,
        thumb: o.itemThumb || thumb,
        kind: o.kind,
        source: { url: ex.url, id: o.id, label: o.label, audio: false },
        request: { ticket: o.ticket, title: `${ex.title || 'downvid'} (${o.item})` },
      }));
  } else {
    const o = state.selected;
    const audio = state.mode === 'audio';
    const meta = audio ? state.musicMeta : null;
    const title = meta ? [meta.artist, meta.title].filter(Boolean).join(' - ') : ex.title;
    items = [
      {
        title: title || ex.pageUrl,
        label: o.label,
        thumb: meta?.coverUrl || thumb,
        kind: o.kind,
        // Lets a failed job be retried with a fresh ticket (expired links).
        source: { url: ex.url, id: o.id, label: o.label, audio },
        request: {
          ticket: o.ticket,
          // Audio without tags yet: the server names the file from the tags it resolves.
          title: (audio && !meta ? undefined : title) || undefined,
          ...(audio ? { meta: meta ?? undefined, music: ex.music, linkMeta: ex.linkMeta } : {}),
        },
      },
    ];
  }
  if (!items.length) return;
  $('download').disabled = true;
  await chrome.runtime.sendMessage({ type: 'enqueue', items });
  $('download').disabled = false;
  showView('jobs');
}

// ------------------------------------------------------------- downloads

const isRunning = (j) => j.state === 'pending' || j.state === 'queued' || j.state === 'running';

function jobInfo(j) {
  switch (j.state) {
    case 'pending':
      return [t('jobWaiting'), ''];
    case 'queued':
      return [t('jobQueued'), ''];
    case 'running': {
      const phase = t('phase_' + (j.phase || 'downloading'));
      const pct = j.percent > 0 ? ` ${Math.round(j.percent)}%` : '';
      const bytes = j.total > 0 ? `${formatBytes(j.bytes)} / ${j.totalEstimate ? '~' : ''}${formatBytes(j.total)}` : formatBytes(j.bytes);
      const speed = j.speedBps > 0 ? `${formatBytes(j.speedBps)}/s` : '';
      return [[phase + pct, bytes, speed].filter(Boolean).join(' · '), j.message ?? ''];
    }
    case 'done':
      return [j.saveError ? t('jobSaveFailed', j.saveError) : t('jobDone'), j.saveError ? 'err' : 'ok'];
    case 'saved':
      return [[t('jobSaved'), formatBytes(j.size)].filter(Boolean).join(' · '), 'ok'];
    case 'canceled':
      return [t('jobCanceled'), ''];
    default:
      return [j.message || t('jobFailed'), 'err'];
  }
}

function renderJobs(jobs) {
  const running = jobs.filter(isRunning).length;
  $('jobs-count').hidden = !running;
  $('jobs-count').textContent = running;
  $('jobs-empty').hidden = jobs.length > 0;
  $('clear').hidden = !jobs.some((j) => !isRunning(j));

  $('jobs').replaceChildren(
    ...[...jobs].reverse().map((j) => {
      const li = document.createElement('li');
      li.className = 'job';
      const img = document.createElement('img');
      img.alt = '';
      if (j.thumb) img.src = j.thumb;
      const body = document.createElement('div');
      body.className = 'body';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = j.fileName || j.title || '';
      name.title = name.textContent;
      const [text, cls] = jobInfo(j);
      const info = document.createElement('div');
      info.className = 'info ' + (cls === 'ok' || cls === 'err' ? cls : '');
      info.textContent = j.label ? `${j.label} — ${text}` : text;
      body.append(name, info);

      if (isRunning(j)) {
        const bar = document.createElement('div');
        bar.className = 'progress' + (j.percent > 0 ? '' : ' indeterminate');
        const fill = document.createElement('div');
        fill.style.width = `${Math.min(100, j.percent || 0)}%`;
        bar.append(fill);
        body.append(bar);
      }

      const row = document.createElement('div');
      row.className = 'row';
      const btn = (label, fn) => {
        const b = document.createElement('button');
        b.className = 'btn small';
        b.textContent = label;
        b.onclick = fn;
        row.append(b);
      };
      if (isRunning(j)) btn(t('cancel'), () => chrome.runtime.sendMessage({ type: 'cancel', key: j.key }));
      if (j.state === 'error' && j.source?.url) btn(t('retry'), () => chrome.runtime.sendMessage({ type: 'retry', key: j.key }));
      if (j.state === 'saved' && j.downloadId != null) {
        btn(t('showFile'), () => chrome.downloads.show(j.downloadId));
      }
      const expired = j.expiresAt && Date.parse(j.expiresAt) < Date.now();
      if ((j.state === 'done' || j.state === 'saved') && j.fileUrl && !expired) {
        btn(t('saveAgain'), () => chrome.runtime.sendMessage({ type: 'saveAgain', key: j.key }));
      }
      if (!isRunning(j)) btn(t('remove'), () => chrome.runtime.sendMessage({ type: 'remove', keys: [j.key] }));
      body.append(row);

      li.append(img, body);
      return li;
    }),
  );
}

async function clearFinished() {
  const jobs = (await chrome.storage.local.get({ jobs: [] })).jobs;
  await chrome.runtime.sendMessage({ type: 'remove', keys: jobs.filter((j) => !isRunning(j)).map((j) => j.key) });
}

init();
