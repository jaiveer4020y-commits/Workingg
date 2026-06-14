// api/proxy.js
import https from "https";
import { URL } from "url";
import { pipeline } from "stream";
import { promisify } from "util";

const streamPipeline = promisify(pipeline);

// Connection pool per origin hostname
const agents = new Map();

function getAgent(hostname) {
  if (!agents.has(hostname)) {
    agents.set(hostname, new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 1000,
      maxSockets: 50,
      maxFreeSockets: 10,
      timeout: 60000,
    }));
  }
  return agents.get(hostname);
}

// Simple in-memory cache for rewritten M3U8 (5s TTL)
const playlistCache = new Map();

export const config = {
  runtime: "nodejs",
};

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const targetUrl = req.query.url;
    const format = req.query.format || "raw";
    const source = req.query.source || "1";

    if (!targetUrl) {
      return res.status(400).json({ error: "Missing 'url' query parameter" });
    }

    const decodedUrl = decodeURIComponent(targetUrl);
    const urlObj = new URL(decodedUrl);
    const agent = getAgent(urlObj.hostname);
    const customHeader = "https://multimoviesshg.com/";

    // Helper to make proxied request using native https
    const proxyRequest = (url, headers = {}) => {
      return new Promise((resolve, reject) => {
        const options = {
          hostname: urlObj.hostname,
          port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
          path: urlObj.pathname + urlObj.search,
          method: "GET",
          headers: {
            Referer: customHeader + "/",
            Origin: customHeader,
            "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36",
            Accept: "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            ...headers,
          },
          agent: agent,
        };
        const protocol = urlObj.protocol === "https:" ? https : require("http");
        const request = protocol.request(options, (response) => {
          resolve(response);
        });
        request.on("error", reject);
        request.end();
      });
    };

    const originResponse = await proxyRequest(decodedUrl);
    const contentType = originResponse.headers["content-type"] || "";
    const base = decodedUrl.substring(0, decodedUrl.lastIndexOf("/") + 1);
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host = req.headers["host"];
    const proxyBase = `${protocol}://${host}/api/proxy?source=${source}&url=`;

    // M3U8 handling (similar to before, but using originResponse)
    const isM3U8 = contentType.includes("application/vnd.apple.mpegurl") ||
                   contentType.includes("application/x-mpegurl") ||
                   decodedUrl.includes(".m3u8");

    if (isM3U8) {
      // Cache check...
      const cached = playlistCache.get(decodedUrl);
      if (cached && cached.expires > Date.now()) {
        const text = cached.text;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.setHeader("Cache-Control", "public, max-age=5, s-maxage=60");
        return res.status(200).send(text);
      }

      // Read full playlist text (small, so ok)
      let body = "";
      for await (const chunk of originResponse) {
        body += chunk.toString();
      }

      // Rewrite URLs (same regex as before)
      let text = body;
      text = text.replace(/URI="([^"]+)"/g, (match, p1) => {
        try { const fullUrl = new URL(p1, base).href; return `URI="${proxyBase}${encodeURIComponent(fullUrl)}"`; } catch { return match; }
      });
      text = text.replace(/TYPE=(SUBTITLES|AUDIO|CLOSED-CAPTIONS)(.*?)URI="([^"]+)"/g, (match, type, middle, uri) => {
        try { const fullUrl = new URL(uri, base).href; return `TYPE=${type}${middle}URI="${proxyBase}${encodeURIComponent(fullUrl)}"`; } catch { return match; }
      });
      text = text.replace(/^(?!#)(.+(\.m3u8|\.ts|\.m4s|\.vtt|\.aac|\.mp4)(\?.*)?)$/gm, (m) => {
        try { return `${proxyBase}${encodeURIComponent(new URL(m.trim(), base).href)}`; } catch { return m; }
      });

      playlistCache.set(decodedUrl, { text, expires: Date.now() + 5000 });

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "public, max-age=5, s-maxage=60");
      return res.status(200).send(text);
    }

    // VTT subtitles
    if (contentType.includes("text/vtt") || decodedUrl.endsWith(".vtt")) {
      let body = "";
      for await (const chunk of originResponse) {
        body += chunk.toString();
      }
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
      return res.status(200).send(body);
    }

    // Binary fragments – stream directly using pipeline (reuses agent connection)
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    res.setHeader("Cache-Control", "public, max-age=10, s-maxage=10");
    
    // Pipe the origin response to the client response
    await streamPipeline(originResponse, res);
    
  } catch (error) {
    console.error("[PROXY EXCEPTION]", error);
    res.status(500).json({ error: error.message });
  }
}
