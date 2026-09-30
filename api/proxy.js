// /api/proxy.js  (v5 — Vercel Edge Runtime)
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

export const config = {
  runtime: "edge",
};


// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════

const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT = 25000;
const TEXT_LIMIT = 5 * 1024 * 1024;
const SNIFF_LIMIT = 2 * 1024 * 1024;

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
// CORS
// ═══════════════════════════════════════════════

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": [
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
    ].join(", "),
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
}


// ═══════════════════════════════════════════════
// SMALL HELPERS
// ═══════════════════════════════════════════════

function validHeaderName(name) {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

function validHeaderValue(value) {
  return !/[\r\n]/.test(value);
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
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? "[PRESENT]" : v;
  }
  return out;
}

function extOf(target) {
  const m = target.pathname.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

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

      if (!validHeaderValue(value)) continue;

      map.set(lower, [name, value]);
    }
  }

  const out = {};
  for (const [name, value] of map.values()) out[name] = value;
  return out;
}

function jsonResponse(status, obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function textResponse(status, type, body, cache) {
  return new Response(body, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": type,
      "Cache-Control": cache,
    },
  });
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s + pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}


// ═══════════════════════════════════════════════
// QUERY PARSING
// ═══════════════════════════════════════════════

function readRawParams(rawUrl) {
  const out = { raw: "", format: "", headersParam: "", debug: false };

  const q = rawUrl.indexOf("?");
  if (q === -1) return out;

  const qs = rawUrl.slice(q + 1);
  const m = qs.match(/(?:^|&)url=/);
  if (!m) return out;

  const before = qs.slice(0, m.index);
  let rest = qs.slice(m.index + m[0].length);

  const assign = (name, val) => {
    if (name === "headers") out.headersParam = val;
    else if (name === "format") out.format = val.toLowerCase();
    else if (name === "debug") out.debug = val !== "" && val !== "0" && val !== "false";
  };

  // Trailing params belong to proxy, not the target URL.
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

  for (let i = 0; i < 2 && /^https?%3A/i.test(value); i++) {
    value = safeDecode(value);
  }

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

  if (decoded.startsWith("{")) {
    try {
      parsed = JSON.parse(decoded);
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    try {
      const text = b64urlDecode(decoded);
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
  if (!value) throw new Error("Missing url parameter");

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

function getTarget(reqUrl) {
  const { raw, format, headersParam, debug } = readRawParams(reqUrl);

  const { target, pipeHeaders } = parseTargetAndHeaders(normalizeValue(raw));

  return {
    target,
    headers: sanitizeHeaders(pipeHeaders, parseHeadersParam(headersParam)),
    format,
    debug,
  };
}


// ═══════════════════════════════════════════════
// PROXY URL BUILDING (used when rewriting playlists)
// ═══════════════════════════════════════════════

function proxyRoot(requestUrl) {
  const u = new URL(requestUrl);
  const proto = u.protocol.replace(":", "") || "https";
  const host = u.host;
  const path = u.pathname || "/api/proxy";
  return `${proto}://${host}${path}`;
}

function encodeTarget(absolute) {
  return encodeURIComponent(absolute).replace(
    /%24(?:RepresentationID|Number|Bandwidth|Time|SubNumber)(?:%25\d*d)?%24/g,
    (m) => decodeURIComponent(m)
  );
}

function buildProxyUrl(root, absolute, headers) {
  const clean = sanitizeHeaders(headers);

  const h = Object.keys(clean).length
    ? "headers=" + b64urlEncode(JSON.stringify(clean)) + "&"
    : "";

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

function copyHeaders(upstream, target) {
  const out = new Headers();

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
    const value = upstream.headers.get(name);
    if (value !== null) out.set(name, value);
  }

  const type = String(upstream.headers.get("content-type") || "").toLowerCase();

  if (!type || type.includes("octet-stream")) {
    const guess = MIME_BY_EXT[extOf(target)];
    if (guess) out.set("content-type", guess);
  }

  return out;
}

async function readCapped(response, limit) {
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= limit) {
      try { await reader.cancel(); } catch {}
      break;
    }
  }

  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  return bytes;
}

function upstreamDiagnostics(upstream) {
  const obj = {};
  upstream.headers.forEach((v, k) => {
    obj[k] = v;
  });
  const json = JSON.stringify(obj);
  return encodeURIComponent(json.length > 3500 ? json.slice(0, 3500) : json);
}


// ═══════════════════════════════════════════════
// REQUEST UPSTREAM (Edge-compatible)
// ═══════════════════════════════════════════════

function buildUpstreamHeaders(requestHeaders, req) {
  const headers = new Headers();

  for (const [k, v] of Object.entries(requestHeaders)) {
    if (BLOCKED_HEADERS.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }

  // Player's Range wins (needed for seeking)
  const incomingRange = req.headers.get("range");
  if (incomingRange) {
    headers.delete("range");
    headers.set("Range", incomingRange);
  }

  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && !headers.has("if-none-match")) {
    headers.set("If-None-Match", ifNoneMatch);
  }

  const ifModifiedSince = req.headers.get("if-modified-since");
  if (ifModifiedSince && !headers.has("if-modified-since")) {
    headers.set("If-Modified-Since", ifModifiedSince);
  }

  if (!headers.has("user-agent")) headers.set("User-Agent", DEFAULT_UA);
  if (!headers.has("accept")) headers.set("Accept", "*/*");
  // Do NOT default Accept-Encoding: Edge runtime auto-decompresses and strips
  // Content-Encoding, which confuses range/streaming. Let the caller decide.

  return headers;
}

async function fetchUpstream(target, headers, req, redirects = 0) {
  if (redirects > MAX_REDIRECTS) throw new Error("Too many redirects");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT);

  let response;
  try {
    response = await fetch(target.href, {
      method: req.method,
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (
    response.status >= 300 &&
    response.status < 400 &&
    response.headers.get("location")
  ) {
    const location = response.headers.get("location");
    try { response.body?.cancel(); } catch {}

    let redirected;
    try {
      redirected = new URL(location, target);
    } catch (err) {
      throw new Error("Bad redirect target");
    }
    if (redirected.protocol !== "http:" && redirected.protocol !== "https:") {
      throw new Error("Bad redirect protocol");
    }

    // Never forward secrets to a different host.
    let nextHeaders = headers;
    if (redirected.host !== target.host) {
      nextHeaders = new Headers();
      headers.forEach((v, k) => {
        if (!SECRET_HEADERS.has(k.toLowerCase())) nextHeaders.set(k, v);
      });
    }

    return fetchUpstream(redirected, nextHeaders, req, redirects + 1);
  }

  return { response, target };
}


// ═══════════════════════════════════════════════
// HEADER PROFILES (retry on 403 / 426 / 427)
// ═══════════════════════════════════════════════

function buildAttempts(headers) {
  const attempts = [{ name: "as-given", headers }];

  if (!hasHeader(headers, "accept-encoding")) {
    const next = { ...headers, "Accept-Encoding": "gzip, deflate" };
    attempts.push({ name: "+accept-encoding", headers: next });
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
// MAIN HANDLER (Edge)
// ═══════════════════════════════════════════════

export default async function handler(req) {
  const reqUrl = req.url;

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      {
        status: 405,
        headers: { ...corsHeaders(), "Content-Type": "application/json" },
      }
    );
  }

  let parsed;
  try {
    parsed = getTarget(reqUrl);
  } catch (error) {
    return jsonResponse(400, { error: error?.message || "Bad request" });
  }

  const { target, headers: requestHeaders, format, debug } = parsed;

  try {
    console.log(`[PROXY] ${req.method} ${target.href}`);
    console.log("[PROXY REQUEST HEADERS]", redact(requestHeaders));

    const attempts = buildAttempts(requestHeaders);
    const attemptLog = [];

    let result = null;

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      const upstreamHeaders = buildUpstreamHeaders(attempt.headers, req);

      result = await fetchUpstream(target, upstreamHeaders, req);

      const st = result.response.status;

      attemptLog.push({
        name: attempt.name,
        status: st,
        sent: [...upstreamHeaders.keys()],
      });

      // Retry on CDN anti-bot statuses
      if (st !== 403 && st !== 426 && st !== 427) break;

      if (i < attempts.length - 1) {
        try { result.response.body?.cancel(); } catch {}
      }
    }

    const upstream = result.response;
    const finalTarget = result.target;
    const status = upstream.status;
    const ct = String(upstream.headers.get("content-type") || "").toLowerCase();
    const attemptsText = attemptLog.map((a) => `${a.name}:${a.status}`).join(",");

    console.log(`[UPSTREAM ${status}] ${finalTarget.href}`);

    // ─── Debug report ───
    if (debug) {
      try { upstream.body?.cancel(); } catch {}

      const diagnosticHeaders = {};
      upstream.headers.forEach((v, k) => {
        diagnosticHeaders[k] = v;
      });

      return jsonResponse(200, {
        target: target.href,
        finalTarget: finalTarget.href,
        headersReceivedByProxy: redact(requestHeaders),
        attempts: attemptLog.map((a, idx) => ({
          profile: a.name,
          status: a.status,
          headerNamesSent: a.sent,
          cdnResponseHeaders: idx === attemptLog.length - 1 ? diagnosticHeaders : {},
        })),
      });
    }

    // ─── Errors: pass through, never cache, expose diagnostics ───
    if (status !== 200 && status !== 206 && status !== 304) {
      const bodyBytes = await readCapped(upstream, 10000);
      const body = new TextDecoder("utf-8").decode(bodyBytes);

      console.log("[UPSTREAM ERROR BODY]", body.slice(0, 500));

      const outHeaders = {
        ...corsHeaders(),
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Upstream-Status": String(status),
        "X-Upstream-Headers": upstreamDiagnostics(upstream),
        "X-Upstream-Attempts": attemptsText,
        "X-Proxy-Header-Names": Object.keys(requestHeaders).join(","),
      };

      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) outHeaders["Retry-After"] = retryAfter;

      return new Response(body, { status, headers: outHeaders });
    }

    // ─── What kind of body is this? ───
    const ext = extOf(finalTarget);
    const declaredLen = Number(upstream.headers.get("content-length") || 0);

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
      const buf = await readCapped(upstream, TEXT_LIMIT);
      const text = new TextDecoder("utf-8").decode(buf);

      if (sniff) {
        if (text.trimStart().startsWith("#EXTM3U")) kind = "hls";
        else if (/<MPD[\s>]/.test(text.slice(0, 4096))) kind = "dash";
        else if (text.startsWith("WEBVTT")) kind = "vtt";
      }

      const root = proxyRoot(reqUrl);

      if (kind === "hls") {
        const out = rewriteHls(text, finalTarget.href, root, requestHeaders);
        const cache = "public, max-age=2, s-maxage=2, stale-while-revalidate=3";

        if (format === "json") {
          return textResponse(
            200,
            "application/json",
            JSON.stringify({ content: out }),
            cache
          );
        }

        return textResponse(200, "application/vnd.apple.mpegurl", out, cache);
      }

      if (kind === "dash") {
        const out = rewriteMpd(text, finalTarget.href, root, requestHeaders);
        return textResponse(
          200,
          "application/dash+xml",
          out,
          "public, max-age=2, s-maxage=2"
        );
      }

      if (kind === "vtt") {
        return textResponse(
          status,
          "text/vtt; charset=utf-8",
          text,
          "public, max-age=300, s-maxage=300"
        );
      }

      // Sniffed, but ordinary small file
      return new Response(buf, {
        status,
        headers: {
          ...corsHeaders(),
          ...(ct ? { "Content-Type": ct } : {}),
          "Cache-Control": "public, max-age=300, s-maxage=300",
          "Content-Length": String(buf.length),
        },
      });
    }

    // ─── Media (MP4 / WebM / MKV / M4S / TS / AAC / KEY ...) ───
    const outHeaders = new Headers(corsHeaders());
    copyHeaders(upstream, finalTarget).forEach((v, k) => {
      outHeaders.set(k, v);
    });

    if (!outHeaders.has("cache-control")) {
      outHeaders.set("Cache-Control", "public, max-age=3600, s-maxage=3600");
    }

    outHeaders.set("X-Upstream-Attempts", attemptsText);
    outHeaders.set("X-Proxy-Header-Names", Object.keys(requestHeaders).join(","));
    outHeaders.set("X-Accel-Buffering", "no");

    if (req.method === "HEAD") {
      try { upstream.body?.cancel(); } catch {}
      return new Response(null, { status, headers: outHeaders });
    }

    // Stream straight through
    return new Response(upstream.body, { status, headers: outHeaders });
  } catch (error) {
    console.error("[PROXY ERROR]", error);
    return jsonResponse(502, { error: error?.message || "Bad gateway" });
  }
}
