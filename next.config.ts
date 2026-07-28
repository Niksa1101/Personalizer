import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next locks a dev server on `path.join(distDir, "lock")`, so a second one
  // for this directory is refused. verify:settings boots a throwaway server
  // with sentinel env values; pointing it at its own distDir lets that leg run
  // without stopping the dev server you are working in. Unset everywhere else.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  serverExternalPackages: ["ffmpeg-static", "ffprobe-static"],
  experimental: {
    // Intro uploads pass through proxy (session cookie present). Next.js 16
    // buffers the cloned body with a 10MB default — too small for pitch videos.
    proxyClientMaxBodySize: "500mb",
  },
};

export default nextConfig;
