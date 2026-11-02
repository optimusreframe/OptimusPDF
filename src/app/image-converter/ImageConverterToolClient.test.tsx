import { createCanvas } from "@napi-rs/canvas";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ImageConverterToolClient } from "@/app/image-converter/ImageConverterToolClient";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import type { ImageBackend } from "@/lib/media/image/convert";
import { BASELINE_SUPPORT, type OutputSupport } from "@/lib/media/image/formats";

/**
 * El convertidor entero dentro de `ToolShell` con un backend de mentira (el lienzo real se prueba en el E2E): opciones segun lo que
 * sabe crear el navegador, resultado con desglose y avisos, y el aviso de imagenes inservibles cuando no sale ninguna.
 */

const state = vi.hoisted(() => ({ support: null as OutputSupport | null, failNames: new Set<string>() }));

vi.mock("@/lib/media/image/browserBackend", async () => {
  const { BASELINE_SUPPORT: baseline } = await import("@/lib/media/image/formats");
  const { readImageHeader: header } = await import("@/lib/image/prepareForPdf");
  const { ImageConvertError: Failure } = await import("@/lib/media/image/convert");
  const backend: ImageBackend = {
    async render(file, job) {
      if (state.failNames.has((file as File).name)) throw new Failure("unreadable");
      const parsed = header(new Uint8Array(await file.arrayBuffer()));
      const sourceWidth = parsed.displayWidth ?? 10;
      const sourceHeight = parsed.displayHeight ?? 10;
      const size = job.planSize({ width: sourceWidth, height: sourceHeight });
      return { blob: new Blob([new Uint8Array(size.width * size.height)]), sourceWidth, sourceHeight, width: size.width, height: size.height, capped: size.capped };
    },
  };
  return {
    createBrowserBackend: () => backend,
    probeOutputSupport: async () => state.support ?? baseline,
    resetOutputSupportCache: () => {},
    yieldToMain: async () => {},
  };
});
// Las miniaturas y las cabeceras usan workers/lienzo que jsdom no tiene: aqui basta con que no avisen de nada.
vi.mock("@/lib/image/useImageProblems", () => ({ useImageProblems: () => [] }));
vi.mock("@/lib/image/useImageProbes", () => ({ useImageProbes: () => null }));

beforeAll(() => window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es"));
beforeEach(() => {
  state.support = null;
  state.failNames.clear();
});

function png(name: string, width = 40, height = 30): File {
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").fillRect(0, 0, width, height);
  return new File([new Uint8Array(canvas.toBuffer("image/png"))], name, { type: "image/png" });
}

function renderTool() {
  return render(
    <LanguageProvider>
      <ImageConverterToolClient />
    </LanguageProvider>,
  );
}

async function upload(container: HTMLElement, ...files: File[]) {
  fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files } });
  return (await screen.findAllByRole("button", { name: "Procesar" }))[0];
}

describe("opciones", () => {
  it("con la base segura ofrece JPG, PNG y BMP y dice que WebP y AVIF no aparecen porque el navegador no los crea", async () => {
    const { container } = renderTool();
    await upload(container, png("a.png"));
    const formats = screen.getByRole("tablist", { name: "Formato de salida" });
    expect(within(formats).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["JPG", "PNG", "BMP"]);
    expect(container.querySelector("[data-unavailable-formats]")?.textContent).toBe(
      "WebP, AVIF: este navegador no sabe crearlo, por eso no aparece. Prueba en otro navegador si lo necesitas.",
    );
  });

  it("cuando el navegador crea WebP lo ofrece (y AVIF sigue explicado si no)", async () => {
    state.support = { ...BASELINE_SUPPORT, webp: true };
    const { container } = renderTool();
    await upload(container, png("a.png"));
    await waitFor(() => expect(screen.getByRole("tab", { name: "WebP" })).toBeTruthy());
    expect(container.querySelector("[data-unavailable-formats]")?.textContent).toMatch(/^AVIF: /);
  });

  it("calidad y color de fondo solo cuando tienen sentido: JPG los tiene, PNG ninguno, BMP solo el fondo", async () => {
    const { container } = renderTool();
    await upload(container, png("a.png"));
    expect(screen.getByRole("slider", { name: "Calidad" })).toBeTruthy();
    expect(screen.getByLabelText("Color de fondo")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "PNG" }));
    expect(screen.queryByRole("slider", { name: "Calidad" })).toBeNull();
    expect(screen.queryByLabelText("Color de fondo")).toBeNull();
    expect(screen.getByText(/PNG no pierde calidad/)).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "BMP" }));
    expect(screen.queryByRole("slider", { name: "Calidad" })).toBeNull();
    expect(screen.getByLabelText("Color de fondo")).toBeTruthy();
  });

  it("el tamaño muestra su campo segun el modo, y el ancho se puede escribir cifra a cifra", async () => {
    const { container } = renderTool();
    await upload(container, png("a.png"));
    expect(screen.queryByLabelText("Ancho máximo (px)")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Ancho máx." }));
    const width = screen.getByLabelText("Ancho máximo (px)") as HTMLInputElement;
    expect(width.value).toBe("1920");
    fireEvent.change(width, { target: { value: "1" } });
    expect(width.value).toBe("1");
    fireEvent.change(width, { target: { value: "800" } });
    fireEvent.blur(width);
    expect(width.value).toBe("800");
    fireEvent.change(width, { target: { value: "2" } });
    fireEvent.blur(width);
    // Por debajo del minimo se recoge al minimo.
    expect(width.value).toBe("16");
    fireEvent.click(screen.getByRole("tab", { name: "Porcentaje" }));
    expect(screen.getByRole("slider", { name: "Escala" })).toBeTruthy();
  });

  it("dice que se borran los metadatos y solo avisa del GIF cuando hay uno", async () => {
    const { container } = renderTool();
    await upload(container, png("a.png"));
    expect(screen.getByText(/se borran los metadatos/)).toBeTruthy();
    expect(screen.queryByText(/primer fotograma/)).toBeNull();
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [new File([new Uint8Array([1])], "anim.gif", { type: "image/gif" })] } });
    await waitFor(() => expect(screen.getByText(/primer fotograma/)).toBeTruthy());
  });
});

describe("conversion", () => {
  it("una imagen: descarga directa con su nombre, resumen y desglose antes → despues", async () => {
    const { container } = renderTool();
    const run = await upload(container, png("foto.png", 40, 30));
    fireEvent.click(run);
    await waitFor(() => expect(screen.getByText("foto-convertida.jpg", { selector: "p" })).toBeTruthy());
    expect(container.querySelector("[data-download-summary]")?.textContent).toMatch(/^Convertida a JPG: de \d+ B a 1,2 KB\.$/);
    const rows = container.querySelectorAll("[data-converted-row]");
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("foto-convertida.jpg");
    expect(rows[0].textContent).toContain("→");
    expect(rows[0].textContent).toContain("40 × 30 px");
  });

  it("varias con una mala: ZIP, y el resultado nombra la que no se pudo convertir con su motivo", async () => {
    const { container } = renderTool();
    state.failNames.add("rota.png");
    const run = await upload(container, png("a.png"), png("rota.png"), png("b.png"));
    fireEvent.click(run);
    await waitFor(() => expect(screen.getByText("imagenes-convertidas.zip")).toBeTruthy());
    const notices = container.querySelector("[data-download-notices]") as HTMLElement;
    expect(within(notices).getByText("2 de 3 imágenes convertidas. No se pudo convertir:")).toBeTruthy();
    expect(within(notices).getByText("rota.png: no se pudo abrir en este navegador.")).toBeTruthy();
    expect(container.querySelectorAll("[data-converted-row]")).toHaveLength(2);
    expect(container.querySelector("[data-download-summary]")?.textContent).toMatch(/^2 imágenes convertidas a JPG/);
  });

  it("si NINGUNA se convierte: error del shell y la imagen mala queda nombrada con «Quitar y continuar»", async () => {
    const { container } = renderTool();
    state.failNames.add("rota.png");
    const run = await upload(container, png("rota.png"));
    fireEvent.click(run);
    const alert = await waitFor(() => {
      const found = container.querySelector("[data-image-problems]");
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(alert.textContent).toContain("rota.png");
    expect(alert.textContent).toContain("no se pudo abrir en este navegador.");
    fireEvent.click(within(alert).getByRole("button", { name: "Quitar y continuar" }));
    await waitFor(() => expect(container.querySelector("[data-image-problems]")).toBeNull());
  });
});
