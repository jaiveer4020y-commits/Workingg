// /api/proxy.js  (v6.1 — Vercel Edge Runtime, formatted master playlist output)

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
const PROBE_BYTES = 128 * 1024;      
const MASTER_BANDWIDTH = 2500000;    

const LANG_NAMES = {
  hin: "Hindi", tam: "Tamil", tel: "Telugu", kan: "Kannada", mal: "Malayalam",
  eng: "English", ben: "Bengali", mar: "Marathi", guj: "Gujarati", pan: "Punjabi",
  urd: "Urdu", spa: "Spanish", fra: "French", fre: "French", deu: "German",
  ger: "German", jpn: "Japanese", kor: "Korean", zho: "Chinese", chi: "Chinese",
  rus: "Russian", ara: "Arabic", por: "Portuguese", ita: "Italian",
};

const LANG_CODES_2 = {
  hin: "hi", eng: "en", tam: "ta", tel: "te", kan: "kn", mal: "ml",
  ben: "bn", mar: "mr", guj: "gu", pan: "pa", urd: "ur", spa: "es",
  fra: "fr", fre: "fr", deu: "de", ger: "de", jpn: "ja", kor: "ko",
  zho: "zh", chi: "zh", rus: "ru", ara: "ar", por: "pt", ita: "it",
};

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

const BLOCKED_HEADERS = new Set([
  "connection", "proxy-connection", "keep-alive", "transfer-encoding",
  "upgrade", "te", "trailer", "proxy-authenticate", "proxy-authorization",
  "host", "content-length",
]);

const SECRET_HEADERS = new Set(["cookie", "authorization"]);

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

function validHeaderName(name) { return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name); }
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
// TS PARSING & DEMUXING
// ═══════════════════════════════════════════════

const TS = 188;
const VIDEO_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x24]);
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);

function crc32mpeg(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc ^ (bytes[i] << 24)) >>> 0;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
  }
  return crc >>> 0;
}

function findSync(b) {
  for (let i = 0; i + TS * 2 < b.length; i++) {
    if (b[i] === 0x47 && b[i + TS] === 0x47 && b[i + 2 * TS] === 0x47) return i;
  }
  return -1;
}

function tsPayloadOffset(pkt) {
  const afc = (pkt[3] >> 4) & 3;
  if (afc === 0 || afc === 2) return -1;
  let o = 4;
  if (afc === 3) o += 1 + pkt[4];
  return o >= TS ? -1 : o;
}

function sectionStart(pkt) {
  const o = tsPayloadOffset(pkt);
  if (o < 0) return -1;
  const s = o + 1 + pkt[o];
  return s < TS - 3 ? s : -1;
}

function readPat(pkt) {
  const s = sectionStart(pkt);
  if (s < 0 || pkt[s] !== 0x00) return -1;
  const secLen = ((pkt[s + 1] & 0x0f) << 8) | pkt[s + 2];
  const end = Math.min(s + 3 + secLen - 4, TS);
  for (let i = s + 8; i + 4 <= end; i += 4) {
    if (((pkt[i] << 8) | pkt[i + 1]) !== 0) return ((pkt[i + 2] & 0x1f) << 8) | pkt[i + 3];
  }
  return -1;
}

function readPmt(pkt) {
  const s = sectionStart(pkt);
  if (s < 0 || pkt[s] !== 0x02) return null;
  const secLen = ((pkt[s + 1] & 0x0f) << 8) | pkt[s + 2];
  if (s + 3 + secLen > TS) return null;

  const end = s + 3 + secLen - 4;
  const pcrPid = ((pkt[s + 8] & 0x1f) << 8) | pkt[s + 9];
  const progLen = ((pkt[s + 10] & 0x0f) << 8) | pkt[s + 11];
  const progInfo = pkt.slice(s + 12, s + 12 + progLen);

  const streams = [];
  let i = s + 12 + progLen;
  while (i + 5 <= end) {
    const type = pkt[i];
    const pid = ((pkt[i + 1] & 0x1f) << 8) | pkt[i + 2];
    const esLen = ((pkt[i + 3] & 0x0f) << 8) | pkt[i + 4];
    const desc = pkt.slice(i + 5, i + 5 + esLen);
    
    let lang = "";
    for (let d = 0; d + 2 <= desc.length; ) {
      if (desc[d] === 0x0a && desc[d + 1] >= 3 && d + 5 <= desc.length) {
        lang = String.fromCharCode(desc[d + 2], desc[d + 3], desc[d + 4]).toLowerCase();
      }
      d += 2 + desc[d + 1];
    }

    const kind = VIDEO_TYPES.has(type) ? "video" : AUDIO_TYPES.has(type) ? "audio" : "other";
    streams.push({ type, pid, desc, lang, kind });
    i += 5 + esLen;
  }

  return { pcrPid, progInfo, streams, secHead: pkt.slice(s + 3, s + 8) };
}

function parsePsi(bytes) {
  const start = findSync(bytes);
  if (start < 0) return null;
  let pmtPid = -1;
  for (let p = start; p + TS <= bytes.length; p += TS) {
    const pkt = bytes.subarray(p, p + TS);
    if (pkt[0] !== 0x47) break;
    if (!(pkt[1] & 0x40)) continue;
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];

    if (pid === 0 && pmtPid < 0) pmtPid = readPat(pkt);
    else if (pmtPid >= 0 && pid === pmtPid) {
      const info = readPmt(pkt);
      if (info) return { ...info, pmtPid };
    }
  }
  return null;
}

function makeTsFilter(track) {
  let carry = new Uint8Array(0);
  let started = false;
  let passthrough = false;
  let pmtPid = -1;
  let info = null;
  let keep = null;

  const handle = (pkt) => {
    const pid = ((pkt[1] & 0x1f) << 8) | pkt[2];
    const pusi = (pkt[1] & 0x40) !== 0;

    if (pid === 0) {
      if (pmtPid < 0 && pusi) pmtPid = readPat(pkt);
      return pkt;
    }

    if (pmtPid >= 0 && pid === pmtPid) {
      if (!pusi) return info ? null : pkt;
      const parsed = readPmt(pkt);
      if (!parsed) return pkt;
      info = parsed;
      
      const videos = info.streams.filter((s) => s.kind === "video");
      const audios = info.streams.filter((s) => s.kind === "audio");
      keep = track === "v" ? new Set(videos.map((s) => s.pid)) : new Set([audios[Number(track.slice(1))]?.pid].filter(Boolean));

      const first = keep.values().next();
      const pcr = keep.has(info.pcrPid) ? info.pcrPid : first.done ? 0x1fff : first.value;

      // Build PMT
      const body = [];
      for (const st of info.streams) {
        if (!keep.has(st.pid)) continue;
        body.push(st.type, 0xe0 | (st.pid >> 8), st.pid & 0xff, 0xf0 | (st.desc.length >> 8), st.desc.length & 0xff, ...st.desc);
      }

      const sec = [0x02, 0, 0, ...info.secHead, 0xe0 | (pcr >> 8), pcr & 0xff, 0xf0 | (info.progInfo.length >> 8), info.progInfo.length & 0xff, ...info.progInfo, ...body];
      const secLen = sec.length - 3 + 4;
      sec[1] = 0xb0 | (secLen >> 8);
      sec[2] = secLen & 0xff;

      const crc = crc32mpeg(sec);
      sec.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);

      if (5 + sec.length > TS) return pkt;

      const out = new Uint8Array(TS).fill(0xff);
      out[0] = 0x47; out[1] = pkt[1]; out[2] = pkt[2]; out[3] = (pkt[3] & 0x0f) | 0x10; out[4] = 0x00;
      out.set(sec, 5);
      return out;
    }

    return keep && keep.has(pid) ? pkt : null;
  };

  return new TransformStream({
    transform(chunk, controller) {
      const buf = carry.length ? new Uint8Array([...carry, ...chunk]) : chunk;
      carry = new Uint8Array(0);

      if (!started) {
        if (!buf.length) return;
        started = true;
        passthrough = buf[0] !== 0x47;
      }

      if (passthrough) { controller.enqueue(buf); return; }

      const out = new Uint8Array(buf.length);
      let w = 0, p = 0;
      while (p + TS <= buf.length) {
        if (buf[p] !== 0x47) { p++; continue; }
        const r = handle(buf.subarray(p, p + TS));
        if (r) { out.set(r, w); w += TS; }
        p += TS;
      }
      carry = buf.slice(p);
      if (w) controller.enqueue(out.subarray(0, w));
    },
  });
}

// ═══════════════════════════════════════════════
// MASTER PLAYLIST GENERATION
// ═══════════════════════════════════════════════

async function probeTracks(playlistText, playlistUrl, requestHeaders) {
  const first = playlistText.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  if (!first) return { audio: [], video: [] };

  const headers = new Headers();
  for (const [k, v] of Object.entries(requestHeaders)) headers.set(k, v);
  headers.set("Range", `bytes=0-${PROBE_BYTES - 1}`);
  if (!headers.has("user-agent")) headers.set("User-Agent", DEFAULT_UA);

  const res = await fetch(new URL(first, playlistUrl).href, { headers });
  if (res.status !== 200 && res.status !== 206) return { audio: [], video: [] };

  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= PROBE_BYTES) { try { await reader.cancel(); } catch {} break; }
  }

  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }

  const psi = parsePsi(bytes);
  if (!psi) return { audio: [], video: [] };

  return {
    audio: psi.streams.filter((s) => s.kind === "audio"),
    video: psi.streams.filter((s) => s.kind === "video"),
  };
}

function buildMaster(root, playlistUrl, headers, audio) {
  const lines = ["#EXTM3U"];
  const used = new Set();

  audio.forEach((t, i) => {
    const lang3 = t.lang || "und";
    const lang2 = LANG_CODES_2[lang3] || lang3.slice(0, 2);
    
    let name = LANG_NAMES[lang3] || (t.lang ? t.lang.toUpperCase() : `Audio ${i + 1}`);
    if (used.has(name)) name = `${name} ${i + 1}`;
    used.add(name);

    const uri = buildProxyUrl(root, playlistUrl, headers, `a${i}`);
    const defaultFlag = i === 0 ? "YES" : "NO";

    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}",` +
      `DEFAULT=${defaultFlag},AUTOSELECT=YES,LANGUAGE="${lang2}",URI="${uri}"`
    );
  });

  lines.push("");
  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${MASTER_BANDWIDTH},AUDIO="audio"`);
  lines.push(buildProxyUrl(root, playlistUrl, headers, "v"));

  return lines.join("\n") + "\n";
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

      if (mode === "master" && !/#EXT-X-STREAM-INF/.test(text)) {
        const tracks = await probeTracks(text, target.href, requestHeaders);
        if (tracks.audio.length >= 2) {
          return textResponse(
            200,
            format === "text" ? "text/plain; charset=utf-8" : "application/vnd.apple.mpegurl",
            buildMaster(root, target.href, requestHeaders, tracks.audio),
            "no-store"
          );
        }
      }

      const out = rewriteHls(text, target.href, root, requestHeaders, track);
      return textResponse(
        200,
        format === "text" ? "text/plain; charset=utf-8" : "application/vnd.apple.mpegurl",
        out,
        "public, max-age=2, s-maxage=2"
      );
    }

    if (track && req.method === "GET" && status === 200 && upstream.body) {
      return new Response(upstream.body.pipeThrough(makeTsFilter(track)), {
        status: 200,
        headers: { ...corsHeaders(), "Content-Type": "video/mp2t", "Cache-Control": "public, max-age=3600" },
      });
    }

    const outHeaders = new Headers(corsHeaders());
    upstream.headers.forEach((v, k) => { if (!BLOCKED_HEADERS.has(k)) outHeaders.set(k, v); });
    return new Response(upstream.body, { status, headers: outHeaders });
  } catch (error) {
    return jsonResponse(502, { error: error?.message || "Bad gateway" });
  }
}
