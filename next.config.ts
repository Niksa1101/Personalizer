import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  experimental: {
    // Intro uploads pass through proxy (session cookie present). Next.js 16
    // buffers the cloned body with a 10MB default — too small for pitch videos.
    proxyClientMaxBodySize: "500mb",
  },
};

export default nextConfig;
