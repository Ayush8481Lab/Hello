export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = url.searchParams.get("url");

  if (!target) {
    return new Response("Missing url parameter", { status: 400 });
  }

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
    const response = await fetch(target, {
      method: context.request.method,
      headers: headers,
      redirect: "follow"
    });

    // Check if the response is an HLS playlist
    const contentType = response.headers.get("content-type") || "";
    const isM3u8 = target.includes(".m3u8") || contentType.includes("mpegurl");

    if (isM3u8) {
      // Rewrite the playlist so relative URLs point back to our proxy!
      const text = await response.text();
      const lines = text.split('\n');
      const finalUrl = response.url || target; // Use the final redirected URL as the base!

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
        if (lowerKey === 'content-encoding' || lowerKey === 'content-length') {
          continue;
        }
        newResponse.headers.set(key, value);
      }
      newResponse.headers.set("Access-Control-Allow-Origin", "*");
      return newResponse;
    }

    // For other files (e.g. .ts segments), stream them through directly
    const proxyResponse = new Response(response.body, response);
    proxyResponse.headers.set("Access-Control-Allow-Origin", "*");
    return proxyResponse;

  } catch (e) {
    return new Response("Error fetching stream: " + e.message, { 
      status: 500,
      headers: { "Access-Control-Allow-Origin": "*" }
    });
  }
}
