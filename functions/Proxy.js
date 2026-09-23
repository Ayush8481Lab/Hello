export async function onRequest(context) {
  const url = new URL(context.request.url);
  const targetParam = url.searchParams.get("url");

  if (!targetParam) {
    return new Response("Missing url parameter", { status: 400 });
  }

  // RECONSTRUCT TARGET URL PERFECTLY: 
  // Captures tokens like &hmac= that the video player appends to the proxy URL
  let targetUrlObj;
  try {
    targetUrlObj = new URL(targetParam);
  } catch (e) {
    return new Response("Invalid url parameter passed.", { status: 400 });
  }

  url.searchParams.forEach((value, key) => {
    if (key !== "url") {
      targetUrlObj.searchParams.set(key, value);
    }
  });

  const finalTargetUrl = targetUrlObj.href;

  // Handle CORS preflight requests
  if (context.request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  // Set headers
  const headers = new Headers();
  headers.set("User-Agent", "plaYtv/7.1.5 (Linux;Android 14) ExoPlayerLib/2.11.7");
  
  // CRITICAL: Pass 'Range' and 'Accept' headers so the CDN sends chunks instead of downloading the whole file!
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

    const contentType = response.headers.get("content-type") || "";
    const finalUrl = response.url || finalTargetUrl; // Use the final redirected URL as the base
    const proxyBase = url.origin + url.pathname + '?url=';

    const isM3u8 = finalTargetUrl.includes(".m3u8") || contentType.includes("mpegurl");
    const isMpd = finalTargetUrl.includes(".mpd") || contentType.includes("dash+xml");

    // --- 1. HLS REWRITE ---
    if (isM3u8) {
      const text = await response.text();
      const lines = text.split('\n');
      
      const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        
        if (trimmed && trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (match, p1) => {
              try {
                const absoluteUrl = new URL(p1, finalUrl).href;
                return `URI="${proxyBase}${encodeURIComponent(absoluteUrl)}"`;
              } catch(e) { return match; }
            });
          }
          return line;
        }

        if (trimmed && !trimmed.startsWith('#')) {
          try {
            const absoluteUrl = new URL(trimmed, finalUrl).href;
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
        if (lowerKey === 'content-encoding' || lowerKey === 'content-length') continue;
        newResponse.headers.set(key, value);
      }
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      return newResponse;
    }

    // --- 2. DASH (.mpd) REWRITE ---
    if (isMpd) {
      const text = await response.text();
      let rewrittenText = text;

      // Extract the absolute base directory of the original CDN URL
      const urlObj = new URL(finalUrl);
      const basePath = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);

      // Remove <Location> tags to stop player bypass
      rewrittenText = rewrittenText.replace(/<Location>.*?<\/Location>/g, "");

      // Rewrite segment templates (media, initialization) to route through the proxy!
      rewrittenText = rewrittenText.replace(/(media|initialization|sourceURL)="([^"]+)"/g, (match, attr, p1) => {
        try {
          const absoluteUrl = new URL(p1, basePath).href;
          // Note: .replace(/%24/g, '$') ensures ExoPlayer variables like $Number$ aren't broken!
          const wrapped = proxyBase + encodeURIComponent(absoluteUrl).replace(/%24/g, '$');
          return `${attr}="${wrapped}"`;
        } catch(e) { return match; }
      });

      // Rewrite BaseURL tags
      rewrittenText = rewrittenText.replace(/<BaseURL>(.*?)<\/BaseURL>/g, (match, p1) => {
        try {
          const absoluteUrl = new URL(p1.trim(), basePath).href;
          const wrapped = proxyBase + encodeURIComponent(absoluteUrl).replace(/%24/g, '$');
          return `<BaseURL>${wrapped}</BaseURL>`;
        } catch(e) { return match; }
      });

      const newResponse = new Response(rewrittenText, {
        status: response.status,
        statusText: response.statusText
      });

      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'content-encoding' || lowerKey === 'content-length' || lowerKey === 'content-type') continue;
        newResponse.headers.set(key, value);
      }
      
      // Fix raw text issue by forcing MPD content type
      newResponse.headers.set("Content-Type", "application/dash+xml");
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      return newResponse;
    }

    // --- 3. VIDEO SEGMENTS / FALLBACK DIRECT STREAM ---
    const proxyResponse = new Response(response.body, response);
    
    // Prevent duplicated CORS headers
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
