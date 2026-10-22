import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Worker de pdfjs-dist copiado tal cual desde node_modules: es codigo
    // de terceros minificado, no se lintea.
    "public/pdf.worker.min.mjs",
    // Respaldos en JavaScript de los decodificadores JPX / JBIG2 de pdfjs-dist (U7.0), copiados tal cual: tambien
    // codigo de terceros minificado (asignan `module`), no se lintea.
    "public/pdfjs-wasm/**",
  ]),
]);

export default eslintConfig;
