import type { NextConfig } from "next";
const config: NextConfig = { transpilePackages: ["@recast/store", "@recast/core", "@recast/runtime-client"], reactStrictMode: true, serverExternalPackages: ["pg"] };
export default config;
