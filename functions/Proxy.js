export async function onRequest(context) {
  const url = new URL(context.request.url);
  const targetParam = url.searchParams.get("url");

  if (!targetParam) {
    return new Response("Missing url parameter", { status: 400 });
  }

  // RECONSTRUCT TARGET URL PERFECTLY: 
  // This catches any DRM tokens (&hmac=, &exp=) that got separated from the 'url' parameter
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

  // Set the specific User-Agent required by the SonyLIV streams (from the .m3u file)
  const headers = new Headers();
  headers.set("User-Agent", "plaYtv/7.1.5 (Linux;Android 14) ExoPlayerLib/2.11.7");

  try {
    const response = await fetch(finalTargetUrl, {
      method: context.request.method,
      headers: headers,
      redirect: "follow"
    });

    // Check if the response is an HLS playlist
    const contentType = response.headers.get("content-type") || "";
    const isM3u8 = finalTargetUrl.includes(".m3u8") || contentType.includes("mpegurl");

    if (isM3u8) {
      // Rewrite the HLS playlist so relative URLs point back to our proxy!
      const text = await response.text();
      const lines = text.split('\n');
      const finalUrl = response.url || finalTargetUrl; // Use the final redirected URL as the base!

      const proxyBase = url.origin + '/proxy?url=';
      
      const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        
        if (trimmed && trimmed.startsWith('#')) {
          if (trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (match, p1) => {
              try {
                const absoluteUrl = new URL(p1, finalUrl).href;
                return `URI="${proxyBase}${encodeURIComponent(absoluteUrl)}"`;
              } catch(e) {
                return match;
              }
            });
          }
          return line;
        }

        if (trimmed && !trimmed.startsWith('#')) {
          try {
            // Make URL absolute relative to the final redirected URL, then wrap in proxy
            // This forces .ts segments to download through the proxy
            const absoluteUrl = new URL(trimmed, finalUrl).href;
            return proxyBase + encodeURIComponent(absoluteUrl);
          } catch(e) {
            return line;
          }
        }
        return line;
      });
      
      const newResponse = new Response(rewrittenLines.join('\n'), {
        status: response.status,
        statusText: response.statusText
      });
      
      // Copy over headers and add CORS
      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        // Do not copy content-encoding or content-length because we rewrote the body!
        if (lowerKey === 'content-encoding' || lowerKey === 'content-length' || lowerKey.startsWith('access-control-')) {
          continue;
        }
        newResponse.headers.set(key, value);
      }
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      return newResponse;
    }

    // --- PERFECT DASH/MP4 PASSTHROUGH ---
    // We recreate the headers safely so we can modify them
    const proxyHeaders = new Headers(response.headers);
    
    // Strip upstream CORS headers to prevent duplicate "*, *" errors
    proxyHeaders.delete("Access-Control-Allow-Origin");
    proxyHeaders.delete("Access-Control-Allow-Methods");
    proxyHeaders.delete("Access-Control-Allow-Headers");
    
    // FIX: If the file is an MPD manifest, force the correct DASH XML Content-Type!
    // This stops the browser from showing raw XML text.
    if (finalTargetUrl.includes(".mpd") || contentType.includes("dash+xml")) {
      proxyHeaders.set("Content-Type", "application/dash+xml");
    }
    
    // Set our clean CORS headers
    proxyHeaders.set("Access-Control-Allow-Origin", "*");
    
    // We pass `response.body` completely untouched so DRM chunks work natively!
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: proxyHeaders
    });

  } catch (e) {
    return new Response("Error fetching stream: " + e.message, { 
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
}
