export const config = {
  runtime: "nodejs",
};

export default async function handler(req, res) {
  try {
    const targetUrl = req.query.url;
    const format = req.query.format || "raw";
    const source = req.query.source || "1";

    if (!targetUrl) {
      return res.status(400).json({ error: "Missing 'url' query parameter" });
    }

    const decodedUrl = decodeURIComponent(targetUrl);

    // 🛡️ DYNAMIC HEADER SELECTION
    let customHeader;
    if (source === "2" || decodedUrl.includes("streamp2p")) {
      customHeader = "https://multimovies.p2pplay.pro";
    } else {
      customHeader = "https://watchouteng.rpmvid.com";
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
    // 🟩 Handle M3U8 & Subtitles
    // ───────────────────────────────
    if (contentType.includes("application/vnd.apple.mpegurl") || decodedUrl.includes(".m3u8")) {
      let text = await response.text();
      
      const protocol = req.headers["x-forwarded-proto"] || "https";
      const host = req.headers["host"];
      const proxyBase = `${protocol}://${host}/api/proxy?source=${source}&url=`;

      // 1. Rewrite General URI="..." (Keys, Maps, etc.)
      text = text.replace(/URI="([^"]+)"/g, (match, p1) => {
        const fullUrl = new URL(p1, base).href;
        return `URI="${proxyBase}${encodeURIComponent(fullUrl)}"`;
      });

      // 2. Rewrite Embedded HLS Subtitles / Audio Tracks 
      // This specifically finds #EXT-X-MEDIA tags used for subtitles
      text = text.replace(/TYPE=(SUBTITLES|AUDIO|CLOSED-CAPTIONS)(.*?)URI="([^"]+)"/g, (match, type, middle, uri) => {
        const fullUrl = new URL(uri, base).href;
        return `TYPE=${type}${middle}URI="${proxyBase}${encodeURIComponent(fullUrl)}"`;
      });

      // 3. Rewrite Segment references (.ts, .m3u8, .m4s, .vtt)
      const segmentRegex = /^(?!#)(.*(\.m3u8|\.ts|\.m4s|\.vtt)(\?.*)?)$/gm;
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
    // 🟨 Handle video segments, VTT, and everything else
    // ───────────────────────────────
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    // Set appropriate content type (crucial for .vtt or .ts)
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    return res.status(200).send(buffer);

  } catch (error) {
    console.error("Proxy error:", error);
    res.status(500).json({ error: error.message });
  }
}
