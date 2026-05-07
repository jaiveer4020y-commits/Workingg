export const config = {
  runtime: "nodejs",
};

export default async function handler(req, res) {
  try {
    const targetUrl = req.query.url;
    const format = req.query.format || "raw";
    // 🛡️ NEW: Get custom referer from the query endpoint
    const customRef = req.query.ref; 

    if (!targetUrl) {
      return res.status(400).json({ error: "Missing 'url' query parameter" });
    }

    const decodedUrl = decodeURIComponent(targetUrl);

    // Determine headers: Use provided 'ref' endpoint, or fallback to default
    const finalHeader = customRef ? decodeURIComponent(customRef) : "https://watchouteng.rpmvid.com";

    const response = await fetch(decodedUrl, {
      headers: {
        "Referer": finalHeader,
        "Origin": finalHeader.replace(/\/$/, ""), // Clean trailing slash for Origin
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      },
    });

    const contentType = response.headers.get("content-type") || "";
    const base = decodedUrl.substring(0, decodedUrl.lastIndexOf("/") + 1);

    // CORS Configuration
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") return res.status(204).end();

    // 🟩 Handle M3U8 playlists
    if (contentType.includes("application/vnd.apple.mpegurl")) {
      let text = await response.text();
      
      // Pass the 'ref' parameter down to all child segments automatically
      const refParam = customRef ? `&ref=${encodeURIComponent(customRef)}` : "";
      const proxyBase = `https://workingg.vercel.app/api/proxy?url=`;

      // Rewrite URI lines
      text = text.replace(/URI="([^"]+)"/g, (match, p1) => {
        const fullUrl = new URL(p1, base).href;
        return `URI="${proxyBase}${encodeURIComponent(fullUrl)}${refParam}"`;
      });

      // Rewrite Playlist/Segment lines
      text = text.replace(/^(?!#)(.*(\.m3u8|\.ts|\.m4s)(\?.*)?)$/gm, (m) => {
        const fullUrl = new URL(m, base).href;
        return `${proxyBase}${encodeURIComponent(fullUrl)}${refParam}`;
      });

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      return res.status(200).send(text);
    }

    // 🟨 Handle Video Segments
    const arrayBuffer = await response.arrayBuffer();
    res.setHeader("Content-Type", contentType || "video/MP2T");
    return res.status(200).send(Buffer.from(arrayBuffer));

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}
