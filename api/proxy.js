import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);

// Optional: simple in‑memory cache for rewritten playlists (warm instances only)
const playlistCache = new Map();

export const config = {
  runtime: "nodejs", // can also be "edge" – see alternate version below
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const targetUrl = req.query.url;
    const format = req.query.format || "raw";
    const source = req.query.source || "1";

    if (!targetUrl) {
      return res.status(400).json({ error: "Missing 'url' query parameter" });
    }

    const decodedUrl = decodeURIComponent(targetUrl);

    // Header selection (simplified – both source=1 and source=2 use same referer)
    const customHeader = "https://server1.uns.bio/";

    const response = await fetch(decodedUrl, {
      headers: {
        Referer: customHeader + "/",
        Origin: customHeader,
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        // ✅ Allow compression – Vercel decompresses automatically
        // "Accept-Encoding": "gzip, deflate, br",  // let browser decide, or omit
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[PROXY ERROR] ${response.status} for: ${decodedUrl}`);
      console.error(`[PROXY BODY] ${body.substring(0, 500)}`);
      return res.status(response.status).send(body);
    }

    const contentType = response.headers.get("content-type") || "";
    const base = decodedUrl.substring(0, decodedUrl.lastIndexOf("/") + 1);
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["host"];
    const proxyBase = `${protocol}://${host}/api/proxy?source=${source}&url=`;

    // ─────────────────────────────────────────
    // 🟩 Handle M3U8 playlists
    // ─────────────────────────────────────────
    const isM3U8 =
      contentType.includes("application/vnd.apple.mpegurl") ||
      contentType.includes("application/x-mpegurl") ||
      decodedUrl.includes(".m3u8");

    if (isM3U8) {
      // Check cache for this exact decodedUrl
      const cached = playlistCache.get(decodedUrl);
      if (cached && cached.expires > Date.now()) {
        const text = cached.text;
        if (format === "json") {
          res.setHeader("Content-Type", "application/json");
          return res.status(200).json({ content: text });
        }
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=60");
        return res.status(200).send(text);
      }

      let text = await response.text();

      // Rewrite URI="..."
      text = text.replace(/URI="([^"]+)"/g, (match, p1) => {
        try {
          const fullUrl = new URL(p1, base).href;
          return `URI="${proxyBase}${encodeURIComponent(fullUrl)}"`;
        } catch {
          return match;
        }
      });

      // Rewrite TYPE=... URI="..."
      text = text.replace(
        /TYPE=(SUBTITLES|AUDIO|CLOSED-CAPTIONS)(.*?)URI="([^"]+)"/g,
        (match, type, middle, uri) => {
          try {
            const fullUrl = new URL(uri, base).href;
            return `TYPE=${type}${middle}URI="${proxyBase}${encodeURIComponent(fullUrl)}"`;
          } catch {
            return match;
          }
        }
      );

      // Rewrite segment lines
      text = text.replace(
        /^(?!#)(.+(\.m3u8|\.ts|\.m4s|\.vtt|\.aac|\.mp4)(\?.*)?)$/gm,
        (m) => {
          try {
            const trimmed = m.trim();
            const fullUrl = new URL(trimmed, base).href;
            return `${proxyBase}${encodeURIComponent(fullUrl)}`;
          } catch {
            return m;
          }
        }
      );

      // Store in cache (5 seconds TTL)
      playlistCache.set(decodedUrl, {
        text: text,
        expires: Date.now() + 5000,
      });

      if (format === "json") {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).json({ content: text });
      }

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "public, max-age=5, stale-while-revalidate=60");
      return res.status(200).send(text);
    }

    // ─────────────────────────────────────────
    // 🟨 Handle VTT subtitles
    // ─────────────────────────────────────────
    if (contentType.includes("text/vtt") || decodedUrl.endsWith(".vtt")) {
      const text = await response.text();
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=86400"); // cache subtitles
      return res.status(200).send(text);
    }

    // ─────────────────────────────────────────
    // 🟥 Handle binary fragments (TS, M4S, MP4, keys)
    // ─────────────────────────────────────────
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    // Allow clients/CDN to cache fragments for a short time
    res.setHeader("Cache-Control", "public, max-age=10");

    // ✅ Stream the response directly – no Buffer, no arrayBuffer
    if (response.body) {
      await streamPipeline(response.body, res);
      return;
    } else {
      // Fallback for very old environments (should not happen with modern fetch)
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      res.setHeader("Content-Length", buffer.length);
      return res.status(200).send(buffer);
    }
  } catch (error) {
    console.error("[PROXY EXCEPTION]", error);
    return res.status(500).json({ error: error.message });
  }
}
