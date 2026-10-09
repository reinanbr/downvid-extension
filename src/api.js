// Client for the DownVid API (https://reinanbr.com/labs/downvid/api).
// Every call returns the parsed JSON or throws an ApiError with the
// server's machine code ({"error", "code"}).

export class ApiError extends Error {
  constructor(message, code, status, retryAfter = 0) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function createApi(base) {
  async function call(path, init) {
    let res;
    try {
      res = await fetch(base + path, { cache: 'no-store', credentials: 'omit', ...init });
    } catch {
      throw new ApiError('network', 'network', 0);
    }
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ApiError(
        body?.error ?? res.statusText,
        body?.code ?? `http_${res.status}`,
        res.status,
        Number(res.headers.get('Retry-After')) || 0,
      );
    }
    return body;
  }

  const post = (path, body) =>
    call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  return {
    base,
    /** Site origin: job `fileUrl`s are relative to it. */
    origin: new URL(base).origin,
    info: () => call('/v1/info'),
    extract: (url) => post('/v1/extract', { url }),
    parseInstagram: (body, storyPk, pageUrl) => post('/v1/parse/instagram', { body, storyPk, pageUrl }),
    parseThreads: (body, pageUrl) => post('/v1/parse/threads', { body, pageUrl }),
    probe: (pageUrl, candidates, scanPage = false) => post('/v1/probe', { pageUrl, candidates, scanPage }),
    musicMeta: (music, linkMeta) => post('/v1/music/meta', { music: music ?? {}, linkMeta }),
    startJob: (req) => post('/v1/jobs', req),
    job: (id) => call(`/v1/jobs/${id}`),
    cancelJob: (id) => call(`/v1/jobs/${id}`, { method: 'DELETE' }),
    fileUrl: (status) => new URL(status.fileUrl, base).href,
  };
}
