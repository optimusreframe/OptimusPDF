import type { RefObject } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  ToolShell,
  type ProcessResult,
  type ToolShellProps,
} from "@/components/tool/ToolShell";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { getTool } from "@/lib/tools-registry";

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

/**
 * `ToolShell` es el chasis compartido de ~25 herramientas -- estas
 * pruebas cubren especificamente los dos hooks aditivos de este cambio
 * (`renderDone`, `resetRef`), no el resto del componente (ya cubierto
 * indirectamente por cada `XxxToolClient.test.tsx`).
 */

const TOOL = getTool("merge-pdf");

type Options = { note: string };
const DEFAULT_OPTIONS: Options = { note: "" };

function pdfFile(name = "a.pdf"): File {
  return new File([new Uint8Array([1, 2, 3])], name, {
    type: "application/pdf",
  });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input[type="file"]');
  if (!input) throw new Error("no se encontro el input de archivo");
  return input as HTMLInputElement;
}

/** Mas de un boton "Procesar" coexiste (desktop/movil/panel): el primero basta. */
async function clickProcess(): Promise<void> {
  const buttons = await screen.findAllByRole("button", { name: "Procesar" });
  fireEvent.click(buttons[0]);
}

async function uploadAndRun(container: HTMLElement): Promise<void> {
  fireEvent.change(fileInput(container), { target: { files: [pdfFile()] } });
  await clickProcess();
}

describe("ToolShell — renderDone", () => {
  it("no se pinta antes de terminar, y se pinta con el resultado + opciones tras terminar", async () => {
    const process = vi.fn(
      async (): Promise<ProcessResult> => ({
        blob: new Blob(["x"]),
        filename: "salida.pdf",
      }),
    );

    const { container } = render(
      <LanguageProvider>
        <ToolShell<Options>
          tool={TOOL}
          defaultOptions={DEFAULT_OPTIONS}
          process={process}
          renderDone={({ result }) => (
            <p>listo: {result.filename}</p>
          )}
        />
      </LanguageProvider>,
    );

    expect(screen.queryByText(/listo:/)).toBeNull();

    await uploadAndRun(container);

    await waitFor(() =>
      expect(screen.getByText("listo: salida.pdf")).toBeTruthy(),
    );
  });

  it("el contexto no reenvia `reset`: el consumidor usa su propio `resetRef`", async () => {
    const process = vi.fn(
      async (): Promise<ProcessResult> => ({
        blob: new Blob(["x"]),
        filename: "salida.pdf",
      }),
    );
    const resetRef: { current: ((patch?: Partial<Options>) => void) | null } =
      { current: null };

    const { container } = render(
      <LanguageProvider>
        <ToolShell<Options>
          tool={TOOL}
          defaultOptions={DEFAULT_OPTIONS}
          process={process}
          resetRef={resetRef}
          renderDone={() => (
            <button type="button" onClick={() => resetRef.current?.()}>
              volver a empezar (custom)
            </button>
          )}
        />
      </LanguageProvider>,
    );

    await uploadAndRun(container);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "volver a empezar (custom)" }),
      ).toBeTruthy(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "volver a empezar (custom)" }),
    );

    // De vuelta a "idle": el dropzone principal reaparece.
    await waitFor(() =>
      expect(container.querySelector('input[type="file"]')).toBeTruthy(),
    );
    expect(screen.queryByText(/listo:/)).toBeNull();
  });
});

describe("ToolShell — resetRef", () => {
  /**
   * `resetRef` se prueba llamando `resetRef.current(...)` directamente
   * desde el test, no desde un boton dentro de `renderMain`/`renderOptions`
   * -- ambos dejan de pintarse en cuanto `phase === "processing"` (ver
   * `showWorkspace` en `ToolShell.tsx`), y el caso que mas importa
   * verificar es justo "reset mientras hay un `process()` en marcha".
   */
  function Harness({
    resetRef,
    onOptions,
    process,
  }: {
    resetRef: RefObject<((patch?: Partial<Options>) => void) | null>;
    onOptions: (options: Options) => void;
    process: ToolShellProps<Options>["process"];
  }) {
    return (
      <LanguageProvider>
        <ToolShell<Options>
          tool={TOOL}
          defaultOptions={DEFAULT_OPTIONS}
          process={process}
          resetRef={resetRef}
          renderOptions={({ options, setOptions }) => {
            onOptions(options);
            return (
              <button
                type="button"
                onClick={() => setOptions({ note: "algo escrito" })}
              >
                escribir nota
              </button>
            );
          }}
        />
      </LanguageProvider>
    );
  }

  /** Objeto mutable simple: `ToolShell` solo necesita un `.current` escribible. */
  function newRef(): RefObject<((patch?: Partial<Options>) => void) | null> {
    return { current: null };
  }

  it("fusiona el patch contra `defaultOptions`, no contra las opciones actuales", async () => {
    let last: Options = DEFAULT_OPTIONS;
    const resetRef = newRef();
    const process = vi.fn(
      async (): Promise<ProcessResult> => ({
        blob: new Blob(["x"]),
        filename: "salida.pdf",
      }),
    );

    const { container } = render(
      <Harness
        resetRef={resetRef}
        onOptions={(o) => (last = o)}
        process={process}
      />,
    );

    fireEvent.change(fileInput(container), {
      target: { files: [pdfFile()] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Opciones" }));
    fireEvent.click(
      screen.getByRole("button", { name: "escribir nota" }),
    );
    await waitFor(() => expect(last.note).toBe("algo escrito"));

    resetRef.current?.({ note: "reset con patch" });

    // Vuelve a "idle" (sin archivo): `renderOptions` no se pinta ahi, asi
    // que hace falta un archivo nuevo para volver a leer `options` --
    // exactamente el flujo real tras un reset parcial.
    await waitFor(() =>
      expect(container.querySelector('input[type="file"]')).toBeTruthy(),
    );
    fireEvent.change(fileInput(container), {
      target: { files: [pdfFile()] },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Opciones" }));
    await waitFor(() => expect(last.note).toBe("reset con patch"));
  });

  it("aborta un `process()` en marcha", async () => {
    const resetRef = newRef();
    const signalBox: { current: AbortSignal | null } = { current: null };
    const resolveBox: {
      current: ((value: ProcessResult) => void) | null;
    } = { current: null };
    const process = vi.fn(
      (
        _files: File[],
        _options: Options,
        _onProgress: unknown,
        signal: AbortSignal,
      ) => {
        signalBox.current = signal;
        return new Promise<ProcessResult>((resolve) => {
          resolveBox.current = resolve;
        });
      },
    ) satisfies ToolShellProps<Options>["process"];

    const { container } = render(
      <Harness resetRef={resetRef} onOptions={() => {}} process={process} />,
    );

    fireEvent.change(fileInput(container), {
      target: { files: [pdfFile()] },
    });
    await clickProcess();

    await waitFor(() => expect(signalBox.current).not.toBeNull());
    expect(signalBox.current!.aborted).toBe(false);

    resetRef.current?.();

    expect(signalBox.current!.aborted).toBe(true);

    // Si el `process` abortado igual resolviera despues (motor que no
    // escucha la señal a tiempo), el resultado tardio no debe reaparecer:
    // el `runId` ya quedo invalidado por el reset.
    resolveBox.current?.({ blob: new Blob(["x"]), filename: "tardio.pdf" });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/tardio/)).toBeNull();
  });
});
