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

  // Forward ALL extra query parameters to the target URL (handles separated HMACs/Tokens)
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

  // Handle preflight requests
  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 3. Set standard Bypass Headers
  const fetchHeaders = new Headers();
  fetchHeaders.set("User-Agent", "plaYtv/7.1.5 (Linux;Android 14) ExoPlayerLib/2.11.7");
  fetchHeaders.set("Accept", "*/*");

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

    // --- 4. HLS (.m3u8) PERFECT PROXY ---
    if (isM3u8) {
      const text = await response.text();
      const lines = text.split("\n");

      const rewrittenLines = lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
          return trimmed.replace(/URI="([^"]+)"/g, (match, p1) => {
            try {
              const absoluteUrl = new URL(p1, finalUrl).href;
              return `URI="${proxyBase}${encodeURIComponent(absoluteUrl)}"`;
            } catch (e) { return match; }
          });
        }
        if (trimmed && !trimmed.startsWith("#")) {
          try {
            const absoluteUrl = new URL(trimmed, finalUrl).href;
            return proxyBase + encodeURIComponent(absoluteUrl);
          } catch (e) { return line; }
        }
        return line;
      });

      const newHeaders = copyCleanHeaders();
      newHeaders.set("Content-Type", "application/vnd.apple.mpegurl"); // Force HLS type

      return new Response(rewrittenLines.join("\n"), {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // --- 5. DASH (.mpd) PERFECT PROXY ---
    if (isMpd) {
      const text = await response.text();
      let rewrittenText = text;

      // Extract the root BaseURL if it exists (helps resolve nested relative segment URLs)
      let dashBaseUrl = finalUrl;
      const baseMatch = text.match(/<BaseURL>(.*?)<\/BaseURL>/);
      if (baseMatch) {
        try {
          dashBaseUrl = new URL(baseMatch[1].trim(), finalUrl).href;
        } catch (e) {}
      }

      // Rewrite <BaseURL> tags
      rewrittenText = rewrittenText.replace(/<BaseURL>(.*?)<\/BaseURL>/g, (match, p1) => {
        try {
          const absoluteUrl = new URL(p1.trim(), finalUrl).href;
          // Note: We avoid encoding $ symbols so ExoPlayer's $Number$ templates don't break
          const wrapped = proxyBase + encodeURIComponent(absoluteUrl).replace(/%24/g, '$');
          return `<BaseURL>${wrapped}</BaseURL>`;
        } catch (e) { return match; }
      });

      // Rewrite media="", initialization="", and sourceURL=""
      rewrittenText = rewrittenText.replace(/(media|initialization|sourceURL)="([^"]+)"/g, (match, attr, p2) => {
        try {
          // If the URL is already absolute inside the manifest, don't use dashBaseUrl
          const resolveBase = p2.startsWith("http") ? finalUrl : dashBaseUrl;
          const absoluteUrl = new URL(p2.trim(), resolveBase).href;
          
          // Revert %24 to $ to ensure ExoPlayer variables like $Number$ and $Time$ work perfectly
          const wrapped = proxyBase + encodeURIComponent(absoluteUrl).replace(/%24/g, '$');
          return `${attr}="${wrapped}"`;
        } catch (e) { return match; }
      });

      const newHeaders = copyCleanHeaders();
      newHeaders.set("Content-Type", "application/dash+xml"); // Force DASH MPD type (Fixes raw text bug)

      return new Response(rewrittenText, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // --- 6. Direct Stream Proxy (For .ts, .m4s, keys, etc.) ---
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
