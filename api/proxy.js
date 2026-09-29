// api/proxy.js

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export const config = {
  runtime: "nodejs",
};


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
      "Last-Modified"
    ].join(", ")
  );

  res.setHeader(
    "Cross-Origin-Resource-Policy",
    "cross-origin"
  );
}


// ═══════════════════════════════════════════════
// HOP-BY-HOP HEADERS
//
// These must NOT be blindly forwarded.
// ═══════════════════════════════════════════════

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",

  // Proxy/internal headers
  "host",
  "content-length",

  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",

  "via",
]);


// ═══════════════════════════════════════════════
// HEADER NAME NORMALIZATION
// ═══════════════════════════════════════════════

function normalizeHeaderName(name) {
  return String(name)
    .trim()
    .toLowerCase();
}


// ═══════════════════════════════════════════════
// CHECK VALID HEADER NAME
// ═══════════════════════════════════════════════

function isValidHeaderName(name) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(
    name
  );
}


// ═══════════════════════════════════════════════
// CHECK VALID HEADER VALUE
// ═══════════════════════════════════════════════

function isValidHeaderValue(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return false;
  }

  const str = String(value);

  // Prevent header injection.
  return !/[\r\n]/.test(str);
}


// ═══════════════════════════════════════════════
// ADD HEADER SAFELY
// ═══════════════════════════════════════════════

function addHeader(
  headers,
  name,
  value
) {
  const normalized =
    normalizeHeaderName(name);

  if (
    !normalized ||
    !isValidHeaderName(normalized)
  ) {
    return;
  }

  if (
    HOP_BY_HOP_HEADERS.has(normalized)
  ) {
    return;
  }

  if (
    !isValidHeaderValue(value)
  ) {
    return;
  }

  headers[normalized] =
    String(value);
}


// ═══════════════════════════════════════════════
// PARSE CUSTOM HEADERS
//
// Supported:
//
// ?headers={"Referer":"...","Origin":"..."}
//
// Also:
//
// ?headers=<URL encoded JSON>
//
// And:
//
// ?headers=<base64 JSON>
// ═══════════════════════════════════════════════

function parseHeadersParameter(req) {
  const result = {};

  let raw = req.query?.headers;

  if (!raw) {
    return result;
  }

  if (Array.isArray(raw)) {
    raw = raw[0];
  }

  raw = String(raw);

  if (!raw) {
    return result;
  }

  let decoded = raw;

  // Try URL decoding.
  try {
    decoded = decodeURIComponent(
      decoded
    );
  } catch {}

  let parsed = null;

  // ─────────────────────────────────────────
  // JSON
  // ─────────────────────────────────────────

  try {
    parsed = JSON.parse(decoded);
  } catch {}


  // ─────────────────────────────────────────
  // BASE64 JSON
  // ─────────────────────────────────────────

  if (
    !parsed
  ) {
    try {
      const text =
        Buffer.from(
          decoded,
          "base64"
        ).toString("utf8");

      parsed = JSON.parse(text);
    } catch {}
  }


  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return result;
  }


  for (
    const [name, value]
    of Object.entries(parsed)
  ) {
    if (
      Array.isArray(value)
    ) {
      // Node can technically support
      // arrays for some headers.
      // Convert them safely.
      addHeader(
        result,
        name,
        value.join(", ")
      );
    } else {
      addHeader(
        result,
        name,
        value
      );
    }
  }

  return result;
}


// ═══════════════════════════════════════════════
// BUILD UPSTREAM HEADERS
//
// Priority:
//
// 1. Headers explicitly supplied through
//    ?headers=...
//
// 2. Explicit header query parameters
//
// 3. Incoming browser/client headers
//
// This removes all fixed Referer/Origin/UA.
// ═══════════════════════════════════════════════

function buildUpstreamHeaders(
  req
) {
  const headers = {};


  // ═════════════════════════════════════════
  // 1. FORWARD INCOMING REQUEST HEADERS
  // ═════════════════════════════════════════

  for (
    const [name, value]
    of Object.entries(
      req.headers || {}
    )
  ) {
    const normalized =
      normalizeHeaderName(name);

    if (
      HOP_BY_HOP_HEADERS.has(
        normalized
      )
    ) {
      continue;
    }

    if (
      value === undefined ||
      value === null
    ) {
      continue;
    }

    if (
      Array.isArray(value)
    ) {
      addHeader(
        headers,
        normalized,
        value.join(", ")
      );
    } else {
      addHeader(
        headers,
        normalized,
        value
      );
    }
  }


  // ═════════════════════════════════════════
  // 2. CUSTOM JSON HEADERS
  // ═════════════════════════════════════════

  const custom =
    parseHeadersParameter(req);

  for (
    const [name, value]
    of Object.entries(custom)
  ) {
    addHeader(
      headers,
      name,
      value
    );
  }


  // ═════════════════════════════════════════
  // 3. INDIVIDUAL HEADER QUERY PARAMETERS
  //
  // Examples:
  //
  // ?referer=https://example.com
  // ?origin=https://example.com
  // ?user-agent=Mozilla/5.0
  // ?accept=video/*
  // ?authorization=Bearer%20...
  // ═════════════════════════════════════════

  const queryHeaderMap = {
    "referer": "referer",
    "referrer": "referer",

    "origin": "origin",

    "user-agent": "user-agent",

    "accept": "accept",
    "accept-language": "accept-language",
    "accept-encoding": "accept-encoding",

    "authorization": "authorization",

    "cookie": "cookie",

    "range": "range",

    "if-none-match":
      "if-none-match",

    "if-modified-since":
      "if-modified-since",

    "cache-control":
      "cache-control",

    "pragma":
      "pragma",

    "sec-fetch-dest":
      "sec-fetch-dest",

    "sec-fetch-mode":
      "sec-fetch-mode",

    "sec-fetch-site":
      "sec-fetch-site",

    "sec-fetch-user":
      "sec-fetch-user",

    "sec-ch-ua":
      "sec-ch-ua",

    "sec-ch-ua-mobile":
      "sec-ch-ua-mobile",

    "sec-ch-ua-platform":
      "sec-ch-ua-platform",
  };


  for (
    const [
      queryName,
      headerName
    ]
    of Object.entries(
      queryHeaderMap
    )
  ) {
    let value =
      req.query?.[queryName];

    if (
      value === undefined ||
      value === null
    ) {
      continue;
    }

    if (
      Array.isArray(value)
    ) {
      value = value[0];
    }

    addHeader(
      headers,
      headerName,
      value
    );
  }


  // ═════════════════════════════════════════
  // DEFAULTS
  //
  // Only add these if the client did not
  // already provide them.
  // ═════════════════════════════════════════

  if (
    !headers["accept"]
  ) {
    headers["accept"] = "*/*";
  }

  /*
   * We don't force a browser User-Agent.
   *
   * If the client supplied one,
   * it remains untouched.
   */

  return headers;
}


// ═══════════════════════════════════════════════
// GET TARGET URL
// ═══════════════════════════════════════════════

function getTarget(req) {
  let value =
    req.query?.url;

  if (!value) {
    throw new Error(
      "Missing url parameter"
    );
  }

  if (
    Array.isArray(value)
  ) {
    value = value[0];
  }

  value = String(value);


  /*
   * Decode only when the URL itself
   * is encoded.
   */

  try {
    if (
      value.startsWith(
        "http%3A"
      ) ||
      value.startsWith(
        "https%3A"
      )
    ) {
      value =
        decodeURIComponent(
          value
        );
    }
  } catch {}


  const url =
    new URL(value);


  if (
    url.protocol !== "http:" &&
    url.protocol !== "https:"
  ) {
    throw new Error(
      "Invalid URL protocol"
    );
  }


  /*
   * Preserve extra query parameters.
   *
   * IMPORTANT:
   *
   * Header-related parameters are NOT
   * copied into the upstream URL.
   */

  const excluded =
    new Set([
      "url",
      "format",

      "headers",

      "referer",
      "referrer",
      "origin",
      "user-agent",

      "accept",
      "accept-language",
      "accept-encoding",

      "authorization",
      "cookie",

      "range",

      "if-none-match",
      "if-modified-since",

      "cache-control",
      "pragma",

      "sec-fetch-dest",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-user",

      "sec-ch-ua",
      "sec-ch-ua-mobile",
      "sec-ch-ua-platform",
    ]);


  for (
    const [key, val]
    of Object.entries(
      req.query || {}
    )
  ) {
    if (
      excluded.has(
        key.toLowerCase()
      )
    ) {
      continue;
    }

    if (
      val === undefined
    ) {
      continue;
    }

    if (
      Array.isArray(val)
    ) {
      for (
        const x of val
      ) {
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
      req.headers[
        "x-forwarded-proto"
      ] ||
      "https"
    )
      .split(",")[0]
      .trim();

  const host =
    req.headers[
      "x-forwarded-host"
    ] ||
    req.headers.host;

  return (
    `${proto}://${host}` +
    `/api/proxy?url=`
  );
}


// ═══════════════════════════════════════════════
// BUILD CHILD PROXY URL
//
// IMPORTANT:
//
// The original header information is encoded
// into every rewritten URL.
//
// That means:
//
// Master M3U8
//      ↓
// Segment URL
//      ↓
// Proxy
//      ↓
// Same headers
//      ↓
// CDN
// ═══════════════════════════════════════════════

function buildProxyUrl(
  proxy,
  absolute,
  req
) {
  let result =
    proxy +
    encodeURIComponent(
      absolute
    );


  /*
   * Preserve explicit custom headers for
   * child requests.
   *
   * We don't copy every incoming header into
   * the URL because that could create extremely
   * long URLs and expose cookies/auth tokens.
   *
   * Only forwarding-related headers are carried.
   */

  const headerObject = {};

  const sourceHeaders =
    buildUpstreamHeaders(req);


  const headersToCarry = [
    "referer",
    "origin",
    "user-agent",
    "authorization",
    "cookie",
    "accept",
    "accept-language",
  ];


  for (
    const name of headersToCarry
  ) {
    if (
      sourceHeaders[name]
    ) {
      headerObject[name] =
        sourceHeaders[name];
    }
  }


  if (
    Object.keys(
      headerObject
    ).length
  ) {
    result +=
      "&headers=" +
      encodeURIComponent(
        JSON.stringify(
          headerObject
        )
      );
  }


  return result;
}


// ═══════════════════════════════════════════════
// REWRITE M3U8
// ═══════════════════════════════════════════════

function rewritePlaylist(
  text,
  playlistUrl,
  proxy,
  req
) {
  const base =
    new URL(
      "./",
      playlistUrl
    ).href;


  // ═════════════════════════════════════════
  // URI="..."
  //
  // EXT-X-KEY
  // EXT-X-MAP
  // EXT-X-MEDIA
  // EXT-X-PART
  // etc.
  // ═════════════════════════════════════════

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

          return (
            `URI="` +
            buildProxyUrl(
              proxy,
              absolute,
              req
            ) +
            `"`
          );
        } catch {
          return match;
        }
      }
    );


  // ═════════════════════════════════════════
  // NORMAL SEGMENT / PLAYLIST LINES
  // ═════════════════════════════════════════

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

    if (
      line.startsWith("#")
    ) {
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
          req
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
    contentType.includes(
      "mpegurl"
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
    "content-disposition",
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
// NATIVE HTTP FETCH
// ═══════════════════════════════════════════════

function requestUpstream(
  target,
  req,
  redirects = 0
) {
  return new Promise(
    (resolve, reject) => {

      if (
        redirects > 8
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


      // ═════════════════════════════════════
      // DYNAMIC HEADERS
      // ═════════════════════════════════════

      const headers =
        buildUpstreamHeaders(
          req
        );


      // ═════════════════════════════════════
      // LOG IMPORTANT HEADERS
      //
      // Do NOT log Cookie/Authorization.
      // ═════════════════════════════════════

      console.log(
        "[UPSTREAM HEADERS]",
        {
          referer:
            headers.referer ||
            null,

          origin:
            headers.origin ||
            null,

          userAgent:
            headers["user-agent"] ||
            null,

          accept:
            headers.accept ||
            null,

          range:
            headers.range ||
            null,

          authorization:
            headers.authorization
              ? "[PRESENT]"
              : null,

          cookie:
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

        timeout: 15000,
      };


      const upstream =
        transport.request(
          options,
          (response) => {

            // ═══════════════════════════════
            // REDIRECT
            // ═══════════════════════════════

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


              /*
               * Same request headers are
               * automatically rebuilt.
               *
               * Therefore Referer,
               * Origin, UA, Cookie, etc.
               * continue to work.
               */

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


  // ═════════════════════════════════════════
  // OPTIONS
  // ═════════════════════════════════════════

  if (
    req.method ===
    "OPTIONS"
  ) {
    return res
      .status(204)
      .end();
  }


  // ═════════════════════════════════════════
  // METHODS
  // ═════════════════════════════════════════

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
          "Method not allowed",
      });
  }


  try {

    // ═══════════════════════════════════════
    // TARGET
    // ═══════════════════════════════════════

    const target =
      getTarget(req);


    console.log(
      `[PROXY] ${req.method} ${target.href}`
    );


    // ═══════════════════════════════════════
    // UPSTREAM
    // ═══════════════════════════════════════

    const {
      response: upstream,
      target: finalTarget,
    } =
      await requestUpstream(
        target,
        req
      );


    const status =
      upstream.statusCode ||
      500;


    // ═══════════════════════════════════════
    // ERROR RESPONSE
    // ═══════════════════════════════════════

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


    // ═══════════════════════════════════════
    // M3U8
    // ═══════════════════════════════════════

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
          req
        );


      res.statusCode =
        200;


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
          req.query?.format ||
          ""
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
              rewritten,
          })
        );
      }


      return res.end(
        rewritten
      );
    }


    // ═══════════════════════════════════════
    // VTT
    // ═══════════════════════════════════════

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


    // ═══════════════════════════════════════
    // MEDIA
    //
    // TS
    // M4S
    // MP4
    // AAC
    // KEY
    // ETC.
    //
    // DIRECT PIPE
    // ═══════════════════════════════════════

    copyHeaders(
      upstream,
      res
    );


    res.statusCode =
      status;


    res.setHeader(
      "Cache-Control",
      "public, max-age=3600, s-maxage=3600"
    );


    res.setHeader(
      "X-Accel-Buffering",
      "no"
    );


    // ═══════════════════════════════════════
    // HEAD
    // ═══════════════════════════════════════

    if (
      req.method === "HEAD"
    ) {
      upstream.resume();

      return res.end();
    }


    // ═══════════════════════════════════════
    // DIRECT PIPE
    // ═══════════════════════════════════════

    upstream.pipe(res);


    // ═══════════════════════════════════════
    // CLIENT DISCONNECT
    // ═══════════════════════════════════════

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
            "Bad gateway",
        });
    }


    try {
      res.destroy(error);
    } catch {}
  }
}
