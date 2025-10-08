// File: api/proxy.js
// File: api/proxy.js
export const config = {
  runtime: "nodejs20", // ensure proper stream handling
};

export default async function handler(req, res) {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl) {
      res.status(400).json({ error: "Missing url parameter" });
      return;
    }

    const response = await fetch(targetUrl, {
      headers: {
        Referer: "https://watchout.rpmvid.com",
        Origin: "https://watchout.rpmvid.com",
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
    });

    const contentType = response.headers.get("content-type") || "";

    // --- Handle M3U8 playlists ---
    if (contentType.includes("application/vnd.apple.mpegurl")) {
      let text = await response.text();
      const base = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

      text = text.replace(
        /^(?!#)(.*\.m3u8(\?.*)?)$/gm,
        (m) =>
          `https://workingg.vercel.app/api/proxy?url=${encodeURIComponent(
            new URL(m, base).href
          )}`
      );

      text = text.replace(
        /^(?!#)(.*\.ts(\?.*)?)$/gm,
        (m) =>
          `https://workingg.vercel.app/api/proxy?url=${encodeURIComponent(
            new URL(m, base).href
          )}`
      );

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.status(200).send(text);
      return;
    }

    // --- Handle TS video segments ---
    if (
      targetUrl.endsWith(".ts") ||
      contentType.includes("video") ||
      contentType.includes("octet-stream")
    ) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", contentType || "video/MP2T");
      res.status(200).send(buffer);
      return;
    }

    // --- Fallback: forward any other file ---
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", contentType || "application/octet-stream");
    res.status(200).send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
