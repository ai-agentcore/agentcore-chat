import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  serverExternalPackages: ["ali-oss", "better-sqlite3"],
  outputFileTracingExcludes: {
    "/*": ["./data/**/*", "./**/*.private.json*", "./**/*.sqlite*", "./.env*", "./tests/**/*", "./artifacts/**/*", "./functions/**/*"],
  },
};

export default nextConfig;
