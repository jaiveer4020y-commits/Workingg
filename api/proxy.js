// api/proxy.js

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export const config = {
  runtime: "nodejs",
};


// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════

const REFERER = "https://allmovieland.link/";
const ORIGIN = "https://allmovieland.link";

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";


// ═══════════════════════════════════════════════
// KEEP-ALIVE AGENTS
//
// IMPORTANT:
// These are created once per warm Vercel instance,
// instead of creating a new connection every request.
// ═══════════════════════════════════════════════

const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 25,
  keepAliveMsecs: 1000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 25,
  keepAliveMsecs: 1000,
});


// ═══════════════════════════════════════════════
// CORS
// ═══════════════════════════════════════════════

function cors(res) {
  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,HEAD,OPTIONS"
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


// ═══════════════════════════════════════════════
// GET URL
// ═══════════════════════════════════════════════

function getTarget(req) {
  let value = req.query.url;

  if (!value) {
    throw new Error(
      "Missing url parameter"
    );
  }

  if (Array.isArray(value)) {
    value = value[0];
  }

  value = String(value);

  /*
   * Decode only when the URL itself is encoded.
   */
  try {
    if (
      value.startsWith("http%3A") ||
      value.startsWith("https%3A")
    ) {
      value = decodeURIComponent(value);
    }
  } catch {}

  const url = new URL(value);

  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    throw new Error(
      "Invalid URL protocol"
    );
  }

  /*
   * Preserve additional query parameters.
   *
   * /api/proxy?url=...&v=123
   */

  const extra = {
    ...req.query
  };

  delete extra.url;
  delete extra.format;

  for (const [key, val] of Object.entries(extra)) {
    if (val === undefined) continue;

    if (Array.isArray(val)) {
      for (const x of val) {
        url.searchParams.append(
          key,
          String(x)
        );
      }
    } else {
      url.searchParams.set(
        key,
        String(val)
      );
    }
  }

  return url;
}


// ═══════════════════════════════════════════════
// PROXY BASE
// ═══════════════════════════════════════════════

function proxyBase(req) {
  const proto =
    String(
      req.headers["x-forwarded-proto"] ||
      "https"
    )
      .split(",")[0]
      .trim();

  const host =
    req.headers["x-forwarded-host"] ||
    req.headers.host;

  return `${proto}://${host}/api/proxy?url=`;
}


// ═══════════════════════════════════════════════
// REWRITE M3U8
// ═══════════════════════════════════════════════

function rewritePlaylist(
  text,
  playlistUrl,
  proxy
) {
  const base =
    new URL(
      "./",
      playlistUrl
    ).href;


  /*
   * URI="..."
   *
   * Handles:
   *
   * EXT-X-KEY
   * EXT-X-MAP
   * EXT-X-MEDIA
   * EXT-X-PART
   * etc.
   */

  text = text.replace(
    /URI="([^"]+)"/g,
    (match, uri) => {
      try {
        const absolute =
          new URL(
            uri,
            base
          ).href;

        return (
          `URI="${proxy}` +
          encodeURIComponent(
            absolute
          ) +
          `"`
        );
      } catch {
        return match;
      }
    }
  );


  /*
   * Normal segment / playlist lines.
   */

  const lines =
    text.split(/\r?\n/);

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {
    const line =
      lines[i].trim();

    if (!line) continue;

    if (line.startsWith("#")) {
      continue;
    }

    try {
      const absolute =
        new URL(
          line,
          base
        ).href;

      lines[i] =
        proxy +
        encodeURIComponent(
          absolute
        );

    } catch {
      // Keep original.
    }
  }

  return lines.join("\n");
}


// ═══════════════════════════════════════════════
// DETECT PLAYLIST
// ═══════════════════════════════════════════════

function isPlaylist(
  target,
  contentType
) {
  const path =
    target.pathname.toLowerCase();

  return (
    path.endsWith(".m3u8") ||
    path.endsWith(".m3u") ||
    contentType.includes("mpegurl")
  );
}


// ═══════════════════════════════════════════════
// DETECT VTT
// ═══════════════════════════════════════════════

function isVtt(
  target,
  contentType
) {
  return (
    target.pathname
      .toLowerCase()
      .endsWith(".vtt") ||
    contentType.includes(
      "text/vtt"
    )
  );
}


// ═══════════════════════════════════════════════
// COPY RESPONSE HEADERS
// ═══════════════════════════════════════════════

function copyHeaders(
  upstream,
  res
) {
  const allowed = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ];

  for (const name of allowed) {
    const value =
      upstream.headers[name];

    if (
      value !== undefined
    ) {
      res.setHeader(
        name,
        value
      );
    }
  }
}


// ═══════════════════════════════════════════════
// NATIVE HTTP FETCH
//
// This avoids:
// fetch()
// → WebStream
// → getReader()
// → Buffer.from()
// → res.write()
//
// For media:
// upstream.pipe(res)
//
// ═══════════════════════════════════════════════

function requestUpstream(
  target,
  req,
  redirects = 0
) {
  return new Promise(
    (resolve, reject) => {

      if (redirects > 5) {
        reject(
          new Error(
            "Too many redirects"
          )
        );

        return;
      }


      const isHttps =
        target.protocol ===
        "https:";

      const transport =
        isHttps
          ? https
          : http;

      const agent =
        isHttps
          ? httpsAgent
          : httpAgent;


      const headers = {
        "User-Agent":
          USER_AGENT,

        "Referer":
          REFERER,

        "Origin":
          ORIGIN,

        "Accept":
          "*/*",

        "Accept-Language":
          "en-US,en;q=0.9",

        /*
         * Do not force gzip.
         *
         * Binary media doesn't benefit
         * from compression.
         */

        "Accept-Encoding":
          "identity",
      };


      /*
       * VERY IMPORTANT:
       * Forward Range.
       */

      if (
        req.headers.range
      ) {
        headers.Range =
          req.headers.range;
      }


      /*
       * Forward validators.
       */

      if (
        req.headers[
          "if-none-match"
        ]
      ) {
        headers[
          "If-None-Match"
        ] =
          req.headers[
            "if-none-match"
          ];
      }

      if (
        req.headers[
          "if-modified-since"
        ]
      ) {
        headers[
          "If-Modified-Since"
        ] =
          req.headers[
            "if-modified-since"
          ];
      }


      const options = {
        protocol:
          target.protocol,

        hostname:
          target.hostname,

        port:
          target.port ||
          (isHttps
            ? 443
            : 80),

        path:
          target.pathname +
          target.search,

        method:
          req.method,

        headers,

        agent,

        /*
         * Don't leave a dead origin
         * hanging forever.
         */

        timeout: 15000,
      };


      const upstream =
        transport.request(
          options,
          (response) => {

            /*
             * Handle redirect manually.
             */

            if (
              response.statusCode >=
                300 &&
              response.statusCode <
                400 &&
              response.headers.location
            ) {

              const redirected =
                new URL(
                  response.headers.location,
                  target
                );

              response.resume();

              return requestUpstream(
                redirected,
                req,
                redirects + 1
              )
                .then(resolve)
                .catch(reject);
            }


            resolve({
              response,
              target,
            });
          }
        );


      upstream.on(
        "timeout",
        () => {
          upstream.destroy(
            new Error(
              "Upstream timeout"
            )
          );
        }
      );


      upstream.on(
        "error",
        reject
      );


      upstream.end();
    }
  );
}


// ═══════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════

export default async function handler(
  req,
  res
) {
  cors(res);


  // ───────────────────────────────────────────
  // OPTIONS
  // ───────────────────────────────────────────

  if (
    req.method ===
    "OPTIONS"
  ) {
    return res
      .status(204)
      .end();
  }


  // ───────────────────────────────────────────
  // METHODS
  // ───────────────────────────────────────────

  if (
    req.method !== "GET" &&
    req.method !== "HEAD"
  ) {
    res.setHeader(
      "Allow",
      "GET, HEAD, OPTIONS"
    );

    return res
      .status(405)
      .json({
        error:
          "Method not allowed"
      });
  }


  try {

    const target =
      getTarget(req);


    console.log(
      `[PROXY] ${req.method} ${target.href}`
    );


    // ─────────────────────────────────────────
    // UPSTREAM
    // ─────────────────────────────────────────

    const {
      response: upstream,
      target: finalTarget
    } =
      await requestUpstream(
        target,
        req
      );


    const status =
      upstream.statusCode ||
      500;


    // ─────────────────────────────────────────
    // STATUS
    // ─────────────────────────────────────────

    if (
      status !== 200 &&
      status !== 206 &&
      status !== 304
    ) {

      let body = "";

      upstream.setEncoding(
        "utf8"
      );

      for await (
        const chunk of upstream
      ) {
        body += chunk;

        if (
          body.length > 5000
        ) {
          break;
        }
      }

      console.error(
        `[UPSTREAM ${status}] ${finalTarget.href}`
      );

      return res
        .status(status)
        .send(body);
    }


    const contentType =
      String(
        upstream.headers[
          "content-type"
        ] || ""
      );


    // ─────────────────────────────────────────
    // M3U8
    // ─────────────────────────────────────────

    if (
      isPlaylist(
        finalTarget,
        contentType
      )
    ) {

      let body = "";

      upstream.setEncoding(
        "utf8"
      );

      for await (
        const chunk of upstream
      ) {
        body += chunk;
      }


      const rewritten =
        rewritePlaylist(
          body,
          finalTarget.href,
          proxyBase(req)
        );


      res.statusCode = 200;


      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );


      /*
       * Don't cache live playlists for long.
       */

      res.setHeader(
        "Cache-Control",
        "public, max-age=2, s-maxage=2, stale-while-revalidate=3"
      );


      if (
        String(
          req.query.format || ""
        ).toLowerCase() ===
        "json"
      ) {

        res.setHeader(
          "Content-Type",
          "application/json"
        );

        return res.end(
          JSON.stringify({
            content:
              rewritten
          })
        );
      }


      return res.end(
        rewritten
      );
    }


    // ─────────────────────────────────────────
    // VTT
    // ─────────────────────────────────────────

    if (
      isVtt(
        finalTarget,
        contentType
      )
    ) {

      let body = "";

      upstream.setEncoding(
        "utf8"
      );

      for await (
        const chunk of upstream
      ) {
        body += chunk;
      }


      res.statusCode =
        status;


      res.setHeader(
        "Content-Type",
        "text/vtt; charset=utf-8"
      );


      res.setHeader(
        "Cache-Control",
        "public, max-age=300, s-maxage=300"
      );


      return res.end(
        body
      );
    }


    // ═════════════════════════════════════════
    // MEDIA
    //
    // MP2T
    // TS
    // M4S
    // MP4
    // AAC
    // KEY
    //
    // NO arrayBuffer()
    // NO Buffer.from()
    // NO manual chunks
    //
    // DIRECT PIPE
    // ═════════════════════════════════════════

    copyHeaders(
      upstream,
      res
    );


    res.statusCode =
      status;


    /*
     * VOD fragments can be cached.
     */

    res.setHeader(
      "Cache-Control",
      "public, max-age=3600, s-maxage=3600"
    );


    /*
     * Ask compatible proxies not
     * to buffer the response.
     */

    res.setHeader(
      "X-Accel-Buffering",
      "no"
    );


    /*
     * HEAD.
     */

    if (
      req.method === "HEAD"
    ) {
      upstream.resume();

      return res.end();
    }


    /*
     * THE IMPORTANT PART.
     *
     * Node pipes the upstream socket
     * directly into the Vercel response.
     */

    upstream.pipe(res);


    /*
     * If client disconnects,
     * stop downloading the segment.
     */

    req.on(
      "close",
      () => {
        if (
          !res.writableEnded
        ) {
          upstream.destroy();
        }
      }
    );


  } catch (error) {

    console.error(
      "[PROXY ERROR]",
      error
    );


    if (
      !res.headersSent
    ) {
      return res
        .status(502)
        .json({
          error:
            error?.message ||
            "Bad gateway"
        });
    }


    try {
      res.destroy(error);
    } catch {}
  }
}
