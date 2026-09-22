export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = url.searchParams.get("url");

  if (!target) {
    return new Response("Missing url parameter", { status: 400 });
  }

  // Standardized CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };

  // Handle CORS preflight requests
  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Set the specific User-Agent required by the SonyLIV streams (from the .m3u file)
  const fetchHeaders = new Headers();
  fetchHeaders.set("User-Agent", "plaYtv/7.1.5 (Linux;Android 14) ExoPlayerLib/2.11.7");

  try {
    const response = await fetch(target, {
      method: context.request.method,
      headers: fetchHeaders,
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
      
      // Create new headers cleanly
      const newHeaders = new Headers();
      for (const [key, value] of response.headers.entries()) {
        const lowerKey = key.toLowerCase();
        // Skip content encoding/length because body is rewritten, skip existing CORS to avoid duplicates
        if (lowerKey === 'content-encoding' || lowerKey === 'content-length' || lowerKey.startsWith('access-control-')) {
          continue;
        }
        newHeaders.set(key, value);
      }
      
      // Apply our clean CORS headers
      Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));

      return new Response(rewrittenLines.join('\n'), {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders
      });
    }

    // For other files (e.g. .ts segments), stream them through directly
    const proxyHeaders = new Headers(response.headers);
    
    // Strip existing upstream CORS headers to avoid "*, *" duplicate origin errors
    proxyHeaders.delete("Access-Control-Allow-Origin");
    proxyHeaders.delete("Access-Control-Allow-Methods");
    proxyHeaders.delete("Access-Control-Allow-Headers");
    
    // Apply our clean CORS headers
    Object.entries(corsHeaders).forEach(([k, v]) => proxyHeaders.set(k, v));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: proxyHeaders
    });

  } catch (e) {
    return new Response("Error fetching stream: " + e.message, { 
      status: 500,
      headers: corsHeaders
    });
  }
        }
