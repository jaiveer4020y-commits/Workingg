// /api/proxy.js  (v4)
//
// USAGE
//   /api/proxy?url=<encodeURIComponent(streamUrl)>&headers=<headers>
//
// <headers> can be ANY of:
//   - URL-encoded JSON        {"Referer":"...","Origin":"..."}
//   - base64 / base64url JSON (best for cookies and values containing & ; =)
//   - or pipe style inside url:  ?url=<enc("https://cdn/x.mp4?a=1|Referer=<enc>&Origin=<enc>")>
//
// SUPPORTS: MP4 / WebM / MKV (Range seeking), HLS (.m3u8, rewritten),
//           DASH (.mpd, rewritten), TS / M4S segments, VTT, extension-less URLs (sniffed).
//
// DEBUG: add &debug=1 to get a JSON report of exactly which headers were sent
//        upstream and what the CDN answered. Every response also carries
//        X-Proxy-Header-Names (names only) so you can confirm headers arrived.

import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import dns from "node:dns";
import net from "node:net";
import { URL } from "node:url";

export const config = {
  runtime: "nodejs",
};


// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════

const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT = 20000;
const TEXT_LIMIT = 5 * 1024 * 1024;
const SNIFF_LIMIT = 2 * 1024 * 1024;
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === "1"; // tests only

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

const MIME_BY_EXT = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  m4s: "video/mp4",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  ts: "video/mp2t",
  m4a: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  mpd: "application/dash+xml",
  m3u8: "application/vnd.apple.mpegurl",
  vtt: "text/vtt",
};

const MEDIA_EXT = new Set([
  "mp4", "m4v", "m4s", "webm", "mkv", "mov", "ts", "m4a", "aac", "mp3", "ogg",
  "flv", "avi", "mts", "m2ts", "cmfv", "cmfa", "jpg", "jpeg", "png", "webp", "key",
]);


// ═══════════════════════════════════════════════
// SSRF GUARD (blocks localhost / private ranges / cloud metadata)
// ═══════════════════════════════════════════════

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::1" || l === "::") return true;
    if (l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80")) return true;
    if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
    return false;
  }

  return true;
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);

    const list = Array.isArray(address) ? address : [{ address, family }];

    if (!ALLOW_PRIVATE && list.some((a) => isPrivateIp(a.address))) {
      return callback(new Error("Blocked private address"));
    }

    callback(null, address, family);
  });
}


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
      "X-Proxy-Header-Names",
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

// Node throws ERR_INVALID_CHAR on anything outside this set.
function validHeaderValue(value) {
  return !/[^\t\x20-\x7e\x80-\xff]/.test(value);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasHeader(headers, name) {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function deleteHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) delete headers[k];
  }
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

function extOf(target) {
  const m = target.pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

// Validate + normalise + de-duplicate (case-insensitive, later wins).
function sanitizeHeaders(...sources) {
  const map = new Map();

  for (const obj of sources) {
    for (const [rawName, rawValue] of Object.entries(obj || {})) {
      const name = String(rawName).trim();
      const lower = name.toLowerCase();

      if (!name || !validHeaderName(name)) continue;
      if (BLOCKED_HEADERS.has(lower)) continue;
      if (rawValue === null || rawValue === undefined) continue;
      if (typeof rawValue === "object") continue;

      const value = String(rawValue).trim();

      if (/[\r\n]/.test(value)) continue; // header injection guard
      if (!validHeaderValue(value)) continue;

      map.set(lower, [name, value]);
    }
  }

  const out = {};
  for (const [name, value] of map.values()) out[name] = value;
  return out;
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj, null, 2));
}

function sendText(res, status, type, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.setHeader("Cache-Control", cache);
  res.end(body);
}


// ═══════════════════════════════════════════════
// READ RAW QUERY (req.query splits on every "&")
// ═══════════════════════════════════════════════

function readRawParams(req) {
  const full = String(req.url || "");
  const q = full.indexOf("?");

  const out = { raw: "", format: "", headersParam: "", debug: false };

  if (q === -1) return out;

  const qs = full.slice(q + 1);

  const m = qs.match(/(?:^|&)url=/);
  if (!m) return out;

  const before = qs.slice(0, m.index);
  let rest = qs.slice(m.index + m[0].length);

  const assign = (name, val) => {
    if (name === "headers") out.headersParam = val;
    else if (name === "format") out.format = val.toLowerCase();
    else if (name === "debug") out.debug = val !== "" && val !== "0" && val !== "false";
  };

  // Trailing params that belong to the proxy, not to the target URL.
  let changed = true;

  while (changed) {
    changed = false;

    for (const name of ["headers", "format", "debug"]) {
      const mm = rest.match(new RegExp(`&${name}=([^&]*)$`, "i"));

      if (mm) {
        assign(name, mm[1]);
        rest = rest.slice(0, mm.index);
        changed = true;
      }
    }
  }

  // Leading params: ?headers=...&url=...
  for (const part of before.split("&")) {
    if (!part) continue;

    const eq = part.indexOf("=");
    const key = (eq === -1 ? part : part.slice(0, eq)).toLowerCase();
    const val = eq === -1 ? "" : part.slice(eq + 1);

    assign(key, val);
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

  return obj;
}

function parseHeadersParam(param) {
  if (!param) return {};

  const decoded = safeDecode(param).trim();
  let parsed = null;

  // 1) JSON (URL-encoded)
  if (decoded.startsWith("{")) {
    try {
      parsed = JSON.parse(decoded);
    } catch {
      parsed = null;
    }
  }

  // 2) base64 / base64url JSON
  if (!parsed) {
    try {
      const text = Buffer.from(
        decoded.replace(/-/g, "+").replace(/_/g, "/"),
        "base64"
      ).toString("utf8");

      if (text.trim().startsWith("{")) parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  return parsed;
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

  return { target, pipeHeaders: parsePipeHeaders(headerString) };
}

function getTarget(req) {
  const { raw, format, headersParam, debug } = readRawParams(req);

  const { target, pipeHeaders } = parseTargetAndHeaders(normalizeValue(raw));

  return {
    target,
    // pipe first, then the explicit headers= param overrides it
    headers: sanitizeHeaders(pipeHeaders, parseHeadersParam(headersParam)),
    format,
    debug,
  };
}


// ═══════════════════════════════════════════════
// PROXY URL BUILDING (used when rewriting playlists)
// ═══════════════════════════════════════════════

function proxyRoot(req) {
  const proto = String(req.headers["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim();

  const host = req.headers["x-forwarded-host"] || req.headers.host;

  let path = "/api/proxy";
  try {
    path = new URL(req.url, "http://x").pathname || path;
  } catch {
    // keep default
  }

  return `${proto}://${host}${path}`;
}

// Keeps DASH placeholders ($Number$, $Time$, $RepresentationID$ ...) readable so
// the player can substitute them before requesting the segment.
function encodeTarget(absolute) {
  return encodeURIComponent(absolute).replace(
    /%24(?:RepresentationID|Number|Bandwidth|Time|SubNumber)(?:%25\d*d)?%24/g,
    (m) => decodeURIComponent(m)
  );
}

function buildProxyUrl(root, absolute, headers) {
  const clean = sanitizeHeaders(headers);

  const h = Object.keys(clean).length
    ? "headers=" + Buffer.from(JSON.stringify(clean)).toString("base64url") + "&"
    : "";

  // headers FIRST, url LAST (url may contain unencoded $Placeholders$).
  return `${root}?${h}url=${encodeTarget(absolute)}`;
}


// ═══════════════════════════════════════════════
// PLAYLIST REWRITING
// ═══════════════════════════════════════════════

function rewriteHls(text, playlistUrl, root, headers) {
  const wrap = (ref) => {
    if (/^data:/i.test(ref)) return null;
    try {
      return buildProxyUrl(root, new URL(ref, playlistUrl).href, headers);
    } catch {
      return null;
    }
  };

  // Tag attributes: EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, EXT-X-PART, ...
  text = text.replace(/URI="([^"]+)"/g, (match, uri) => {
    const out = wrap(uri);
    return out ? `URI="${out}"` : match;
  });

  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line || line.startsWith("#")) continue;

    const out = wrap(line);
    if (out) lines[i] = out;
  }

  return lines.join("\n");
}

function rewriteMpd(text, manifestUrl, root, headers) {
  const unesc = (s) => s.replace(/&amp;/g, "&");
  const esc = (s) => s.replace(/&/g, "&amp;");
  const wrap = (abs) => esc(buildProxyUrl(root, abs, headers));

  const usesTemplates = /<SegmentTemplate[\s>]|<SegmentList[\s>]/.test(text);

  if (usesTemplates) {
    // Segment URLs are relative to the (first) BaseURL, or the manifest itself.
    let base = manifestUrl;

    const first = text.match(/<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/);
    if (first) {
      try {
        base = new URL(unesc(first[1].trim()), manifestUrl).href;
      } catch {
        // keep manifest url
      }
    }

    text = text.replace(/<BaseURL[^>]*>[\s\S]*?<\/BaseURL>/g, "");

    text = text.replace(
      /\b(initialization|media|index|sourceURL|bitstreamSwitching)="([^"]*)"/g,
      (m, attr, val) => {
        try {
          return `${attr}="${wrap(new URL(unesc(val), base).href)}"`;
        } catch {
          return m;
        }
      }
    );

    return text;
  }

  // On-demand profile: BaseURL IS the media file.
  return text.replace(
    /(<BaseURL[^>]*>)([\s\S]*?)(<\/BaseURL>)/g,
    (m, open, val, close) => {
      try {
        return `${open}${wrap(new URL(unesc(val.trim()), manifestUrl).href)}${close}`;
      } catch {
        return m;
      }
    }
  );
}


// ═══════════════════════════════════════════════
// RESPONSE HELPERS
// ═══════════════════════════════════════════════

function copyHeaders(upstream, res, target) {
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

  // Players refuse to play some CDN responses labelled octet-stream / missing.
  const type = String(upstream.headers["content-type"] || "").toLowerCase();

  if (!type || type.includes("octet-stream")) {
    const guess = MIME_BY_EXT[extOf(target)];
    if (guess) res.setHeader("content-type", guess);
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

async function readBuffer(upstream, limit) {
  const stream = decodedStream(upstream);
  const chunks = [];
  let size = 0;

  try {
    for await (const chunk of stream) {
      chunks.push(chunk);
      size += chunk.length;

      if (size >= limit) {
        stream.destroy();
        upstream.destroy();
        break;
      }
    }
  } catch {
    // truncated / undecodable body: return what we have
  }

  return Buffer.concat(chunks);
}

function upstreamDiagnostics(upstream) {
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

    const hostname = target.hostname.replace(/^\[|\]$/g, "");

    if (!ALLOW_PRIVATE && net.isIP(hostname) && isPrivateIp(hostname)) {
      reject(new Error("Blocked private address"));
      return;
    }

    const isHttps = target.protocol === "https:";
    const transport = isHttps ? https : http;
    const agent = isHttps ? httpsAgent : httpAgent;

    const headers = { ...requestHeaders };

    // Range comes from the player (needed for seeking) and wins over any preset.
    if (req.headers.range) {
      deleteHeader(headers, "range");
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

    console.log("[UPSTREAM HEADERS]", target.host, redact(headers));

    const options = {
      protocol: target.protocol,
      hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
      agent,
      lookup: safeLookup,
      timeout: UPSTREAM_TIMEOUT,
    };

    const upstream = transport.request(options, (response) => {
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();

        let redirected;
        try {
          redirected = new URL(response.headers.location, target);
          if (redirected.protocol !== "http:" && redirected.protocol !== "https:") {
            throw new Error("Bad redirect protocol");
          }
        } catch (err) {
          reject(err);
          return;
        }

        // Never leak cookies / auth to a different host.
        let nextHeaders = requestHeaders;
        if (redirected.host !== target.host) {
          nextHeaders = Object.fromEntries(
            Object.entries(requestHeaders).filter(
              ([k]) => !SECRET_HEADERS.has(k.toLowerCase())
            )
          );
        }

        requestUpstream(redirected, nextHeaders, req, redirects + 1)
          .then(resolve)
          .catch(reject);

        return;
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
    res.statusCode = 204;
    return res.end();
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD, OPTIONS");
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  let parsed;

  try {
    parsed = getTarget(req);
  } catch (error) {
    return sendJson(res, 400, { error: error?.message || "Bad request" });
  }

  const { target, headers: requestHeaders, format, debug } = parsed;

  try {
    console.log(`[PROXY] ${req.method} ${target.href}`);
    console.log("[PROXY REQUEST HEADERS]", redact(requestHeaders));

    res.setHeader("X-Proxy-Header-Names", Object.keys(requestHeaders).join(","));

    const attempts = buildAttempts(requestHeaders);
    const attemptLog = [];

    let result = null;

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];

      result = await requestUpstream(target, attempt.headers, req);

      const st = result.response.statusCode;

      attemptLog.push({
        name: attempt.name,
        status: st,
        sent: Object.keys(attempt.headers),
        responseHeaders: result.response.headers,
      });

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
    const ct = contentType.toLowerCase();
    const attemptsText = attemptLog.map((a) => `${a.name}:${a.status}`).join(",");

    console.log(`[UPSTREAM ${status}] ${finalTarget.href}`);

    // ─── Debug report ───
    if (debug) {
      upstream.resume();

      return sendJson(res, 200, {
        target: target.href,
        finalTarget: finalTarget.href,
        headersReceivedByProxy: redact(requestHeaders),
        attempts: attemptLog.map((a) => ({
          profile: a.name,
          status: a.status,
          headerNamesSent: a.sent,
          cdnResponseHeaders: a.responseHeaders,
        })),
      });
    }

    // ─── Errors: pass through, never cache, expose diagnostics ───
    if (status !== 200 && status !== 206 && status !== 304) {
      const body = (await readBuffer(upstream, 10000)).toString("utf8");

      console.log("[UPSTREAM ERROR BODY]", body.slice(0, 500));

      res.setHeader("X-Upstream-Status", String(status));
      res.setHeader("X-Upstream-Headers", upstreamDiagnostics(upstream));
      res.setHeader("X-Upstream-Attempts", attemptsText);

      return sendText(res, status, "text/plain; charset=utf-8", body, "no-store");
    }

    // ─── What kind of body is this? ───
    const ext = extOf(finalTarget);
    const declaredLen = Number(upstream.headers["content-length"] || 0);

    let kind = "";
    if (ext === "m3u8" || ext === "m3u" || ct.includes("mpegurl")) kind = "hls";
    else if (ext === "mpd" || ct.includes("dash+xml")) kind = "dash";
    else if (ext === "vtt" || ct.includes("text/vtt")) kind = "vtt";

    const knownMedia = /^(video|audio|image)\//.test(ct) || MEDIA_EXT.has(ext);
    const textish = !ct || /^text\/|json|xml/.test(ct);
    const smallBinary =
      ct.includes("octet-stream") && declaredLen > 0 && declaredLen <= SNIFF_LIMIT;

    const sniff =
      !kind &&
      req.method === "GET" &&
      status === 200 &&
      !knownMedia &&
      (textish || smallBinary);

    if (kind || sniff) {
      const buf = await readBuffer(upstream, TEXT_LIMIT);
      const text = buf.toString("utf8");

      if (sniff) {
        if (text.trimStart().startsWith("#EXTM3U")) kind = "hls";
        else if (/<MPD[\s>]/.test(text.slice(0, 4096))) kind = "dash";
        else if (text.startsWith("WEBVTT")) kind = "vtt";
      }

      const root = proxyRoot(req);

      if (kind === "hls") {
        const out = rewriteHls(text, finalTarget.href, root, requestHeaders);
        const cache = "public, max-age=2, s-maxage=2, stale-while-revalidate=3";

        if (format === "json") {
          return sendText(res, 200, "application/json", JSON.stringify({ content: out }), cache);
        }

        return sendText(res, 200, "application/vnd.apple.mpegurl", out, cache);
      }

      if (kind === "dash") {
        const out = rewriteMpd(text, finalTarget.href, root, requestHeaders);
        return sendText(res, 200, "application/dash+xml", out, "public, max-age=2, s-maxage=2");
      }

      if (kind === "vtt") {
        return sendText(res, status, "text/vtt; charset=utf-8", text, "public, max-age=300, s-maxage=300");
      }

      // Sniffed, but just an ordinary small file: send the decoded bytes as-is.
      res.statusCode = status;
      if (contentType) res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
      res.setHeader("Content-Length", String(buf.length));
      return res.end(buf);
    }

    // ─── Media (MP4 / WebM / MKV / M4S / TS / AAC / KEY ...) ───
    copyHeaders(upstream, res, finalTarget);

    res.statusCode = status;

    if (!upstream.headers["cache-control"]) {
      res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    }

    res.setHeader("X-Upstream-Attempts", attemptsText);
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
      return sendJson(res, 502, { error: error?.message || "Bad gateway" });
    }

    try {
      res.destroy(error);
    } catch {
      // ignore
    }
  }
}
