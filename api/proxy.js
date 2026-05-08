export const config = {
runtime: “nodejs”,
};

export default async function handler(req, res) {
try {
const targetUrl = req.query.url;
const format = req.query.format || “raw”;
// source=1 → watchout (default), source=2 → streamp2p
const source = req.query.source || “1”;

```
if (!targetUrl) {
  return res.status(400).json({ error: "Missing 'url' query parameter" });
}

const decodedUrl = decodeURIComponent(targetUrl);

// ───────────────────────────────
// 🛡️ DYNAMIC HEADER SELECTION
// source=1 → watchout (default)
// source=2 → streamp2p
// ───────────────────────────────
let customHeader;

if (source === "2" || decodedUrl.includes("streamp2p")) {
  customHeader = "https://multimovies.p2pplay.pro"; // streamp2p
} else {
  customHeader = "https://watchouteng.rpmvid.com"; // watchout (default)
}

const response = await fetch(decodedUrl, {
  headers: {
    Referer: customHeader,
    Origin: customHeader,
    "User-Agent":
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
});

const contentType = response.headers.get("content-type") || "";
const base = decodedUrl.substring(0, decodedUrl.lastIndexOf("/") + 1);

// CORS headers
res.setHeader("Access-Control-Allow-Origin", "*");
res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
res.setHeader("Access-Control-Allow-Headers", "*");
res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

if (req.method === "OPTIONS") {
  return res.status(204).end();
}

// ───────────────────────────────
// 🟩 Handle M3U8 playlists
// ───────────────────────────────
if (contentType.includes("application/vnd.apple.mpegurl")) {
  let text = await response.text();
  const proxyBase = `https://workingg.vercel.app/api/proxy?source=${source}&url=`;

  // Rewrite URI="..." references (keys, subtitles, etc.)
  const rewrite = (match, p1) => {
    const fullUrl = new URL(p1, base).href;
    return `URI="${proxyBase}${encodeURIComponent(fullUrl)}"`;
  };

  text = text.replace(/URI="([^"]+)"/g, rewrite);

  // Rewrite .m3u8, .ts, and .m4s segment references
  const segmentRegex = /^(?!#)(.*(\.m3u8|\.ts|\.m4s)(\?.*)?)$/gm;
  text = text.replace(segmentRegex, (m) => {
    const fullUrl = new URL(m, base).href;
    return `${proxyBase}${encodeURIComponent(fullUrl)}`;
  });

  if (format === "json") {
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ content: text });
  }

  res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  return res.status(200).send(text);
}

// ───────────────────────────────
// 🟨 Handle video segments
// ───────────────────────────────
if (
  targetUrl.endsWith(".ts") ||
  targetUrl.endsWith(".m4s") ||
  targetUrl.endsWith(".mp4") ||
  contentType.includes("video") ||
  contentType.includes("octet-stream")
) {
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  res.setHeader("Content-Type", contentType || "video/MP2T");
  return res.status(200).send(buffer);
}

// ───────────────────────────────
// 🟦 Default: forward everything else
// ───────────────────────────────
const arrayBuffer = await response.arrayBuffer();
const buffer = Buffer.from(arrayBuffer);
res.setHeader("Content-Type", contentType || "application/octet-stream");
return res.status(200).send(buffer);
```

} catch (error) {
console.error(“Proxy error:”, error);
res.status(500).json({ error: error.message });
}
}
