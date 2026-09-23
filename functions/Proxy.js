export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const targetParam = requestUrl.searchParams.get("url");

  // 2. Strict CORS Headers (defined early so every return path can use them)
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Range, Origin, X-Requested-With, Content-Type, Accept, Authorization, x-dt-auth, If-Match, If-None-Match",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date, Server, Transfer-Encoding",
    "Access-Control-Max-Age": "86400",
  };

  if (!targetParam) {
    return new Response("Missing url parameter. Usage: ?url=https://...", {
      status: 400,
      headers: corsHeaders,
    });
  }

  // 1. RECONSTRUCT THE TARGET URL PERFECTLY
  let targetUrlObj;
  try {
    targetUrlObj = new URL(targetParam);
  } catch (e) {
    return new Response("Invalid url parameter passed.", { status: 400, headers: corsHeaders });
  }

  // Merge any extra proxy parameters into the target URL safely
  requestUrl.searchParams.forEach((value, key) => {
    if (key !== "url") {
      targetUrlObj.searchParams.set(key, value);
    }
  });

  const finalTargetUrl = targetUrlObj.href;

  // Handle preflight requests
  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 3. Set bypass headers safely
  const fetchHeaders = new Headers();
  const clientHeaders = context.request.headers;

  for (const [key, value] of clientHeaders.entries()) {
    const lowerKey = key.toLowerCase();
    if (
      !lowerKey.startsWith("cf-") &&
      !["host", "origin", "referer", "connection", "accept-encoding"].includes(lowerKey)
    ) {
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
    const isM3u8 =
      lowerUrl.includes(".m3u") ||
      finalUrl.toLowerCase().includes(".m3u") ||
      contentType.includes("mpegurl");
    const isMpd =
      lowerUrl.includes(".mpd") ||
      finalUrl.toLowerCase().includes(".mpd") ||
      contentType.includes("dash+xml");

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
          lowerKey === "transfer-encoding" ||
          lowerKey === "connection" ||
          lowerKey === "set-cookie" ||
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
    const wrap = (absoluteUrl) => proxyBase + encodeURIComponent(absoluteUrl);

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

    // --- 4. HLS (.m3u8) MANIFEST PROXY (playlists + segments) ---
    if (isM3u8) {
      const text = await response.text();
      const lines = text.split("\n");

      const rewrittenLines = lines.map((line) => {
        const trimmed = line.trim();

        // Tag attributes: URI="..."  (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-I-FRAME-STREAM-INF ...)
        if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
          return trimmed.replace(/URI="([^"]+)"/g, (match, p1) => {
            try {
              const absoluteUrl = resolveAndKeepParams(p1, finalUrl);
              return `URI="${wrap(absoluteUrl)}"`;
            } catch (e) {
              return match;
            }
          });
        }

        // Segment / variant playlist lines -> always route through the proxy
        if (trimmed && !trimmed.startsWith("#")) {
          try {
            const absoluteUrl = resolveAndKeepParams(trimmed, finalUrl);
            return wrap(absoluteUrl);
          } catch (e) {
            return line;
          }
        }

        return line;
      });

      const newHeaders = copyCleanHeaders();
      newHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
      newHeaders.set("Cache-Control", "no-store");

      return new Response(rewrittenLines.join("\n"), {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // --- 5. DASH (.mpd) MANIFEST PROXY (BaseURL + SegmentTemplate) ---
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

      // $ placeholders (%24) must survive so the player can still expand $Number$ / $RepresentationID$
      const restorePlaceholders = (s) => s.replace(/%24/g, () => "$");

      // Rewrite BaseURLs -> proxy
      rewrittenText = rewrittenText.replace(/<BaseURL>(.*?)<\/BaseURL>/g, (match, p1) => {
        try {
          const absoluteUrl = resolveAndKeepParams(p1.trim(), finalUrl);
          const proxied = restorePlaceholders(wrap(absoluteUrl)).replace(/&/g, "&amp;");
          return `<BaseURL>${proxied}</BaseURL>`;
        } catch (e) {
          return match;
        }
      });

      // Rewrite initialization / media / sourceURL / xlink:href -> proxy
      rewrittenText = rewrittenText.replace(
        /(media|initialization|sourceURL|xlink:href)="([^"]+)"/g,
        (match, attr, p2) => {
          try {
            const cleanP2 = p2.replace(/&amp;/g, "&");
            const resolveBase = cleanP2.startsWith("http") ? finalUrl : dashBaseUrl;
            const absoluteUrl = resolveAndKeepParams(cleanP2.trim(), resolveBase);

            const proxied = restorePlaceholders(wrap(absoluteUrl)).replace(/&/g, "&amp;");
            return `${attr}="${proxied}"`;
          } catch (e) {
            return match;
          }
        }
      );

      const newHeaders = copyCleanHeaders();
      newHeaders.set("Content-Type", "application/dash+xml");
      newHeaders.set("Cache-Control", "no-store");

      return new Response(rewrittenText, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    }

    // --- 6. Media Segment Proxy (.mp4 / .m4s / .ts / .aac / keys ...) ---
    // This is where CORS is actually granted and the forced download is killed.
    const proxyHeaders = new Headers();

    for (const [key, value] of response.headers.entries()) {
      const lk = key.toLowerCase();
      if (
        lk === "content-encoding" ||
        lk === "content-length" ||
        lk === "content-type" ||
        lk === "content-disposition" ||   // <-- this is what caused the "download" popup
        lk === "transfer-encoding" ||
        lk === "connection" ||
        lk === "set-cookie" ||
        lk.startsWith("access-control-")
      ) {
        continue;
      }
      proxyHeaders.set(key, value); // keeps Content-Range, Accept-Ranges, ETag, Last-Modified ...
    }

    // Force a playable Content-Type based on the real (post-redirect) path
    const finalLower = (response.url || finalTargetUrl).toLowerCase();
    const pathOnly = finalLower.split("?")[0];

    let forcedType = null;
    if (/\.(m4s|m4v|m4a|mp4|cmfv|cmfa)$/.test(pathOnly)) forcedType = "video/mp4";
    else if (/\.ts$/.test(pathOnly)) forcedType = "video/mp2t";
    else if (/\.aac$/.test(pathOnly)) forcedType = "audio/aac";
    else if (/\.mp3$/.test(pathOnly)) forcedType = "audio/mpeg";
    else if (/\.vtt$/.test(pathOnly)) forcedType = "text/vtt";
    else if (/\.key$/.test(pathOnly)) forcedType = "application/octet-stream";

    proxyHeaders.set("Content-Type", forcedType || contentType || "application/octet-stream");
    // Never let the browser treat this as a file download
    proxyHeaders.set("Content-Disposition", "inline");

    Object.entries(corsHeaders).forEach(([k, v]) => proxyHeaders.set(k, v));

    return new Response(context.request.method === "HEAD" ? null : response.body, {
      status: response.status,          // preserves 200 / 206 (Range)
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
