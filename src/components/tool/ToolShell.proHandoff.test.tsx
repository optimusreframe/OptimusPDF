import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { clearHandoff, hasHandoff, takeHandoff } from "@/app/pdf-pro/proHandoff";
import { getTool } from "@/lib/tools-registry";
import { es } from "@/lib/locales/es";
import type { InputGuard } from "@/lib/pdf/inputGuard";

/**
 * «Abrir en PDF Pro» / «Seguir en PDF Pro» en el chasis de las herramientas: visible solo con un PDF
 * cargado, no en PDF Pro, y el archivo pasa por el store en memoria sin subirse.
 */

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(() => clearHandoff());
afterEach(cleanup);

type Options = Record<string, never>;
const OPTIONS: Options = {};

function pdf(name = "a.pdf") {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

function renderShell(
  slug: Parameters<typeof getTool>[0],
  props: Partial<React.ComponentProps<typeof ToolShell<Options>>> = {},
  guard?: InputGuard | null,
) {
  const tool = (
    <LanguageProvider>
      <ToolShell<Options>
        tool={getTool(slug)}
        defaultOptions={OPTIONS}
        process={async (): Promise<ProcessResult> => ({ blob: new Blob(["%PDF-"], { type: "application/pdf" }), filename: "salida.pdf" })}
        {...props}
      />
    </LanguageProvider>
  );
  return render(guard === undefined ? tool : <InputGuardContext.Provider value={guard}>{tool}</InputGuardContext.Provider>);
}

function upload(container: HTMLElement, ...files: File[]) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  fireEvent.change(input, { target: { files } });
}

/** jsdom no implementa la navegacion: el clic se cancela tras el manejador del enlace (que es lo que se prueba). */
function clickLink(link: HTMLElement) {
  link.addEventListener("click", (event) => event.preventDefault(), { once: true });
  fireEvent.click(link);
}

const openLink = () => screen.queryByRole("link", { name: es.tool.openInPro });

describe("ToolShell — «Abrir en PDF Pro»", () => {
  it("no se ofrece sin archivo cargado", () => {
    renderShell("merge-pdf");
    expect(openLink()).toBeNull();
  });

  it("con un PDF cargado aparece un enlace a /pdf-pro", async () => {
    const { container } = renderShell("rotate-pdf");
    upload(container, pdf());
    const link = await screen.findByRole("link", { name: es.tool.openInPro });
    expect(link.getAttribute("href")).toBe("/pdf-pro");
  });

  it("al pulsarlo deja el MISMO archivo en el traspaso, con la herramienta de origen", async () => {
    const { container } = renderShell("rotate-pdf");
    const file = pdf("informe.pdf");
    upload(container, file);
    clickLink(await screen.findByRole("link", { name: es.tool.openInPro }));
    const taken = takeHandoff();
    expect(taken?.file).toBe(file);
    expect(taken?.from).toBe("rotate-pdf");
  });

  it("no pasa nada con el archivo hasta que se pulsa (no se sube ni se guarda al cargarlo)", async () => {
    const { container } = renderShell("rotate-pdf");
    upload(container, pdf());
    await screen.findByRole("link", { name: es.tool.openInPro });
    expect(hasHandoff()).toBe(false);
  });

  it("en una herramienta de varios archivos (Unir PDF) abre el PRIMER PDF y lo dice en el title", async () => {
    const { container } = renderShell("merge-pdf");
    const first = pdf("uno.pdf");
    upload(container, first, pdf("dos.pdf"));
    const link = await screen.findByRole("link", { name: es.tool.openInPro });
    expect(link.getAttribute("title")).toBe(`${es.tool.openInPro}: uno.pdf`);
    clickLink(link);
    expect(takeHandoff()?.file).toBe(first);
  });

  it("con un solo archivo no pone title (el nombre ya es evidente)", async () => {
    const { container } = renderShell("merge-pdf");
    upload(container, pdf("uno.pdf"));
    expect((await screen.findByRole("link", { name: es.tool.openInPro })).getAttribute("title")).toBeNull();
  });

  it("no se ofrece en herramientas cuyo archivo no es un PDF (Imagen a PDF)", async () => {
    const { container } = renderShell("jpg-to-pdf");
    upload(container, new File([new Uint8Array([1, 2])], "foto.jpg", { type: "image/jpeg" }));
    await screen.findByText("foto.jpg");
    expect(openLink()).toBeNull();
  });

  it("no se ofrece en la propia herramienta PDF Pro", async () => {
    const { container } = renderShell("pdf-pro");
    upload(container, pdf());
    await screen.findByText("a.pdf");
    expect(openLink()).toBeNull();
  });

  it("se queda en la zona de archivos, junto al titulo «Archivos» (no se mezcla con «Procesar»)", async () => {
    const { container } = renderShell("rotate-pdf");
    upload(container, pdf());
    const link = await screen.findByRole("link", { name: es.tool.openInPro });
    const header = screen.getByRole("heading", { name: es.tool.filesTitle }).parentElement!;
    expect(header.contains(link)).toBe(true);
    expect(within(header).queryByRole("button", { name: es.tool.run })).toBeNull();
  });

  it("es un objetivo tactil de 44 px (boton ghost sm con HIT_44)", async () => {
    const { container } = renderShell("rotate-pdf");
    upload(container, pdf());
    expect((await screen.findByRole("link", { name: es.tool.openInPro })).className).toMatch(/pointer-coarse:before:h-11/);
  });

  it("no se ofrece mientras el archivo esta bloqueado (vacio, no PDF...): el banner manda", async () => {
    const guard: InputGuard = async () => ({ status: "problem", code: "corrupt" });
    const { container } = renderShell("rotate-pdf", {}, guard);
    upload(container, pdf("roto.pdf"));
    await waitFor(() => expect(screen.getByText(es.tool.fileProblemTitle)).toBeTruthy());
    expect(openLink()).toBeNull();
  });

  it("al quitar el archivo el enlace desaparece", async () => {
    const { container } = renderShell("rotate-pdf");
    upload(container, pdf());
    await screen.findByRole("link", { name: es.tool.openInPro });
    fireEvent.click(screen.getByRole("button", { name: es.tool.remove }));
    await waitFor(() => expect(openLink()).toBeNull());
  });

  it("no cambia el foco ni el orden: «Procesar» sigue ahi y habilitado", async () => {
    const { container } = renderShell("rotate-pdf");
    upload(container, pdf());
    await screen.findByRole("link", { name: es.tool.openInPro });
    expect((screen.getAllByRole("button", { name: es.tool.run })[0] as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("ToolShell — «Seguir en PDF Pro» tras procesar", () => {
  async function runToDone(slug: Parameters<typeof getTool>[0], result: ProcessResult) {
    const { container } = renderShell(slug, { process: async () => result });
    upload(container, pdf());
    fireEvent.click((await screen.findAllByRole("button", { name: es.tool.run }))[0]);
    await screen.findByRole("button", { name: es.tool.download });
  }

  it("con un PDF resultado ofrece seguir con ESE PDF, no con el de entrada", async () => {
    await runToDone("rotate-pdf", { blob: new Blob(["%PDF-1.4 salida"], { type: "application/pdf" }), filename: "girado.pdf" });
    const link = screen.getByRole("link", { name: es.tool.continueInPro });
    expect(link.getAttribute("href")).toBe("/pdf-pro");
    clickLink(link);
    const taken = takeHandoff()!;
    expect(taken.file.name).toBe("girado.pdf");
    expect(taken.file.type).toBe("application/pdf");
    expect(taken.file.size).toBe("%PDF-1.4 salida".length);
    expect(taken.from).toBe("rotate-pdf");
  });

  it("reconoce un PDF por la extension aunque el tipo MIME venga vacio", async () => {
    await runToDone("rotate-pdf", { blob: new Blob(["x"]), filename: "salida.PDF" });
    expect(screen.getByRole("link", { name: es.tool.continueInPro })).toBeTruthy();
  });

  it("no se ofrece si el resultado no es un PDF (ZIP, imagen, texto)", async () => {
    await runToDone("split-pdf", { blob: new Blob(["PK"], { type: "application/zip" }), filename: "partes.zip" });
    expect(screen.queryByRole("link", { name: es.tool.continueInPro })).toBeNull();
    expect(screen.getByRole("button", { name: es.tool.download })).toBeTruthy();
  });

  it("se ve debajo de «Descargar» y antes de «Empezar de nuevo»", async () => {
    await runToDone("rotate-pdf", { blob: new Blob(["%PDF-"], { type: "application/pdf" }), filename: "a.pdf" });
    const download = screen.getByRole("button", { name: es.tool.download });
    const link = screen.getByRole("link", { name: es.tool.continueInPro });
    const startOver = screen.getByRole("button", { name: es.tool.startOver });
    expect(download.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(link.compareDocumentPosition(startOver) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("«Sigue con estas» ya no sugiere PDF Pro (su acceso es el boton)", async () => {
    await runToDone("rotate-pdf", { blob: new Blob(["%PDF-"], { type: "application/pdf" }), filename: "a.pdf" });
    const related = screen.getByRole("heading", { name: es.tool.relatedTitle }).closest("section")!;
    expect(related.querySelector("a[href='/pdf-pro']")).toBeNull();
  });
});
