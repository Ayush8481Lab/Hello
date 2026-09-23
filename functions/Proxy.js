export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const targetParam = requestUrl.searchParams.get("url");

  if (!targetParam) {
    return new Response("Missing url parameter", { status: 400 });
  }

  // 1. Reconstruct the Target URL perfectly, preserving any extra auth tokens
  let targetUrlObj;
  try {
    targetUrlObj = new URL(targetParam);
  } catch (e) {
    return new Response("Invalid url parameter", { status: 400 });
  }

  requestUrl.searchParams.forEach((value, key) => {
    if (key !== "url") {
      targetUrlObj.searchParams.set(key, value);
    }
  });

  const finalTargetUrl = targetUrlObj.href;

  // 2. Standardized CORS Headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date, Server, Transfer-Encoding",
  };

  // Handle CORS preflight requests
  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 3. Set the specific User-Agent and pass essential streaming headers (like Range)
  const fetchHeaders = new Headers();
  const clientHeaders = context.request.headers;
  
  fetchHeaders.set("User-Agent", "plaYtv/7.1.5 (Linux;Android 14) ExoPlayerLib/2.11.7");
  fetchHeaders.set("Accept", "*/*");

  // CRUCIAL: Forward Range and Auth headers so the CDN sends the exact chunk size needed
  ["range", "cookie", "authorization", "x-dt-auth"].forEach(h => {
    if (clientHeaders.has(h)) fetchHeaders.set(h, clientHeaders.get(h));
  });

  try {
    const response = await fetch(finalTargetUrl, {
      method: context.request.method,
      headers: fetchHeaders,
      redirect: "follow"
    });

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const finalUrl = response.url || finalTargetUrl;
    const lowerUrl = finalTargetUrl.toLowerCase();

    const isM3u8 = lowerUrl.includes(".m3u") || finalUrl.toLowerCase().includes(".m3u") || contentType.includes("mpegurl");
    const isMpd = lowerUrl.includes(".mpd") || finalUrl.toLowerCase().includes(".mpd") || contentType.includes("dash+xml");

    const proxyBase = requestUrl.origin + requestUrl.pathname + "?url=";

    // Helper: Safely inherit DRM tokens into relative manifest paths
    const resolveAndKeepParams = (relativeUrl, baseUrl) => {
      try {
        const baseObj = new URL(baseUrl);
        const resolvedObj = new URL(relativeUrl, baseUrl);
        baseObj.searchParams.forEach((val, key) => {
          if (!resolvedObj.searchParams.has(key)) resolvedObj.searchParams.set(key, val);
        });
        return resolvedObj.href;
      } catch (e) { return relativeUrl; }
    };

    // --- 4. HLS (.m3u8) PROXY ---
    if (isM3u8) {
      const text = await response.text();
      const lines = text.split('\n');

      const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#') && trimmed.includes('URI="')) {
          return trimmed.replace(/URI="([^"]+)"/g, (match, p1) => {
            try {
              const absoluteUrl = resolveAndKeepParams(p1, finalUrl);
              return `URI="${proxyBase}${encodeURIComponent(absoluteUrl)}"`;
            } catch(e) { return match; }
          });
        }
        if (trimmed && !trimmed.startsWith('#')) {
          try {
            const absoluteUrl = resolveAndKeepParams(trimmed, finalUrl);
            return proxyBase + encodeURIComponent(absoluteUrl);
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
      Object.entries(corsHeaders).forEach(([k, v]) => newResponse.headers.set(k, v));
      return newResponse;
    }

    // --- 5. DASH (.mpd) PROXY ---
    if (isMpd) {
      const text = await response.text();
      let rewrittenText = text;

      // Strip <Location> to force the player to stay inside our proxy
      rewrittenText = rewrittenText.replace(/<Location>.*?<\/Location>/g, "");

      let dashBaseUrl = finalUrl;
      const baseMatch = text.match(/<BaseURL>(.*?)<\/BaseURL>/);
      if (baseMatch) {
        try { dashBaseUrl = resolveAndKeepParams(baseMatch[1].trim(), finalUrl); } catch (e) {}
      }

      rewrittenText = rewrittenText.replace(/<BaseURL>(.*?)<\/BaseURL>/g, (match, p1) => {
        try {
          const absoluteUrl = resolveAndKeepParams(p1.trim(), finalUrl);
          const wrapped = proxyBase + encodeURIComponent(absoluteUrl).replace(/%24/g, '$');
          return `<BaseURL>${wrapped}</BaseURL>`;
        } catch (e) { return match; }
      });

      rewrittenText = rewrittenText.replace(/(media|initialization|sourceURL|xlink:href)="([^"]+)"/g, (match, attr, p2) => {
        try {
          const cleanP2 = p2.replace(/&amp;/g, '&'); 
          const resolveBase = cleanP2.startsWith("http") ? finalUrl : dashBaseUrl;
          const absoluteUrl = resolveAndKeepParams(cleanP2.trim(), resolveBase);
          const wrapped = proxyBase + encodeURIComponent(absoluteUrl).replace(/%24/g, '$');
          return `${attr}="${wrapped}"`;
        } catch (e) { return match; }
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
      // Force correct MPD content type
      newResponse.headers.set("Content-Type", "application/dash+xml");
      Object.entries(corsHeaders).forEach(([k, v]) => newResponse.headers.set(k, v));
      return newResponse;
    }

    // --- 6. DIRECT STREAM PROXY (For .ts, .m4s, .mp4 segments) ---
    // EXACTLY as you requested: we stream the bytes through perfectly natively, 
    // maintaining the original CDN Content-Type, while injecting CORS to fix browser buffering!
    const proxyResponse = new Response(response.body, response);
    
    // Clear the original CDN's CORS to prevent duplicate "*, *" errors
    proxyResponse.headers.delete("Access-Control-Allow-Origin");
    proxyResponse.headers.delete("Access-Control-Allow-Methods");
    proxyResponse.headers.delete("Access-Control-Allow-Headers");
    proxyResponse.headers.delete("Access-Control-Expose-Headers");
    proxyResponse.headers.delete("Content-Disposition"); // Stop browser download prompts

    // Apply our master CORS headers
    Object.entries(corsHeaders).forEach(([k, v]) => proxyResponse.headers.set(k, v));

    return proxyResponse;

  } catch (e) {
    return new Response("Error fetching stream: " + e.message, { 
      status: 500,
      headers: corsHeaders
    });
  }
      }
