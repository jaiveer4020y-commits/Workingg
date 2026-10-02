// /api/proxy.js  (v6 — Vercel Edge Runtime, multi-audio support)
//
// USAGE
//   /api/proxy?url=<encodeURIComponent(streamUrl)>&headers=<headers>
//
// MULTI-AUDIO (muxed MPEG-TS with several audio streams)
//   /api/proxy?url=<enc(media.m3u8)>&headers=<headers>&mode=master
//     -> returns a MASTER playlist with one #EXT-X-MEDIA audio entry per
//        audio stream found in the first segment (hls.js / Video.js / Shaka
//        will show an audio selector).
//   Add &format=text to any playlist URL to view it as plain text in a browser
//   instead of downloading it as a .m3u file.
//   Each entry points back here with &track=a0, a1, ... and the video with
//   &track=v. Segments requested with &track=... are filtered on the fly
//   (only the chosen PIDs are kept, PMT rewritten).
//
// <headers> can be:
//   - URL-encoded JSON        {"Referer":"...","Origin":"..."}
//   - base64 / base64url JSON (best for cookies and values containing & ; =)
//   - pipe style inside url:  ?url=<enc("https://cdn/x.mp4?a=1|Referer=<enc>&Origin=<enc>")>
//
// SUPPORTS: MP4 / WebM / MKV (Range seeking), HLS (.m3u8, rewritten),
//           DASH (.mpd, rewritten), TS / M4S segments, VTT, extension-less URLs.
//
// DEBUG: add &debug=1 to get a JSON report.

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
const PROBE_BYTES = 128 * 1024;      // how much of the first segment to read for PAT/PMT
const MASTER_BANDWIDTH = 3000000;    // advertised bandwidth in generated master

const LANG_NAMES = {
  hin: "Hindi", tam: "Tamil", tel: "Telugu", kan: "Kannada", mal: "Malayalam",
  eng: "English", ben: "Bengali", mar: "Marathi", guj: "Gujarati", pan: "Punjabi",
  urd: "Urdu", spa: "Spanish", fra: "French", fre: "French", deu: "German",
  ger: "German", jpn: "Japanese", kor: "Korean", zho: "Chinese", chi: "Chinese",
  rus: "Russian", ara: "Arabic", por: "Portuguese", ita: "Italian",
};

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
      "X-Upstream-Attempts",
      "X-Proxy-Header-Names",
      "X-Proxy-Track",
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
  try { return decodeURIComponent(value); } catch { return value; }
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
  const out = {
    raw: "", format: "", headersParam: "", debug: false, track: "", mode: "",
  };

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
    try { parsed = JSON.parse(decoded); } catch { parsed = null; }
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
  const { raw, format, headersParam, debug, track, mode } = readRawParams(reqUrl);

  const { target, pipeHeaders } = parseTargetAndHeaders(normalizeValue(raw));

  return {
    target,
    headers: sanitizeHeaders(pipeHeaders, parseHeadersParam(headersParam)),
    format,
    debug,
    track: /^(v|a\d{1,2})$/.test(track) ? track : "",
    mode,
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

function buildProxyUrl(root, absolute, headers, track) {
  const clean = sanitizeHeaders(headers);

  const h = Object.keys(clean).length
    ? "headers=" + b64urlEncode(JSON.stringify(clean)) + "&"
    : "";
  const t = track ? `track=${track}&` : "";

  return `${root}?${h}${t}url=${encodeTarget(absolute)}`;
}


// ═══════════════════════════════════════════════
// PLAYLIST REWRITING
// ═══════════════════════════════════════════════

// `track` is appended to media segment URLs only (not to keys / init maps).
function rewriteHls(text, playlistUrl, root, headers, track) {
  const wrap = (ref, withTrack) => {
    if (/^data:/i.test(ref)) return null;
    try {
      return buildProxyUrl(
        root,
        new URL(ref, playlistUrl).href,
        headers,
        withTrack ? track : ""
      );
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
// MPEG-TS: PAT / PMT PARSING, PID FILTER
// ═══════════════════════════════════════════════

const TS = 188;

const VIDEO_TYPES = new Set([0x01, 0x02, 0x10, 0x1b, 0x24]);
const AUDIO_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);
const AUDIO_DESC_TAGS = [0x6a, 0x7a, 0x7c, 0x81];

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

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

// Offset of the payload inside a TS packet, or -1.
function tsPayloadOffset(pkt) {
  const afc = (pkt[3] >> 4) & 3;
  if (afc === 0 || afc === 2) return -1;
  let o = 4;
  if (afc === 3) o += 1 + pkt[4];
  return o >= TS ? -1 : o;
}

// Start of the PSI section in a payload-unit-start packet, or -1.
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
    const prog = (pkt[i] << 8) | pkt[i + 1];
    if (prog !== 0) return ((pkt[i + 2] & 0x1f) << 8) | pkt[i + 3];
  }
  return -1;
}

function scanDescriptors(desc) {
  let lang = "";
  const tags = new Set();
  for (let i = 0; i + 2 <= desc.length; ) {
    const tag = desc[i];
    const len = desc[i + 1];
    tags.add(tag);
    if (tag === 0x0a && len >= 3 && i + 5 <= desc.length) {
      lang = String.fromCharCode(desc[i + 2], desc[i + 3], desc[i + 4]).toLowerCase();
    }
    i += 2 + len;
  }
  return { lang, tags };
}

function classifyStream(type, tags) {
  if (VIDEO_TYPES.has(type)) return "video";
  if (AUDIO_TYPES.has(type)) return "audio";
  if (type === 0x06 && AUDIO_DESC_TAGS.some((t) => tags.has(t))) return "audio";
  return "other";
}

// Parses a single-packet PMT section. Returns null if it does not fit one packet.
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
    const { lang, tags } = scanDescriptors(desc);
    streams.push({ type, pid, desc, lang, kind: classifyStream(type, tags) });
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

    if (pid === 0 && pmtPid < 0) {
      pmtPid = readPat(pkt);
    } else if (pmtPid >= 0 && pid === pmtPid) {
      const info = readPmt(pkt);
      if (info) return { ...info, pmtPid };
    }
  }
  return null;
}

function chooseKeep(info, track) {
  const videos = info.streams.filter((s) => s.kind === "video");
  const audios = info.streams.filter((s) => s.kind === "audio");

  if (track === "v") return new Set(videos.map((s) => s.pid));

  const a = audios[Number(track.slice(1))];
  return a ? new Set([a.pid]) : new Set();
}

function buildPmtPacket(orig, info, keep, pcrPid) {
  const body = [];
  for (const st of info.streams) {
    if (!keep.has(st.pid)) continue;
    body.push(
      st.type,
      0xe0 | (st.pid >> 8),
      st.pid & 0xff,
      0xf0 | (st.desc.length >> 8),
      st.desc.length & 0xff,
      ...st.desc
    );
  }

  const sec = [
    0x02, 0, 0,
    ...info.secHead,                       // program number, version, section numbers
    0xe0 | (pcrPid >> 8), pcrPid & 0xff,
    0xf0 | (info.progInfo.length >> 8), info.progInfo.length & 0xff,
    ...info.progInfo,
    ...body,
  ];

  const secLen = sec.length - 3 + 4;       // + CRC
  sec[1] = 0xb0 | (secLen >> 8);
  sec[2] = secLen & 0xff;

  const crc = crc32mpeg(sec);
  sec.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff);

  if (5 + sec.length > TS) return null;

  const out = new Uint8Array(TS).fill(0xff);
  out[0] = 0x47;
  out[1] = orig[1];
  out[2] = orig[2];
  out[3] = (orig[3] & 0x0f) | 0x10;        // payload only, keep continuity counter
  out[4] = 0x00;                           // pointer_field
  out.set(sec, 5);
  return out;
}

// Streaming filter: keeps PAT + rewritten PMT + only the chosen elementary streams.
// If the body does not start with a TS sync byte it is passed through untouched.
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
      keep = chooseKeep(info, track);
      const first = keep.values().next();
      const pcr = keep.has(info.pcrPid)
        ? info.pcrPid
        : first.done ? 0x1fff : first.value;
      return buildPmtPacket(pkt, info, keep, pcr) || pkt;
    }

    return keep && keep.has(pid) ? pkt : null;
  };

  return new TransformStream({
    transform(chunk, controller) {
      const buf = carry.length ? concatBytes(carry, chunk) : chunk;
      carry = new Uint8Array(0);

      if (!started) {
        if (!buf.length) return;
        started = true;
        passthrough = buf[0] !== 0x47;
      }

      if (passthrough) {
        controller.enqueue(buf);
        return;
      }

      const out = new Uint8Array(buf.length);
      let w = 0;
      let p = 0;

      while (p + TS <= buf.length) {
        if (buf[p] !== 0x47) { p++; continue; }
        const r = handle(buf.subarray(p, p + TS));
        if (r) {
          out.set(r, w);
          w += TS;
        }
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
  const first = playlistText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!first) return { audio: [], video: [] };

  const segUrl = new URL(first, playlistUrl);
  const headers = buildUpstreamHeaders(requestHeaders, { headers: new Headers() }, true);
  headers.set("Range", `bytes=0-${PROBE_BYTES - 1}`);

  const { response } = await fetchUpstream(segUrl, headers, { method: "GET" });
  if (response.status !== 200 && response.status !== 206) {
    try { response.body?.cancel(); } catch {}
    return { audio: [], video: [] };
  }

  const bytes = await readCapped(response, PROBE_BYTES);
  const psi = parsePsi(bytes);
  if (!psi) return { audio: [], video: [] };

  return {
    audio: psi.streams.filter((s) => s.kind === "audio"),
    video: psi.streams.filter((s) => s.kind === "video"),
  };
}

function buildMaster(root, playlistUrl, headers, audio) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  const used = new Set();

  audio.forEach((t, i) => {
    const lang = t.lang || "und";
    let name = LANG_NAMES[lang] || (t.lang ? t.lang.toUpperCase() : `Audio ${i + 1}`);
    if (used.has(name)) name = `${name} ${i + 1}`;
    used.add(name);

    const uri = buildProxyUrl(root, playlistUrl, headers, `a${i}`);
    const flag = i === 0 ? "YES" : "NO";
    lines.push(
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${name}",LANGUAGE="${lang}",` +
      `DEFAULT=${flag},AUTOSELECT=${flag},URI="${uri}"`
    );
  });

  lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${MASTER_BANDWIDTH},AUDIO="aud"`);
  lines.push(buildProxyUrl(root, playlistUrl, headers, "v"));

  return lines.join("\n") + "\n";
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
// REQUEST UPSTREAM
// ═══════════════════════════════════════════════

// skipRange: do not forward the client's Range header (used for filtered TS,
// whose size differs from the upstream file).
function buildUpstreamHeaders(requestHeaders, req, skipRange = false) {
  const headers = new Headers();

  for (const [k, v] of Object.entries(requestHeaders)) {
    if (BLOCKED_HEADERS.has(k.toLowerCase())) continue;
    headers.set(k, v);
  }

  const incomingRange = req.headers.get("range");
  if (incomingRange && !skipRange) {
    headers.delete("range");
    headers.set("Range", incomingRange);
  }

  const ifNoneMatch = req.headers.get("if-none-match");
  if (ifNoneMatch && !skipRange && !headers.has("if-none-match")) {
    headers.set("If-None-Match", ifNoneMatch);
  }

  const ifModifiedSince = req.headers.get("if-modified-since");
  if (ifModifiedSince && !skipRange && !headers.has("if-modified-since")) {
    headers.set("If-Modified-Since", ifModifiedSince);
  }

  if (!headers.has("user-agent")) headers.set("User-Agent", DEFAULT_UA);
  if (!headers.has("accept")) headers.set("Accept", "*/*");

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

  const { target, headers: requestHeaders, format, debug, track, mode } = parsed;

  try {
    console.log(`[PROXY] ${req.method} ${target.href}`);
    console.log("[PROXY REQUEST HEADERS]", redact(requestHeaders));

    const attempts = buildAttempts(requestHeaders);
    const attemptLog = [];

    let result = null;

    for (let i = 0; i < attempts.length; i++) {
      const attempt = attempts[i];
      const upstreamHeaders = buildUpstreamHeaders(attempt.headers, req, Boolean(track));

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
        // ─── Multi-audio: build a master playlist from the muxed TS ───
        if (mode === "master" && !/#EXT-X-STREAM-INF/.test(text)) {
          let tracks = { audio: [], video: [] };
          try {
            tracks = await probeTracks(text, finalTarget, requestHeaders);
          } catch (err) {
            console.error("[PROBE ERROR]", err);
          }

          if (tracks.audio.length < 2) {
            return jsonResponse(422, {
              error: "Could not find multiple audio streams in the first segment",
              audioStreamsFound: tracks.audio.length,
              hint: "Segments may be encrypted / fMP4, or the probe request was blocked.",
            });
          }

          return textResponse(
            200,
            format === "text"
              ? "text/plain; charset=utf-8"
              : "application/vnd.apple.mpegurl",
            buildMaster(root, finalTarget.href, requestHeaders, tracks.audio),
            "no-store"
          );
        }

        const out = rewriteHls(text, finalTarget.href, root, requestHeaders, track);
        const cache = "public, max-age=2, s-maxage=2, stale-while-revalidate=3";

        if (format === "json") {
          return textResponse(
            200,
            "application/json",
            JSON.stringify({ content: out }),
            cache
          );
        }

        return textResponse(
          200,
          format === "text"
            ? "text/plain; charset=utf-8"
            : "application/vnd.apple.mpegurl",
          out,
          cache
        );
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

    // ─── Per-track filtered TS segment (video-only or one audio stream) ───
    if (track && req.method === "GET" && status === 200 && upstream.body) {
      const filtered = upstream.body.pipeThrough(makeTsFilter(track));
      return new Response(filtered, {
        status: 200,
        headers: {
          ...corsHeaders(),
          "Content-Type": "video/mp2t",
          "Cache-Control": "public, max-age=3600, s-maxage=3600",
          "X-Proxy-Track": track,
          "X-Upstream-Attempts": attemptsText,
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
