export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const targetParam = requestUrl.searchParams.get("url");

  if (!targetParam) {
    return new Response("Missing url parameter. Usage: ?url=https://...", { status: 400 });
  }

  // 1. RECONSTRUCT THE TARGET URL PERFECTLY
  let targetUrlObj;
  try {
    targetUrlObj = new URL(targetParam);
  } catch (e) {
    return new Response("Invalid url parameter passed.", { status: 400 });
  }

  // Merge any extra proxy parameters into the target URL safely
  requestUrl.searchParams.forEach((value, key) => {
    if (key !== "url") {
      targetUrlObj.searchParams.set(key, value);
    }
  });

  const finalTargetUrl = targetUrlObj.href;

  // 2. Strict CORS Headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Range, Origin, X-Requested-With, Content-Type, Accept, Authorization, x-dt-auth, If-Match, If-None-Match",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date, Server, Transfer-Encoding",
  };

  // Handle preflight requests
  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 3. Set bypass headers safely
  const fetchHeaders = new Headers();
  const clientHeaders = context.request.headers;
  
  for (const [key, value] of clientHeaders.entries()) {
    const lowerKey = key.toLowerCase();
    if (!lowerKey.startsWith("cf-") && 
        !["host", "origin", "referer", "connection", "accept-encoding"].includes(lowerKey)) {
      fetchHeaders.set(key, value);
    }
  }

  if (!fetchHeaders.has("user-agent")) {
    fetchHeaders.set("user-agent", "plaYtv/7.1.5 (Linux;Android 14) ExoPlayerLib/2.11.7");
  }

  try {
    const response = await fetch(finalTargetUrl, {
      method: context.request.method,
      headers: fetchHeaders,
      redirect: "follow",
    });

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const finalUrl = response.url || finalTargetUrl; 
    const lowerUrl = finalTargetUrl.toLowerCase();

    // Detect format
    const isM3u8 = lowerUrl.includes(".m3u") || finalUrl.toLowerCase().includes(".m3u") || contentType.includes("mpegurl");
    const isMpd = lowerUrl.includes(".mpd") || finalUrl.toLowerCase().includes(".mpd") || contentType.includes("dash+xml");

    // Helper: Safely copy response headers avoiding conflicts
    const copyCleanHeaders = () => {
      const newHeaders = new Headers();
      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey === "content-encoding" ||
          lowerKey === "content-length" ||
          lowerKey === "content-type" ||
          lowerKey === "content-disposition" || 
          lowerKey.startsWith("access-control-")
        ) {
          continue;
        }
        newHeaders.set(key, value);
      }
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
      return newHeaders;
    };

    const proxyBase = requestUrl.origin + requestUrl.pathname + "?url=";

    // This helper extracts the tokens from the Manifest URL and mathematically merges them into the Segment URL
    const resolveAndKeepParams = (relativeUrl, baseUrl) => {
      try {
        const baseObj = new URL(baseUrl);
        const resolvedObj = new URL(relativeUrl, baseUrl);
        
        baseObj.searchParams.forEach((val, key) => {
          if (!resolvedObj.searchParams.has(key)) {
            resolvedObj.searchParams.set(key, val);
          }
        });
        return resolvedObj.href;
      } catch (e) {
        return relativeUrl;
      }
    };

    // --- 4. HLS (.m3u8) MANIFEST-ONLY PROXY ---
    if (isM3u8) {
      const text = await response.text();
      const lines = text.split("\n");

      const rewrittenLines = lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
          return trimmed.replace(/URI="([^"]+)"/g, (match, p1) => {
            try {
              const absoluteUrl = resolveAndKeepParams(p1, finalUrl);
              // Proxy nested playlists, but let video segments hit the native CDN directly!
              if (absoluteUrl.includes(".m3u")) return `URI="${proxyBase}${encodeURIComponent(absoluteUrl)}"`;
              return `URI="${absoluteUrl}"`; 
            } catch (e) { return match; }
          });
        }
        if (trimmed && !trimmed.startsWith("#")) {
          try {
            const absoluteUrl = resolveAndKeepParams(trimmed, finalUrl);
            // Proxy nested playlists, but let video segments hit the native CDN directly!
            if (absoluteUrl.includes(".m3u")) return proxyBase + encodeURIComponent(absoluteUrl);
            return absoluteUrl;
          } catch (e) { return line; }
        }
        return line;
      });

      const newHeaders = copyCleanHeaders();
      newHeaders.set("Content-Type", "application/vnd.apple.mpegurl");

      return new Response(rewrittenLines.join("\n"), {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // --- 5. DASH (.mpd) MANIFEST-ONLY PROXY ---
    if (isMpd) {
      const text = await response.text();
      let rewrittenText = text;

      rewrittenText = rewrittenText.replace(/<Location>.*?<\/Location>/g, "");

      let dashBaseUrl = finalUrl;
      const baseMatch = text.match(/<BaseURL>(.*?)<\/BaseURL>/);
      if (baseMatch) {
        try {
          dashBaseUrl = resolveAndKeepParams(baseMatch[1].trim(), finalUrl);
        } catch (e) {}
      }

      // Rewrite BaseURLs to point DIRECTLY to the CDN (No proxyBase wrapper)
      rewrittenText = rewrittenText.replace(/<BaseURL>(.*?)<\/BaseURL>/g, (match, p1) => {
        try {
          const absoluteUrl = resolveAndKeepParams(p1.trim(), finalUrl);
          const finalSegmentUrl = absoluteUrl.replace(/%24/g, '$').replace(/&/g, '&amp;');
          return `<BaseURL>${finalSegmentUrl}</BaseURL>`;
        } catch (e) { return match; }
      });

      // Rewrite initialization and media segments to point DIRECTLY to the CDN
      rewrittenText = rewrittenText.replace(/(media|initialization|sourceURL|xlink:href)="([^"]+)"/g, (match, attr, p2) => {
        try {
          const cleanP2 = p2.replace(/&amp;/g, '&'); 
          const resolveBase = cleanP2.startsWith("http") ? finalUrl : dashBaseUrl;
          const absoluteUrl = resolveAndKeepParams(cleanP2.trim(), resolveBase);
          
          // Notice we DO NOT wrap this in proxyBase. The player will hit SonyLIV directly with the correct DRM tokens!
          const finalSegmentUrl = absoluteUrl.replace(/%24/g, '$').replace(/&/g, '&amp;');
          return `${attr}="${finalSegmentUrl}"`;
        } catch (e) { return match; }
      });

      const newHeaders = copyCleanHeaders();
      newHeaders.set("Content-Type", "application/dash+xml");

      return new Response(rewrittenText, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // --- 6. Direct Stream Proxy (Fallback Only) ---
    // If you happen to hit the proxy with a media segment directly, we force the correct Content-Type to prevent "proxy.bin" downloads.
    const proxyHeaders = new Headers(response.headers);
    proxyHeaders.delete("Access-Control-Allow-Origin");
    proxyHeaders.delete("Access-Control-Allow-Methods");
    proxyHeaders.delete("Access-Control-Allow-Headers");
    proxyHeaders.delete("Content-Disposition"); // Stop forced downloads

    if (lowerUrl.includes(".m4s")) proxyHeaders.set("Content-Type", "video/iso.segment");
    else if (lowerUrl.includes(".mp4")) proxyHeaders.set("Content-Type", "video/mp4");
    else if (lowerUrl.includes(".ts")) proxyHeaders.set("Content-Type", "video/MP2T");

    Object.entries(corsHeaders).forEach(([k, v]) => proxyHeaders.set(k, v));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: proxyHeaders,
    });
    
  } catch (e) {
    return new Response("Error fetching stream: " + e.message, {
      status: 500,
      headers: corsHeaders,
    });
  }
}
