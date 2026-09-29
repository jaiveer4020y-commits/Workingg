// /api/proxy.js
//
// Accepts BOTH forms:
//   1) Properly encoded:
//      /api/proxy?url=<encodeURIComponent("https://cdn/x.mp4?sign=1&t=2|Referer=...&Origin=...")>
//   2) Un-encoded (what your screenshot shows):
//      /api/proxy?url=https://cdn/x.mp4?sign=1&t=2|Referer=https://site/&Origin=https://site
//
// Form 2 used to break because req.query splits on every "&", so
// "t=2|Referer=..." became its own query param and was then appended
// to the upstream URL (corrupting the signed "t"), while the headers
// never reached the CDN (Referer: null in your logs -> 429).
// We now read the RAW query string instead of req.query.

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

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

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

// Never accepted from the URL header section.
const BLOCKED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "host",
  "content-length",
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
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
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
      "Cache-Control",
    ].join(", ")
  );
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}


// ═══════════════════════════════════════════════
// SMALL HELPERS
// ═══════════════════════════════════════════════

function validHeaderName(name) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

function hasHeader(headers, name) {
  return getHeader(headers, name) !== undefined;
}

function pickHeaders(headers, names) {
  const out = {};
  for (const key of Object.keys(headers)) {
    if (names.includes(key.toLowerCase())) out[key] = headers[key];
  }
  return out;
}


// ═══════════════════════════════════════════════
// READ THE RAW `url` PARAMETER
//
// Do NOT use req.query.url: it is cut at the first
// unencoded "&", which destroys un-encoded URLs.
// ═══════════════════════════════════════════════

function readRawUrlParam(req) {
  const full = String(req.url || "");
  const q = full.indexOf("?");

  if (q === -1) {
    return { raw: "", format: "" };
  }

  let qs = full.slice(q + 1);
  let format = "";

  // Optional trailing "&format=json"
  const trailing = qs.match(/&format=([a-z]+)$/i);
  if (trailing) {
    format = trailing[1].toLowerCase();
    qs = qs.slice(0, trailing.index);
  }

  const m = qs.match(/(?:^|&)url=/);
  if (!m) {
    return { raw: "", format };
  }

  // Optional leading "format=json&url=..."
  const before = qs.slice(0, m.index);
  const leading = before.match(/(?:^|&)format=([a-z]+)/i);
  if (leading) format = leading[1].toLowerCase();

  // EVERYTHING after "url=" belongs to the target + pipe headers.
  const raw = qs.slice(m.index + m[0].length);

  return { raw, format };
}


// ═══════════════════════════════════════════════
// NORMALIZE VALUE
//
// Encoded form  : https%3A%2F%2F...%7CReferer%3D...  -> decode ONCE
// Un-encoded    : https://...|Referer=...            -> leave alone
// ═══════════════════════════════════════════════

function normalizeValue(raw) {
  let value = String(raw || "").trim();

  // Fully encoded (handles accidental double-encoding too).
  for (let i = 0; i < 2 && /^https?%3A/i.test(value); i++) {
    value = safeDecode(value);
  }

  // Only the pipe was encoded.
  if (!value.includes("|") && /%7C/i.test(value)) {
    value = value.replace(/%7C/i, "|");
  }

  return value;
}


// ═══════════════════════════════════════════════
// PARSE TARGET + PIPE HEADERS
//
//   <target>|Name=Value&Name2=Value2
//
// Each header value is percent-decoded INDIVIDUALLY, after
// splitting on "&" and the first "=". (Decoding the whole
// header string first turns %26 / %3D inside a value into
// real "&" / "=" and corrupts cookies.)
// ═══════════════════════════════════════════════

function parseTargetAndHeaders(value) {
  if (!value) {
    throw new Error("Missing url parameter");
  }

  const pipe = value.indexOf("|");

  let targetString = pipe === -1 ? value : value.slice(0, pipe);
  const headerString = pipe === -1 ? "" : value.slice(pipe + 1);

  targetString = targetString.trim();

  // Only decode the target if it is not already a plain URL.
  if (!/^https?:\/\//i.test(targetString)) {
    targetString = safeDecode(targetString);
  }

  const target = new URL(targetString);

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Only HTTP/HTTPS URLs are allowed");
  }

  const headers = {};

  for (const part of headerString.split("&")) {
    if (!part) continue;

    const eq = part.indexOf("=");
    if (eq === -1) continue;

    const name = safeDecode(part.slice(0, eq)).trim();
    const val = safeDecode(part.slice(eq + 1));

    if (!name || !validHeaderName(name)) continue;
    if (BLOCKED_HEADERS.has(name.toLowerCase())) continue;
    if (/[\r\n]/.test(val)) continue; // header injection guard

    headers[name] = val;
  }

  return { target, headers };
}


function getTarget(req) {
  const { raw, format } = readRawUrlParam(req);
  const parsed = parseTargetAndHeaders(normalizeValue(raw));

  return {
    target: parsed.target,
    headers: parsed.headers,
    format,
  };
}


// ═══════════════════════════════════════════════
// PROXY URL BUILDERS (for playlist rewriting)
// ═══════════════════════════════════════════════

function proxyBase(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim();

  const host = req.headers["x-forwarded-host"] || req.headers.host;

  return `${proto}://${host}/api/proxy?url=`;
}

function buildProxyUrl(proxy, absolute, headers) {
  let value = absolute;
  const pairs = [];

  for (const [name, headerValue] of Object.entries(headers)) {
    const lower = name.toLowerCase();

    if (!headerValue || BLOCKED_HEADERS.has(lower)) continue;

    pairs.push(`${name}=${encodeURIComponent(String(headerValue))}`);
  }

  if (pairs.length) {
    value += "|" + pairs.join("&");
  }

  return proxy + encodeURIComponent(value);
}


// ═══════════════════════════════════════════════
// REWRITE M3U8
// ═══════════════════════════════════════════════

function rewritePlaylist(text, playlistUrl, proxy, headers) {
  const base = new URL("./", playlistUrl).href;

  // URI="..." (KEY, MAP, MEDIA, PART, ...)
  text = text.replace(/URI="([^"]+)"/g, (match, uri) => {
    try {
      const absolute = new URL(uri, base).href;
      return `URI="${buildProxyUrl(proxy, absolute, headers)}"`;
    } catch {
      return match;
    }
  });

  // Segment / playlist lines
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line || line.startsWith("#")) continue;

    try {
      const absolute = new URL(line, base).href;
      lines[i] = buildProxyUrl(proxy, absolute, headers);
    } catch {
      // keep original
    }
  }

  return lines.join("\n");
}


// ═══════════════════════════════════════════════
// DETECTORS
// ═══════════════════════════════════════════════

function isPlaylist(target, contentType) {
  const path = target.pathname.toLowerCase();
  const type = contentType.toLowerCase();

  return (
    path.endsWith(".m3u8") ||
    path.endsWith(".m3u") ||
    type.includes("mpegurl")
  );
}

function isVtt(target, contentType) {
  return (
    target.pathname.toLowerCase().endsWith(".vtt") ||
    contentType.toLowerCase().includes("text/vtt")
  );
}


// ═══════════════════════════════════════════════
// COPY RESPONSE HEADERS
// ═══════════════════════════════════════════════

function copyHeaders(upstream, res) {
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

  for (const name of allowed) {
    const value = upstream.headers[name];
    if (value !== undefined) res.setHeader(name, value);
  }
}


// ═══════════════════════════════════════════════
// REQUEST UPSTREAM
// ═══════════════════════════════════════════════

function requestUpstream(target, requestHeaders, req, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > MAX_REDIRECTS) {
      reject(new Error("Too many redirects"));
      return;
    }

    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const headers = { ...requestHeaders };

    // Range comes from the player (needed for seeking).
    if (req.headers.range) {
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === "range") delete headers[k];
      }
      headers.Range = req.headers.range;
    }

    if (req.headers["if-none-match"] && !hasHeader(headers, "if-none-match")) {
      headers["If-None-Match"] = req.headers["if-none-match"];
    }

    if (
      req.headers["if-modified-since"] &&
      !hasHeader(headers, "if-modified-since")
    ) {
      headers["If-Modified-Since"] = req.headers["if-modified-since"];
    }

    // Defaults only when the caller did not provide them.
    if (!hasHeader(headers, "user-agent")) headers["User-Agent"] = DEFAULT_UA;
    if (!hasHeader(headers, "accept")) headers.Accept = "*/*";
    if (!hasHeader(headers, "accept-encoding")) {
      headers["Accept-Encoding"] = "identity";
    }

    // Node supplies Host itself; strip anything hop-by-hop.
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === "host" || HOP_BY_HOP_HEADERS.has(lower)) {
        delete headers[key];
      }
    }

    console.log("[UPSTREAM HEADERS]", {
      referer: getHeader(headers, "referer") ?? null,
      origin: getHeader(headers, "origin") ?? null,
      userAgent: getHeader(headers, "user-agent") ?? null,
      accept: getHeader(headers, "accept") ?? null,
      range: getHeader(headers, "range") ?? null,
      cookie: hasHeader(headers, "cookie") ? "[PRESENT]" : null,
    });

    const options = {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
      agent,
      timeout: UPSTREAM_TIMEOUT,
    };

    const upstream = transport.request(options, (response) => {
      // Manual redirect
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        const redirected = new URL(response.headers.location, target);

        response.resume();

        return requestUpstream(redirected, requestHeaders, req, redirects + 1)
          .then(resolve)
          .catch(reject);
      }

      resolve({ response, target });
    });

    upstream.on("timeout", () => {
      upstream.destroy(new Error("Upstream timeout"));
    });

    upstream.on("error", reject);

    upstream.end();
  });
}


// ═══════════════════════════════════════════════
// READ A BOUNDED TEXT BODY
// ═══════════════════════════════════════════════

async function readText(stream, limit = Infinity) {
  let body = "";

  stream.setEncoding("utf8");

  for await (const chunk of stream) {
    body += chunk;

    if (body.length >= limit) {
      stream.destroy();
      break;
    }
  }

  return body;
}


// ═══════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════

export default async function handler(req, res) {
  cors(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { target, headers: requestHeaders, format } = getTarget(req);

    console.log(`[PROXY] ${req.method} ${target.href}`);

    console.log(
      "[PROXY REQUEST HEADERS]",
      Object.fromEntries(
        Object.entries(requestHeaders).map(([k, v]) => [
          k,
          k.toLowerCase() === "cookie" ? "[PRESENT]" : v,
        ])
      )
    );

    let result = await requestUpstream(target, requestHeaders, req);

    // Some CDNs reject extra headers (e.g. Origin) on media requests.
    // One retry with the minimal set before giving up.
    const firstStatus = result.response.statusCode;

    if (firstStatus === 403 || firstStatus === 426) {
      const minimal = pickHeaders(requestHeaders, [
        "referer",
        "user-agent",
        "cookie",
      ]);

      if (
        Object.keys(minimal).length &&
        Object.keys(minimal).length < Object.keys(requestHeaders).length
      ) {
        console.log(`[RETRY] ${firstStatus} -> minimal headers`);
        result.response.resume();
        result = await requestUpstream(target, minimal, req);
      }
    }

    const upstream = result.response;
    const finalTarget = result.target;
    const status = upstream.statusCode || 500;

    const contentType = String(upstream.headers["content-type"] || "");

    console.log(`[UPSTREAM ${status}] ${finalTarget.href}`);

    // ─── Errors: pass through, never cache ───
    if (status !== 200 && status !== 206 && status !== 304) {
      const body = await readText(upstream, 10000);

      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("X-Upstream-Status", String(status));

      return res.status(status).send(body);
    }

    // ─── M3U8 ───
    if (isPlaylist(finalTarget, contentType)) {
      const body = await readText(upstream);

      const rewritten = rewritePlaylist(
        body,
        finalTarget.href,
        proxyBase(req),
        requestHeaders
      );

      res.statusCode = status === 206 ? 206 : 200;

      res.setHeader(
        "Cache-Control",
        "public, max-age=2, s-maxage=2, stale-while-revalidate=3"
      );

      if (format === "json") {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ content: rewritten }));
      }

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.end(rewritten);
    }

    // ─── VTT ───
    if (isVtt(finalTarget, contentType)) {
      const body = await readText(upstream);

      res.statusCode = status;
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");

      return res.end(body);
    }

    // ─── Media (MP4 / M4S / TS / AAC / KEY ...) ───
    copyHeaders(upstream, res);

    res.statusCode = status; // 200 stays 200, 206 stays 206

    if (!upstream.headers["cache-control"]) {
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    }

    res.setHeader("X-Accel-Buffering", "no");

    if (req.method === "HEAD") {
      upstream.resume();
      return res.end();
    }

    // Stop the upstream download if the client goes away.
    req.on("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });

    upstream.on("error", (err) => {
      console.error("[UPSTREAM STREAM ERROR]", err);
      res.destroy(err);
    });

    upstream.pipe(res);
  } catch (error) {
    console.error("[PROXY ERROR]", error);

    if (!res.headersSent) {
      return res
        .status(502)
        .json({ error: error?.message || "Bad gateway" });
    }

    try {
      res.destroy(error);
    } catch {
      // ignore
    }
  }
}
