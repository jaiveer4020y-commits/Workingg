// api/proxy.js
import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);

// Simple in‑memory cache for rewritten playlists (reduces repeated regex work)
const playlistCache = new Map();

export const config = {
  runtime: "nodejs",
  // OPTIONAL: Force a region close to your origin IP to reduce latency.
  // Example: "fra1" (Frankfurt), "iad1" (N. Virginia), "hnd1" (Tokyo)
  // Find your origin's approximate location and pick the nearest Vercel region:
  // https://vercel.com/docs/functions/serverless-functions#regions
  // regions: ["fra1"],   // uncomment and adjust
};

export default async function handler(req, res) {
  // CORS headers (required for HLS.js, etc.)
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
    const customHeader = "https://server1.uns.bio/";

    // Fetch the upstream resource
    const response = await fetch(decodedUrl, {
      headers: {
        Referer: customHeader + "/",
        Origin: customHeader,
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        // Allow compression – Vercel will decompress automatically
        // "Accept-Encoding": "gzip, deflate, br",  // let the browser/fetch decide
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[PROXY ERROR] ${response.status} for ${decodedUrl}`);
      return res.status(response.status).send(body);
    }

    const contentType = response.headers.get("content-type") || "";
    const base = decodedUrl.substring(0, decodedUrl.lastIndexOf("/") + 1);
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["host"];
    const proxyBase = `${protocol}://${host}/api/proxy?source=${source}&url=`;

    // ─────────────────────────────────────────
    // M3U8 Playlist (rewrite URLs + cache)
    // ─────────────────────────────────────────
    const isM3U8 =
      contentType.includes("application/vnd.apple.mpegurl") ||
      contentType.includes("application/x-mpegurl") ||
      decodedUrl.includes(".m3u8");

    if (isM3U8) {
      // Check in‑memory cache (5 seconds TTL)
      const cached = playlistCache.get(decodedUrl);
      if (cached && cached.expires > Date.now()) {
        const text = cached.text;
        if (format === "json") {
          res.setHeader("Content-Type", "application/json");
          return res.status(200).json({ content: text });
        }
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "public, max-age=5, s-maxage=60");
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

      // Rewrite segment lines (.ts, .m4s, .vtt, .aac, .mp4, .m3u8)
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

      // Cache the rewritten playlist (5 seconds)
      playlistCache.set(decodedUrl, {
        text: text,
        expires: Date.now() + 5000,
      });

      if (format === "json") {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).json({ content: text });
      }

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "public, max-age=5, s-maxage=60");
      return res.status(200).send(text);
    }

    // ─────────────────────────────────────────
    // VTT Subtitles
    // ─────────────────────────────────────────
    if (contentType.includes("text/vtt") || decodedUrl.endsWith(".vtt")) {
      const text = await response.text();
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
      return res.status(200).send(text);
    }

    // ─────────────────────────────────────────
    // Binary fragments (TS, M4S, MP4, keys)
    // ─────────────────────────────────────────
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    // CDN caching for fragments – 10 seconds is reasonable for live streams
    res.setHeader("Cache-Control", "public, max-age=10, s-maxage=10");

    // ✅ Stream the response – no buffering, much faster
    if (response.body) {
      await streamPipeline(response.body, res);
      return;
    } else {
      // Fallback for very old fetch implementations (unlikely)
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
