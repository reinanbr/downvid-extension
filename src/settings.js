// User settings, in storage.sync so they follow the browser profile.
// Same choices as the app's Settings screen (lib/core/settings.dart), plus
// the API address and how files are saved.

export const DEFAULT_API = 'https://reinanbr.com/api/labs/downvid';

export const DEFAULTS = {
  apiBase: DEFAULT_API,
  /** Default video quality: 0 = best available, else max height (720...). */
  videoMaxHeight: 0,
  /** Default audio: m4a_copy | mp3_v0 | mp3_320. */
  audioFormat: 'm4a_copy',
  /** Music links (YouTube Music, SoundCloud, Spotify...) open in "audio only". */
  musicAudioMode: true,
  /** Record the media requests tabs make (MP4/HLS) for generic pages. */
  sniffer: true,
  /** Subfolder inside the browser's download folder ('' = none). */
  folder: 'DownVid',
  /** Ask where to save each file. */
  saveAs: false,
  /** System notification when a download finishes or fails. */
  notify: true,
  /** The usage notice was acknowledged. */
  disclaimerAccepted: false,
};

export async function loadSettings() {
  try {
    const s = await chrome.storage.sync.get(DEFAULTS);
    return { ...DEFAULTS, ...s, apiBase: (s.apiBase || DEFAULT_API).replace(/\/+$/, '') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSetting(key, value) {
  return chrome.storage.sync.set({ [key]: value });
}
