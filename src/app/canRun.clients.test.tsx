import type { ComponentType } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { buildGoodPdf, pdfFile } from "@/lib/pdf/testing/inputFixtures";
import { WatermarkToolClient } from "@/app/add-watermark/WatermarkToolClient";
import { CropToolClient } from "@/app/crop-pdf/CropToolClient";
import { ExtractPagesToolClient } from "@/app/extract-pages/ExtractPagesToolClient";
import { MergeToolClient } from "@/app/merge-pdf/MergeToolClient";
import { OrganizeToolClient } from "@/app/organize-pdf/OrganizeToolClient";
import { RedactToolClient } from "@/app/redact-pdf/RedactToolClient";

/**
 * Wave 6 · U2: «Procesar» deshabilitado, con el motivo a la vista, cuando no hay
 * nada que procesar. Cada herramienta con ese riesgo, montada de verdad; los
 * lienzos de pdf.js (recorte, tachado, miniaturas) se sustituyen por un boton que
 * emite el cambio que interesa.
 */

vi.mock("@/app/organize-pdf/pageToolkit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/organize-pdf/pageToolkit")>();
  return {
    ...actual,
    usePageThumbnails: () => ({ pageCount: 3, thumbs: {}, loading: false, error: null }),
  };
});

vi.mock("@/components/tool/PageThumbnailGrid", () => ({
  PageThumbnailGrid: ({
    files,
    onItemsChange,
  }: {
    files: File[];
    onItemsChange?: (
      pages: Array<{ id: string; fileIndex: number; pageIndex: number; rotation: number; selected: boolean }>,
      meta: { files: File[] | null },
    ) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        // El plan ya esta completo (meta.files = los archivos actuales), con todo desmarcado.
        onItemsChange?.(
          [
            { id: "0:0", fileIndex: 0, pageIndex: 0, rotation: 0, selected: false },
            { id: "1:0", fileIndex: 1, pageIndex: 0, rotation: 0, selected: false },
          ],
          { files },
        )
      }
    >
      desmarcar todo
    </button>
  ),
}));

vi.mock("@/app/crop-pdf/CropCanvas", () => ({
  CropCanvas: ({ onRectChange }: { onRectChange: (rect: { x: number; y: number; width: number; height: number }) => void }) => (
    <button type="button" onClick={() => onRectChange({ x: 0.4, y: 0.4, width: 0.01, height: 0.01 })}>
      encoger
    </button>
  ),
}));

vi.mock("@/app/redact-pdf/RedactCanvas", () => ({
  RedactCanvas: ({
    onElementsChange,
  }: {
    onElementsChange: (elements: unknown[]) => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onElementsChange([
            { kind: "rect", pageIndex: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
          ])
        }
      >
        dibujar zona
      </button>
      <button type="button" onClick={() => onElementsChange([])}>
        borrar zonas
      </button>
    </div>
  ),
}));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

function renderClient(Client: ComponentType) {
  return render(
    <LanguageProvider>
      <InputGuardContext.Provider value={null}>
        <Client />
      </InputGuardContext.Provider>
    </LanguageProvider>,
  );
}

async function load(container: HTMLElement, ...names: string[]) {
  const files = await Promise.all(names.map(async (name) => pdfFile(await buildGoodPdf(3), name)));
  fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, {
    target: { files },
  });
  await screen.findByText(names[0]);
}

function runButton(): HTMLButtonElement {
  return screen.getAllByRole("button", { name: "Procesar" })[0] as HTMLButtonElement;
}

function reason(): string | undefined {
  return document.getElementById(runButton().getAttribute("aria-describedby") ?? "")?.textContent ?? undefined;
}

describe("redact-pdf — sin zonas", () => {
  it("Procesar desactivado con «Dibuja al menos una zona…» y SIN role=alert", async () => {
    const { container } = renderClient(RedactToolClient);
    await load(container, "informe.pdf");
    expect(runButton().disabled).toBe(true);
    expect(reason()).toBe("Dibuja al menos una zona antes de procesar.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("dibujar una zona lo activa; borrarla lo vuelve a desactivar", async () => {
    const { container } = renderClient(RedactToolClient);
    await load(container, "informe.pdf");
    fireEvent.click(screen.getByRole("button", { name: "dibujar zona" }));
    await waitFor(() => expect(runButton().disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "borrar zonas" }));
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(reason()).toBe("Dibuja al menos una zona antes de procesar.");
  });

  it("el aviso de «sin zonas» ya no se repite en el panel (una sola vez, junto al boton)", async () => {
    const { container } = renderClient(RedactToolClient);
    await load(container, "informe.pdf");
    // Panel (escritorio) + barra movil (md:hidden): nunca en tres sitios como antes (panel + alerta + banner).
    expect(screen.getAllByText("Dibuja al menos una zona antes de procesar.")).toHaveLength(2);
    expect(document.querySelectorAll("[role=alert]")).toHaveLength(0);
  });
});

describe("add-watermark — texto o imagen vacios", () => {
  it("con el texto por defecto se puede procesar", async () => {
    const { container } = renderClient(WatermarkToolClient);
    await load(container, "contrato.pdf");
    expect(runButton().disabled).toBe(false);
  });

  it("vaciar el texto desactiva Procesar con «Escribe el texto que quieres estampar.»", async () => {
    const { container } = renderClient(WatermarkToolClient);
    await load(container, "contrato.pdf");
    const field = screen.getByLabelText("Texto de la marca") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "   " } });
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(reason()).toBe("Escribe el texto que quieres estampar.");
  });

  it("marca de imagen sin imagen: «Elige la imagen…»", async () => {
    const { container } = renderClient(WatermarkToolClient);
    await load(container, "contrato.pdf");
    fireEvent.click(screen.getByRole("tab", { name: "Imagen" }));
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(reason()).toBe("Elige la imagen que se usará como marca.");
  });
});

describe("crop-pdf — selección diminuta", () => {
  it("por defecto se puede; una seleccion casi puntual no", async () => {
    const { container } = renderClient(CropToolClient);
    await load(container, "plano.pdf");
    expect(runButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "encoger" }));
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(reason()).toContain("La selección es demasiado pequeña");
  });
});

describe("merge-pdf — todas las páginas desmarcadas", () => {
  it("con dos archivos se puede; sin ninguna pagina marcada, no", async () => {
    const { container } = renderClient(MergeToolClient);
    await load(container, "a.pdf", "b.pdf");
    expect(runButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "desmarcar todo" }));
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(reason()).toBe(es.tool.needPageSelected);
  });

  it("con un solo archivo: «necesita al menos dos»", async () => {
    const { container } = renderClient(MergeToolClient);
    await load(container, "a.pdf");
    expect(runButton().disabled).toBe(true);
    expect(reason()).toBe(es.tool.errors.needTwo);
  });
});

describe("organize-pdf — sin cambios", () => {
  it("el plan identico al documento no se puede procesar", async () => {
    const { container } = renderClient(OrganizeToolClient);
    await load(container, "libro.pdf");
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(reason()).toBe("Reordena, gira, quita o añade alguna página para poder procesar.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("extract-pages — lista escrita mal", () => {
  it("por defecto extrae todo; una lista con sintaxis rota desactiva Procesar", async () => {
    const { container } = renderClient(ExtractPagesToolClient);
    await load(container, "libro.pdf");
    await waitFor(() => expect(runButton().disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("Páginas a extraer"), { target: { value: "x-y" } });
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(reason()).toBeTruthy();
  });
});

describe("N8 — marca de agua con el texto vacío: el motivo se lee UNA vez", () => {
  it("sin alerta en linea en el panel: solo el motivo junto a «Procesar»", async () => {
    const { container } = renderClient(WatermarkToolClient);
    await load(container, "contrato.pdf");
    fireEvent.change(screen.getByLabelText("Texto de la marca"), { target: { value: "" } });
    await waitFor(() => expect(runButton().disabled).toBe(true));
    const message = "Escribe el texto que quieres estampar.";
    const aside = screen.getByRole("complementary");
    // Dentro del panel de escritorio: exactamente una vez (el motivo del pie), sin role=alert.
    expect(within(aside).getAllByText(message)).toHaveLength(1);
    expect(document.querySelectorAll("[role=alert]")).toHaveLength(0);
  });

  it("marca de imagen sin imagen: tambien una sola vez", async () => {
    const { container } = renderClient(WatermarkToolClient);
    await load(container, "contrato.pdf");
    fireEvent.click(screen.getByRole("tab", { name: "Imagen" }));
    await waitFor(() => expect(runButton().disabled).toBe(true));
    const aside = screen.getByRole("complementary");
    expect(within(aside).getAllByText("Elige la imagen que se usará como marca.")).toHaveLength(1);
  });
});
