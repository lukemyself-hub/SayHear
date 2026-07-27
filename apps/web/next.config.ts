import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    useTypeScriptCli: true,
  },
  transpilePackages: [
    "@sayhear/application",
    "@sayhear/data",
    "@sayhear/domain",
  ],
};

export default nextConfig;
