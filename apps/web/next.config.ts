import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  experimental: {
    useTypeScriptCli: true,
  },
  transpilePackages: [
    "@sayhear/ai",
    "@sayhear/application",
    "@sayhear/data",
    "@sayhear/domain",
  ],
};

export default withWorkflow(nextConfig);
