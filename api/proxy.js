// api/proxy.js

export const config = {
  runtime: "nodejs",
};

const UPSTREAM_REFERER = "https://multimovies.rpmhub.site/";
const UPSTREAM_ORIGIN = "https://multimovies.rpmhub.site";

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";


// ─────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, HEAD, OPTIONS"
  );

  res.setHeader(
    "Access-Control-Allow-Headers",
    "*"
  );

  res.setHeader(
    "Access-Control-Expose-Headers",
    [
      "Content-Length",
      "Content-Range",
      "Accept-Ranges",
      "Content-Type",
      "ETag",
      "Last-Modified"
    ].join(", ")
  );

  res.setHeader(
    "Cross-Origin-Resource-Policy",
    "cross-origin"
  );
}


// ─────────────────────────────────────────────
// GET TARGET URL
// ─────────────────────────────────────────────

function getTargetUrl(req) {
  let target = req.query.url;

  if (!target) {
    throw new Error("Missing 'url' query parameter");
  }

  if (Array.isArray(target)) {
    target = target[0];
  }

  target = String(target);

  /*
   * Vercel normally gives req.query values decoded.
   * Only attempt decoding when it is clearly encoded.
   */
  try {
    if (
      target.startsWith("http%3A") ||
      target.startsWith("https%3A")
    ) {
      target = decodeURIComponent(target);
    }
  } catch {
    // Keep original URL if decoding fails.
  }

  const url = new URL(target);

  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    throw new Error("Only HTTP/HTTPS URLs are supported");
  }

  /*
   * If the user supplied additional query parameters
   * outside `url`, preserve them.
   *
   * Example:
   *
   * ?url=https://site/video.m3u8&v=123
   *
   * becomes:
   *
   * https://site/video.m3u8?v=123
   */

  const extra = {
    ...req.query
  };

  delete extra.url;
  delete extra.format;

  for (const [key, value] of Object.entries(extra)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined) {
          url.searchParams.append(
            key,
            String(item)
          );
        }
      }
    } else if (value !== undefined) {
      url.searchParams.set(
        key,
        String(value)
      );
    }
  }

  return url;
}


// ─────────────────────────────────────────────
// PROXY BASE
// ─────────────────────────────────────────────

function getProxyBase(req) {
  const forwardedProto =
    req.headers["x-forwarded-proto"] || "https";

  const protocol =
    String(forwardedProto)
      .split(",")[0]
      .trim();

  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host;

  return `${protocol}://${host}/api/proxy?url=`;
}


// ─────────────────────────────────────────────
// PLAYLIST REWRITER
// ─────────────────────────────────────────────

function rewritePlaylist(
  playlist,
  playlistUrl,
  proxyBase
) {
  const baseUrl =
    new URL("./", playlistUrl).href;


  /*
   * Rewrite every URI="..."
   *
   * Handles:
   *
   * EXT-X-KEY
   * EXT-X-MAP
   * EXT-X-MEDIA
   * EXT-X-I-FRAMES-ONLY
   * EXT-X-PART
   * etc.
   */

  playlist = playlist.replace(
    /URI="([^"]+)"/g,
    (match, uri) => {
      try {
        const absolute =
          new URL(uri, baseUrl).href;

        return `URI="${proxyBase}${encodeURIComponent(
          absolute
        )}"`;
      } catch {
        return match;
      }
    }
  );


  /*
   * Rewrite normal playlist lines.
   *
   * This covers:
   *
   * .m3u8
   * .ts
   * .m4s
   * .mp4
   * .aac
   * .vtt
   * and URLs without extensions.
   */

  const lines =
    playlist.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) {
      continue;
    }

    if (line.startsWith("#")) {
      continue;
    }

    try {
      const absolute =
        new URL(line, baseUrl).href;

      lines[i] =
        proxyBase +
        encodeURIComponent(absolute);

    } catch {
      // Keep original line.
    }
  }

  return lines.join("\n");
}


// ─────────────────────────────────────────────
// COPY IMPORTANT RESPONSE HEADERS
// ─────────────────────────────────────────────

function copyResponseHeaders(
  upstream,
  res
) {
  const headers = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified"
  ];

  for (const name of headers) {
    const value =
      upstream.headers.get(name);

    if (value) {
      res.setHeader(name, value);
    }
  }
}


// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────

export default async function handler(
  req,
  res
) {
  setCors(res);

  /*
   * CORS preflight
   */

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }


  /*
   * Only GET / HEAD
   */

  if (
    req.method !== "GET" &&
    req.method !== "HEAD"
  ) {
    res.setHeader(
      "Allow",
      "GET, HEAD, OPTIONS"
    );

    return res.status(405).json({
      error: "Method not allowed"
    });
  }


  try {

    // ───────────────────────────────────────
    // TARGET
    // ───────────────────────────────────────

    const targetUrl =
      getTargetUrl(req);

    const target =
      targetUrl.href;


    console.log(
      `[PROXY] ${req.method} ${target}`
    );


    // ───────────────────────────────────────
    // UPSTREAM REQUEST HEADERS
    // ───────────────────────────────────────

    const headers = {
      "User-Agent": USER_AGENT,

      "Referer": UPSTREAM_REFERER,

      "Origin": UPSTREAM_ORIGIN,

      "Accept": "*/*",

      "Accept-Language":
        "en-US,en;q=0.9",

      /*
       * Avoid compressed binary responses
       * because we are streaming them directly.
       */
      "Accept-Encoding": "identity",

      /*
       * Some origins inspect these.
       */
      "Sec-Fetch-Mode": "cors",

      "Sec-Fetch-Site": "cross-site"
    };


    // ───────────────────────────────────────
    // RANGE SUPPORT
    // ───────────────────────────────────────

    if (req.headers.range) {
      headers.Range =
        req.headers.range;
    }


    // ───────────────────────────────────────
    // CONDITIONAL REQUESTS
    // ───────────────────────────────────────

    if (req.headers["if-none-match"]) {
      headers["If-None-Match"] =
        req.headers["if-none-match"];
    }

    if (req.headers["if-modified-since"]) {
      headers["If-Modified-Since"] =
        req.headers["if-modified-since"];
    }


    // ───────────────────────────────────────
    // UPSTREAM FETCH
    // ───────────────────────────────────────

    const upstream =
      await fetch(target, {
        method: req.method,
        headers,

        /*
         * Follow StreamHG/origin redirects.
         */
        redirect: "follow"
      });


    const status =
      upstream.status;


    // ───────────────────────────────────────
    // ERROR RESPONSE
    // ───────────────────────────────────────

    if (
      status !== 200 &&
      status !== 206 &&
      status !== 304
    ) {
      let errorBody = "";

      try {
        errorBody =
          await upstream.text();
      } catch {}

      console.error(
        `[UPSTREAM ERROR] ${status} ${target}`
      );

      return res
        .status(status)
        .send(
          errorBody ||
          `Upstream returned ${status}`
        );
    }


    // ───────────────────────────────────────
    // CONTENT TYPE
    // ───────────────────────────────────────

    const contentType =
      upstream.headers.get(
        "content-type"
      ) || "";

    const pathname =
      targetUrl.pathname.toLowerCase();


    // ───────────────────────────────────────
    // DETECT M3U8
    // ───────────────────────────────────────

    const isM3U8 =
      contentType.includes(
        "application/vnd.apple.mpegurl"
      ) ||
      contentType.includes(
        "application/x-mpegurl"
      ) ||
      contentType.includes(
        "mpegurl"
      ) ||
      pathname.endsWith(".m3u8") ||
      pathname.endsWith(".m3u");


    // ───────────────────────────────────────
    // M3U8
    // ───────────────────────────────────────

    if (isM3U8) {

      const playlist =
        await upstream.text();

      const proxyBase =
        getProxyBase(req);

      const rewritten =
        rewritePlaylist(
          playlist,
          target,
          proxyBase
        );


      /*
       * Very short cache.
       *
       * Good for VOD and also avoids
       * excessively stale live playlists.
       */

      res.setHeader(
        "Cache-Control",
        "public, max-age=2, s-maxage=2, stale-while-revalidate=3"
      );


      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );


      /*
       * Optional:
       *
       * ?format=json
       */

      if (
        String(req.query.format || "")
          .toLowerCase() === "json"
      ) {
        res.setHeader(
          "Content-Type",
          "application/json"
        );

        return res.status(200).json({
          content: rewritten
        });
      }


      return res
        .status(200)
        .send(rewritten);
    }


    // ───────────────────────────────────────
    // VTT SUBTITLE
    // ───────────────────────────────────────

    const isVTT =
      contentType.includes("text/vtt") ||
      pathname.endsWith(".vtt");


    if (isVTT) {

      const text =
        await upstream.text();

      res.setHeader(
        "Content-Type",
        "text/vtt; charset=utf-8"
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=300, s-maxage=300"
      );

      return res
        .status(status)
        .send(text);
    }


    // ───────────────────────────────────────
    // EVERYTHING ELSE = STREAM
    //
    // TS / MP2T
    // M4S
    // MP4
    // AAC
    // KEY
    // etc.
    // ───────────────────────────────────────

    copyResponseHeaders(
      upstream,
      res
    );


    /*
     * VOD fragments can be cached.
     *
     * This helps when the same fragment
     * is requested again.
     */

    res.setHeader(
      "Cache-Control",
      "public, max-age=3600, s-maxage=3600"
    );


    /*
     * Tell intermediaries not to buffer
     * where supported.
     */

    res.setHeader(
      "X-Accel-Buffering",
      "no"
    );


    /*
     * HEAD has no body.
     */

    if (
      req.method === "HEAD" ||
      !upstream.body
    ) {
      return res
        .status(status)
        .end();
    }


    /*
     * Send headers immediately.
     */

    if (
      typeof res.flushHeaders === "function"
    ) {
      res.flushHeaders();
    }


    // ───────────────────────────────────────
    // DIRECT STREAM
    // ───────────────────────────────────────

    const reader =
      upstream.body.getReader();


    try {

      while (true) {

        const {
          done,
          value
        } = await reader.read();


        if (done) {
          break;
        }


        if (value) {

          /*
           * Immediately forward each
           * received chunk.
           */

          res.write(
            Buffer.from(value)
          );
        }
      }


      res.end();

    } catch (streamError) {

      console.error(
        "[STREAM ERROR]",
        streamError
      );

      try {
        res.destroy(streamError);
      } catch {}
    }

  } catch (error) {

    console.error(
      "[PROXY EXCEPTION]",
      error
    );

    if (!res.headersSent) {

      return res
        .status(500)
        .json({
          error:
            error?.message ||
            "Proxy error"
        });
    }

    try {
      res.destroy(error);
    } catch {}
  }
}
