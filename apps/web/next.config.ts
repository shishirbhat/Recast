import type { NextConfig } from "next";
const config: NextConfig = { transpilePackages: ["@recast/store", "@recast/core"], reactStrictMode: true };
export default config;
