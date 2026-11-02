import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ImageProblems } from "@/app/image-converter/ImageProblems";
import type { ConverterProblemEntry } from "@/app/image-converter/useConverterProblems";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

beforeAll(() => window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es"));

const entry = (name: string, problem: ConverterProblemEntry["problem"]): ConverterProblemEntry => ({
  file: new File([new Uint8Array([1])], name),
  problem,
});

function renderIt(problems: ConverterProblemEntry[], onRemove = vi.fn()) {
  const view = render(
    <LanguageProvider>
      <ImageProblems problems={problems} onRemove={onRemove} />
    </LanguageProvider>,
  );
  return { ...view, onRemove };
}

describe("ImageProblems · aviso previo de imagenes que no se pueden convertir", () => {
  it("sin problemas no pinta nada", () => {
    expect(renderIt([]).container.firstChild).toBeNull();
  });

  it("nombra CADA imagen con su motivo y avisa como alerta", () => {
    const { container } = renderIt([entry("iphone.heic", "heic"), entry("nota.jpg", "notImage"), entry("corte.png", "truncated")]);
    expect(screen.getByRole("alert").getAttribute("aria-label")).toBe("3 imágenes no se pueden convertir");
    const items = Array.from(container.querySelectorAll("[data-image-problems-list] li")).map((item) => item.textContent);
    expect(items).toEqual([
      "iphone.heic es HEIC y este navegador no puede abrirlo. Prueba en Safari o exporta la foto como JPEG.",
      "nota.jpg no es una imagen válida.",
      "corte.png está incompleta: el archivo se cortó.",
    ]);
  });

  it("singular cuando es una sola, y los limites del dispositivo salen con su cifra", () => {
    const { container } = renderIt([entry("enorme.png", "tooManyPixels"), entry("pesada.jpg", "tooBig")]);
    const items = Array.from(container.querySelectorAll("[data-image-problems-list] li")).map((item) => item.textContent);
    expect(items[0]).toMatch(/^enorme\.png tiene demasiados píxeles para abrirla en este dispositivo \(máximo \d+ Mpx\)\.$/);
    expect(items[1]).toMatch(/^pesada\.jpg pesa demasiado para abrirla en este dispositivo \(máximo [\d,.]+ MB\)\.$/);
    expect(renderIt([entry("a.png", "empty")]).container.querySelector("h3")?.textContent).toBe("1 imagen no se puede convertir");
  });

  it("«Quitar y continuar» avisa a quien lo usa", () => {
    const { onRemove } = renderIt([entry("a.png", "corrupt")]);
    fireEvent.click(screen.getByRole("button", { name: "Quitar y continuar" }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
