export async function onRequest(context) {
  const url = new URL(context.request.url);
  const targetParam = url.searchParams.get("url");

  if (!targetParam) {
    return new Response("Missing url parameter", { status: 400 });
  }

  // 1. RECONSTRUCT TARGET URL PERFECTLY
  let targetUrlObj;
  try {
    targetUrlObj = new URL(targetParam);
  } catch (e) {
    return new Response("Invalid url parameter passed.", { status: 400 });
  }

  // Capture all DRM tokens attached to the proxy request
  url.searchParams.forEach((value, key) => {
    if (key !== "url") {
      targetUrlObj.searchParams.set(key, value);
    }
  });

  const finalTargetUrl = targetUrlObj.href;

  // 2. Handle CORS preflight requests
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };

  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 3. Set standard Bypass Headers
  const headers = new Headers();
  headers.set("User-Agent", "plaYtv/7.1.5 (Linux;Android 14) ExoPlayerLib/2.11.7");
  
  const clientHeaders = context.request.headers;
  ["range", "accept", "cookie", "authorization"].forEach(h => {
    if (clientHeaders.has(h)) headers.set(h, clientHeaders.get(h));
  });

  try {
    const response = await fetch(finalTargetUrl, {
      method: context.request.method,
      headers: headers,
      redirect: "follow"
    });

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const finalUrl = response.url || finalTargetUrl;

    const isM3u8 = finalTargetUrl.includes(".m3u8") || contentType.includes("mpegurl");
    const isMpd = finalTargetUrl.includes(".mpd") || contentType.includes("dash+xml");

    // Define the distinct paths for Manifests vs Segments
    const manifestProxyBase = url.origin + url.pathname + '?url=';
    const segmentProxyBase = url.origin + '/Segmentsproxy?url=';

    // Helper: Safely resolves relative paths and forces DRM token inheritance!
    const resolveWithParams = (relativeUrl, manifestUrl) => {
      try {
        const manifestObj = new URL(manifestUrl);
        const resolvedObj = new URL(relativeUrl, manifestObj.href); // Resolves path relatively
        
        // Inject DRM tokens from Manifest URL into the Segment URL
        manifestObj.searchParams.forEach((val, key) => {
          if (!resolvedObj.searchParams.has(key)) {
            resolvedObj.searchParams.set(key, val);
          }
        });
        return resolvedObj.href;
      } catch (e) {
        return relativeUrl;
      }
    };

    // --- 4. HLS (.m3u8) DUAL-ROUTING ---
    if (isM3u8) {
      const text = await response.text();
      const lines = text.split('\n');
      
      const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        
        if (trimmed && trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (match, p1) => {
              try {
                const absoluteWithTokens = resolveWithParams(p1, finalUrl);
                // Route nested playlists back to THIS worker, and chunks to the SEGMENT worker
                if (absoluteWithTokens.includes('.m3u')) {
                  return `URI="${manifestProxyBase}${encodeURIComponent(absoluteWithTokens)}"`;
                }
                return `URI="${segmentProxyBase}${encodeURIComponent(absoluteWithTokens)}"`;
              } catch(e) { return match; }
            });
          }
          return line;
        }

        if (trimmed && !trimmed.startsWith('#')) {
          try {
            const absoluteWithTokens = resolveWithParams(trimmed, finalUrl);
            if (absoluteWithTokens.includes('.m3u')) {
              return manifestProxyBase + encodeURIComponent(absoluteWithTokens);
            }
            return segmentProxyBase + encodeURIComponent(absoluteWithTokens);
          } catch(e) { return line; }
        }
        return line;
      });
      
      const newResponse = new Response(rewrittenLines.join('\n'), {
        status: response.status,
        statusText: response.statusText
      });
      
      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'content-encoding' || lowerKey === 'content-length' || lowerKey.startsWith('access-control-')) continue;
        newResponse.headers.set(key, value);
      }
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      return newResponse;
    }

    // --- 5. DASH (.mpd) ROUTING TO /Segmentsproxy ---
    if (isMpd) {
      const text = await response.text();
      let rewrittenText = text;

      // Strip <Location> to force the player to stay inside our proxy environment
      rewrittenText = rewrittenText.replace(/<Location>.*?<\/Location>/g, "");

      // Rewrite Segment Templates to route strictly to /Segmentsproxy
      rewrittenText = rewrittenText.replace(/(media|initialization|sourceURL)="([^"]+)"/g, (match, attr, p1) => {
        try {
          const absoluteWithTokens = resolveWithParams(p1, finalUrl);
          // Notice: .replace(/%24/g, '$') keeps ExoPlayer DASH variables intact!
          const wrapped = segmentProxyBase + encodeURIComponent(absoluteWithTokens).replace(/%24/g, '$');
          return `${attr}="${wrapped}"`;
        } catch(e) { return match; }
      });

      // Rewrite BaseURLs to route strictly to /Segmentsproxy
      rewrittenText = rewrittenText.replace(/<BaseURL>(.*?)<\/BaseURL>/g, (match, p1) => {
        try {
          const absoluteWithTokens = resolveWithParams(p1.trim(), finalUrl);
          const wrapped = segmentProxyBase + encodeURIComponent(absoluteWithTokens).replace(/%24/g, '$');
          return `<BaseURL>${wrapped}</BaseURL>`;
        } catch(e) { return match; }
      });

      const newResponse = new Response(rewrittenText, {
        status: response.status,
        statusText: response.statusText
      });

      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'content-encoding' || lowerKey === 'content-length' || lowerKey.startsWith('access-control-')) continue;
        newResponse.headers.set(key, value);
      }
      
      // Fix raw text issue by strictly forcing MPD content type
      newResponse.headers.set("Content-Type", "application/dash+xml");
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      return newResponse;
    }

    // --- 6. FALLBACK DIRECT PASSTHROUGH ---
    // If a segment accidentally hits this manifest worker, just pass it through directly
    const proxyResponse = new Response(response.body, response);
    proxyResponse.headers.delete("Access-Control-Allow-Origin");
    proxyResponse.headers.delete("Access-Control-Allow-Methods");
    proxyResponse.headers.delete("Access-Control-Allow-Headers");
    proxyResponse.headers.set("Access-Control-Allow-Origin", "*");
    
    return proxyResponse;

  } catch (e) {
    return new Response("Error fetching stream: " + e.message, { 
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
   }
