import path from "node:path";
import { build } from "vite";

/**
 * Empaqueta con Vite (en memoria) el punto de entrada del motor del Escaner y su Web Worker. Se hace una vez por proceso.
 * El worker se entrega como texto: la pagina lo arranca desde un `blob:` (la CSP de la app permite `worker-src blob:`).
 */

async function bundle(entry: string, name: string): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: process.cwd(),
    resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
    // `core.ts` lee `process.env.NEXT_PUBLIC_PDFJS_VERSION` (Next lo sustituye al compilar; aqui lo fijamos).
    define: { "process.env.NEXT_PUBLIC_PDFJS_VERSION": JSON.stringify("0"), "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      write: false,
      minify: false,
      target: "es2022",
      rollupOptions: { output: { inlineDynamicImports: true } },
      lib: { entry: path.resolve(process.cwd(), entry), name, formats: ["iife"], fileName: () => `${name}.js` },
    },
  });
  const outputs = Array.isArray(output) ? output : [output];
  const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error(`no se pudo empaquetar ${entry}`);
  return chunk.code;
}

let cached: Promise<{ engine: string; worker: string }> | null = null;

export function scanBundles(): Promise<{ engine: string; worker: string }> {
  cached ??= (async () => ({
    engine: await bundle("e2e/helpers/scan-engine-entry.ts", "ScanLab"),
    worker: await bundle("src/lib/scan/renderWorker.ts", "ScanWorker"),
  }))();
  return cached;
}
