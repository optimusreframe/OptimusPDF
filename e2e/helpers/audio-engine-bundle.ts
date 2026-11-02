import path from "node:path";
import { build } from "vite";

/** Empaqueta con Vite (en memoria, una vez por proceso) el motor de audio para inyectarlo en la pagina. */
let cached: Promise<string> | null = null;

export function audioLabBundle(): Promise<string> {
  cached ??= (async () => {
    const output = await build({
      configFile: false,
      logLevel: "silent",
      root: process.cwd(),
      resolve: { alias: { "@": path.resolve(process.cwd(), "src") } },
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      build: {
        write: false,
        minify: false,
        target: "es2022",
        rollupOptions: { output: { inlineDynamicImports: true } },
        lib: { entry: path.resolve(process.cwd(), "e2e/helpers/audio-engine-entry.ts"), name: "AudioLab", formats: ["iife"], fileName: () => "AudioLab.js" },
      },
    });
    const outputs = Array.isArray(output) ? output : [output];
    const chunk = outputs.flatMap((result) => ("output" in result ? result.output : [])).find((item) => item.type === "chunk");
    if (!chunk || chunk.type !== "chunk") throw new Error("no se pudo empaquetar el motor de audio");
    return chunk.code;
  })();
  return cached;
}
