import { createRef } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { InputGuardContext } from "@/components/tool/InputGuardContext";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { loadPdf } from "@/lib/pdf/core";
import { createInputGuard } from "@/lib/pdf/inputGuard";
import { buildGoodPdf, pdfFile } from "@/lib/pdf/testing/inputFixtures";
import { getTool } from "@/lib/tools-registry";

/*
 * Cargar archivos sin pasar por la zona de carga (`loadRef`) y los dos ganchos que Firmar usa en U0.3: `renderIdle` (contenido
 * sobre la zona de carga, solo sin archivos) y `onFilesChanged` (lo que la PERSONA cambia en la lista, no lo que se carga).
 */

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 1, height: 1 }] as unknown as DOMRectList;
  };
});

const TOOL = getTool("merge-pdf");
type Options = { note: string };
const guard = createInputGuard({
  open: async (file: File) => {
    (await loadPdf(file)).getPageCount();
  },
});

type Load = (files: File[], patch?: Partial<Options>) => void;

function mount(extra: Partial<React.ComponentProps<typeof ToolShell<Options>>> = {}) {
  const loadRef = createRef<Load | null>() as React.MutableRefObject<Load | null>;
  loadRef.current = null;
  const process = vi.fn(async (): Promise<ProcessResult> => ({ blob: new Blob(["x"]), filename: "s.pdf" }));
  const view = render(
    <LanguageProvider>
      <InputGuardContext.Provider value={guard}>
        <ToolShell<Options>
          tool={TOOL}
          defaultOptions={{ note: "" }}
          process={process}
          loadRef={loadRef}
          renderMain={({ files }) => <p data-testid="workspace">{`contenido de ${files.length}`}</p>}
          {...extra}
        />
      </InputGuardContext.Provider>
    </LanguageProvider>,
  );
  return { ...view, loadRef };
}

const good = async (name: string) => pdfFile(await buildGoodPdf(2), name);

describe("ToolShell: cargar con loadRef", () => {
  it("cargar los MISMOS archivos otra vez (el «Deshacer» de Firmar) vuelve a montar el contenido: se comprueban de nuevo", async () => {
    const a = await good("a.pdf");
    const b = await good("b.pdf");
    const { loadRef } = mount();
    await waitFor(() => expect(loadRef.current).not.toBeNull());
    act(() => loadRef.current!([a, b]));
    expect((await screen.findByTestId("workspace")).textContent).toBe("contenido de 2");

    // Vuelven a cargarse esos mismos `File` (ya comprobados antes): el contenido no puede quedarse sin montar.
    act(() => loadRef.current!([a, b]));
    await waitFor(() => expect(screen.getByTestId("workspace").textContent).toBe("contenido de 2"));
    // Y con uno solo, tambien.
    act(() => loadRef.current!([a]));
    await waitFor(() => expect(screen.getByTestId("workspace").textContent).toBe("contenido de 1"));
  });
});

describe("ToolShell: renderIdle y onFilesChanged", () => {
  it("`renderIdle` se pinta solo mientras no hay archivos, encima de la zona de carga", async () => {
    const { loadRef, container } = mount({ renderIdle: () => <p data-testid="idle">sin terminar</p> });
    expect(screen.getByTestId("idle")).toBeTruthy();
    expect(container.querySelector('input[type="file"]')).toBeTruthy();
    await waitFor(() => expect(loadRef.current).not.toBeNull());
    act(() => loadRef.current!([]));
    expect(screen.queryByTestId("idle")).toBeTruthy();
    const a = await good("a.pdf");
    act(() => loadRef.current!([a]));
    await waitFor(() => expect(screen.queryByTestId("idle")).toBeNull());
  });

  it("`onFilesChanged` recibe la lista nueva y la anterior al subir, quitar y reordenar; NO al cargar con loadRef", async () => {
    const seen: Array<[string[], string[]]> = [];
    const onFilesChanged = vi.fn((next: File[], previous: File[]) => {
      seen.push([next.map((file) => file.name), previous.map((file) => file.name)]);
    });
    const a = await good("a.pdf");
    const b = await good("b.pdf");
    const { loadRef, container } = mount({ onFilesChanged });

    // Subir (zona de carga): de [] a [a, b].
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [a, b] } });
    await screen.findByTestId("workspace");
    expect(seen).toEqual([[["a.pdf", "b.pdf"], []]]);

    // Quitar el segundo.
    fireEvent.click(screen.getAllByRole("button", { name: "Quitar" })[1]);
    await waitFor(() => expect(screen.getByTestId("workspace").textContent).toBe("contenido de 1"));
    expect(seen.at(-1)).toEqual([["a.pdf"], ["a.pdf", "b.pdf"]]);

    // Cargar con `loadRef` (reanudar un borrador, deshacer): NO es un cambio de la persona.
    const calls = onFilesChanged.mock.calls.length;
    act(() => loadRef.current!([a, b]));
    await waitFor(() => expect(screen.getByTestId("workspace").textContent).toBe("contenido de 2"));
    expect(onFilesChanged).toHaveBeenCalledTimes(calls);
  });
});
