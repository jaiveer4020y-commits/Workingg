// /api/proxy.js

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export const config = {
  runtime: "nodejs",
};


// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════

const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT = 20000;

// Hop-by-hop headers must NOT be forwarded manually.
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "proxy-connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "proxy-authenticate",
  "proxy-authorization",
]);


// ═══════════════════════════════════════════════
// KEEP-ALIVE AGENTS
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
      "Last-Modified",
      "Content-Disposition",
      "Cache-Control"
    ].join(", ")
  );

  res.setHeader(
    "Cross-Origin-Resource-Policy",
    "cross-origin"
  );
}


// ═══════════════════════════════════════════════
// HEADER NAME VALIDATION
// ═══════════════════════════════════════════════

function validHeaderName(name) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(
    name
  );
}


// ═══════════════════════════════════════════════
// PARSE URL + PIPE HEADERS
//
// Supported:
//
// https://example.com/video.mp4
//
// OR:
//
// https://example.com/video.mp4|
// Referer=https%3A%2F%2Fexample.com%2F&
// Origin=https%3A%2F%2Fexample.com&
// User-Agent=Mozilla%2F5.0
//
// Everything after the FIRST "|" is treated as
// encoded header data.
// ═══════════════════════════════════════════════

function parseTargetAndHeaders(value) {
  value = String(value || "").trim();

  if (!value) {
    throw new Error(
      "Missing url parameter"
    );
  }

  // Decode only enough to detect an encoded pipe.
  try {
    if (
      value.includes("%7C") ||
      value.includes("%7c")
    ) {
      value = decodeURIComponent(value);
    }
  } catch {
    // Keep original if malformed.
  }

  let targetString = value;
  let headerString = "";

  const pipeIndex = value.indexOf("|");

  if (pipeIndex !== -1) {
    targetString =
      value.slice(0, pipeIndex);

    headerString =
      value.slice(pipeIndex + 1);
  }

  // Decode URL if it was passed encoded.
  try {
    targetString = decodeURIComponent(
      targetString
    );
  } catch {
    // Keep original.
  }

  const target = new URL(
    targetString
  );

  if (
    target.protocol !== "http:" &&
    target.protocol !== "https:"
  ) {
    throw new Error(
      "Only HTTP/HTTPS URLs are allowed"
    );
  }

  const headers = {};

  if (headerString) {
    /*
     * Header values were encoded individually:
     *
     * Referer=https%3A%2F%2F...
     *
     * Decode the header portion once.
     */
    let decodedHeaders = headerString;

    try {
      decodedHeaders =
        decodeURIComponent(
          headerString
        );
    } catch {
      // It may already be decoded.
    }

    /*
     * Split by &.
     *
     * Header values containing & should have
     * been percent-encoded by the Python builder.
     */
    const parts =
      decodedHeaders.split("&");

    for (const part of parts) {
      if (!part) continue;

      const equals =
        part.indexOf("=");

      if (equals === -1) {
        continue;
      }

      const rawName =
        part.slice(0, equals).trim();

      const rawValue =
        part.slice(equals + 1);

      if (!rawName) continue;

      const name =
        rawName.toLowerCase();

      if (!validHeaderName(rawName)) {
        continue;
      }

      /*
       * Never allow the URL header section to
       * manually control the upstream Host.
       */
      if (name === "host") {
        continue;
      }

      /*
       * Never forward hop-by-hop headers.
       */
      if (
        HOP_BY_HOP_HEADERS.has(name)
      ) {
        continue;
      }

      headers[rawName] =
        rawValue;
    }
  }

  return {
    target,
    headers,
  };
}


// ═══════════════════════════════════════════════
// GET TARGET
// ═══════════════════════════════════════════════

function getTarget(req) {
  let value = req.query?.url;

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
   * Important:
   *
   * The URL may contain:
   *
   * target|Referer=...&Origin=...
   *
   * Therefore parse the pipe/header section
   * BEFORE adding normal query parameters.
   */

  const parsed =
    parseTargetAndHeaders(value);

  const url =
    parsed.target;

  const headers =
    parsed.headers;


  /*
   * Preserve additional proxy query parameters.
   *
   * Example:
   *
   * /api/proxy?url=...&format=json
   */

  const extra = {
    ...(req.query || {})
  };

  delete extra.url;

  for (
    const [key, val]
    of Object.entries(extra)
  ) {
    if (
      val === undefined ||
      key === "format"
    ) {
      continue;
    }

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

  return {
    target: url,
    headers,
  };
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
// BUILD PROXIED URL WITH HEADERS
// ═══════════════════════════════════════════════

function buildProxyUrl(
  proxy,
  absolute,
  headers
) {
  let value =
    absolute;

  const pairs = [];

  for (
    const [name, headerValue]
    of Object.entries(headers)
  ) {
    if (
      !headerValue ||
      HOP_BY_HOP_HEADERS.has(
        name.toLowerCase()
      ) ||
      name.toLowerCase() === "host"
    ) {
      continue;
    }

    pairs.push(
      `${name}=${encodeURIComponent(
        String(headerValue)
      )}`
    );
  }

  if (pairs.length) {
    value +=
      "|" +
      pairs.join("&");
  }

  return (
    proxy +
    encodeURIComponent(value)
  );
}


// ═══════════════════════════════════════════════
// REWRITE M3U8
// ═══════════════════════════════════════════════

function rewritePlaylist(
  text,
  playlistUrl,
  proxy,
  headers
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

  text =
    text.replace(
      /URI="([^"]+)"/g,
      (match, uri) => {
        try {
          const absolute =
            new URL(
              uri,
              base
            ).href;

          const proxied =
            buildProxyUrl(
              proxy,
              absolute,
              headers
            );

          return `URI="${proxied}"`;
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

    if (!line) {
      continue;
    }

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
        buildProxyUrl(
          proxy,
          absolute,
          headers
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

  const type =
    contentType.toLowerCase();

  return (
    path.endsWith(".m3u8") ||
    path.endsWith(".m3u") ||
    type.includes(
      "mpegurl"
    ) ||
    type.includes(
      "vnd.apple.mpegurl"
    )
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
    contentType
      .toLowerCase()
      .includes("text/vtt")
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
    "content-disposition",
    "cache-control",
  ];

  for (
    const name of allowed
  ) {
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
// REQUEST UPSTREAM
// ═══════════════════════════════════════════════

function requestUpstream(
  target,
  requestHeaders,
  req,
  redirects = 0
) {
  return new Promise(
    (resolve, reject) => {

      if (
        redirects > MAX_REDIRECTS
      ) {
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


      /*
       * Start with the headers extracted
       * from the proxy URL.
       */
      const headers = {
        ...requestHeaders,
      };


      /*
       * Range must come from the actual
       * proxy request if supplied.
       *
       * This is important for video seeking.
       */
      if (
        req.headers.range
      ) {
        headers.Range =
          req.headers.range;
      }


      /*
       * Conditional requests.
       */
      if (
        req.headers[
          "if-none-match"
        ] &&
        !headers[
          "If-None-Match"
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
        ] &&
        !headers[
          "If-Modified-Since"
        ]
      ) {
        headers[
          "If-Modified-Since"
        ] =
          req.headers[
            "if-modified-since"
          ];
      }


      /*
       * Defaults only when the caller
       * didn't provide them.
       */
      if (!headers.Accept) {
        headers.Accept =
          "*/*";
      }

      if (!headers["Accept-Encoding"]) {
        headers["Accept-Encoding"] =
          "identity";
      }


      /*
       * Node itself supplies Host.
       */
      delete headers.Host;
      delete headers.host;


      /*
       * Remove hop-by-hop headers.
       */
      for (
        const key
        of Object.keys(headers)
      ) {
        if (
          HOP_BY_HOP_HEADERS.has(
            key.toLowerCase()
          )
        ) {
          delete headers[key];
        }
      }


      console.log(
        "[UPSTREAM HEADERS]",
        {
          referer:
            headers.Referer ??
            headers.referer ??
            null,

          origin:
            headers.Origin ??
            headers.origin ??
            null,

          userAgent:
            headers["User-Agent"] ??
            headers["user-agent"] ??
            null,

          accept:
            headers.Accept ??
            headers.accept ??
            null,

          range:
            headers.Range ??
            headers.range ??
            null,

          authorization:
            headers.Authorization ??
            headers.authorization ??
            null,

          cookie:
            headers.Cookie ||
            headers.cookie
              ? "[PRESENT]"
              : null,
        }
      );


      const options = {
        protocol:
          target.protocol,

        hostname:
          target.hostname,

        port:
          target.port ||
          (
            isHttps
              ? 443
              : 80
          ),

        path:
          target.pathname +
          target.search,

        method:
          req.method,

        headers,

        agent,

        timeout:
          UPSTREAM_TIMEOUT,
      };


      const upstream =
        transport.request(
          options,
          (response) => {

            /*
             * Manual redirect.
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
                requestHeaders,
                req,
                redirects + 1
              )
                .then(resolve)
                .catch(reject);
            }


            resolve({
              response,
              target,
              requestHeaders:
                headers,
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

    // ═════════════════════════════════════════
    // PARSE TARGET + HEADERS
    // ═════════════════════════════════════════

    const {
      target,
      headers: requestHeaders,
    } =
      getTarget(req);


    console.log(
      `[PROXY] ${req.method} ${target.href}`
    );


    console.log(
      "[PROXY REQUEST HEADERS]",
      Object.fromEntries(
        Object.entries(
          requestHeaders
        ).map(
          ([key, value]) => [
            key,
            key.toLowerCase() ===
            "cookie"
              ? "[PRESENT]"
              : value
          ]
        )
      )
    );


    // ═════════════════════════════════════════
    // UPSTREAM
    // ═════════════════════════════════════════

    const {
      response: upstream,
      target: finalTarget,
    } =
      await requestUpstream(
        target,
        requestHeaders,
        req
      );


    const status =
      upstream.statusCode ||
      500;


    const contentType =
      String(
        upstream.headers[
          "content-type"
        ] || ""
      );


    console.log(
      `[UPSTREAM ${status}] ${finalTarget.href}`
    );


    // ═════════════════════════════════════════
    // STATUS
    //
    // IMPORTANT:
    // We NEVER manufacture 206.
    // ═════════════════════════════════════════

    if (
      status !== 200 &&
      status !== 206 &&
      status !== 304
    ) {

      let body = "";

      /*
       * Don't read huge error responses.
       */
      upstream.setEncoding(
        "utf8"
      );

      for await (
        const chunk of upstream
      ) {
        body += chunk;

        if (
          body.length >= 10000
        ) {
          break;
        }
      }


      return res
        .status(status)
        .send(body);
    }


    // ═════════════════════════════════════════
    // M3U8 / M3U
    // ═════════════════════════════════════════

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
          proxyBase(req),
          requestHeaders
        );


      res.statusCode =
        status === 206
          ? 206
          : 200;


      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );


      res.setHeader(
        "Cache-Control",
        "public, max-age=2, s-maxage=2, stale-while-revalidate=3"
      );


      if (
        String(
          req.query?.format || ""
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


    // ═════════════════════════════════════════
    // VTT
    // ═════════════════════════════════════════

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
    // MP4
    // M4S
    // TS
    // AAC
    // KEY
    // etc.
    // ═════════════════════════════════════════

    copyHeaders(
      upstream,
      res
    );


    res.statusCode =
      status;


    /*
     * Preserve the upstream status.
     *
     * 200 remains 200.
     * 206 remains 206.
     */
    res.statusCode =
      status;


    /*
     * Don't overwrite upstream
     * cache-control when one exists.
     */
    if (
      !upstream.headers[
        "cache-control"
      ]
    ) {
      res.setHeader(
        "Cache-Control",
        "public, max-age=3600, s-maxage=3600"
      );
    }


    res.setHeader(
      "X-Accel-Buffering",
      "no"
    );


    // ═════════════════════════════════════════
    // HEAD
    // ═════════════════════════════════════════

    if (
      req.method === "HEAD"
    ) {
      upstream.resume();

      return res.end();
    }


    // ═════════════════════════════════════════
    // DIRECT STREAM
    // ═════════════════════════════════════════

    upstream.pipe(res);


    /*
     * Stop upstream download if
     * client disconnects.
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
