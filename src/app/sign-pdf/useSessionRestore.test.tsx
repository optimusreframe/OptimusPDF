import "fake-indexeddb/auto";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { HASH, SESSION_ID, seedDocument, seedSession } from "@/app/sign-pdf/draftTestUtils";
import { clearAllDrafts, type DraftEntry } from "@/app/sign-pdf/signDrafts";
import { useSessionRestore } from "@/app/sign-pdf/useSessionRestore";

/** Recargar con `/sign-pdf?s=<id>` restaura la sesion sola (U0.3): con un id valido que existe, que no existe, basura, o `?resume=`. */

beforeEach(async () => {
  window.history.replaceState(null, "", "/sign-pdf");
  await clearAllDrafts();
});
afterEach(() => {
  vi.restoreAllMocks();
});

function mount(search: string) {
  window.history.replaceState(null, "", `/sign-pdf${search}`);
  const onResume = vi.fn<(entry: DraftEntry) => void>();
  const view = renderHook(() => useSessionRestore(onResume));
  return { onResume, ...view };
}

describe("useSessionRestore", () => {
  it("sin `s` en la direccion no hace nada", async () => {
    await seedSession();
    const { onResume, result } = mount("");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(onResume).not.toHaveBeenCalled();
    expect(result.current.gone).toBe(false);
  });

  it("con el id de una SESION guardada la retoma una sola vez y deja `?s=` como esta (es la sesion)", async () => {
    const id = await seedSession();
    const { onResume, result } = mount(`?s=${id}`);
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(onResume.mock.calls[0][0].kind).toBe("session");
    expect(onResume.mock.calls[0][0].meta.id).toBe(id);
    expect(result.current.gone).toBe(false);
    expect(window.location.search).toBe(`?s=${id}`);
  });

  it("con la huella de un DOCUMENTO suelto retoma ese borrador (no una sesion)", async () => {
    const key = await seedDocument();
    await seedSession();
    const { onResume } = mount(`?s=${key}`);
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(onResume.mock.calls[0][0].kind).toBe("document");
    expect(onResume.mock.calls[0][0].meta.id).toBe(key);
  });

  it("restaura el borrador CORRECTO entre varios", async () => {
    const wanted = await seedSession({ id: SESSION_ID("w"), names: ["Uno.pdf", "Dos.pdf"] });
    await seedSession({ id: SESSION_ID("x"), names: ["Otro.pdf", "Mas.pdf"], keys: [HASH("e"), HASH("f")] });
    await seedDocument();
    const { onResume } = mount(`?s=${wanted}`);
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    expect(onResume.mock.calls[0][0].meta.id).toBe(wanted);
  });

  it("si el borrador ya no existe avisa (`gone`) y limpia `s` de la direccion", async () => {
    await seedSession();
    const { onResume, result } = mount(`?s=${SESSION_ID("z")}`);
    await waitFor(() => expect(result.current.gone).toBe(true));
    expect(onResume).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("un id de sesion NO restaura la huella de un documento, ni al reves (el tipo cuenta)", async () => {
    await seedDocument({ key: HASH("c") });
    const { onResume, result } = mount(`?s=${SESSION_ID("a")}`);
    await waitFor(() => expect(result.current.gone).toBe(true));
    expect(onResume).not.toHaveBeenCalled();
  });

  it.each([
    "?s=basura",
    "?s=%3Cscript%3E",
    `?s=${"x".repeat(500)}`,
    `?s=${SESSION_ID("a")}&s=${SESSION_ID("b")}`,
    `?s=${HASH("A")}`,
    "?s=",
  ])("un `s` manipulado (%s) no restaura nada, no avisa y se limpia", async (search) => {
    await seedSession();
    const { onResume, result } = mount(search);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(onResume).not.toHaveBeenCalled();
    expect(result.current.gone).toBe(false);
    expect(new URLSearchParams(window.location.search).has("s")).toBe(false);
  });

  it("con `?resume=` manda ese (Recientes): este hook no restaura ni toca la direccion", async () => {
    const id = await seedSession();
    const { onResume } = mount(`?resume=session:${id}&s=${id}`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(onResume).not.toHaveBeenCalled();
    expect(window.location.search).toContain("resume=");
  });

  it("el doble efecto de StrictMode no restaura dos veces", async () => {
    const id = await seedSession();
    window.history.replaceState(null, "", `/sign-pdf?s=${id}`);
    const onResume = vi.fn();
    renderHook(() => useSessionRestore(onResume), { wrapper: StrictMode });
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("el aviso `gone` se retira con `dismiss` o en cuanto la persona elige un archivo", async () => {
    const first = mount(`?s=${SESSION_ID("z")}`);
    await waitFor(() => expect(first.result.current.gone).toBe(true));
    act(() => first.result.current.dismiss());
    expect(first.result.current.gone).toBe(false);
    first.unmount();

    const second = mount(`?s=${SESSION_ID("y")}`);
    await waitFor(() => expect(second.result.current.gone).toBe(true));
    const input = document.createElement("input");
    input.type = "file";
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(second.result.current.gone).toBe(false);
    input.remove();
  });
});
