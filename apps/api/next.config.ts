import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages: ["@recast/api-core", "@recast/resolve", "@recast/bridges", "@recast/core"],
  poweredByHeader: false,
  // The core is TypeScript source that imports "./x.js" (ESM style). Webpack maps that to x.ts; Turbopack cannot yet, so we build with --webpack.
  webpack: (cfg) => { cfg.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] }; return cfg; },
};
export default config;
