import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Configuracion minima de Vitest para los motores de `src/lib/pdf/`.
 *
 * Estos tests son de logica pura (generan y leen PDFs con
 * `@cantoo/pdf-lib` directamente en Node): no hace falta un entorno DOM
 * como `jsdom`, el entorno "node" por defecto basta. Solo se resuelve el
 * alias `@/*` -> `src/*` para poder importar los motores igual que lo hace
 * el resto del proyecto (ver `tsconfig.json`).
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
