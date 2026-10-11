// /api/proxy.js (Vercel Edge Runtime - Media & Range Request Optimized)

export const config = {
  runtime: "edge",
};

// ═══════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════

const DEFAULT_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

// Preserve range response headers for video players while filtering restricted hop-by-hop headers
const BLOCKED_HEADERS = new Set([
  "connection", "proxy-connection", "keep-alive", "transfer-encoding",
  "upgrade", "te", "trailer", "proxy-authenticate", "proxy-authorization",
  "host",
]);

const MIME_BY_EXT = {
  mp4: "video/mp4", m4v: "video/mp4", m4s: "video/mp4", webm: "video/webm",
  mkv: "video/x-matroska", mov: "video/quicktime", ts: "video/mp2t",
  m4a: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", ogg: "audio/ogg",
  mpd: "application/dash+xml", m3u8: "application/vnd.apple.mpegurl", vtt: "text/vtt",
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
      "Content-Length", "Content-Range", "Accept-Ranges", "Content-Type",
      "ETag", "Last-Modified", "Content-Disposition", "Cache-Control",
      "X-Upstream-Status", "X-Upstream-Attempts", "X-Proxy-Header-Names", "X-Proxy-Track",
    ].join(", "),
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
}

// ═══════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════

function validHeaderName(name) { return /^[!#$\%&'*+\-.^_`\vert{}~0-9A-Za-z]+$/.test(name); }
function validHeaderValue(value) { return !/[\r\n]/.test(value); }
function safeDecode(value) { try { return decodeURIComponent(value); } catch { return value; } }

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
      if (!name || !validHeaderName(name) || BLOCKED_HEADERS.has(lower)) continue;
      if (rawValue === null || rawValue === undefined || typeof rawValue === "object") continue;
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
    headers: { ...corsHeaders(), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function textResponse(status, type, body, cache) {
  return new Response(body, {
    status,
    headers: { ...corsHeaders(), "Content-Type": type, "Cache-Control": cache },
  });
}

function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(s + pad);
  return new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function readRawParams(rawUrl) {
  const out = { raw: "", format: "", headersParam: "", debug: false, track: "", mode: "" };
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
    else if (name === "track") out.track = val.toLowerCase();
    else if (name === "mode") out.mode = val.toLowerCase();
    else if (name === "debug") out.debug = val !== "" && val !== "0" && val !== "false";
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const name of ["headers", "format", "debug", "track", "mode"]) {
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
    assign(eq === -1 ? part : part.slice(0, eq), eq === -1 ? "" : part.slice(eq + 1));
  }

  out.raw = rest;
  return out;
}

function parseTargetAndHeaders(value) {
  if (!value) throw new Error("Missing url parameter");
  const pipe = value.indexOf("|");
  let targetString = pipe === -1 ? value : value.slice(0, pipe);
  const headerString = pipe === -1 ? "" : value.slice(pipe + 1);

  targetString = targetString.trim();
  if (!/^https?:\/\//i.test(targetString)) targetString = safeDecode(targetString);

  const target = new URL(targetString);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Only HTTP/HTTPS URLs are allowed");
  }

  const pipeHeaders = {};
  for (const part of headerString.split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq !== -1) pipeHeaders[safeDecode(part.slice(0, eq)).trim()] = safeDecode(part.slice(eq + 1));
  }

  return { target, pipeHeaders };
}

function getTarget(reqUrl) {
  const { raw, format, headersParam, debug, track, mode } = readRawParams(reqUrl);
  let value = String(raw || "").trim();
  for (let i = 0; i < 2 && /^https?%3A/i.test(value); i++) value = safeDecode(value);

  const { target, pipeHeaders } = parseTargetAndHeaders(value);
  let parsedHeaders = {};
  if (headersParam) {
    const dec = safeDecode(headersParam).trim();
    try {
      parsedHeaders = JSON.parse(dec.startsWith("{") ? dec : b64urlDecode(dec));
    } catch {}
  }

  return {
    target,
    headers: sanitizeHeaders(pipeHeaders, parsedHeaders),
    format,
    debug,
    track: /^(v|a\d{1,2})$/.test(track) ? track : "",
    mode,
  };
}

function proxyRoot(requestUrl) {
  const u = new URL(requestUrl);
  return `${u.protocol}//${u.host}${u.pathname || "/api/proxy"}`;
}

function buildProxyUrl(root, absolute, headers, track) {
  const clean = sanitizeHeaders(headers);
  const h = Object.keys(clean).length ? "headers=" + b64urlEncode(JSON.stringify(clean)) + "&" : "";
  const t = track ? `track=${track}&` : "";
  return `${root}?${h}${t}url=${encodeURIComponent(absolute)}`;
}

function rewriteHls(text, playlistUrl, root, headers, track) {
  const wrap = (ref, withTrack) => {
    if (/^data:/i.test(ref)) return null;
    try {
      return buildProxyUrl(root, new URL(ref, playlistUrl).href, headers, withTrack ? track : "");
    } catch {
      return null;
    }
  };

  text = text.replace(/URI="([^"]+)"/g, (match, uri) => {
    const out = wrap(uri, false);
    return out ? `URI="${out}"` : match;
  });

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const out = wrap(line, true);
    if (out) lines[i] = out;
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }

  let parsed;
  try { parsed = getTarget(req.url); } catch (e) { return jsonResponse(400, { error: e.message }); }

  const { target, headers: requestHeaders, format, debug, track, mode } = parsed;

  try {
    const upstreamHeaders = new Headers();
    for (const [k, v] of Object.entries(requestHeaders)) upstreamHeaders.set(k, v);
    if (!upstreamHeaders.has("user-agent")) upstreamHeaders.set("User-Agent", DEFAULT_UA);

    // Forward Range and If-Range headers from client request
    const clientRange = req.headers.get("range");
    if (clientRange && !upstreamHeaders.has("range")) {
      upstreamHeaders.set("Range", clientRange);
    }
    const clientIfRange = req.headers.get("if-range");
    if (clientIfRange && !upstreamHeaders.has("if-range")) {
      upstreamHeaders.set("If-Range", clientIfRange);
    }

    const upstream = await fetch(target.href, { method: req.method, headers: upstreamHeaders });
    const status = upstream.status;

    if (status !== 200 && status !== 206) {
      return new Response(await upstream.text(), { status, headers: corsHeaders() });
    }

    const ext = extOf(target);
    const ct = String(upstream.headers.get("content-type") || "").toLowerCase();
    const isHls = ext === "m3u8" || ext === "m3u" || ct.includes("mpegurl");

    if (isHls) {
      const text = await upstream.text();
      const root = proxyRoot(req.url);

      const out = rewriteHls(text, target.href, root, requestHeaders, track);
      return textResponse(
        200,
        format === "text" ? "text/plain; charset=utf-8" : "application/vnd.apple.mpegurl",
        out,
        "public, max-age=2, s-maxage=2"
      );
    }

    const outHeaders = new Headers(corsHeaders());
    upstream.headers.forEach((v, k) => { if (!BLOCKED_HEADERS.has(k)) outHeaders.set(k, v); });

    // Force inline rendering for media files so browsers do not trigger file downloads
    if (ext && MEDIA_EXT.has(ext)) {
      outHeaders.set("Content-Disposition", "inline");
      if (!outHeaders.has("Content-Type") && MIME_BY_EXT[ext]) {
        outHeaders.set("Content-Type", MIME_BY_EXT[ext]);
      }
    } else if (ct.startsWith("video/") || ct.startsWith("audio/")) {
      outHeaders.set("Content-Disposition", "inline");
    }

    // Indicate byte-seeking support to browser media engine
    if (!outHeaders.has("Accept-Ranges")) {
      outHeaders.set("Accept-Ranges", "bytes");
    }

    return new Response(upstream.body, { status, headers: outHeaders });
  } catch (error) {
    return jsonResponse(502, { error: error?.message || "Bad gateway" });
  }
}
