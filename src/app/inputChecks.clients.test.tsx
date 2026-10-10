import type { ComponentType } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import { blockedRunText } from "@/components/tool/errorCopy";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { loadPdf } from "@/lib/pdf/core";
import { createInputGuard } from "@/lib/pdf/inputGuard";
import {
  EXPECTED_CODE,
  buildBadFile,
  buildGoodPdf,
  pdfFile,
  type BadFileKind,
} from "@/lib/pdf/testing/inputFixtures";
import { CompressToolClient } from "@/app/compress-pdf/CompressToolClient";
import { PdfToJpgClient } from "@/app/pdf-to-jpg/PdfToJpgClient";
import { PdfToWordClient } from "@/app/pdf-to-word/PdfToWordClient";
import { ProtectToolClient } from "@/app/protect-pdf/ProtectToolClient";
import { RemovePagesToolClient } from "@/app/remove-pages/RemovePagesToolClient";
import { RotateToolClient } from "@/app/rotate-pdf/RotateToolClient";
import { SplitToolClient } from "@/app/split-pdf/SplitToolClient";
import { ExtractPagesToolClient } from "@/app/extract-pages/ExtractPagesToolClient";

/**
 * Wave 6 · U1 sobre HERRAMIENTAS REALES (no un shell de juguete): los archivos
 * malos de verdad entran por el input de cada cliente y todos explican el mismo
 * problema con las mismas palabras, con «Procesar» desactivado y el motivo a la
 * vista. Las miniaturas (pdf.js) se sustituyen por un tablero fijo de 3 paginas.
 */

vi.mock("@/app/organize-pdf/pageToolkit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/organize-pdf/pageToolkit")>();
  return {
    ...actual,
    usePageThumbnails: () => ({ pageCount: 3, thumbs: {}, loading: false, error: null }),
  };
});
vi.mock("@/components/tool/PageThumbnailGrid", () => ({ PageThumbnailGrid: () => null }));

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  window.requestAnimationFrame = (callback) => {
    queueMicrotask(() => callback(performance.now()));
    return 1;
  };
  window.cancelAnimationFrame = () => {};
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
});

const guard = createInputGuard({
  open: async (file) => {
    (await loadPdf(file)).getPageCount();
  },
});

const CLIENTS: Array<[string, ComponentType]> = [
  ["split-pdf", SplitToolClient],
  ["remove-pages", RemovePagesToolClient],
  ["rotate-pdf", RotateToolClient],
  ["compress-pdf", CompressToolClient],
  ["protect-pdf", ProtectToolClient],
  ["pdf-to-jpg", PdfToJpgClient],
  ["pdf-to-word", PdfToWordClient],
  ["extract-pages", ExtractPagesToolClient],
];

function renderClient(Client: ComponentType) {
  return render(
    <LanguageProvider>
      <InputGuardContext.Provider value={guard}>
        <Client />
      </InputGuardContext.Provider>
    </LanguageProvider>,
  );
}

function input(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

function runButton(): HTMLButtonElement {
  return screen.getAllByRole("button", { name: "Procesar" })[0] as HTMLButtonElement;
}

/** El texto que el banner tiene que mostrar para cada archivo malo (un PDF cifrado abre la hoja de contrasena en todas, Proteger incluida). */
function expectedText(kind: BadFileKind, _slug: string): string {
  const code = EXPECTED_CODE[kind];
  if (code === "encrypted") return es.tool.encryptedSheetMessage;
  return es.tool.errors[code];
}

const BLOCKING: BadFileKind[] = ["garbage", "truncated", "empty", "notPdf", "encrypted", "renamedPng"];

describe("herramientas reales — los archivos malos dan el MISMO mensaje en todas", () => {
  for (const [slug, Client] of CLIENTS) {
    describe(slug, () => {
      for (const kind of BLOCKING) {
        it(`${kind}: «${EXPECTED_CODE[kind]}», Procesar desactivado con motivo`, async () => {
          const { container } = renderClient(Client);
          fireEvent.change(input(container), { target: { files: [await buildBadFile(kind)] } });

          const alert = await screen.findByRole("alert");
          expect(alert.textContent).toContain(expectedText(kind, slug));
          expect(alert.textContent).not.toContain(es.tool.errors.unknown);
          await waitFor(() => expect(runButton().disabled).toBe(true));
          const reason = document.getElementById(runButton().getAttribute("aria-describedby") ?? "");
          expect(reason?.textContent).toBe(blockedRunText(es, "Procesar"));
          expect(within(alert).getByRole("button", { name: "Quitar archivo" })).toBeTruthy();
        });
      }

      it("tooLarge: avisa con su pista, sin bloquear", async () => {
        const { container } = renderClient(Client);
        fireEvent.change(input(container), { target: { files: [await buildBadFile("tooLarge")] } });
        await waitFor(() => expect(document.querySelector("[data-error-banner]")).toBeTruthy());
        const banner = document.querySelector<HTMLElement>("[data-error-banner]");
        expect(banner?.getAttribute("role")).toBe("status");
        expect(banner?.textContent).toContain(es.tool.errors.tooLarge);
        expect(banner?.textContent).toContain(es.tool.largeFileTitle);
        // Dividir PDF no se propone a si mismo.
        expect(banner?.textContent).toContain(
          slug === "split-pdf" ? es.tool.errorHints.tooLarge : es.tool.errorHints.tooLargeSplit,
        );
      });
    });
  }
});

describe("herramientas reales — un PDF bueno entra sin banner", () => {
  for (const [slug, Client] of CLIENTS) {
    it(`${slug}: sin banner de archivo`, async () => {
      const { container } = renderClient(Client);
      fireEvent.change(input(container), {
        target: { files: [pdfFile(await buildGoodPdf(3), "bueno.pdf")] },
      });
      await screen.findByText("bueno.pdf");
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.queryByRole("alert")).toBeNull();
    });
  }
});

describe("protect-pdf — contrasena sin el banner generico duplicado", () => {
  async function loadGood() {
    const view = renderClient(ProtectToolClient);
    fireEvent.change(input(view.container), {
      target: { files: [pdfFile(await buildGoodPdf(2), "bueno.pdf")] },
    });
    await screen.findByText("bueno.pdf");
    return view;
  }

  function reasonText(): string | undefined {
    return document.getElementById(runButton().getAttribute("aria-describedby") ?? "")?.textContent ?? undefined;
  }

  it("sin contraseña: Procesar desactivado con «Escribe una contraseña…» y SIN ningun role=alert", async () => {
    await loadGood();
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(reasonText()).toBe("Escribe una contraseña para cifrar el documento.");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(es.tool.errors.unknown)).toBeNull();
  });

  it("contraseña corta: el motivo cambia a «al menos 4 caracteres»", async () => {
    await loadGood();
    const fields = screen.getAllByLabelText(/contraseña/i, { selector: "input" });
    fireEvent.change(fields[0], { target: { value: "ab" } });
    await waitFor(() => expect(reasonText()).toBe("Usa al menos 4 caracteres."));
  });

  it("sin repetirla: pide la confirmacion (no dice que 'no coinciden')", async () => {
    await loadGood();
    const fields = screen.getAllByLabelText(/contraseña/i, { selector: "input" });
    fireEvent.change(fields[0], { target: { value: "clave-larga" } });
    await waitFor(() => expect(reasonText()).toBe("Repite la contraseña para confirmarla."));
  });

  it("confirmacion distinta: «no coinciden» en el motivo y en el campo, sin banner", async () => {
    await loadGood();
    const fields = screen.getAllByLabelText(/contraseña/i, { selector: "input" });
    fireEvent.change(fields[0], { target: { value: "clave-larga" } });
    fireEvent.change(fields[1], { target: { value: "otra-distinta" } });
    await waitFor(() => expect(reasonText()).toBe("Las dos contraseñas no coinciden."));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("contraseña y confirmacion iguales: Procesar se activa y el motivo desaparece", async () => {
    await loadGood();
    const fields = screen.getAllByLabelText(/contraseña/i, { selector: "input" });
    fireEvent.change(fields[0], { target: { value: "clave-larga" } });
    fireEvent.change(fields[1], { target: { value: "clave-larga" } });
    await waitFor(() => expect(runButton().disabled).toBe(false));
    expect(runButton().hasAttribute("aria-describedby")).toBe(false);
  });
});

describe("remove-pages — sin paginas marcadas", () => {
  it("Procesar desactivado con «Marca al menos una página para quitar.» y sin alert", async () => {
    const { container } = renderClient(RemovePagesToolClient);
    fireEvent.change(input(container), {
      target: { files: [pdfFile(await buildGoodPdf(3), "tres.pdf")] },
    });
    await screen.findByText("tres.pdf");
    await waitFor(() => expect(runButton().disabled).toBe(true));
    const reason = document.getElementById(runButton().getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe("Marca al menos una página para quitar.");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("rotate-pdf y split-pdf — el motivo se ve", () => {
  it("rotate: por página sin ninguna girada no se puede procesar", async () => {
    const { container } = renderClient(RotateToolClient);
    fireEvent.change(input(container), {
      target: { files: [pdfFile(await buildGoodPdf(3), "tres.pdf")] },
    });
    await screen.findByText("tres.pdf");
    // «Todo» (por defecto) siempre vale; por página sin girar ninguna, no.
    fireEvent.click(await screen.findByRole("tab", { name: "Por página" }));
    await waitFor(() => expect(runButton().disabled).toBe(true));
    expect(
      document.getElementById(runButton().getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Gira al menos una página para poder procesar.");
  });

  it("split: el plan por defecto (un rango con todo) se puede procesar", async () => {
    const { container } = renderClient(SplitToolClient);
    fireEvent.change(input(container), {
      target: { files: [pdfFile(await buildGoodPdf(3), "tres.pdf")] },
    });
    await screen.findByText("tres.pdf");
    // El tablero publica el plan al leer las paginas (simulado por el mock).
    await waitFor(() => expect(runButton().disabled).toBe(false));
  });
});
