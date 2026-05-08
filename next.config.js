/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false,
  // The 'experimental' block was removed as 'appDir' is no longer needed
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Access-Control-Allow-Headers', value: '*' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
