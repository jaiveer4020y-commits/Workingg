// /api/proxy.js  (v3)
//
// HEADER TRANSPORT (any of these, later ones override earlier ones):
//   1) pipe   : ?url=<enc("https://cdn/x.mp4?sign=1&t=2|Referer=...&Cookie=...")>
//   2) b64    : ?url=<enc("https://cdn/x.mp4?sign=1&t=2")>&headers=<base64url(JSON)>
//               (recommended: cookies / ; = & never break parsing)
//   3) raw    : ?url=https://cdn/x.mp4?sign=1&t=2|Referer=...&Origin=...   (un-encoded)
//
// UPSTREAM PROFILES on 403/426 (tried in order, first non-403/426 wins):
//   as-given -> +accept-encoding -> minimal (referer/ua/cookie) -> ua-only
//
// DIAGNOSTICS: on any upstream error the response carries
//   X-Upstream-Status, X-Upstream-Headers (URL-encoded JSON of the CDN's
//   response headers), X-Upstream-Attempts, so the caller can see WHO rejected it.

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
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

const BLOCKED_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "host",
  "content-length",
]);

const SECRET_HEADERS = new Set(["cookie", "authorization"]);


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
      "X-Upstream-Status",
      "X-Upstream-Headers",
      "X-Upstream-Attempts",
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

function redact(headers) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k,
      SECRET_HEADERS.has(k.toLowerCase()) ? "[PRESENT]" : v,
    ])
  );
}

// Validate + normalise a header object coming from the URL.
function sanitizeHeaders(obj) {
  const headers = {};

  for (const [rawName, rawValue] of Object.entries(obj || {})) {
    const name = String(rawName).trim();

    if (!name || !validHeaderName(name)) continue;
    if (BLOCKED_HEADERS.has(name.toLowerCase())) continue;
    if (rawValue === null || rawValue === undefined) continue;
    if (typeof rawValue === "object") continue;

    const value = String(rawValue);

    if (/[\r\n]/.test(value)) continue; // header injection guard

    headers[name] = value;
  }

  return headers;
}


// ═══════════════════════════════════════════════
// READ RAW QUERY (req.query splits on every "&")
// ═══════════════════════════════════════════════

function readRawParams(req) {
  const full = String(req.url || "");
  const q = full.indexOf("?");

  const out = { raw: "", format: "", headersParam: "" };

  if (q === -1) return out;

  const qs = full.slice(q + 1);

  const m = qs.match(/(?:^|&)url=/);
  if (!m) return out;

  const before = qs.slice(0, m.index);
  let rest = qs.slice(m.index + m[0].length);

  // Trailing params that belong to the proxy, not to the target URL.
  let changed = true;

  while (changed) {
    changed = false;

    for (const name of ["headers", "format"]) {
      const re = new RegExp(`&${name}=([^&]*)$`, "i");
      const mm = rest.match(re);

      if (mm) {
        if (name === "headers") out.headersParam = mm[1];
        else out.format = mm[1].toLowerCase();

        rest = rest.slice(0, mm.index);
        changed = true;
      }
    }
  }

  // Leading params: ?headers=...&url=...
  for (const part of before.split("&")) {
    if (!part) continue;

    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    const val = eq === -1 ? "" : part.slice(eq + 1);

    if (key === "headers") out.headersParam = val;
    if (key === "format") out.format = val.toLowerCase();
  }

  out.raw = rest;

  return out;
}


function normalizeValue(raw) {
  let value = String(raw || "").trim();

  // Fully encoded (also handles accidental double-encoding).
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
// PARSE TARGET + HEADERS
// ═══════════════════════════════════════════════

function parsePipeHeaders(headerString) {
  const obj = {};

  for (const part of headerString.split("&")) {
    if (!part) continue;

    const eq = part.indexOf("=");
    if (eq === -1) continue;

    // Each name/value decoded INDIVIDUALLY, after splitting.
    const name = safeDecode(part.slice(0, eq)).trim();
    const val = safeDecode(part.slice(eq + 1));

    if (name) obj[name] = val;
  }

  return sanitizeHeaders(obj);
}


function parseHeadersParam(param) {
  if (!param) return {};

  let parsed = null;

  // base64url (or plain base64) JSON
  try {
    parsed = JSON.parse(
      Buffer.from(safeDecode(param), "base64url").toString("utf8")
    );
  } catch {
    parsed = null;
  }

  // plain URL-encoded JSON
  if (!parsed) {
    try {
      parsed = JSON.parse(safeDecode(param));
    } catch {
      parsed = null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return sanitizeHeaders(parsed);
}


function parseTargetAndHeaders(value) {
  if (!value) {
    throw new Error("Missing url parameter");
  }

  const pipe = value.indexOf("|");

  let targetString = pipe === -1 ? value : value.slice(0, pipe);
  const headerString = pipe === -1 ? "" : value.slice(pipe + 1);

  targetString = targetString.trim();

  if (!/^https?:\/\//i.test(targetString)) {
    targetString = safeDecode(targetString);
  }

  const target = new URL(targetString);

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Only HTTP/HTTPS URLs are allowed");
  }

  return {
    target,
    headers: parsePipeHeaders(headerString),
  };
}


function getTarget(req) {
  const { raw, format, headersParam } = readRawParams(req);

  const parsed = parseTargetAndHeaders(normalizeValue(raw));

  return {
    target: parsed.target,
    // pipe first, then the explicit headers= param overrides it
    headers: { ...parsed.headers, ...parseHeadersParam(headersParam) },
    format,
  };
}


// ═══════════════════════════════════════════════
// PLAYLIST REWRITING (uses the b64 header transport)
// ═══════════════════════════════════════════════

function proxyBase(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim();

  const host = req.headers["x-forwarded-host"] || req.headers.host;

  return `${proto}://${host}/api/proxy?url=`;
}

function buildProxyUrl(proxy, absolute, headers) {
  const clean = sanitizeHeaders(headers);

  let out = proxy + encodeURIComponent(absolute);

  if (Object.keys(clean).length) {
    out +=
      "&headers=" +
      Buffer.from(JSON.stringify(clean)).toString("base64url");
  }

  return out;
}

function rewritePlaylist(text, playlistUrl, proxy, headers) {
  const base = new URL("./", playlistUrl).href;

  text = text.replace(/URI="([^"]+)"/g, (match, uri) => {
    try {
      const absolute = new URL(uri, base).href;
      return `URI="${buildProxyUrl(proxy, absolute, headers)}"`;
    } catch {
      return match;
    }
  });

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
// RESPONSE HELPERS
// ═══════════════════════════════════════════════

function copyHeaders(upstream, res) {
  const allowed = [
    "content-type",
    "content-length",
    "content-range",
    "content-encoding",
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

// Text bodies (playlists / VTT / errors) must be decompressed first.
function decodedStream(upstream) {
  const enc = String(upstream.headers["content-encoding"] || "").toLowerCase();

  if (enc.includes("gzip")) return upstream.pipe(zlib.createGunzip());
  if (enc.includes("deflate")) return upstream.pipe(zlib.createInflate());
  if (enc.includes("br")) return upstream.pipe(zlib.createBrotliDecompress());

  return upstream;
}

async function readText(upstream, limit = Infinity) {
  const stream = decodedStream(upstream);
  let body = "";

  stream.setEncoding("utf8");

  try {
    for await (const chunk of stream) {
      body += chunk;

      if (body.length >= limit) {
        stream.destroy();
        upstream.destroy();
        break;
      }
    }
  } catch {
    // truncated / undecodable body: return what we have
  }

  return body;
}

function upstreamDiagnostics(upstream) {
  // Response headers from the CDN: who answered and why.
  const json = JSON.stringify(upstream.headers);
  return encodeURIComponent(json.length > 3500 ? json.slice(0, 3500) : json);
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

    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === "host" || HOP_BY_HOP_HEADERS.has(lower)) {
        delete headers[key];
      }
    }

    // Log EVERY header we send (secrets redacted).
    console.log("[UPSTREAM HEADERS]", redact(headers));

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
// HEADER PROFILES (tried on 403 / 426)
// ═══════════════════════════════════════════════

function buildAttempts(headers) {
  const attempts = [{ name: "as-given", headers }];

  if (!hasHeader(headers, "accept-encoding")) {
    attempts.push({
      name: "+accept-encoding",
      headers: { ...headers, "Accept-Encoding": "gzip, deflate" },
    });
  }

  const count = Object.keys(headers).length;

  const minimal = pickHeaders(headers, ["referer", "user-agent", "cookie"]);
  if (Object.keys(minimal).length && Object.keys(minimal).length < count) {
    attempts.push({ name: "minimal", headers: minimal });
  }

  const uaOnly = pickHeaders(headers, ["user-agent", "cookie"]);
  if (
    Object.keys(uaOnly).length &&
    Object.keys(uaOnly).length < Object.keys(minimal).length
  ) {
    attempts.push({ name: "ua-only", headers: uaOnly });
  }

  return attempts;
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
    console.log("[PROXY REQUEST HEADERS]", redact(requestHeaders));

    const attempts = buildAttempts(requestHeaders);
    const attemptLog = [];

    let result = null;

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];

      result = await requestUpstream(target, attempt.headers, req);

      const st = result.response.statusCode;

      attemptLog.push(`${attempt.name}:${st}`);

      if (st !== 403 && st !== 426) break;

      if (i < attempts.length - 1) {
        console.log(`[RETRY] ${st} with '${attempt.name}' -> next profile`);
        result.response.resume();
      }
    }

    const upstream = result.response;
    const finalTarget = result.target;
    const status = upstream.statusCode || 500;

    const contentType = String(upstream.headers["content-type"] || "");

    console.log(`[UPSTREAM ${status}] ${finalTarget.href}`);
    console.log("[UPSTREAM RESPONSE HEADERS]", upstream.headers);

    // ─── Errors: pass through, never cache, expose diagnostics ───
    if (status !== 200 && status !== 206 && status !== 304) {
      const body = await readText(upstream, 10000);

      console.log("[UPSTREAM ERROR BODY]", body.slice(0, 500));

      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("X-Upstream-Status", String(status));
      res.setHeader("X-Upstream-Headers", upstreamDiagnostics(upstream));
      res.setHeader("X-Upstream-Attempts", attemptLog.join(","));

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

    res.statusCode = status;

    if (!upstream.headers["cache-control"]) {
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    }

    res.setHeader("X-Upstream-Attempts", attemptLog.join(","));
    res.setHeader("X-Accel-Buffering", "no");

    if (req.method === "HEAD") {
      upstream.resume();
      return res.end();
    }

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
