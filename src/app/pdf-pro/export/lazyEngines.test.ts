import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CARGA DIFERIDA de los motores de conversion (Wave 7 · U8): docx, exceljs, pptxgenjs, jszip (y los motores que los
 * importan) NO pueden entrar en el paquete inicial de `/pdf-pro`; solo se cargan con `import()` al exportar o al
 * insertar un archivo. El E2E `pdf-pro-bundle.spec.ts` lo mide en un navegador real; esta prueba lo vigila en el
 * codigo: ningun archivo de PDF Pro (salvo las pruebas) los importa de forma ESTATICA (un `import type` si vale).
 */

const ROOT = path.resolve(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** Modulos de valor importados estaticamente (sin `import type`). */
function staticValueImports(code: string): string[] {
  const found: string[] = [];
  const pattern = /^import\s+(?!type\b)(?:[\s\S]*?\sfrom\s+)?["']([^"']+)["']\s*;?/gm;
  for (const match of code.matchAll(pattern)) found.push(match[1]);
  return found;
}

const HEAVY_PACKAGES = new Set([
  "docx",
  "exceljs",
  "pptxgenjs",
  "jszip",
  "tesseract.js",
  "html2canvas",
  "jspdf",
  "pdfmake",
  "mammoth",
  "html-to-pdfmake",
  "@huggingface/transformers",
  "@mlc-ai/web-llm",
]);

const HEAVY_ENGINES =
  /^@\/lib\/pdf\/(pdfToWord|pdfToExcel|pdfToCsv|pdfToJson|pdfToMarkdown|pdfToPowerpoint|pdfToImages|pdfToText|pdfsToZip|wordToPdf|excelToPdf|htmlToPdf|imagesToPdf|ocrGuard|summarize|compare|scanToPdf)$/;

describe("ningun archivo de PDF Pro importa de forma estatica un motor pesado", () => {
  const files = sources(ROOT);

  it("hay codigo que revisar", () => {
    expect(files.length).toBeGreaterThan(80);
  });

  it("paquetes pesados: solo con import() dinamico", () => {
    const offenders = files.flatMap((file) =>
      staticValueImports(readFileSync(file, "utf8"))
        .filter((specifier) => HEAVY_PACKAGES.has(specifier))
        .map((specifier) => `${path.relative(ROOT, file)} → ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it("motores de conversion: solo con import() dinamico (los tipos con `import type` valen)", () => {
    const offenders = files.flatMap((file) =>
      staticValueImports(readFileSync(file, "utf8"))
        .filter((specifier) => HEAVY_ENGINES.test(specifier))
        .map((specifier) => `${path.relative(ROOT, file)} → ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });

  it("los ocho motores de exportacion y los tres de importacion se cargan con import() en su sitio", () => {
    const runners = readFileSync(path.join(ROOT, "export/exportRunners.ts"), "utf8");
    for (const engine of ["pdfToImages", "pdfToText", "pdfToWord", "pdfToExcel", "pdfToCsv", "pdfToMarkdown", "pdfToJson", "pdfToPowerpoint"]) {
      expect(runners, engine).toContain(`await import("@/lib/pdf/${engine}")`);
    }
    const imports = readFileSync(path.join(ROOT, "create/importConvert.ts"), "utf8");
    for (const engine of ["wordToPdf", "excelToPdf", "htmlToPdf"]) {
      expect(imports, engine).toContain(`await import("@/lib/pdf/${engine}")`);
    }
    const images = readFileSync(path.join(ROOT, "create/fromImages.ts"), "utf8");
    expect(images).toContain('await import("@/lib/pdf/imagesToPdf")');
  });

  it("el analizador de importaciones distingue `import type` de un import de valor", () => {
    const code = [
      'import type { A } from "@/lib/pdf/pdfToWord";',
      'import { b } from "@/lib/pdf/pdfToExcel";',
      'import { type C, d } from "docx";',
      'import "jszip";',
      'const lazy = () => import("@/lib/pdf/pdfToCsv");',
    ].join("\n");
    expect(staticValueImports(code)).toEqual(["@/lib/pdf/pdfToExcel", "docx", "jszip"]);
  });
});
