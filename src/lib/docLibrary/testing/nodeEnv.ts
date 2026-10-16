import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { sha256Hex } from "../../crypto/sha256";
import type { FingerprintEnv, PdfjsLike, RenderSurface } from "../fingerprintEngine";

/**
 * Entorno de la huella para Node (Vitest): pdf.js «legacy» + `@napi-rs/canvas`. El MISMO motor que corre en el
 * navegador, con otro lienzo.
 */
export function nodeEnv(overrides: Partial<FingerprintEnv> = {}): FingerprintEnv {
  return {
    getPdfjs: () => import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as Promise<PdfjsLike>,
    createCanvas: (width, height): RenderSurface => {
      const canvas = createCanvas(width, height);
      return { context: canvas.getContext("2d") as unknown as RenderSurface["context"] };
    },
    sha256: sha256Hex,
    documentParams: { standardFontDataUrl: path.join(process.cwd(), "public", "standard_fonts") + "/" },
    ...overrides,
  };
}
