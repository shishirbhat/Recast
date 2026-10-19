import type { NextConfig } from "next";

// Static export: the Relay server serves these files next to its API and WebSockets.
const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
