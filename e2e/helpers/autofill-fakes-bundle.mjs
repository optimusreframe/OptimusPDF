/**
 * Compila `src/app/sign-pdf/autofill/testing/installFakes.ts` (motor FALSO del autorrelleno) a un IIFE para inyectarlo con
 * `page.addInitScript` ANTES de la pagina: asi las pruebas E2E usan el gancho `globalThis.__optimusAutofillEngine` sin ninguna
 * ruta de prueba en el build. Uso: `node e2e/helpers/autofill-fakes-bundle.mjs <salida.js>`.
 */
import path from "node:path";
import { rolldown } from "rolldown";

const root = process.cwd();
const out = path.resolve(process.argv[2] ?? ".evidence/autofill-fakes.iife.js");
const bundle = await rolldown({
  input: path.join(root, "src/app/sign-pdf/autofill/testing/installFakes.ts"),
  platform: "browser",
  resolve: { alias: { "@": path.join(root, "src") } },
  logLevel: "silent",
});
await bundle.write({ file: out, format: "iife", minify: false });
await bundle.close();
console.log(out);
