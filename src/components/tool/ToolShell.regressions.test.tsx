import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import { OptionsPanel } from "@/components/tool/OptionsPanel";
import { ToolShell, type InputPolicy, type ProcessResult } from "@/components/tool/ToolShell";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { en } from "@/lib/locales/en";
import { es } from "@/lib/locales/es";
import { loadPdf } from "@/lib/pdf/core";
import { createInputGuard, isRestrictionOnlyCopy, type InputCheck, type InputGuard } from "@/lib/pdf/inputGuard";
import {
  buildBadFile,
  buildEncryptedPdf,
  buildGoodPdf,
  pdfFile,
} from "@/lib/pdf/testing/inputFixtures";
import { getTool } from "@/lib/tools-registry";

/**
 * Regresiones de la ronda de verificacion V-B (N2, N4, N5, N7, N8): foco que nunca cae a <body>
 * (causa raiz: el bucle de reintento moria con la limpieza del efecto), aviso de archivo grande,
 * PDF «solo-propietario» en Proteger, pie fijo del panel y titulo de la hoja de contrasena.
 */

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
});

const SINGLE = getTool("rotate-pdf");
const MULTI = getTool("merge-pdf");
type Options = { note: string };

async function strictOpen(file: File): Promise<void> {
  (await loadPdf(file)).getPageCount();
}
const realGuard = createInputGuard({ open: strictOpen });

function mount(props: {
  tool?: typeof SINGLE;
  guard?: InputGuard | null;
  policy?: InputPolicy | "off";
  withOptions?: boolean;
}) {
  const process = vi.fn(async (): Promise<ProcessResult> => ({ blob: new Blob(["x"]), filename: "s.pdf" }));
  const utils = render(
    <LanguageProvider>
      <InputGuardContext.Provider value={props.guard === undefined ? realGuard : props.guard}>
        <ToolShell<Options>
          tool={props.tool ?? SINGLE}
          defaultOptions={{ note: "" }}
          process={process}
          inputPolicy={props.policy}
          renderOptions={props.withOptions ? () => <p>panel</p> : undefined}
        />
      </InputGuardContext.Provider>
    </LanguageProvider>,
  );
  return { ...utils, process };
}

const input = (container: HTMLElement) => container.querySelector('input[type="file"]') as HTMLInputElement;
const runButton = () => screen.getAllByRole("button", { name: "Procesar" })[0] as HTMLButtonElement;
const banner = () => document.querySelector<HTMLElement>("[data-error-banner]");
const good = async (name: string) => pdfFile(await buildGoodPdf(2), name);

/** El foco esta en un control de la pagina (nunca en <body>). */
function focusIsLogical(): boolean {
  const active = document.activeElement;
  return !!active && active !== document.body && active.isConnected;
}

describe("N2 — el foco nunca cae a <body>", () => {
  for (let round = 1; round <= 6; round += 1) {
    it(`«Elegir otro archivo» (ronda ${round}): al volver con un PDF bueno el foco esta en un control`, async () => {
      const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
      const { container } = mount({});
      fireEvent.change(input(container), { target: { files: [await buildBadFile("garbage")] } });
      const alert = await waitFor(() => {
        expect(banner()).toBeTruthy();
        return banner() as HTMLElement;
      });
      fireEvent.click(within(alert).getByRole("button", { name: "Elegir otro archivo" }));
      click.mockRestore();
      const picker = screen.getByLabelText("Elegir otro archivo", { selector: "input" }) as HTMLInputElement;
      fireEvent.change(picker, { target: { files: [await good("nuevo.pdf")] } });
      await waitFor(() => expect(banner()).toBeNull());
      await waitFor(() => expect(focusIsLogical()).toBe(true));
      // Sin pasar por <body>: primero el control de reserva (si la comprobacion sigue) y luego «Procesar».
      await waitFor(() => expect(document.activeElement?.textContent).toBe("Procesar"));
    });
  }

  it("el reintento sobrevive a que `checks` cambie mientras tanto (la comprobacion llega tarde)", async () => {
    // Causa raiz: el bucle de reintento se cancelaba en la limpieza del efecto. Con una comprobacion lenta,
    // `checks` cambia DESPUES de pedir el foco y el bucle moria: foco en <body>.
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    let release: (check: InputCheck) => void = () => {};
    let calls = 0;
    const guard: InputGuard = (file) => {
      calls += 1;
      if (calls === 1) return realGuard(file);
      return new Promise<InputCheck>((resolve) => {
        release = resolve;
      });
    };
    const { container } = mount({ guard });
    fireEvent.change(input(container), { target: { files: [await buildBadFile("garbage")] } });
    const alert = await waitFor(() => {
      expect(banner()).toBeTruthy();
      return banner() as HTMLElement;
    });
    fireEvent.click(within(alert).getByRole("button", { name: "Elegir otro archivo" }));
    click.mockRestore();
    const picker = screen.getByLabelText("Elegir otro archivo", { selector: "input" }) as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [await good("lento.pdf")] } });
    // La comprobacion sigue en curso: «Procesar» aun no se puede enfocar.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    // La comprobacion sigue en curso: el foco NO esta en <body>, sino en el control de reserva (el «Quitar» de la fila).
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Quitar");
    await act(async () => {
      release({ status: "ok" });
    });
    await waitFor(() => expect(document.activeElement?.textContent).toBe("Procesar"));
  });

  it("recuperacion: si el foco recien dado al banner se pierde en el render siguiente, vuelve a un control", async () => {
    // Causa raiz de la carrera: el destino se consumia al enfocar el banner con el DOM anterior y, si ese
    // render lo retiraba, nadie volvia a pedir el foco. Se reproduce de forma determinista: el foco se
    // suelta (como al desmontarse el banner) y llega un cambio de archivos dentro de la ventana de 2 s.
    const { container } = mount({ tool: MULTI });
    fireEvent.change(input(container), { target: { files: [await buildBadFile("empty")] } });
    const alert = await waitFor(() => {
      expect(banner()).toBeTruthy();
      return banner() as HTMLElement;
    });
    await waitFor(() => expect(alert.contains(document.activeElement)).toBe(true));
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    const inputs = container.querySelectorAll('input[type="file"]');
    fireEvent.change(inputs[inputs.length - 1], { target: { files: [await good("otro.pdf")] } });
    await waitFor(() => expect(focusIsLogical()).toBe(true));
  });

  it("quitar un archivo de varios con el banner: el foco va al «Quitar» del vecino, no a <body>", async () => {
    const { container } = mount({ tool: MULTI });
    fireEvent.change(input(container), {
      target: { files: [await good("a.pdf"), await buildBadFile("empty"), await good("c.pdf")] },
    });
    const alert = await waitFor(() => {
      expect(banner()).toBeTruthy();
      return banner() as HTMLElement;
    });
    fireEvent.click(within(alert).getByRole("button", { name: "Quitar archivo" }));
    await waitFor(() => expect(banner()).toBeNull());
    await waitFor(() => expect(focusIsLogical()).toBe(true));
    // El vecino que ocupa el sitio del quitado es c.pdf (indice 1 tras quitar el vacio).
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Quitar");
    expect(document.activeElement?.closest("li")?.textContent).toContain("c.pdf");
  });

  it("«Cancelar» en la hoja de contrasena con otros archivos buenos: el foco queda en un control", async () => {
    const { container } = mount({ tool: MULTI });
    fireEvent.change(input(container), {
      target: { files: [await good("a.pdf"), pdfFile(await buildEncryptedPdf("x"), "cifrado.pdf")] },
    });
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: es.tool.password.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(focusIsLogical()).toBe(true));
    expect(screen.queryByText("cifrado.pdf")).toBeNull();
  });

  it("quitar el ultimo archivo: el foco va a la zona de carga", async () => {
    const { container } = mount({});
    fireEvent.change(input(container), { target: { files: [await buildBadFile("empty")] } });
    const alert = await waitFor(() => {
      expect(banner()).toBeTruthy();
      return banner() as HTMLElement;
    });
    fireEvent.click(within(alert).getByRole("button", { name: "Quitar archivo" }));
    const pick = await screen.findByRole("button", { name: "Seleccionar archivo", hidden: false });
    await waitFor(() => expect(document.activeElement).toBe(pick));
  });

  it("con «Procesar» desactivado (canRun) el foco cae en el primer control util de la lista, no en <body>", async () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    const process = vi.fn(async (): Promise<ProcessResult> => ({ blob: new Blob(["x"]), filename: "s.pdf" }));
    const { container } = render(
      <LanguageProvider>
        <InputGuardContext.Provider value={realGuard}>
          <ToolShell<Options>
            tool={SINGLE}
            defaultOptions={{ note: "" }}
            process={process}
            canRun={() => ({ ok: false, reason: "Falta algo." })}
          />
        </InputGuardContext.Provider>
      </LanguageProvider>,
    );
    fireEvent.change(input(container), { target: { files: [await buildBadFile("garbage")] } });
    const alert = await waitFor(() => {
      expect(banner()).toBeTruthy();
      return banner() as HTMLElement;
    });
    fireEvent.click(within(alert).getByRole("button", { name: "Elegir otro archivo" }));
    click.mockRestore();
    const picker = screen.getByLabelText("Elegir otro archivo", { selector: "input" }) as HTMLInputElement;
    fireEvent.change(picker, { target: { files: [await good("nuevo.pdf")] } });
    await waitFor(() => expect(banner()).toBeNull());
    await waitFor(() => expect(focusIsLogical()).toBe(true));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Quitar");
  });
});

describe("N4 — archivo muy grande: aviso, no fallo", () => {
  it("en Dividir PDF NO se propone Dividir PDF", async () => {
    const { container } = mount({ tool: getTool("split-pdf") });
    fireEvent.change(input(container), { target: { files: [await buildBadFile("tooLarge")] } });
    const alert = await waitFor(() => {
      expect(banner()).toBeTruthy();
      return banner() as HTMLElement;
    });
    expect(alert.textContent).toContain(es.tool.errorHints.tooLarge);
    expect(alert.textContent).not.toContain("Dividir PDF");
  });

  it("en otra herramienta si se propone, y «Procesar» sigue activo", async () => {
    const { container } = mount({});
    fireEvent.change(input(container), { target: { files: [await buildBadFile("tooLarge")] } });
    const alert = await waitFor(() => {
      expect(banner()).toBeTruthy();
      return banner() as HTMLElement;
    });
    expect(alert.textContent).toContain("Dividir PDF");
    expect(alert.getAttribute("role")).toBe("status");
    expect(runButton().disabled).toBe(false);
  });

  it("ErrorBanner variant=warning es una region de estado; el error por defecto, una alerta", () => {
    const { rerender } = render(
      <ErrorBanner show title="t" message="m" dismissLabel="x" variant="warning" />,
    );
    expect(screen.getByRole("status").textContent).toContain("m");
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<ErrorBanner show title="t" message="m" dismissLabel="x" />);
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});

describe("N5 — Proteger con un PDF «solo-propietario»", () => {
  const link: InputPolicy = { encrypted: "link" };

  it("se abre una copia sin restricciones y se puede proteger: ni bloqueo ni «protegido con contraseña»", async () => {
    const lenient = createInputGuard({ open: async () => {} });
    const { container, process } = mount({ guard: lenient, policy: link });
    fireEvent.change(input(container), {
      target: { files: [pdfFile(await buildEncryptedPdf(""), "restringido.pdf")] },
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("restricciones de edición o impresión"),
    );
    expect(banner()).toBeNull();
    expect(document.body.textContent).not.toContain("protegido con contraseña");
    await waitFor(() => expect(runButton().disabled).toBe(false));
    fireEvent.click(runButton());
    await waitFor(() => expect(process).toHaveBeenCalledTimes(1));
    const received = (process.mock.calls[0] as unknown as [File[]])[0][0];
    expect(isRestrictionOnlyCopy(received)).toBe(true);
    await expect(loadPdf(received)).resolves.toBeTruthy();
  });

  it("con contrasena de apertura: UNA frase y UNA accion al enlace (sin pista repetida)", async () => {
    const { container } = mount({ policy: link });
    fireEvent.change(input(container), {
      target: { files: [pdfFile(await buildEncryptedPdf("secreta"), "cifrado.pdf")] },
    });
    const alert = await waitFor(() => {
      expect(banner()).toBeTruthy();
      return banner() as HTMLElement;
    });
    const sentences = alert.textContent?.match(/protegido con contraseña/g) ?? [];
    expect(sentences).toHaveLength(1);
    expect(within(alert).getAllByRole("link")).toHaveLength(1);
  });
});

describe("N7 — el pie del panel de opciones queda fijo", () => {
  it("el contenido se desplaza dentro del panel y el pie (con «Procesar») queda fuera de esa zona", () => {
    render(
      <LanguageProvider>
        <OptionsPanel open={false} onOpenChange={() => {}} footer={<button type="button">Procesar</button>}>
          <p>opcion</p>
        </OptionsPanel>
      </LanguageProvider>,
    );
    const aside = screen.getByRole("complementary");
    expect(aside.className).toContain("sticky");
    expect(aside.className).toContain("max-h-[calc(100dvh-9rem)]");
    expect(aside.className).toContain("flex-col");
    const scroller = aside.querySelector(".overflow-y-auto") as HTMLElement;
    expect(scroller).toBeTruthy();
    expect(scroller.textContent).toContain("opcion");
    const footerButton = within(aside).getByRole("button", { name: "Procesar" });
    // El boton del pie NO esta dentro de la zona con scroll: siempre visible.
    expect(scroller.contains(footerButton)).toBe(false);
  });
});

describe("N8 — copy", () => {
  it("el titulo de la hoja de contrasena cabe en una linea a 375 px (corto en los dos idiomas)", () => {
    expect(es.tool.password.title.length).toBeLessThanOrEqual(22);
    expect(en.tool.password.title.length).toBeLessThanOrEqual(22);
  });

  it("el motivo de «Procesar» desactivado se parametriza con el nombre real del boton", () => {
    expect(es.tool.blockedRun).toContain("{action}");
    expect(en.tool.blockedRun).toContain("{action}");
  });
});

describe("V-F — «Procesar» siempre a la vista", () => {
  it("hoja movil: el pie con «Procesar» es sticky al borde inferior de la hoja (las opciones se desplazan por encima)", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width: 767px"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    try {
      render(
        <LanguageProvider>
          <OptionsPanel open onOpenChange={() => {}} footer={<button type="button">Procesar</button>}>
            <p>opcion larga</p>
          </OptionsPanel>
        </LanguageProvider>,
      );
      const dialog = await screen.findByRole("dialog");
      const button = within(dialog).getByRole("button", { name: "Procesar" });
      const footer = button.closest(".sticky") as HTMLElement;
      expect(footer).toBeTruthy();
      expect(footer.className).toContain("bottom-0");
      // El contenido va ANTES del pie dentro de la zona con scroll.
      const scroller = dialog.querySelector(".overflow-y-auto") as HTMLElement;
      expect(scroller.contains(footer)).toBe(true);
      expect(scroller.textContent?.indexOf("opcion larga")).toBeLessThan(scroller.textContent?.indexOf("Procesar") ?? -1);
    } finally {
      window.matchMedia = original;
    }
  });

  it("herramienta sin panel: la barra con «Procesar» es sticky al borde inferior en escritorio", async () => {
    const { container } = mount({ guard: null });
    fireEvent.change(input(container), { target: { files: [await good("a.pdf")] } });
    await screen.findByText("a.pdf");
    const bar = screen.getAllByRole("button", { name: "Procesar" })[0].closest(".sticky") as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.className).toContain("bottom-0");
    expect(bar.className).toContain("md:block");
  });
});

describe("V-G — hoja movil de opciones abierta: el fondo es inerte", () => {
  it("la barra de fondo (con su «Procesar») y la columna principal quedan inertes mientras la hoja esta abierta", async () => {
    const { container } = mount({ guard: null, withOptions: true });
    fireEvent.change(input(container), { target: { files: [await good("a.pdf")] } });
    await screen.findByText("a.pdf");
    const bar = container.querySelector("[data-scrolled]") as HTMLElement;
    const column = container.querySelector(".min-w-0.flex-1") as HTMLElement;
    expect(bar.hasAttribute("inert")).toBe(false);
    expect(column.hasAttribute("inert")).toBe(false);

    fireEvent.click(within(bar).getByRole("button", { name: "Opciones" }));
    await waitFor(() => expect(bar.hasAttribute("inert")).toBe(true));
    expect(column.hasAttribute("inert")).toBe(true);
  });
});
