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

  // CORE FIX: Forward ALL extra query parameters to the target URL.
  // If the stream URL had unencoded '&hmac=...' params, or if the video player 
  // automatically appended tokens to our proxy URL, this loop catches them 
  // and injects them back into the CDN request where they belong!
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
  };

  // Handle preflight
  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 3. Set standard Bypass Headers
  const fetchHeaders = new Headers();
  // Standard User-Agent to bypass blocks, plus the specific ExoPlayer one you requested
  fetchHeaders.set("User-Agent", "plaYtv/7.1.5 (Linux;Android 14) ExoPlayerLib/2.11.7");
  fetchHeaders.set("Accept", "*/*");

  try {
    const response = await fetch(finalTargetUrl, {
      method: context.request.method,
      headers: fetchHeaders,
      redirect: "follow",
    });

    const contentType = response.headers.get("content-type") || "";
    const finalUrl = response.url || finalTargetUrl; // Use final redirected URL for base resolutions
    const isM3u8 = finalTargetUrl.includes(".m3u") || finalUrl.includes(".m3u") || contentType.toLowerCase().includes("mpegurl");

    if (isM3u8) {
      // 4. Perfect HLS Playlist Rewrite
      const text = await response.text();
      const lines = text.split("\n");

      // Dynamically detect the current worker path so you don't have to hardcode /proxy
      const proxyBase = requestUrl.origin + requestUrl.pathname + "?url=";

      const rewrittenLines = lines.map((line) => {
        const trimmed = line.trim();

        // Rewrite #EXT-X tags that contain URIs (like Encryption Keys and Audio/Sub tracks)
        if (trimmed.startsWith("#")) {
          if (trimmed.includes('URI="')) {
            return trimmed.replace(/URI="([^"]+)"/g, (match, p1) => {
              try {
                const absoluteUrl = new URL(p1, finalUrl).href;
                return `URI="${proxyBase}${encodeURIComponent(absoluteUrl)}"`;
              } catch (e) {
                return match;
              }
            });
          }
          return line;
        }

        // Rewrite standard .ts / .m4s segment URLs
        if (trimmed && !trimmed.startsWith("#")) {
          try {
            const absoluteUrl = new URL(trimmed, finalUrl).href;
            return proxyBase + encodeURIComponent(absoluteUrl);
          } catch (e) {
            return line;
          }
        }
        return line;
      });

      // Cleanly pass non-problematic headers to the client
      const newHeaders = new Headers();
      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (
          lowerKey === "content-encoding" ||
          lowerKey === "content-length" ||
          lowerKey.startsWith("access-control-")
        ) {
          continue;
        }
        newHeaders.set(key, value);
      }

      // Inject strict CORS
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));

      return new Response(rewrittenLines.join("\n"), {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // 5. Direct Stream Proxy (For .ts, .m4s, keys, etc.)
    const proxyHeaders = new Headers(response.headers);
    proxyHeaders.delete("Access-Control-Allow-Origin");
    proxyHeaders.delete("Access-Control-Allow-Methods");
    proxyHeaders.delete("Access-Control-Allow-Headers");

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
