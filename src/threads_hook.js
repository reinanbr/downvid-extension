// Runs at document_start in Threads pages (page world): keeps the responses
// of the page's own requests that carry media, because some posts are not
// embedded in the HTML but fetched after loading. Read by threadsPageData()
// in page_scripts.js. Same as THREADS_HOOK in the app's InstagramQuery.kt.
(function () {
  if (window.__dvData) return;
  window.__dvData = [];
  const keep = (t) => {
    if (typeof t === 'string' && (t.indexOf('image_versions2') >= 0 || t.indexOf('video_versions') >= 0)) {
      window.__dvData.push(t);
      if (window.__dvData.length > 30) window.__dvData.shift();
    }
  };
  const f = window.fetch;
  window.fetch = function () {
    return f.apply(this, arguments).then((r) => {
      try {
        r.clone().text().then(keep, () => {});
      } catch (_) {}
      return r;
    });
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        if (this.responseType === '' || this.responseType === 'text') keep(this.responseText);
      } catch (_) {}
    });
    return send.apply(this, arguments);
  };
})();
