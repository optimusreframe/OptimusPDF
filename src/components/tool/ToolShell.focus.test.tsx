import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { getTool } from "@/lib/tools-registry";

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  // jsdom no implementa requestAnimationFrame con temporizacion util para
  // los reintentos de foco: se resuelve en un microtask.
  window.requestAnimationFrame = (callback) => {
    queueMicrotask(() => callback(performance.now()));
    return 1;
  };
  window.cancelAnimationFrame = () => {};
  // Los elementos de jsdom no tienen caja: `isFocusable` exige rects.
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
});

const TOOL = getTool("merge-pdf");
type Options = { note: string };

function pdfFile(name = "a.pdf"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type="file"]') as HTMLInputElement;
}

type Deferred = {
  resolve: (value: ProcessResult) => void;
  reject: (reason: unknown) => void;
};

function renderShell(options: { deferred?: { current: Deferred | null }; fail?: boolean } = {}) {
  const process = vi.fn(
    (): Promise<ProcessResult> =>
      new Promise((resolve, reject) => {
        if (options.deferred) {
          options.deferred.current = { resolve, reject };
          return;
        }
        if (options.fail) reject(new Error("boom"));
        else resolve({ blob: new Blob(["x"]), filename: "salida.pdf" });
      }),
  );
  const utils = render(
    <LanguageProvider>
      <ToolShell<Options> tool={TOOL} defaultOptions={{ note: "" }} process={process} />
    </LanguageProvider>,
  );
  return { ...utils, process };
}

async function uploadTwo(container: HTMLElement) {
  fireEvent.change(fileInput(container), {
    target: { files: [pdfFile("a.pdf"), pdfFile("b.pdf")] },
  });
  await screen.findAllByRole("button", { name: "Procesar" });
}

async function clickProcess() {
  const buttons = await screen.findAllByRole("button", { name: "Procesar" });
  fireEvent.click(buttons[0]);
}

/**
 * Foco por fase: el overlay atrapa el foco mientras procesa y ToolShell lo
 * lleva al sitio logico al salir de cada fase (nunca a <body>).
 */
describe("ToolShell — foco", () => {
  it("al procesar, el dialogo recibe el foco, el resto queda inert y Tab cicla dentro", async () => {
    const deferred: { current: Deferred | null } = { current: null };
    const { container } = renderShell({ deferred });
    await uploadTwo(container);
    await clickProcess();

    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(dialog);
    // Todo hijo de body que no sea el overlay esta inert.
    const others = Array.from(document.body.children).filter(
      (child) => !child.hasAttribute("data-processing-overlay"),
    );
    expect(others.length).toBeGreaterThan(0);
    for (const child of others) expect(child.hasAttribute("inert")).toBe(true);

    // Tab desde el dialogo -> primer enfocable (Cancelar); Tab desde el
    // ultimo enfocable -> vuelve al primero; Shift+Tab desde el primero ->
    // ultimo.
    const cancel = screen.getByRole("button", { name: "Cancelar" });
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);

    // Al terminar, inert desaparece y el foco va a Descargar.
    await act(async () => {
      deferred.current?.resolve({ blob: new Blob(["x"]), filename: "salida.pdf" });
    });
    const download = await screen.findByRole("button", { name: "Descargar" });
    await waitFor(() => expect(document.activeElement).toBe(download));
    await waitFor(() => {
      for (const child of Array.from(document.body.children)) {
        expect(child.hasAttribute("inert")).toBe(false);
      }
    });
  });

  it("tras cancelar, el foco vuelve al boton Procesar", async () => {
    const deferred: { current: Deferred | null } = { current: null };
    const { container } = renderShell({ deferred });
    await uploadTwo(container);
    await clickProcess();
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null;
      expect(active?.textContent).toBe("Procesar");
    });
    expect(document.activeElement).not.toBe(document.body);
  });

  it("tras un error del motor, el foco vuelve al boton Procesar", async () => {
    const { container } = renderShell({ fail: true });
    await uploadTwo(container);
    await clickProcess();
    await screen.findByRole("alert");
    await waitFor(() =>
      expect((document.activeElement as HTMLElement | null)?.textContent).toBe("Procesar"),
    );
  });

  it("tras 'Empezar de nuevo', el foco va al boton de la zona de carga", async () => {
    const { container } = renderShell();
    await uploadTwo(container);
    await clickProcess();
    const download = await screen.findByRole("button", { name: "Descargar" });
    await waitFor(() => expect(document.activeElement).toBe(download));
    fireEvent.click(screen.getByRole("button", { name: "Empezar de nuevo" }));
    const pick = await screen.findByRole("button", { name: "Seleccionar archivos" });
    await waitFor(() => expect(document.activeElement).toBe(pick));
  });

  it("tras 'Quitar', el foco pasa al siguiente archivo y, sin archivos, a la zona de carga", async () => {
    const { container } = renderShell();
    await uploadTwo(container);
    const removeButtons = screen.getAllByRole("button", { name: "Quitar" });
    expect(removeButtons).toHaveLength(2);
    fireEvent.click(removeButtons[0]);
    await waitFor(() => {
      const remaining = screen.getAllByRole("button", { name: "Quitar" });
      expect(remaining).toHaveLength(1);
      expect(document.activeElement).toBe(remaining[0]);
    });
    fireEvent.click(screen.getByRole("button", { name: "Quitar" }));
    const pick = await screen.findByRole("button", { name: "Seleccionar archivos" });
    await waitFor(() => expect(document.activeElement).toBe(pick));
  });
});

describe("ToolShell — archivos omitidos", () => {
  it("con archivos mezclados, carga los validos y mantiene un aviso no bloqueante", async () => {
    const { container } = renderShell();
    const txt = new File(["hola"], "notes.txt", { type: "text/plain" });
    fireEvent.change(fileInput(container), {
      target: { files: [pdfFile("a.pdf"), pdfFile("b.pdf"), txt] },
    });
    await screen.findAllByRole("button", { name: "Procesar" });
    expect(screen.getByText("a.pdf")).toBeTruthy();
    expect(screen.queryByText("notes.txt")).toBeNull();
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Se omitió notes.txt: formato no admitido.");
    expect(screen.queryByRole("alert")).toBeNull();

    // Se descarta con su boton (la region sigue montada, solo se vacia)...
    fireEvent.click(screen.getByRole("button", { name: "Cerrar" }));
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("");

    // ...y tambien al añadir archivos nuevos (el aviso de ESA carga manda).
    const inputs = container.querySelectorAll('input[type="file"]');
    fireEvent.change(inputs[inputs.length - 1], {
      target: { files: [new File(["x"], "x.doc"), new File(["y"], "y.doc"), pdfFile("c.pdf")] },
    });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Se omitieron 2 archivos (x.doc, y.doc): formato no admitido.",
      ),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Quitar" })[0]);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(""));
  });

  it("la region role=status existe vacia antes del primer aviso y solo cambia su texto", async () => {
    // Varios lectores de pantalla no anuncian regiones vivas que nacen ya llenas:
    // el MISMO nodo debe estar montado desde el primer render, vacio y sin caja.
    const { container } = renderShell();
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(status.className).toBe("");
    expect(status.parentElement!.className).toBe("");
    expect(screen.queryByRole("button", { name: "Cerrar" })).toBeNull();

    // Primer aviso: el nodo es el mismo y solo cambia su texto.
    fireEvent.change(fileInput(container), {
      target: { files: [pdfFile("a.pdf"), new File(["hola"], "notes.txt", { type: "text/plain" })] },
    });
    await screen.findAllByRole("button", { name: "Procesar" });
    expect(screen.getByRole("status")).toBe(status);
    expect(status.textContent).toBe("Se omitió notes.txt: formato no admitido.");
    // El boton de cierre queda fuera de la region: no se lee junto al mensaje.
    expect(status.querySelector("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Cerrar" })).toBeTruthy();

    // Segundo aviso distinto: otra vez el mismo nodo con otro texto (se anuncia el cambio).
    const inputs = container.querySelectorAll('input[type="file"]');
    fireEvent.change(inputs[inputs.length - 1], {
      target: { files: [new File(["x"], "x.doc"), new File(["y"], "y.doc"), pdfFile("c.pdf")] },
    });
    await waitFor(() =>
      expect(status.textContent).toBe(
        "Se omitieron 2 archivos (x.doc, y.doc): formato no admitido.",
      ),
    );
    expect(screen.getByRole("status")).toBe(status);
  });

  it("si ningun archivo vale, el error bloqueante de siempre", async () => {
    const { container } = renderShell();
    fireEvent.change(fileInput(container), {
      target: { files: [new File(["hola"], "notes.txt", { type: "text/plain" })] },
    });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Ese formato no sirve para esta herramienta.");
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
