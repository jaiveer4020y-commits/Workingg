// api/proxy.js
export const config = { runtime: "edge" };

export default async function handler(req) {
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("url");
  const source = url.searchParams.get("source") || "1";

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: "Missing 'url' query parameter" }), { status: 400 });
  }

  const decodedUrl = decodeURIComponent(targetUrl);
  const customHeader = "https://server1.uns.bio/";

  const response = await fetch(decodedUrl, {
    headers: {
      Referer: customHeader + "/",
      Origin: customHeader,
      "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36",
      Accept: "*/*",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    return new Response(await response.text(), { status: response.status });
  }

  const contentType = response.headers.get("content-type") || "";
  const isM3U8 = contentType.includes("application/vnd.apple.mpegurl") || decodedUrl.includes(".m3u8");

  if (isM3U8) {
    const base = decodedUrl.substring(0, decodedUrl.lastIndexOf("/") + 1);
    const proxyBase = `${url.protocol}//${url.host}/api/proxy?source=${source}&url=`;
    let text = await response.text();

    // Rewrite M3U8 content to route segments through the proxy
    text = text.replace(/^(?!#)(.+)$/gm, (line) => {
      try {
        const fullUrl = new URL(line.trim(), base).href;
        return `${proxyBase}${encodeURIComponent(fullUrl)}`;
      } catch {
        return line;
      }
    });

    return new Response(text, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "public, max-age=5, s-maxage=60",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // For all other files (fragments, keys, etc.)
  return new Response(response.body, {
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=10, s-maxage=10",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
