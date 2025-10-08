export default async function handler(req, res) {
  const target = req.query.url;
  if (!target) return res.status(400).json({ error: "Missing url" });

  try {
    const response = await fetch(target, {
      headers: {
        Referer: "https://watchout.rpmvid.com",
        Origin: "https://watchout.rpmvid.com",
        "User-Agent": "Mozilla/5.0 (Linux; Android 10) Chrome/114 Mobile Safari/537.36"
      }
    });

    // forward headers and body
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");

    const data = await response.arrayBuffer();
    res.status(response.status).send(Buffer.from(data));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
