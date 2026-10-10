import { describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { render } from "@testing-library/react";
import { FileDropzone } from "@/components/tool/FileDropzone";
import { LanguageProvider, useI18n, type Language } from "@/lib/i18n";
import { getTool } from "@/lib/tools-registry";

/*
 * W6-C · D10: el <input type="file"> sr-only de la zona de carga (el de la
 * variante compacta «Añadir más archivos» era el que axe marcaba como `label`
 * en merge, pdfs-to-zip, jpg-to-pdf y pdf-to-pdfa) necesita un nombre
 * accesible aunque no sea tabulable (tabIndex -1).
 */
const multiple = { ...getTool("merge-pdf"), multiple: true };
const single = { ...getTool("compress-pdf"), multiple: false };

/** El idioma vive en un store con cache: se fija por el propio contexto. */
function Lang({ code }: { code: Language }) {
  const { setLanguage } = useI18n();
  useEffect(() => setLanguage(code), [code, setLanguage]);
  return null;
}

function input(language: Language, tool: typeof multiple, compact: boolean) {
  const view = render(
    <LanguageProvider>
      <Lang code={language} />
      <FileDropzone
        tool={tool}
        files={[]}
        onFilesChange={vi.fn()}
        onError={vi.fn()}
        compact={compact}
      />
    </LanguageProvider>,
  );
  return view.container.querySelector('input[type="file"]') as HTMLInputElement;
}

describe("FileDropzone — nombre accesible del input de archivo", () => {
  it("compacta (es): «Añadir más archivos»", () => {
    expect(input("es", multiple, true).getAttribute("aria-label")).toBe("Añadir más archivos");
  });

  it("compacta (en): «Add more files»", () => {
    expect(input("en", multiple, true).getAttribute("aria-label")).toBe("Add more files");
  });

  it("completa, varios archivos (es): «Seleccionar archivos»", () => {
    expect(input("es", multiple, false).getAttribute("aria-label")).toBe("Seleccionar archivos");
  });

  it("completa, un archivo (es): «Seleccionar archivo»", () => {
    expect(input("es", single, false).getAttribute("aria-label")).toBe("Seleccionar archivo");
  });

  it("completa, un archivo (en): «Select file»", () => {
    expect(input("en", single, false).getAttribute("aria-label")).toBe("Select file");
  });

  it("sigue siendo sr-only y fuera del orden de Tab (el botón visible es el control)", () => {
    const el = input("es", multiple, true);
    expect(el.className).toContain("sr-only");
    expect(el.tabIndex).toBe(-1);
  });
});
