import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { ConvertTab } from "@/app/pdf-pro/tabs/ConvertTab";
import { __resetProExportsForTests, registerProExport } from "@/app/pdf-pro/ops/proExports";
import { labelsOf, mountTab } from "@/app/pdf-pro/tabs/docTestUtils";
import { es } from "@/lib/locales/es";

/** Pestaña «Convertir» (U5): contenedor de exportaciones; marcadores funcionales y punto de extension para U8. */

const downloaded = vi.hoisted(() => ({ items: [] as { blob: Blob; name: string }[] }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: (blob: Blob, name: string) => downloaded.items.push({ blob, name }) };
});

const T = PRO_STRINGS.es.docTools.convert;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => {
  downloaded.items.length = 0;
  __resetProExportsForTests();
});
afterEach(() => cleanup());

describe("ConvertTab", () => {
  it("muestra el titulo, la introduccion y una tarjeta por exportacion registrada", async () => {
    await mountTab(<ConvertTab />);
    expect(screen.getByRole("heading", { name: T.title })).toBeTruthy();
    expect(screen.getByText(T.intro)).toBeTruthy();
    const list = screen.getByRole("list", { name: T.title });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByRole("heading", { name: T.imagesTitle })).toBeTruthy();
    expect(within(list).getByRole("heading", { name: T.textTitle })).toBeTruthy();
  });

  it("los marcadores dicen «Próximamente» y abren la herramienta suelta en otra pestaña", async () => {
    await mountTab(<ConvertTab />);
    expect(screen.getAllByText(T.comingSoon)).toHaveLength(2);
    const link = screen.getByRole("link", { name: T.openTool(es.tools["pdf-to-jpg"].name) });
    expect(link.getAttribute("href")).toBe("/pdf-to-jpg");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("cada tarjeta indica si necesita conexion (hoy ninguna)", async () => {
    await mountTab(<ConvertTab />);
    expect(screen.getAllByText(T.localOnly)).toHaveLength(2);
    expect(screen.queryByText(T.requiresNetwork)).toBeNull();
  });

  it("una exportacion con `run` muestra su boton y descarga el resultado SIN tocar el historial", async () => {
    const run = vi.fn(async (...args: [Uint8Array, unknown]) => {
      void args;
      return { blob: new Blob(["png"]), filename: "paginas.zip" };
    });
    const { doc } = await mountTab(<ConvertTab />);
    registerProExport({ id: "images", title: () => "Imágenes PNG", body: () => "x", slug: "pdf-to-jpg", requiresNetwork: false, run });
    cleanup();
    const mounted = await mountTab(<ConvertTab />, { name: "informe.pdf" });
    fireEvent.click(screen.getByRole("button", { name: "Imágenes PNG" }));
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    expect(downloaded.items[0].name).toBe("paginas.zip");
    expect(run.mock.calls[0][1]).toMatchObject({ name: "informe.pdf", language: "es" });
    expect(labelsOf(mounted.doc)).toEqual(["Original"]);
    expect(doc).toBeTruthy();
  });

  it("si la exportacion falla muestra el error tipado y no descarga", async () => {
    const { PdfError } = await import("@/lib/pdf/core");
    registerProExport({
      id: "text",
      title: () => "Texto",
      body: () => "x",
      slug: "pdf-to-text",
      requiresNetwork: true,
      run: async () => {
        throw new PdfError("corrupt");
      },
    });
    await mountTab(<ConvertTab />);
    expect(screen.getByText(T.requiresNetwork)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Texto" }));
    expect((await screen.findByRole("alert")).textContent).toContain(es.tool.errors.corrupt);
    expect(downloaded.items).toHaveLength(0);
  });

  it("una exportacion cancelada no muestra error", async () => {
    const { PdfError } = await import("@/lib/pdf/core");
    registerProExport({
      id: "text",
      title: () => "Texto",
      body: () => "x",
      slug: "pdf-to-text",
      requiresNetwork: false,
      run: async () => {
        throw new PdfError("cancelled");
      },
    });
    await mountTab(<ConvertTab />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Texto" }));
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sin documento no pinta nada", async () => {
    const { container, doc } = await mountTab(<ConvertTab />);
    act(() => doc.close());
    expect(container.querySelector("[data-doc-tab='convert']")).toBeNull();
  });
});
