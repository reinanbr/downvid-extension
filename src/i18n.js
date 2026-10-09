// chrome.i18n helpers: t('key', ...substitutions) and data-i18n attributes.

export const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.map(String)) || key;

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((e) => (e.textContent = t(e.dataset.i18n)));
  root.querySelectorAll('[data-i18n-placeholder]').forEach((e) => (e.placeholder = t(e.dataset.i18nPlaceholder)));
  root.querySelectorAll('[data-i18n-title]').forEach((e) => {
    e.title = t(e.dataset.i18nTitle);
    e.setAttribute('aria-label', e.title);
  });
  document.documentElement.lang = chrome.i18n.getUILanguage();
}

export function formatBytes(n) {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (!sec || sec <= 0) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
