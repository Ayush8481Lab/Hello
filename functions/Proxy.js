export async function onRequest(context) {
  const url = new URL(context.request.url);
  const targetParam = url.searchParams.get("url");

  if (!targetParam) {
    return new Response("Missing url parameter", { status: 400 });
  }

  // RECONSTRUCT TARGET URL PERFECTLY: 
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

  // Set the specific User-Agent required by the streams
  const headers = new Headers();
  headers.set("User-Agent", "plaYtv/7.1.5 (Linux;Android 14) ExoPlayerLib/2.11.7");

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

    // --- 1. HLS (.m3u8) PROXY (UNTOUCHED AS REQUESTED) ---
    if (isM3u8) {
      const text = await response.text();
      const lines = text.split('\n');

      const proxyBase = url.origin + '/Proxy?url=';
      
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
      
      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        if (lowerKey === 'content-encoding' || lowerKey === 'content-length' || lowerKey.startsWith('access-control-')) {
          continue;
        }
        newResponse.headers.set(key, value);
      }
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      return newResponse;
    }

    // --- 2. DASH (.mpd) MANIFEST REWRITE ---
    if (isMpd) {
      const text = await response.text();
      
      // Extract the absolute base directory of the original CDN URL
      const urlObj = new URL(finalUrl);
      const basePath = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);

      // Rewrite segment templates (media, initialization) to point DIRECTLY to the CDN!
      let rewrittenText = text.replace(/(media|initialization|sourceURL)="([^"]+)"/g, (match, attr, p1) => {
        if (p1.startsWith("http")) return match;
        // Make the URL absolute to the CDN, and restore $ symbols for ExoPlayer templates
        const absoluteUrl = new URL(p1, basePath).href.replace(/%24/g, '$');
        return `${attr}="${absoluteUrl}"`;
      });

      // Rewrite BaseURL tags
      rewrittenText = rewrittenText.replace(/<BaseURL>(.*?)<\/BaseURL>/g, (match, p1) => {
        if (p1.startsWith("http")) return match;
        const absoluteUrl = new URL(p1.trim(), basePath).href.replace(/%24/g, '$');
        return `<BaseURL>${absoluteUrl}</BaseURL>`;
      });

      const newHeaders = new Headers(response.headers);
      newHeaders.delete("Access-Control-Allow-Origin");
      newHeaders.delete("Access-Control-Allow-Methods");
      newHeaders.delete("Access-Control-Allow-Headers");
      
      // FIX: Force correct DASH XML Content-Type so it's not raw text!
      newHeaders.set("Content-Type", "application/dash+xml");
      newHeaders.set("Access-Control-Allow-Origin", "*");

      return new Response(rewrittenText, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    }

    // --- 3. DIRECT STREAM FALLBACK ---
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
