export const config = {
  runtime: "nodejs",
};

const UPSTREAM_REFERER = "https://multimovies.rpmhub.site/";
const UPSTREAM_ORIGIN = "https://multimovies.rpmhub.site";

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Range, Origin, Referer, Content-Type, Accept, User-Agent"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag"
  );
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

function getTargetUrl(req) {
  let target = req.query.url;

  if (!target) {
    throw new Error("Missing 'url' query parameter");
  }

  // Vercel normally gives url decoded, but safely handle encoded values.
  try {
    if (
      typeof target === "string" &&
      target.includes("%") &&
      !target.startsWith("http%3A") &&
      !target.startsWith("https%3A")
    ) {
      target = decodeURIComponent(target);
    }
  } catch {}

  if (Array.isArray(target)) {
    target = target[0];
  }

  const url = new URL(target);

  // Prevent accidental non-http requests.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only HTTP/HTTPS URLs are allowed");
  }

  // Preserve query parameters that Vercel parsed outside `url`.
  const extra = { ...req.query };

  delete extra.url;
  delete extra.format;
  delete extra.source;

  for (const [key, value] of Object.entries(extra)) {
    if (Array.isArray(value)) {
      for (const v of value) {
        url.searchParams.append(key, String(v));
      }
    } else if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  return url;
}

function getProxyBase(req, source) {
  const forwardedProto =
    req.headers["x-forwarded-proto"] ||
    req.headers["x-forwarded-protocol"] ||
    "https";

  const proto = String(forwardedProto).split(",")[0].trim();

  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host;

  return `${proto}://${host}/api/proxy?url=`;
}

function rewritePlaylist(text, playlistUrl, proxyBase) {
  const base = new URL("./", playlistUrl).href;

  // Rewrite URI="..." attributes:
  // EXT-X-KEY
  // EXT-X-MAP
  // EXT-X-MEDIA
  // EXT-X-I-FRAMES-ONLY
  // EXT-X-PART
  // etc.
  text = text.replace(/URI="([^"]+)"/g, (match, uri) => {
    try {
      const absolute = new URL(uri, base).href;

      return `URI="${proxyBase}${encodeURIComponent(absolute)}"`;
    } catch {
      return match;
    }
  });

  // Rewrite normal URI lines.
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    try {
      const absolute = new URL(line, base).href;

      lines[i] =
        proxyBase + encodeURIComponent(absolute);
    } catch {
      // Leave malformed/non-URL lines untouched.
    }
  }

  return lines.join("\n");
}

function copyResponseHeaders(upstream, res) {
  const headers = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
    "expires",
  ];

  for (const name of headers) {
    const value = upstream.headers.get(name);

    if (value) {
      res.setHeader(name, value);
    }
  }
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  try {
    const source = String(req.query.source || "1");
    const format = String(req.query.format || "raw");

    const targetUrl = getTargetUrl(req);

    /*
     * Your existing custom headers.
     */
    const headers = {
      Referer: UPSTREAM_REFERER,
      Origin: UPSTREAM_ORIGIN,

      "User-Agent": USER_AGENT,

      Accept: "*/*",

      "Accept-Language": "en-US,en;q=0.9",

      /*
       * Do NOT force gzip/identity unnecessarily.
       * fetch can handle compressed responses.
       */
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "cross-site",
    };

    /*
     * Forward Range.
     *
     * Important for MP4 and some HLS configurations.
     */
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    /*
     * Forward conditional requests when present.
     */
    if (req.headers["if-none-match"]) {
      headers["If-None-Match"] = req.headers["if-none-match"];
    }

    if (req.headers["if-modified-since"]) {
      headers["If-Modified-Since"] =
        req.headers["if-modified-since"];
    }

    /*
     * HEAD should remain HEAD upstream.
     */
    const method = req.method === "HEAD" ? "HEAD" : "GET";

    /*
     * Fetch upstream.
     *
     * redirect: follow is required for origins that redirect
     * their media URLs.
     */
    const upstream = await fetch(targetUrl.href, {
      method,
      headers,
      redirect: "follow",
    });

    /*
     * Forward status directly.
     *
     * This preserves 206 Partial Content.
     */
    const status = upstream.status;

    if (
      status !== 200 &&
      status !== 206 &&
      status !== 304
    ) {
      const errorText = await upstream.text();

      console.error(
        `[PROXY] ${status} ${targetUrl.href}`
      );

      return res.status(status).send(errorText);
    }

    const contentType =
      upstream.headers.get("content-type") || "";

    const pathname =
      targetUrl.pathname.toLowerCase();

    const isM3U8 =
      contentType.includes("mpegurl") ||
      pathname.endsWith(".m3u8") ||
      pathname.endsWith(".m3u");

    const isVTT =
      contentType.includes("text/vtt") ||
      pathname.endsWith(".vtt");

    /*
     * Playlist
     */
    if (isM3U8) {
      const text = await upstream.text();

      const proxyBase = getProxyBase(req, source);

      const rewritten = rewritePlaylist(
        text,
        targetUrl.href,
        proxyBase
      );

      /*
       * Playlists should NOT be cached for a long time if
       * this is live HLS.
       */
      res.setHeader(
        "Cache-Control",
        "public, max-age=2, s-maxage=2, stale-while-revalidate=5"
      );

      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );

      if (format === "json") {
        res.setHeader("Content-Type", "application/json");

        return res.status(200).json({
          content: rewritten,
        });
      }

      return res.status(200).send(rewritten);
    }

    /*
     * VTT subtitles.
     */
    if (isVTT) {
      const text = await upstream.text();

      res.setHeader(
        "Content-Type",
        "text/vtt; charset=utf-8"
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=60, s-maxage=60"
      );

      return res.status(status).send(text);
    }

    /*
     * EVERYTHING ELSE:
     *
     * Do NOT call arrayBuffer().
     * Do NOT call Buffer.from().
     *
     * Pipe the upstream Web stream directly into the
     * Node.js response.
     */

    copyResponseHeaders(upstream, res);

    /*
     * Fragments are generally immutable for VOD.
     *
     * If you are using LIVE HLS, change this to:
     *
     * no-store
     *
     * for live segments.
     */
    res.setHeader(
      "Cache-Control",
      "public, max-age=3600, s-maxage=3600"
    );

    /*
     * HEAD has no body.
     */
    if (req.method === "HEAD" || !upstream.body) {
      return res.status(status).end();
    }

    /*
     * Stream Web ReadableStream → Node response.
     */
    const reader = upstream.body.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) break;

        if (value) {
          res.write(Buffer.from(value));
        }
      }

      res.end();
    } catch (streamError) {
      console.error(
        "[PROXY STREAM ERROR]",
        streamError
      );

      try {
        res.destroy(streamError);
      } catch {}
    }

  } catch (error) {
    console.error("[PROXY EXCEPTION]", error);

    if (!res.headersSent) {
      return res.status(500).json({
        error: error?.message || "Proxy error",
      });
    }

    try {
      res.destroy(error);
    } catch {}
  }
}
