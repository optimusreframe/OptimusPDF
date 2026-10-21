import { beforeAll, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileList } from "@/components/tool/FileList";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

/** VI-07 (integracion M4): «Subir», «Bajar» y el asa estaban pegados (0 px); ahora van en un `ButtonGroup` (4 px raton, 8 px dedo). */
describe("FileList — separacion de «Subir» y «Bajar»", () => {
  it("los botones de reordenar comparten un grupo con separacion de dedo", () => {
    const files = [new File(["a"], "uno.pdf", { type: "application/pdf" }), new File(["b"], "dos.pdf", { type: "application/pdf" })];
    render(
      <LanguageProvider>
        <FileList files={files} onChange={() => undefined} reorderable />
      </LanguageProvider>,
    );
    const up = screen.getAllByRole("button", { name: "Subir" })[0];
    const group = up.parentElement as HTMLElement;
    expect(group.className).toContain("gap-1");
    expect(group.className).toContain("pointer-coarse:gap-2");
    expect(group.contains(screen.getAllByRole("button", { name: "Bajar" })[0])).toBe(true);
  });
});
