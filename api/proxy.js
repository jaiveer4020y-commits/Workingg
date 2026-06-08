// api/proxy.js

export default async function handler(req, res) {
  // Enable CORS for browser requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Get the target URL from query parameter
  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  // Required headers from your image
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
    'Referer': 'https://allmovieland.one/',
    'Cache-Control': 'max-age=0',
    'Host': 'gemma416okl.com',
    'Connection': 'Keep-Alive',
    'Accept-Encoding': 'gzip'
  };

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: headers
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream fetch failed with status ${response.status}`
      });
    }

    // Forward the response body (HTML, JSON, etc.)
    const data = await response.text();
    res.setHeader('Content-Type', response.headers.get('content-type') || 'text/html');
    return res.status(200).send(data);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
}
