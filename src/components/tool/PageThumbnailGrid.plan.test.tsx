import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { PageThumbnailGrid } from "@/components/tool/PageThumbnailGrid";
import { effectivePlan } from "@/app/merge-pdf/MergeToolClient";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import type { PageRef } from "@/lib/pdf/core";

/**
 * Regresion (W6-D): el plan de paginas crecia archivo a archivo, y las miniaturas del primero se
 * renderizaban ANTES de leer el segundo. «Procesar» en ese intervalo unia solo las paginas ya
 * publicadas (40 de 42, en silencio). Ahora el plan se publica COMPLETO de una vez (y con los archivos a
 * los que pertenece) aunque las miniaturas tarden: aqui el render de miniaturas no termina nunca.
 */

const PAGES_BY_NAME: Record<string, number> = { "grande.pdf": 40, "anexo.pdf": 2 };

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async (file: File) => {
      // Lectura lenta: cada archivo tarda en abrirse.
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { numPages: PAGES_BY_NAME[file.name] ?? 1, getPage: async () => ({ cleanup: () => {} }) };
    },
    // Miniaturas que no acaban nunca: el plan no puede depender de ellas.
    renderPageToDataUrl: () => new Promise<string>(() => {}),
    closePdfDocument: async () => {},
  };
});

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

const file = (name: string) => new File([new Uint8Array([1])], name, { type: "application/pdf" });

describe("PageThumbnailGrid — el plan nunca se publica a medias", () => {
  it("con 40 + 2 paginas y miniaturas lentas, la primera emision con paginas ya trae las 42 y sus archivos", async () => {
    const files = [file("grande.pdf"), file("anexo.pdf")];
    const emissions: Array<{ count: number; planFiles: File[] | null }> = [];
    render(
      <LanguageProvider>
        <PageThumbnailGrid
          files={files}
          selectable
          reorderable
          removable
          onItemsChange={(items, meta) => emissions.push({ count: items.length, planFiles: meta.files })}
        />
      </LanguageProvider>,
    );
    await waitFor(() => expect(emissions.some((emission) => emission.count > 0)).toBe(true));

    const withPages = emissions.filter((emission) => emission.count > 0);
    // Ninguna emision intermedia (p. ej. 40): todas traen las 42.
    expect(withPages.every((emission) => emission.count === 42)).toBe(true);
    expect(withPages[0].planFiles).toBe(files);
    // Mientras no hay plan completo, no se declara ningun archivo.
    expect(emissions.filter((emission) => emission.count === 0).every((emission) => emission.planFiles === null)).toBe(true);
  });
});

describe("effectivePlan (Unir) — solo se usa un plan completo de ESTOS archivos", () => {
  const ref = (fileIndex: number, pageIndex: number, selected = true): PageRef => ({
    id: `${fileIndex}-${pageIndex}`,
    fileIndex,
    pageIndex,
    rotation: 0,
    selected,
  });

  it("plan de otros archivos o a medias: vacio (= todas las paginas de todos los archivos)", () => {
    const a = file("a.pdf");
    const b = file("b.pdf");
    const partial = [ref(0, 0), ref(0, 1)];
    expect(effectivePlan([a, b], { pages: partial, planFiles: null })).toEqual([]);
    expect(effectivePlan([a, b], { pages: partial, planFiles: [a] })).toEqual([]);
    expect(effectivePlan([b, a], { pages: partial, planFiles: [a, b] })).toEqual([]);
  });

  it("plan completo de estos mismos archivos: se respeta tal cual (con lo que la persona quito)", () => {
    const a = file("a.pdf");
    const b = file("b.pdf");
    const plan = [ref(0, 0), ref(1, 0, false)];
    expect(effectivePlan([a, b], { pages: plan, planFiles: [a, b] })).toBe(plan);
  });
});
