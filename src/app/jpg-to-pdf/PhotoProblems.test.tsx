import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PhotoProblems } from "@/app/jpg-to-pdf/PhotoProblems";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import type { ImageProblemEntry } from "@/lib/image/useImageProblems";

beforeAll(() => window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es"));

const entry = (name: string, problem: ImageProblemEntry["problem"]): ImageProblemEntry => ({ file: new File([new Uint8Array([1])], name), problem });

function renderIt(problems: ImageProblemEntry[], onRemove = vi.fn()) {
  const view = render(
    <LanguageProvider>
      <PhotoProblems problems={problems} onRemove={onRemove} />
    </LanguageProvider>,
  );
  return { ...view, onRemove };
}

describe("PhotoProblems · aviso previo de fotos inservibles", () => {
  it("sin problemas no pinta nada", () => {
    expect(renderIt([]).container.firstChild).toBeNull();
  });

  it("nombra CADA foto con su motivo y avisa como alerta", () => {
    const { container } = renderIt([entry("foto-12.jpg", "unreadable"), entry("IMG_7.png", "notImage"), entry("corte.jpg", "truncated")]);
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-label")).toBe("3 fotos no se pueden usar");
    const items = Array.from(container.querySelectorAll("[data-photo-problems-list] li")).map((item) => item.textContent);
    expect(items).toEqual([
      "foto-12.jpg no se pudo leer.",
      "IMG_7.png no es una imagen válida.",
      "corte.jpg está incompleta: el archivo se cortó y la foto saldría rota.",
    ]);
  });

  it("una sola foto en singular; HEIC dice como arreglarlo", () => {
    renderIt([entry("IMG_0001.HEIC", "heic")]);
    expect(screen.getByRole("alert").getAttribute("aria-label")).toBe("1 foto no se puede usar");
    expect(screen.getByText(/«Más compatible» en Ajustes › Cámara o exporta como JPEG/)).toBeTruthy();
  });

  it("«Quitar y continuar» avisa al padre una vez", () => {
    const { onRemove } = renderIt([entry("a.jpg", "corrupt"), entry("b.jpg", "empty")]);
    fireEvent.click(screen.getByRole("button", { name: "Quitar y continuar" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
