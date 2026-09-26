// functions/api/live-proxy.js
//
// HLS / DASH stream proxy for Cloudflare Pages Functions.
//
// Two block types are handled:
//   - Geographic-only (FanCode): cleared by edge placement, no proxy needed.
//   - Datacenter-refusing (SonyLiv, Hotstar): forwarded through a public
//     HTTP proxy on an Indian residential/campus network. Those proxies are
//     strangers' machines — fine for token-signed public streams that expire
//     in hours, not for anything private.
//
//   GET /api/live-proxy?url=<encoded>[&cookie=][&ref=][&ua=][&via=host:port]
//
// Constraints this respects:
//   - workerd has no ProxyAgent. Proxies are addressed directly:
//     fetch(`http://${proxy}/${target}`). CONNECT-only proxies will fail the
//     r.ok check and be discarded — test your list before deploying.
//   - Subrequest budget: 50 free / 10000 paid. MAX_TRIES caps the race.
//   - CPU budget on free is 10 ms. Segments stream through, never buffered.
//   - Playlist/DASH base uses upstream.url (post-redirect), not targetUrl.
//   - Range is forwarded; 206 and Content-Range pass through.
//   - No env, no wrangler.toml, no dashboard config required.

const ALLOWED = ['fancode.com', 'akamaized.net', 'hotstar.com', 'jio.com'];

const NEEDS_RESIDENTIAL = [
  'sonydaimenew.akamaized.net',
  'live09p.hotstar.com',
  'hotstar.com',
];

const PROXY_LIST =
  'https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Subrequest budget leaves headroom for the list fetch, the pinned attempt,
// and the direct fallback.
const MAX_TRIES = 30;
const BATCH = 8;
const BATCH_MS = 5000;
const PINNED_MS = 6000;
const DIRECT_MS = 15000;

const allowed = (h) => ALLOWED.some(s => h === s || h.endsWith('.' + s));
const needsResidential = (h) => NEEDS_RESIDENTIAL.some(s => h === s || h.endsWith('.' + s));

// ── proxy pool ──────────────────────────────────────────────
// Module scope survives between requests on a warm isolate. `inflight`
// guards against a cold isolate stampeding the list URL.
let pool = { list: [], at: 0 };
let inflight = null;
const known = new Map();  // hostname -> proxy that last worked for it

function capKnown() {
  if (known.size > 500) known.delete(known.keys().next().value);
}

async function proxyList() {
  if (pool.list.length && Date.now() - pool.at < 15 * 60_000) return pool.list;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(PROXY_LIST, { cf: { cacheTtl: 900 } });
      if (r.ok) {
        const txt = await r.text();
        const list = txt.split('\n').map(l => l.trim())
          .filter(l => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(l));
        if (list.length) pool = { list, at: Date.now() };
      }
    } catch { /* keep whatever we had */ }
    finally { inflight = null; }
  })();
  return inflight;
}

// Direct-address proxy fetch. workerd has no ProxyAgent; the proxy is the
// host in the URL and the target goes in the path.
function get(url, headers, proxy, ms) {
  const target = proxy ? `http://${proxy}/${url}` : url;
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
  if (!list.length) return null;

  const remembered = known.get(hostname);
  const rest = list.filter(p => p !== remembered && p !== skip);
  const ordered = remembered && remembered !== skip ? [remembered, ...rest] : rest;

  for (let i = 0; i < Math.min(ordered.length, MAX_TRIES); i += BATCH) {
    const batch = ordered.slice(i, i + BATCH);
    const hit = await Promise.any(batch.map(async (p) => {
      const r = await get(url, headers, p, BATCH_MS);
      if (!r.ok) throw new Error(String(r.status));
      return { proxy: p, res: r };
    })).catch((agg) => {
      // Surface the last batch's failures so a dead pool is visible.
      if (i + BATCH >= Math.min(ordered.length, MAX_TRIES)) {
        const codes = (agg && agg.errors ? agg.errors : [])
          .map(e => e && e.message).filter(Boolean).slice(0, 8);
        console.warn('proxy race exhausted', hostname, codes);
      }
      return null;
    });
    if (hit) { known.set(hostname, hit.proxy); capKnown(); return hit; }
  }
  return null;
}

// ── handler ─────────────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'X-Proxy-Via, X-Proxy-Upstream',
};

export const onRequestOptions = async () =>
  new Response(null, { status: 204, headers: CORS });

export const onRequestGet = async (context) => {
  const { request } = context;
  const url = new URL(request.url);

  const target = url.searchParams.get('url');
  const cookie = url.searchParams.get('cookie') || '';
  const ref = url.searchParams.get('ref') || '';
  const ua = url.searchParams.get('ua') || '';
  const via = url.searchParams.get('via') || '';

  if (!target) return new Response('Missing ?url=', { status: 400, headers: CORS });

  let targetUrl;
  try { targetUrl = new URL(target); }
  catch { return new Response('Invalid url', { status: 400, headers: CORS }); }
  if (!allowed(targetUrl.hostname))
    return new Response('Host not allowed', { status: 403, headers: CORS });

  let refOrigin = targetUrl.origin;
  if (ref) { try { refOrigin = new URL(ref).origin; } catch { /* keep target's */ } }

  const headers = {
    'User-Agent': ua || DEFAULT_UA,
    'Referer': ref || targetUrl.origin + '/',
    'Origin': refOrigin,
    'Accept': '*/*',
    ...(cookie ? { Cookie: cookie } : {}),
    ...(request.headers.get('range')
      ? { Range: request.headers.get('range') }
      : {}),
  };

  let upstream = null;
  let usedProxy = '';

  try {
    if (via) {
      // A playlist names the proxy that fetched it, so its segments go the
      // same way instead of each one searching the pool again. Public
      // proxies die mid-stream, so a pinned one that throws or refuses is
      // dropped and the pool is searched again.
      const pinned = known.get(targetUrl.hostname) || via;
      usedProxy = pinned;
      try { upstream = await get(targetUrl.toString(), headers, pinned, PINNED_MS); }
      catch { upstream = null; }

      if (!upstream || !upstream.ok) {
        if (known.get(targetUrl.hostname) === pinned) known.delete(targetUrl.hostname);
        const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname, pinned);
        if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
        else {
          // Pinned failed and the pool is empty or dead. Try direct before
          // giving up, so the player sees a slower fetch rather than a 403.
          const status = upstream ? upstream.status : 0;
          upstream = await get(targetUrl.toString(), headers, null, DIRECT_MS);
          usedProxy = '';
          if (!upstream.ok && status) {
            console.warn('pinned + pool + direct all failed',
              targetUrl.hostname, status, upstream.status);
          }
        }
      }
    } else if (needsResidential(targetUrl.hostname)) {
      const hit = await findProxy(targetUrl.toString(), headers, targetUrl.hostname);
      if (hit) { upstream = hit.res; usedProxy = hit.proxy; }
      else upstream = await get(targetUrl.toString(), headers, null, DIRECT_MS);
    } else {
      // FanCode and friends: served straight from the edge. Placement is
      // what clears their geographic block, not a proxy.
      upstream = await get(targetUrl.toString(), headers, null, DIRECT_MS);
    }
  } catch (e) {
    return new Response('Upstream failed: ' + e.message, { status: 502, headers: CORS });
  }

  const out = new Headers(CORS);
  if (usedProxy) out.set('X-Proxy-Via', usedProxy);

  // A refusal is not a playlist, whatever the path says. Rewriting an HTML
  // error page as one turns its lines into proxy URLs and the player gets a
  // 200-looking manifest of nonsense instead of the reason.
  if (!upstream.ok) {
    const body = await upstream.text();
    out.set('X-Proxy-Upstream', String(upstream.status));
    return new Response(body.slice(0, 2000), { status: upstream.status, headers: out });
  }

  // Redirects change the directory; relative playlist lines must resolve
  // against where the bytes actually came from, not where we asked.
  const resolvedBase = new URL(upstream.url || targetUrl.href);

  const ct = upstream.headers.get('content-type') || '';
  const lower = targetUrl.pathname.toLowerCase();
  const isPlaylist = lower.endsWith('.m3u8') || ct.includes('mpegurl');
  const isDash = lower.endsWith('.mpd') || ct.includes('dash+xml');

  // ── DASH manifest ─────────────────────────────────────────
  // Segment names live in templates, not as URLs, so line-by-line rewriting
  // does not apply. An absolute BaseURL pointing at the real directory makes
  // the player resolve segments to real CDN URLs, which the client-side
  // request filter then wraps on the way out.
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

  // ── HLS playlist ──────────────────────────────────────────
  if (isPlaylist) {
    const text = await upstream.text();
    const base = `${url.origin}/api/live-proxy`;

    const extras =
      (cookie ? '&cookie=' + encodeURIComponent(cookie) : '') +
      (ref ? '&ref=' + encodeURIComponent(ref) : '') +
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

  // ── Segments and keys ─────────────────────────────────────
  // Stream through. No Buffer, no arrayBuffer — workerd's CPU budget on the
  // free plan is 10 ms and materializing a 6 MB segment eats it.
  out.set('Content-Type', ct || 'application/octet-stream');
  out.set('Cache-Control', upstream.headers.get('cache-control') || 'no-cache');
  const cr = upstream.headers.get('content-range');
  if (cr) out.set('Content-Range', cr);

  return new Response(upstream.body, { status: upstream.status, headers: out });
};
