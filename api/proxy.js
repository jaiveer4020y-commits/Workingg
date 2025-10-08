// File: api/proxy.js
import fetch from "node-fetch";

export default async function handler(req, res) {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: "Missing url parameter" });

    // Fetch from the real origin with the required headers
    const upstream = await fetch(targetUrl, {
      headers: {
        Referer: "https://watchout.rpmvid.com",
        Origin: "https://watchout.rpmvid.com",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
    });

    // Check the content type
    const contentType = upstream.headers.get("content-type") || "";

    // Handle playlists (.m3u8)
    if (contentType.includes("application/vnd.apple.mpegurl")) {
      let text = await upstream.text();

      // Rewrite relative URLs to absolute proxied ones
      const base = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      text = text.replace(
        /^(?!#)(.*\.m3u8(\?.*)?)$/gm,
        (m) => `https://workingg.vercel.app/api/proxy?url=${encodeURIComponent(new URL(m, base).href)}`
      );
      text = text.replace(
        /^(?!#)(.*\.ts(\?.*)?)$/gm,
        (m) => `https://workingg.vercel.app/api/proxy?url=${encodeURIComponent(new URL(m, base).href)}`
      );

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(200).send(text);
      return;
    }

    // Handle video segments (.ts)
    if (
      contentType.includes("video") ||
      contentType.includes("octet-stream") ||
      targetUrl.endsWith(".ts")
    ) {
      res.setHeader("Content-Type", contentType || "video/MP2T");
      res.setHeader("Access-Control-Allow-Origin", "*");
      upstream.body.pipe(res);
      return;
    }

    // Fallback: forward everything else
    const buffer = await upstream.arrayBuffer();
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
