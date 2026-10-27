/**
 * Compila `src/lib/scan/testing/installFakes.ts` (motor y almacen FALSOS del Escaner) a un IIFE para inyectarlo con
 * `page.addInitScript` ANTES de la pagina: asi las pruebas E2E usan los ganchos `globalThis.__optimusScanEngine` /
 * `__optimusScanStore` sin ninguna ruta de prueba en el build. Uso: `node e2e/helpers/scan-fakes-bundle.mjs <salida.js>`.
 */
import path from "node:path";
import { rolldown } from "rolldown";

const root = process.cwd();
const out = path.resolve(process.argv[2] ?? ".evidence/scan-fakes.iife.js");
const bundle = await rolldown({
  input: path.join(root, "src/lib/scan/testing/installFakes.ts"),
  platform: "browser",
  resolve: { alias: { "@": path.join(root, "src") } },
  logLevel: "silent",
});
await bundle.write({ file: out, format: "iife", minify: false });
await bundle.close();
console.log(out);
