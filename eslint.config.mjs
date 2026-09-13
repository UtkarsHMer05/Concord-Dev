import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    ignores: [
      ".next/**",
      "test-results/**",
      ".kilo/**",
      "node_modules/**",
      "wasm/dist/**",
      "public/wasm/**",
      "public/crdt-worker.js",
      "build/**",
    ],
  },
];

export default eslintConfig;
