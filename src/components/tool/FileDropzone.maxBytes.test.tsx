import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { FileDropzone } from "@/components/tool/FileDropzone";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { getTool } from "@/lib/tools-registry";

/* El tope que dice la zona de carga («hasta X») es el de la herramienta, no siempre los 100 MB de los PDF. */

const MB = 1024 * 1024;
const GB = 1024 * MB;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

function dropzone(maxBytes?: number | null) {
  render(
    <LanguageProvider>
      <FileDropzone tool={getTool("image-converter")} files={[]} onFilesChange={() => {}} onError={() => {}} maxBytes={maxBytes} />
    </LanguageProvider>,
  );
  return document.querySelector("p.tabular-nums") as HTMLElement;
}

describe("FileDropzone · tope de peso", () => {
  it("por defecto, el de los PDF (100 MB)", () => {
    expect(dropzone().textContent).toMatch(/hasta\s100\sMB$/);
  });

  it("un tope propio sale redondo y sin partirse: «64 MB», «4 GB»", () => {
    expect(dropzone(64 * MB).textContent).toMatch(/hasta\s64\sMB$/);
  });

  it("4 GB", () => {
    expect(dropzone(4 * GB).textContent).toMatch(/hasta\s4\sGB$/);
  });

  it("el tope va en un trozo que no se parte (whitespace-nowrap)", () => {
    const line = dropzone(32 * MB);
    const limit = line.querySelector("span.whitespace-nowrap") as HTMLElement;
    expect(limit.textContent).toMatch(/^·\shasta\s32\sMB$/);
  });

  it("null quita la cifra y deja solo los formatos", () => {
    const line = dropzone(null);
    expect(line.textContent).not.toMatch(/hasta/);
    expect(line.textContent).toMatch(/^Acepta\s/);
    expect(screen.queryByText(/MB/)).toBeNull();
  });
});
