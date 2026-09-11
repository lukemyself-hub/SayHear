import path from "node:path";

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
  // G1 startup verifies the exact synthetic F3 manifest, ledger, catalog, and
  // per-criterion artifacts from the deployed bundle. Keep those repository
  // files in the standalone trace instead of relying on the build cwd.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  outputFileTracingIncludes: {
    "/*": ["eval/**/*"],
  },
};

export default withWorkflow(nextConfig);
