// Functions injected into Instagram/Threads tabs with
// chrome.scripting.executeScript (page world, the user's own session).
// They must be self-contained: no closures, only their arguments.
// Ported from the app's InstagramQuery.kt; the responses are parsed by the
// API (/v1/parse/instagram, /v1/parse/threads), never stored.

/**
 * Instagram's logged-out post query, made from the post page like the site
 * does for visitors (session token and current query id read from the
 * page). Used when Instagram refuses the API server's address.
 * Returns {status, body}.
 */
export async function instagramPublicQuery(q) {
  try {
    const html = document.documentElement.innerHTML;
    let lsd = (html.match(/"LSD",\[\],\{"token":"([^"]+)"/) || [])[1];
    if (!lsd) {
      const e = document.getElementById('__eqmc');
      if (e) {
        try {
          lsd = JSON.parse(e.textContent).l;
        } catch (_) {}
      }
    }
    const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '';
    const qid = (html.match(new RegExp('"queryID":"(\\d+)","variables":\\{[^}]*\\},"queryName":"' + q.friendlyName + '"')) || [])[1];
    const body = new URLSearchParams({
      lsd: lsd || '',
      fb_api_caller_class: 'RelayModern',
      fb_api_req_friendly_name: q.friendlyName,
      server_timestamps: 'true',
      variables: q.variables,
      doc_id: qid || q.docId,
    });
    const r = await fetch('/api/graphql', {
      method: 'POST',
      credentials: 'include',
      body,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-IG-App-ID': q.appId,
        'X-FB-LSD': lsd || '',
        'X-ASBD-ID': '129477',
        'X-FB-Friendly-Name': q.friendlyName,
        'X-Requested-With': 'XMLHttpRequest',
        'X-CSRFToken': csrf,
      },
    });
    return { status: r.status, body: await r.text() };
  } catch (e) {
    return { status: 0, error: String(e) };
  }
}

/**
 * Logged-in Instagram requests: media info for a post, or the user's
 * current stories (the API picks the story by storyPk).
 * Returns {status, body}.
 */
export async function instagramSessionQuery(q) {
  const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '';
  const headers = {
    'X-IG-App-ID': q.appId,
    'X-ASBD-ID': '129477',
    'X-CSRFToken': csrf,
    'X-Requested-With': 'XMLHttpRequest',
  };
  const loginRequired = '{"status":"fail","message":"login_required"}';
  try {
    let r;
    if (q.kind === 'story') {
      const pr = await fetch('/api/v1/users/web_profile_info/?username=' + encodeURIComponent(q.username), {
        credentials: 'include',
        headers,
      });
      const pt = await pr.text();
      let uid = null;
      try {
        uid = JSON.parse(pt).data.user.id;
      } catch (_) {}
      if (!uid) return { status: pr.status, body: pt.startsWith('{') ? pt : '{"status":"fail","message":"user not found"}' };
      r = await fetch('/api/v1/feed/reels_media/?reel_ids=' + uid, { credentials: 'include', headers });
    } else {
      r = await fetch('/api/v1/media/' + q.mediaId + '/info/', { credentials: 'include', headers });
    }
    const t = await r.text();
    // A redirect to the login page means there is no session.
    return { status: r.status, body: t.startsWith('{') || t.startsWith('for (;;);') ? t : loginRequired };
  } catch (e) {
    return { status: 0, error: String(e) };
  }
}

/**
 * Threads: the post page embeds its data in <script type="application/json">
 * tags, or fetches it after loading (kept by threads_hook.js). Returns the
 * body for /v1/parse/threads: {url, scripts} with the data that mentions the
 * post, or {url, html} with the page as served.
 */
export async function threadsPageData(shortcode) {
  try {
    const code = shortcode || (location.pathname.match(/\/post\/([A-Za-z0-9_-]+)/) || [])[1] || '';
    const pick = () =>
      Array.from(document.querySelectorAll('script[type="application/json"]'))
        .map((s) => s.textContent)
        .concat(window.__dvData || [])
        .filter((t) => code && t.indexOf('"' + code + '"') >= 0 && t.indexOf('image_versions2') >= 0);
    let found = pick();
    for (let i = 0; i < 40 && !found.length; i++) {
      await new Promise((r) => setTimeout(r, 300));
      found = pick();
    }
    if (found.length) return { body: JSON.stringify({ url: location.href, scripts: found }) };
    const r = await fetch(location.href, { credentials: 'include' });
    return { body: JSON.stringify({ url: r.url || location.href, html: await r.text() }) };
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * Media URLs the page's DOM references directly (<video>, <source>,
 * og:video), to complement the network sniffer.
 */
export function domMediaCandidates() {
  const out = new Set();
  const add = (u) => {
    try {
      const abs = new URL(u, location.href);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') out.add(abs.href);
    } catch (_) {}
  };
  document.querySelectorAll('video[src], video source[src], audio[src]').forEach((e) => add(e.getAttribute('src')));
  document.querySelectorAll('video').forEach((v) => v.currentSrc && add(v.currentSrc));
  document
    .querySelectorAll('meta[property="og:video"], meta[property="og:video:url"], meta[property="og:video:secure_url"]')
    .forEach((m) => m.content && add(m.content));
  return [...out].slice(0, 20);
}
