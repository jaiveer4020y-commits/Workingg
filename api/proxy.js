export const config = {
  runtime: "nodejs",
};

export default async function handler(req, res) {
  try {
    const targetUrl = req.query.url;
    const format = req.query.format || "raw";

    if (!targetUrl) {
      return res.status(400).json({ error: "Missing 'url' query parameter" });
    }

    const decodedUrl = decodeURIComponent(targetUrl);

    const response = await fetch(decodedUrl, {
      headers: {
        Referer: "https://watchout.rpmvid.com",
        Origin: "https://watchout.rpmvid.com",
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

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    // ───────────────────────────────
    // 🟩 Handle M3U8 playlists
    // ───────────────────────────────
    if (contentType.includes("application/vnd.apple.mpegurl")) {
      let text = await response.text();

      // Rewrite "URI=" references (audio, init segments, etc.)
      text = text.replace(
        /URI="([^"]+)"/g,
        (match, p1) =>
          `URI="https://workingg.vercel.app/api/proxy?url=${encodeURIComponent(
            new URL(p1, base).href
          )}"`
      );

      // Rewrite .m3u8 playlist references
      text = text.replace(
        /^(?!#)(.*\.m3u8(\?.*)?)$/gm,
        (m) =>
          `https://workingg.vercel.app/api/proxy?url=${encodeURIComponent(
            new URL(m, base).href
          )}`
      );

      // Rewrite .ts segments
      text = text.replace(
        /^(?!#)(.*\.ts(\?.*)?)$/gm,
        (m) =>
          `https://workingg.vercel.app/api/proxy?url=${encodeURIComponent(
            new URL(m, base).href
          )}`
      );

      // Rewrite .m4s segments
      text = text.replace(
        /^(?!#)(.*\.m4s(\?.*)?)$/gm,
        (m) =>
          `https://workingg.vercel.app/api/proxy?url=${encodeURIComponent(
            new URL(m, base).href
          )}`
      );

      // Return as JSON (debug mode)
      if (format === "json") {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).json({ content: text });
      }

      // Normal playback mode
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.status(200).send(text);
    }

    // ───────────────────────────────
    // 🟨 Handle video segments (.ts, .m4s, .mp4)
    // ───────────────────────────────
    if (
      targetUrl.endsWith(".ts") ||
      targetUrl.endsWith(".m4s") ||
      targetUrl.endsWith(".mp4") ||
      contentType.includes("video") ||
      contentType.includes("octet-stream")
    ) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader("Content-Type", contentType || "video/MP2T");
      return res.status(200).send(buffer);
    }

    // ───────────────────────────────
    // 🟦 Handle JSON or text responses
    // ───────────────────────────────
    if (contentType.includes("application/json") || format === "json") {
      const data = await response.text();
      res.setHeader("Content-Type", "application/json");
      return res.status(200).send(data);
    }

    // ───────────────────────────────
    // 🟪 Default: forward everything else
    // ───────────────────────────────
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    return res.status(200).send(buffer);
  } catch (error) {
    console.error("Proxy error:", error);
    res.status(500).json({ error: error.message });
  }
}
