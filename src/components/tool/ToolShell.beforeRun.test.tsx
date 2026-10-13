import { beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach } from "vitest";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { getTool } from "@/lib/tools-registry";

/** `beforeRun` y los campos `summary`/`notices` de `ProcessResult` (W5-U5), aditivos. */

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
afterEach(cleanup);

const TOOL = getTool("merge-pdf");
const OPTIONS = {};
const done = (): ProcessResult => ({ blob: new Blob(["x"]), filename: "salida.pdf" });

function mount(props: { beforeRun?: () => boolean | Promise<boolean>; process?: () => Promise<ProcessResult> }) {
  const process = props.process ?? vi.fn(async () => done());
  const view = render(
    <LanguageProvider>
      <ToolShell<object> tool={TOOL} defaultOptions={OPTIONS} process={process} beforeRun={props.beforeRun} />
    </LanguageProvider>,
  );
  fireEvent.change(view.container.querySelector('input[type="file"]') as HTMLInputElement, {
    target: { files: [new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" })] },
  });
  return { process };
}
const run = async () => fireEvent.click((await screen.findAllByRole("button", { name: "Procesar" }))[0]);

describe("ToolShell — beforeRun", () => {
  it("sin beforeRun todo sigue igual", async () => {
    const { process } = mount({});
    await run();
    await screen.findByRole("button", { name: "Descargar" });
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("false cancela sin procesar, sin overlay y sin error", async () => {
    const beforeRun = vi.fn(() => false);
    const { process } = mount({ beforeRun });
    await run();
    await waitFor(() => expect(beforeRun).toHaveBeenCalledTimes(1));
    expect(process).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Procesar" }).length).toBeGreaterThan(0);
  });

  it("una promesa que se resuelve a true procesa despues de esperarla", async () => {
    let accept: (ok: boolean) => void = () => {};
    const beforeRun = () => new Promise<boolean>((resolve) => (accept = resolve));
    const { process } = mount({ beforeRun });
    await run();
    expect(process).not.toHaveBeenCalled();
    accept(true);
    await screen.findByRole("button", { name: "Descargar" });
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("una promesa que se resuelve a false deja la herramienta lista para reintentar", async () => {
    let accept: (ok: boolean) => void = () => {};
    const beforeRun = vi.fn(() => new Promise<boolean>((resolve) => (accept = resolve)));
    const { process } = mount({ beforeRun });
    await run();
    accept(false);
    await waitFor(() => expect(beforeRun).toHaveBeenCalledTimes(1));
    await run();
    await waitFor(() => expect(beforeRun).toHaveBeenCalledTimes(2));
    expect(process).not.toHaveBeenCalled();
  });
});

describe("ToolShell — resumen y avisos de la descarga", () => {
  it("pasa `summary` y `notices` a la pantalla de descarga", async () => {
    mount({
      process: async () => ({
        ...done(),
        summary: "1 texto editado.",
        notices: { title: "Avisos", items: ["Uno", "Dos"] },
      }),
    });
    await run();
    await screen.findByRole("button", { name: "Descargar" });
    expect(document.querySelector("[data-download-summary]")!.textContent).toBe("1 texto editado.");
    const group = document.querySelector("[data-download-notices]") as HTMLElement;
    expect(group.getAttribute("role")).toBe("group");
    expect(Array.from(group.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["Uno", "Dos"]);
    // El boton de descarga los describe para los lectores de pantalla.
    // Por el titulo y por cada aviso, uno por uno: nunca por el grupo entero (Chromium lo leeria con todo su contenido, y la
    // lista dos veces).
    const describedBy = screen.getByRole("button", { name: "Descargar" }).getAttribute("aria-describedby")!;
    const ids = describedBy.split(" ");
    expect(ids).not.toContain(group.id);
    expect(ids).toContain(group.getAttribute("aria-labelledby"));
    for (const li of Array.from(group.querySelectorAll("li"))) expect(ids).toContain(li.id);
    const text = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    expect(text).toContain("Uno");
    expect(text).toContain("Dos");
  });

  it("sin resumen ni avisos la pantalla es la de siempre", async () => {
    mount({});
    await run();
    await screen.findByRole("button", { name: "Descargar" });
    expect(document.querySelector("[data-download-summary]")).toBeNull();
    expect(document.querySelector("[data-download-notices]")).toBeNull();
    expect(screen.getByRole("button", { name: "Descargar" }).getAttribute("aria-describedby")).toBeNull();
  });
});
