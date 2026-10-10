import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CameraStage } from "@/app/scan-to-pdf/CameraStage";
import { STRINGS } from "@/app/scan-to-pdf/strings";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

/*
 * W6-C · N6: los dos <input type=file> sr-only de scan-to-pdf no tenian
 * etiqueta (axe `label` x2) y el de «Elegir fotos» aparecia ademas como un
 * SEGUNDO boton con el mismo nombre que el visible. Ahora cada uno lleva un
 * nombre propio, distinto del de los botones, y queda fuera del arbol de
 * accesibilidad y de Tab (los abre el boton visible).
 */
beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

function inputs() {
  render(
    <LanguageProvider>
      <CameraStage filter="color" onCapture={vi.fn()} onImport={vi.fn()} />
    </LanguageProvider>,
  );
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));
}

describe("CameraStage — inputs de archivo ocultos", () => {
  it("hay exactamente dos y los dos tienen nombre accesible", () => {
    const found = inputs();
    expect(found).toHaveLength(2);
    const [files, camera] = found;
    expect(files.getAttribute("aria-label")).toBeTruthy();
    expect(camera.getAttribute("aria-label")).toBeTruthy();
  });

  it("los nombres son distintos entre si y distintos de los botones visibles", () => {
    const [files, camera] = inputs();
    const names = [files.getAttribute("aria-label"), camera.getAttribute("aria-label")];
    expect(new Set(names).size).toBe(2);
    for (const button of [STRINGS.es.uploadInstead, STRINGS.es.nativeCamera]) {
      expect(names).not.toContain(button);
    }
  });

  it("quedan fuera del arbol de accesibilidad y de Tab: el boton visible es el unico control", () => {
    for (const input of inputs()) {
      expect(input.getAttribute("aria-hidden")).toBe("true");
      expect(input.tabIndex).toBe(-1);
    }
  });

  it("no aparecen como un segundo boton con el nombre del visible", () => {
    inputs();
    expect(screen.getAllByRole("button", { name: STRINGS.es.uploadInstead })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: STRINGS.es.nativeCamera })).toHaveLength(1);
  });
});
