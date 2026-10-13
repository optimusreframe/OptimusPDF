import v8 from "node:v8";
import vm from "node:vm";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useViewerDocument } from "@/app/pdf-pro/viewer/useViewerDocument";
import { fakePdfDocument, pagesOf } from "@/app/pdf-pro/viewer/viewerMocks";
import type { ViewerSnapshot } from "@/app/pdf-pro/viewer/viewerTypes";

/**
 * El visor NO retiene los bytes de los snapshots que ya no muestra (Wave 9 · memoria). Medido en un navegador real:
 * tras 6 operaciones con un PDF de 100 MB quedaban TRES copias de documento vivas (actual, anterior y el ORIGINAL abierto
 * al principio) aunque el historial ya habia volcado el original a disco. La causa: `retry`, un `useCallback([])`, es la
 * funcion del primer render, y una funcion retiene el contexto entero del render que la creo, `bytes` incluidos.
 *
 * Aqui se comprueba con el recolector de basura de verdad (`WeakRef` + `gc`): los bytes de un snapshot superado, y los de
 * todos al desmontar, deben poder liberarse. Los simulacros de pdf.js no guardan los bytes que reciben (un `vi.fn` si los
 * guardaria en `mock.calls`).
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  const utils = await import("@/app/pdf-pro/viewer/viewerMocks");
  return {
    ...actual,
    // Funciones normales (no `vi.fn`): no guardan sus argumentos.
    openPdfDocument: async () => utils.fakePdfDocument(utils.pagesOf(3)) as never,
    closePdfDocument: async () => undefined,
  };
});

function getGc(): (() => void) | null {
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    return typeof gc === "function" ? gc : null;
  } catch {
    return null;
  }
}
const gc = getGc();

afterEach(cleanup);

const MB = 1024 * 1024;

/** Un snapshot con bytes propios; solo se devuelve el snapshot y una referencia DEBIL a sus bytes. */
function makeSnapshot(id: string): { snapshot: ViewerSnapshot; ref: WeakRef<Uint8Array> } {
  const bytes = new Uint8Array(6 * MB);
  bytes[0] = 37;
  return { snapshot: { id, bytes }, ref: new WeakRef(bytes) };
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/** Recoge la basura hasta que `ref` se vacie (o se agoten los intentos). */
async function collect(ref: WeakRef<Uint8Array>): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await tick();
    gc?.();
    if (ref.deref() === undefined) return true;
  }
  return false;
}

describe.skipIf(!gc)("el visor no retiene los bytes de snapshots superados", () => {
  it("al pasar a otro snapshot, los bytes del anterior (incluido el primero de la sesion) se pueden liberar", async () => {
    let current: ViewerSnapshot | null;
    const first = makeSnapshot("a");
    const refFirst = first.ref;
    current = first.snapshot;
    const { result, rerender } = renderHook(() => useViewerDocument(current));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(result.current.document?.snapshotId).toBe("a");

    // Se pasa por varios snapshots, como tras varias operaciones: ninguno de los superados se retiene.
    const refs: WeakRef<Uint8Array>[] = [refFirst];
    for (const id of ["b", "c", "d"]) {
      const next = makeSnapshot(id);
      refs.push(next.ref);
      current = next.snapshot;
      rerender();
      await waitFor(() => expect(result.current.document?.snapshotId).toBe(id));
    }
    // Se sueltan las referencias del propio test: lo unico que podria retenerlos es el visor. React conserva un
    // render anterior (su fibra «alterna») hasta el siguiente: unos repintados mas lo dejan limpio.
    first.snapshot.bytes = new Uint8Array(0);
    for (let i = 0; i < 3; i += 1) {
      rerender();
      await tick();
    }
    for (const ref of refs.slice(0, -1)) expect(await collect(ref)).toBe(true);
    // El actual sigue vivo mientras el visor lo muestra.
    expect(refs.at(-1)!.deref()).toBeDefined();
  });

  it("al desmontar el visor no queda ningun snapshot retenido", async () => {
    const a = makeSnapshot("a");
    let current: ViewerSnapshot | null = a.snapshot;
    const ref = a.ref;
    const { result, unmount } = renderHook(() => useViewerDocument(current));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    unmount();
    current = null;
    a.snapshot.bytes = new Uint8Array(0);
    expect(await collect(ref)).toBe(true);
  });

  it("reintentar (retry) no retiene los bytes del snapshot desde el que se llamo", async () => {
    const a = makeSnapshot("a");
    let current: ViewerSnapshot | null = a.snapshot;
    const ref = a.ref;
    const { result, rerender } = renderHook(() => useViewerDocument(current));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    result.current.retry();
    await waitFor(() => expect(result.current.status).toBe("ready"));
    current = makeSnapshot("b").snapshot;
    rerender();
    await waitFor(() => expect(result.current.document?.snapshotId).toBe("b"));
    a.snapshot.bytes = new Uint8Array(0);
    for (let i = 0; i < 3; i += 1) {
      rerender();
      await tick();
    }
    expect(await collect(ref)).toBe(true);
  });
});

describe("el entorno de la prueba", () => {
  it("dispone de un recolector de basura (si no, las pruebas de liberacion no pueden correr)", () => {
    expect(gc).not.toBeNull();
  });

  it("los simulacros de pdf.js sirven (la prueba no depende de un doble que retenga bytes)", async () => {
    const document = fakePdfDocument(pagesOf(2));
    expect(document.numPages).toBe(2);
  });
});
