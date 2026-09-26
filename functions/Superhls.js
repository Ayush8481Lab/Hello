// functions/api/live-proxy.js
//
// HLS / DASH stream proxy for Cloudflare Pages Functions.
//
//   GET /api/live-proxy?url=<encoded>[&cookie=][&ref=][&ua=][&via=host:port]
//
// workerd constraints respected:
//   - No ProxyAgent. Proxies addressed directly: fetch(`${scheme}://${proxy}/${url}`)
//     for scheme in {http, https}. CONNECT-only proxies still won't work.
//   - Subrequest budget 50 free / 10000 paid. MAX_TRIES caps the race.
//   - CPU budget 10 ms free. Segments stream, never buffered.
//   - Playlist base uses upstream.url (post-redirect), not targetUrl.
//   - Range forwarded; 206 + Content-Range pass through.

const ALLOWED = ['fancode.com', 'akamaized.net', 'hotstar.com', 'jio.com'];

const NEEDS_RESIDENTIAL = [
  'sonydaimenew.akamaized.net',
  'live09p.hotstar.com',
  'hotstar.com',
];

// What each CDN's WAF actually expects. Defaulting to the CDN's own origin
// (which the previous version did) is what earns the Akamai error page:
// sonydaimenew.akamaized.net does not refer itself.
const REFERERS = [
  [/hotstar\.com$/i,                    'https://www.hotstar.com/'],
  [/sonydaimenew\.akamaized\.net$/i,    'https://www.sonyliv.com/'],
  [/sonyliv\.com$/i,                    'https://www.sonyliv.com/'],
  [/fancode\.com$/i,                    'https://www.fancode.com/'],
  [/jio\.com$/i,                        'https://www.jio.com/'],
];

function refererFor(hostname) {
  for (const [re, ref] of REFERERS) if (re.test(hostname)) return ref;
  return null;
}

const PROXY_LIST_URLS = [
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt',
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/https.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
];

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Leave headroom for the list fetch, the pinned attempt, and the direct
// fallback. 30 tries at 8-wide is 4 batches worst case.
const MAX_TRIES = 30;
const BATCH = 8;
const BATCH_MS = 5000;
const PINNED_MS = 6000;
const DIRECT_MS = 15000;

const allowed = (h) => ALLOWED.some(s => h === s || h.endsWith('.' + s));
const needsResidential = (h) => NEEDS_RESIDENTIAL.some(s => h === s || h.endsWith('.' + s));

// ── proxy pool ──────────────────────────────────────────────
// Module scope survives between requests on a warm isolate. `inflight`
// guards against a cold isolate stampeding every list at once.
let pool = { list: [], at: 0 };
let inflight = null;
const known = new Map();  // hostname -> { scheme, proxy } that last worked

function capKnown() {
  if (known.size > 500) known.delete(known.keys().next().value);
}

async function proxyList() {
  if (pool.list.length && Date.now() - pool.at < 15 * 60_000) return pool.list;
  if (inflight) return inflight;
  inflight = (async () => {
    const merged = new Set();
    await Promise.all(PROXY_LIST_URLS.map(async (src) => {
      try {
        const r = await fetch(src, { cf: { cacheTtl: 900 } });
        if (!r.ok) return;
        const txt = await r.text();
        for (const line of txt.split('\n')) {
          const t = line.trim();
          if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(t)) merged.add(t);
        }
      } catch { /* skip this source */ }
    }));
    const list = [...merged];
    if (list.length) pool = { list, at: Date.now() };
  })().finally(() => { inflight = null; });
  return inflight;
}

// Direct-address proxy fetch. workerd has no ProxyAgent, so the proxy goes
// in the URL and the target goes in the path. Both schemes are tried: some
// entries only answer TLS on the advertised port.
function get(url, headers, proxy, ms, scheme = 'http') {
  const target = proxy ? `${scheme}://${proxy}/${url}` : url;
  return fetch(target, {
    headers,
    signal: AbortSignal.timeout(ms),
    redirect: 'follow',
  });
}

// Race the pool in batches. Serial would exhaust the function's time long
// before finding a live entry. The winner is remembered per host, because
// what SonyLiv accepts and what Hotstar accepts need not match.
async function findProxy(url, headers, hostname, skip = '') {
  const list = await proxyList();
  if (!list.length) return { hit: null, diag: 'empty-pool' };

  const remembered = known.get(hostname);
  const rememberedKey = remembered ? remembered.proxy : '';
  const rest = list.filter(p => p !== rememberedKey && p !== skip);
  const ordered = rememberedKey && rememberedKey !== skip
    ? [rememberedKey, ...rest]
    : rest;

  const failures = [];
  for (let i = 0; i < Math.min(ordered.length, MAX_TRIES); i += BATCH) {
    const batch = ordered.slice(i, i + BATCH);

    const attempts = batch.flatMap((p) => ['http', 'https'].map(async (scheme) => {
      try {
        const r = await get(url, headers, p, BATCH_MS, scheme);
        if (!r.ok) throw new Error(`${r.status}`);
        return { proxy: p, scheme, res: r };
      } catch (e) {
        failures.push(`${p}/${scheme}=${e.message}`);
        throw e;
      }
    }));

    const hit = await Promise.any(attempts).catch(() => null);
    if (hit) {
      known.set(hostname, { proxy: hit.proxy, scheme: hit.scheme });
      capKnown();
      return { hit, diag: `ok ${hit.proxy} via ${hit.scheme}` };
    }
  }
  return { hit: null, diag: failures.slice(-12).join(',') };
}

// ── handler ─────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers':
    'X-Proxy-Via, X-Proxy-Scheme, X-Proxy-Diag, X-Proxy-Upstream',
};

export const onRequestOptions = async () =>
  new Response(null, { status: 204, headers: CORS });

export const onRequestGet = async (context) => {
  const { request } = context;
  const url = new URL(request.url);

  const target = url.searchParams.get('url');
  const cookie = url.searchParams.get('cookie') || '';
  const refParam = url.searchParams.get('ref') || '';
  const ua = url.searchParams.get('ua') || '';
  const via = url.searchParams.get('via') || '';

  if (!target) return new Response('Missing ?url=', { status: 400, headers: CORS });

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return new Response('Invalid url', { status: 400, headers: CORS }); }
  if (!allowed(targetUrl.hostname))
    return new Response('Host not allowed', { status: 403, headers: CORS });

  // Referer priority: explicit ?ref= wins; otherwise the CDN's expected
  // origin from REFERERS; otherwise the target's own origin as a last resort.
  const referer =
    refParam ||
    refererFor(targetUrl.hostname) ||
    targetUrl.origin + '/';
  let refOrigin;
  try { refOrigin = new URL(referer).origin; }
  catch { refOrigin = targetUrl.origin; }

  const headers = {
    'User-Agent': ua || DEFAULT_UA,
    'Referer': referer,
    'Origin': refOrigin,
    'Accept': '*/*',
    'Accept-Language': 'en-IN,en;q=0.9',
    ...(cookie ? { Cookie: cookie } : {}),
    ...(request.headers.get('range')
      ? { Range: request.headers.get('range') }
      : {}),
  };

  let upstream = null;
  let usedProxy = '';
  let usedScheme = '';
  let diag = '';

  try {
    if (via) {
      // A playlist names the proxy that fetched it, so its segments follow
      // the same route instead of each one searching the pool again. Public
      // proxies die mid-stream, so a pinned one that throws or refuses is
      // dropped and the pool is searched again.
      const remembered = known.get(targetUrl.hostname);
      const pinned = remembered ? remembered.proxy : via;
      const pinnedScheme = remembered ? remembered.scheme : 'http';
      usedProxy = pinned;
      usedScheme = pinnedScheme;

      try { upstream = await get(targetUrl.toString(), headers, pinned, PINNED_MS, pinnedScheme); }
      catch { upstream = null; }

      if (!upstream || !upstream.ok) {
        const prevStatus = upstream ? upstream.status : 0;
        if (remembered && remembered.proxy === pinned) known.delete(targetUrl.hostname);
        const found = await findProxy(targetUrl.toString(), headers, targetUrl.hostname, pinned);
        if (found.hit) {
          upstream = found.hit.res;
          usedProxy = found.hit.proxy;
          usedScheme = found.hit.scheme;
          diag = found.diag;
        } else {
          // Pinned failed and the pool is empty or dead. Try direct before
          // giving up, so the player sees a slower fetch rather than a 403.
          upstream = await get(targetUrl.toString(), headers, null, DIRECT_MS);
          usedProxy = '';
          usedScheme = '';
          diag = `pinned ${prevStatus} then ${found.diag}`;
        }
      }
    } else if (needsResidential(targetUrl.hostname)) {
      const found = await findProxy(targetUrl.toString(), headers, targetUrl.hostname);
      if (found.hit) {
        upstream = found.hit.res;
        usedProxy = found.hit.proxy;
        usedScheme = found.hit.scheme;
        diag = found.diag;
      } else {
        upstream = await get(targetUrl.toString(), headers, null, DIRECT_MS);
        diag = found.diag;
      }
    } else {
      upstream = await get(targetUrl.toString(), headers, null, DIRECT_MS);
    }
  } catch (e) {
    return new Response('Upstream failed: ' + e.message, { status: 502, headers: CORS });
  }

  const out = new Headers(CORS);
  if (usedProxy) {
    out.set('X-Proxy-Via', usedProxy);
    out.set('X-Proxy-Scheme', usedScheme);
  }
  if (diag) out.set('X-Proxy-Diag', diag.slice(0, 500));

  if (!upstream.ok) {
    const body = await upstream.text();
    out.set('X-Proxy-Upstream', String(upstream.status));

    // Akamai puts its real reason in these headers when it serves the
    // edgesuite error page. Pass them through so curl shows what the code
    // cannot see.
    for (const h of ['x-akamai-request-id', 'x-akamai-transformed',
                     'server-timing', 'x-cache', 'x-check-cacheable',
                     'x-true-cache-key']) {
      const v = upstream.headers.get(h);
      if (v) out.set('X-Upstream-' + h, v.slice(0, 300));
    }

    return new Response(body.slice(0, 4000), { status: upstream.status, headers: out });
  }

  // Redirects change the directory; relative playlist lines must resolve
  // against where the bytes actually came from, not where we asked.
  const resolvedBase = new URL(upstream.url || targetUrl.href);

  const ct = upstream.headers.get('content-type') || '';
  const lower = targetUrl.pathname.toLowerCase();
  const isPlaylist = lower.endsWith('.m3u8') || ct.includes('mpegurl');
  const isDash = lower.endsWith('.mpd') || ct.includes('dash+xml');

  if (isDash) {
    let xml = await upstream.text();
    const dir = resolvedBase.href.slice(0, resolvedBase.href.lastIndexOf('/') + 1);
    if (!/<BaseURL>\s*https?:/i.test(xml)) {
      xml = xml.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${dir}</BaseURL>`);
    }
    out.set('Content-Type', 'application/dash+xml');
    out.set('Cache-Control', 'no-cache');
    return new Response(xml, { status: 200, headers: out });
  }

  if (isPlaylist) {
    const text = await upstream.text();
    const base = `${url.origin}/api/live-proxy`;

    const extras =
      (cookie ? '&cookie=' + encodeURIComponent(cookie) : '') +
      (refParam ? '&ref=' + encodeURIComponent(refParam) : '') +
      (ua ? '&ua=' + encodeURIComponent(ua) : '') +
      (usedProxy ? '&via=' + encodeURIComponent(usedProxy) : '');

    // A child with no query of its own inherits the parent's. FanCode and
    // SonyLiv sign in the query with an acl covering the folder, and
    // resolving a relative reference drops it — without this the master
    // plays and every variant comes back 403.
    const parentQuery = targetUrl.search;
    const toAbs = (r) => {
      const u = new URL(r, resolvedBase);
      if (!u.search && parentQuery) u.search = parentQuery;
      return u.toString();
    };
    const wrap = (abs) => base + '?url=' + encodeURIComponent(abs) + extras;

    const body = text.split('\n').map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#'))
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(toAbs(u))}"`);
      return wrap(toAbs(t));
    }).join('\n');

    out.set('Content-Type', 'application/vnd.apple.mpegurl');
    out.set('Cache-Control', 'no-cache');
    return new Response(body, { status: 200, headers: out });
  }

  out.set('Content-Type', ct || 'application/octet-stream');
  out.set('Cache-Control', upstream.headers.get('cache-control') || 'no-cache');
  const cr = upstream.headers.get('content-range');
  if (cr) out.set('Content-Range', cr);

  return new Response(upstream.body, { status: upstream.status, headers: out });
};
