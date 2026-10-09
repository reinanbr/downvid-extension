import { createApi } from '../src/api.js';
import { loadSettings, saveSetting, DEFAULT_API } from '../src/settings.js';
import { t, applyI18n, formatBytes } from '../src/i18n.js';

const $ = (id) => document.getElementById(id);

let toastTimer = 0;
function saved() {
  $('saved').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('saved').hidden = true), 1200);
}

async function showServer(base) {
  const dl = $('server');
  dl.replaceChildren();
  const row = (k, v) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  };
  try {
    const info = await createApi(base).info();
    const l = info.limits ?? {};
    row(t('serverStatus'), `${t('serverOnline')} · ${info.name} ${info.version}`);
    row(t('serverMaxFile'), formatBytes(l.maxFileBytes));
    row(t('serverMaxDuration'), t('minutes', Math.round((l.maxDurationSec ?? 0) / 60)));
    row(t('serverFileTtl'), t('minutes', Math.round((l.fileTtlSec ?? 0) / 60)));
    row(t('serverJobs'), String(l.maxJobsPerClient ?? '-'));
    row(t('serverPlatforms'), (info.platforms ?? []).map((p) => p.label).join(', '));
  } catch {
    row(t('serverStatus'), t('serverOffline'));
  }
}

async function init() {
  applyI18n();
  const s = await loadSettings();

  $('videoMaxHeight').value = String(s.videoMaxHeight);
  $('audioFormat').value = s.audioFormat;
  $('folder').value = s.folder;
  $('apiBase').value = s.apiBase;
  for (const k of ['musicAudioMode', 'saveAs', 'notify', 'sniffer']) $(k).checked = s[k];

  $('videoMaxHeight').onchange = (e) => saveSetting('videoMaxHeight', +e.target.value).then(saved);
  $('audioFormat').onchange = (e) => saveSetting('audioFormat', e.target.value).then(saved);
  $('folder').onchange = (e) => saveSetting('folder', e.target.value.trim()).then(saved);
  for (const k of ['musicAudioMode', 'saveAs', 'notify', 'sniffer']) {
    $(k).onchange = (e) => saveSetting(k, e.target.checked).then(saved);
  }

  const setApi = async (v) => {
    const base = (v || DEFAULT_API).trim().replace(/\/+$/, '');
    $('apiBase').value = base;
    await saveSetting('apiBase', base);
    saved();
    showServer(base);
  };
  $('apiBase').onchange = (e) => setApi(e.target.value);
  $('reset-api').onclick = () => setApi(DEFAULT_API);

  showServer(s.apiBase);
}

init();
