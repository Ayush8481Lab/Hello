export async function onRequest(context) {
  const requestUrl = new URL(context.request.url);
  const targetParam = requestUrl.searchParams.get("url");

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

  let targetUrlObj;
  try {
    targetUrlObj = new URL(targetParam);
  } catch (e) {
    return new Response("Invalid url parameter passed.", { status: 400, headers: corsHeaders });
  }

  requestUrl.searchParams.forEach((value, key) => {
    if (key !== "url") targetUrlObj.searchParams.set(key, value);
  });

  const finalTargetUrl = targetUrlObj.href;

  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const fetchHeaders = new Headers();
  for (const [key, value] of context.request.headers.entries()) {
    const lk = key.toLowerCase();
    if (
      !lk.startsWith("cf-") &&
      !["host", "origin", "referer", "connection", "accept-encoding"].includes(lk)
    ) {
      fetchHeaders.set(key, value);
    }
  }
  if (!fetchHeaders.has("user-agent")) {
    fetchHeaders.set("user-agent", "plaYtv/7.1.5 (Linux;Android 14) ExoPlayerLib/2.11.7");
  }

  // --- SonyLIV / Akamai specific: forward hdnea as a Cookie ---
  // The hdnea token is often expected as a cookie, not just a query param.
  if (!fetchHeaders.has("cookie")) {
    const hdnea = targetUrlObj.searchParams.get("hdnea");
    if (hdnea) {
      fetchHeaders.set("cookie", `hdnea=${hdnea}`);
    }
  }

  // Also forward the Referer / Origin that the CDN expects
  if (!fetchHeaders.has("referer")) {
    fetchHeaders.set("referer", "https://www.sonyliv.com/");
  }

  try {
    const response = await fetch(finalTargetUrl, {
      method: context.request.method,
      headers: fetchHeaders,
      redirect: "follow",
    });

    // Log upstream status for debugging
    console.log(`Upstream fetch to ${finalTargetUrl} returned ${response.status}`);

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const finalUrl = response.url || finalTargetUrl;
    const lowerUrl = finalTargetUrl.toLowerCase();
    const lowerFinal = finalUrl.toLowerCase();

    const isM3u8 =
      lowerUrl.includes(".m3u") ||
      lowerFinal.includes(".m3u") ||
      contentType.includes("mpegurl");
    const isMpd =
      lowerUrl.includes(".mpd") ||
      lowerFinal.includes(".mpd") ||
      contentType.includes("dash+xml");

    const proxyBase = requestUrl.origin + requestUrl.pathname + "?url=";

    // Preserve $...$ template vars for DASH
    const enc = (u) => encodeURIComponent(u).replace(/%24/g, "$");
    const wrap = (u) => proxyBase + enc(u);

    const resolveAndKeepParams = (relativeUrl, baseUrl) => {
      try {
        const baseObj = new URL(baseUrl);
        const resolvedObj = new URL(relativeUrl, baseUrl);
        baseObj.searchParams.forEach((val, key) => {
          if (!resolvedObj.searchParams.has(key)) resolvedObj.searchParams.set(key, val);
        });
        return resolvedObj.href;
      } catch (e) {
        return relativeUrl;
      }
    };

    const withCors = (extra = {}) => {
      const h = new Headers();
      Object.entries(corsHeaders).forEach(([k, v]) => h.set(k, v));
      Object.entries(extra).forEach(([k, v]) => h.set(k, v));
      return h;
    };

    // ============== HLS (.m3u8) ==============
    if (isM3u8) {
      const text = await response.text();
      const lines = text.split("\n");

      const rewrittenLines = lines.map((line) => {
        const trimmed = line.trim();

        if (trimmed.startsWith("#") && trimmed.includes('URI="')) {
          return trimmed.replace(/URI="([^"]+)"/g, (match, p1) => {
            try {
              const abs = resolveAndKeepParams(p1, finalUrl);
              return `URI="${wrap(abs)}"`;
            } catch (e) {
              return match;
            }
          });
        }

        if (trimmed && !trimmed.startsWith("#")) {
          try {
            const abs = resolveAndKeepParams(trimmed, finalUrl);
            return wrap(abs);
          } catch (e) {
            return line;
          }
        }

        return line;
      });

      return new Response(rewrittenLines.join("\n"), {
        status: response.status,
        statusText: response.statusText,
        headers: withCors({
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "no-store",
        }),
      });
    }

    // ============== DASH (.mpd) ==============
    if (isMpd) {
      let text = await response.text();

      text = text.replace(/<Location>.*?<\/Location>/g, "");

      let dashBase = finalUrl;
      const baseMatch = text.match(/<BaseURL>(.*?)<\/BaseURL>/);
      if (baseMatch) {
        try {
          dashBase = resolveAndKeepParams(baseMatch[1].trim(), finalUrl);
        } catch (e) {}
      }

      text = text.replace(/<BaseURL>(.*?)<\/BaseURL>/g, (match, p1) => {
        try {
          const abs = resolveAndKeepParams(p1.trim(), finalUrl);
          return `<BaseURL>${abs.replace(/&/g, "&amp;")}</BaseURL>`;
        } catch (e) {
          return match;
        }
      });

      text = text.replace(
        /(media|initialization|sourceURL|xlink:href)="([^"]+)"/g,
        (match, attr, p2) => {
          try {
            const clean = p2.replace(/&amp;/g, "&");
            const abs = resolveAndKeepParams(clean.trim(), dashBase);
            const proxied = wrap(abs).replace(/&/g, "&amp;");
            return `${attr}="${proxied}"`;
          } catch (e) {
            return match;
          }
        }
      );

      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: withCors({
          "Content-Type": "application/dash+xml",
          "Cache-Control": "no-store",
        }),
      });
    }

    // ============== Media segment passthrough ==============
    const proxyHeaders = new Headers();

    for (const [key, value] of response.headers.entries()) {
      const lk = key.toLowerCase();
      if (
        lk === "content-encoding" ||
        lk === "content-length" ||
        lk === "content-type" ||
        lk === "content-disposition" ||
        lk === "transfer-encoding" ||
        lk === "connection" ||
        lk === "set-cookie" ||
        lk.startsWith("access-control-")
      ) {
        continue;
      }
      proxyHeaders.set(key, value);
    }

    const pathOnly = lowerFinal.split("?")[0];
    let forcedType = null;
    if (/\.(m4s|m4v|m4a|mp4|cmfv|cmfa)$/.test(pathOnly)) forcedType = "video/mp4";
    else if (/\.ts$/.test(pathOnly)) forcedType = "video/mp2t";
    else if (/\.aac$/.test(pathOnly)) forcedType = "audio/aac";
    else if (/\.mp3$/.test(pathOnly)) forcedType = "audio/mpeg";
    else if (/\.vtt$/.test(pathOnly)) forcedType = "text/vtt";
    else if (/\.key$/.test(pathOnly)) forcedType = "application/octet-stream";

    proxyHeaders.set("Content-Type", forcedType || contentType || "application/octet-stream");
    proxyHeaders.set("Content-Disposition", "inline");

    Object.entries(corsHeaders).forEach(([k, v]) => proxyHeaders.set(k, v));

    return new Response(
      context.request.method === "HEAD" ? null : response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: proxyHeaders,
      }
    );
  } catch (e) {
    // Return a readable error so you can see what failed
    return new Response(
      `Proxy error: ${e.message}\n\nTarget: ${finalTargetUrl}`,
      {
        status: 502,
        headers: {
          "Content-Type": "text/plain",
          ...corsHeaders,
        },
      }
    );
  }
      }
