import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  turbopack: {
    rules: {
      // See scripts/spz-wasm-nul-loader.cjs: without this, `next build` emits a
      // Cesium chunk that throws "Octal escape sequences are not allowed in
      // template strings" and the globe never renders. `next dev` doesn't minify,
      // which is why it only shows up in production.
      "*.js": {
        condition: { path: /@spz-loader\/core\/dist\/index\.js$/ },
        loaders: [require.resolve("./scripts/spz-wasm-nul-loader.cjs")],
      },
    },
  },
};

export default nextConfig;
