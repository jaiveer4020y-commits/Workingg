export const config = {
  runtime: "nodejs",
};

export default async function handler(req, res) {
  // Handle CORS preflight first
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

    // ✅ Fixed header selection (was overwriting source=2 with source=1)
    let customHeader = "https://multimovies.fyi"; // default

    if (source === "2" || decodedUrl.includes("streamp2p")) {
      customHeader = "https://multimovies.p2pplay.pro";
    } else if (source === "1") {
      customHeader = "https://multimovies.fyi";
    }

    const response = await fetch(decodedUrl, {
      headers: {
        Referer: customHeader + "/",
        Origin: customHeader,
        "User-Agent":
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "identity", // avoid gzip so Buffer works cleanly
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "cross-site",
      },
      redirect: "follow",
    });

    // ✅ Log and forward non-OK responses clearly
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

    // ───────────────────────────────
    // 🟩 Handle M3U8 playlists
    // ───────────────────────────────
    const isM3U8 =
      contentType.includes("application/vnd.apple.mpegurl") ||
      contentType.includes("application/x-mpegurl") ||
      decodedUrl.includes(".m3u8");

    if (isM3U8) {
      let text = await response.text();

      // 1. Rewrite URI="..." (encryption keys, maps, etc.)
      text = text.replace(/URI="([^"]+)"/g, (match, p1) => {
        try {
          const fullUrl = new URL(p1, base).href;
          return `URI="${proxyBase}${encodeURIComponent(fullUrl)}"`;
        } catch {
          return match;
        }
      });

      // 2. Rewrite #EXT-X-MEDIA subtitle/audio/caption track URIs
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

      // 3. Rewrite segment lines (.ts, .m3u8, .m4s, .vtt, .aac, .mp4)
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

      if (format === "json") {
        res.setHeader("Content-Type", "application/json");
        return res.status(200).json({ content: text });
      }

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.status(200).send(text);
    }

    // ───────────────────────────────
    // 🟨 Handle VTT subtitles
    // ───────────────────────────────
    if (contentType.includes("text/vtt") || decodedUrl.endsWith(".vtt")) {
      const text = await response.text();
      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      return res.status(200).send(text);
    }

    // ───────────────────────────────
    // 🟥 Handle binary segments (ts, m4s, aac, mp4, keys)
    // ───────────────────────────────
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", contentType || "application/octet-stream");
    res.setHeader("Content-Length", buffer.length);
    return res.status(200).send(buffer);

  } catch (error) {
    console.error("[PROXY EXCEPTION]", error);
    return res.status(500).json({ error: error.message });
  }
}
