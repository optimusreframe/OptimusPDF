import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  __resetEditDraftsMemoryForTests,
  __setEditDraftsLimitsForTests,
  clearAllEditDrafts,
  fingerprintPdfBytes,
  listEditDrafts,
  loadEditDraft,
  saveEditDraft,
} from "@/app/edit-pdf/editDrafts";
import { applyOp, createEditSession, newTextEdit, textItem } from "@/app/edit-pdf/editSession";
import { useEditDrafts } from "@/app/edit-pdf/useEditDrafts";
import { useEditSession } from "@/app/edit-pdf/useEditSession";

/**
 * Borradores integrados en la herramienta (W5-U5) con IndexedDB de verdad
 * (fake-indexeddb): restaurar al reabrir el MISMO pdf, autoguardar, empezar de
 * cero y los casos en que no se guarda nada.
 */

const BYTES = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10, 1, 2, 3]);
const file = () => new File([BYTES as BlobPart], "informe.pdf", { type: "application/pdf" });

const textOp = (id: string, text = "Hola") =>
  ({
    type: "add",
    item: textItem(newTextEdit({ id, pageIndex: 0, box: { x: 10, y: 10, width: 100, height: 20 }, fontKey: "helvetica", text })),
  }) as const;

beforeEach(async () => {
  __resetEditDraftsMemoryForTests();
  __setEditDraftsLimitsForTests();
  await clearAllEditDrafts();
});
afterEach(cleanup);

function setup(options: { enabled?: boolean; currentPage?: number; f?: File } = {}) {
  const f = options.f ?? file();
  return renderHook(
    () => {
      const session = useEditSession({ shortcuts: false });
      const drafts = useEditDrafts({
        file: f,
        enabled: options.enabled ?? true,
        session,
        pageCount: 4,
        currentPage: options.currentPage ?? 0,
      });
      return { session, drafts };
    },
    {},
  );
}

async function seedDraft(texts: number, currentPage = 2) {
  const id = (await fingerprintPdfBytes(BYTES))!;
  let session = createEditSession();
  for (let i = 0; i < texts; i += 1) session = applyOp(session, textOp(`t${i}`, `Texto ${i}`), i);
  const saved = await saveEditDraft({ id, fileName: "informe.pdf", fileBytes: BYTES, session, pageCount: 4, currentPage });
  expect(saved.ok).toBe(true);
  return id;
}

describe("useEditDrafts", () => {
  it("sin borrador previo: termina de comprobar, da la huella y no restaura nada", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.drafts.checked).toBe(true));
    expect(result.current.drafts.id).toMatch(/^[0-9a-f]{64}$/);
    expect(result.current.drafts.restored).toBeNull();
    expect(result.current.drafts.initialPage).toBe(0);
    expect(result.current.session.items).toHaveLength(0);
  });

  it("con un borrador del MISMO pdf: restaura la sesion y la pagina y lo cuenta", async () => {
    await seedDraft(2, 2);
    const { result } = setup();
    await waitFor(() => expect(result.current.drafts.restored).not.toBeNull());
    expect(result.current.drafts.restored).toEqual({ count: 2, lost: 0 });
    expect(result.current.drafts.initialPage).toBe(2);
    expect(result.current.session.items).toHaveLength(2);
    expect(result.current.drafts.checked).toBe(true);
  });

  it("otro pdf (otra huella) no recibe el borrador", async () => {
    await seedDraft(1);
    const other = new File([new Uint8Array([37, 80, 68, 70, 9, 9, 9, 9, 9])], "otro.pdf", { type: "application/pdf" });
    const { result } = setup({ f: other });
    await waitFor(() => expect(result.current.drafts.checked).toBe(true));
    expect(result.current.drafts.restored).toBeNull();
    expect(result.current.session.items).toHaveLength(0);
  });

  it("un borrador sin cambios pendientes no se restaura", async () => {
    await seedDraft(0);
    const { result } = setup();
    await waitFor(() => expect(result.current.drafts.checked).toBe(true));
    expect(result.current.drafts.restored).toBeNull();
  });

  it("autoguarda: tras editar y la calma de 350 ms hay un borrador con ese documento", async () => {
    const { result } = setup({ currentPage: 1 });
    await waitFor(() => expect(result.current.drafts.checked).toBe(true));
    act(() => result.current.session.dispatch(textOp("n1")));
    await waitFor(async () => expect((await listEditDrafts()).length).toBe(1));
    const [summary] = await listEditDrafts();
    expect(summary).toMatchObject({ fileName: "informe.pdf", pendingCount: 1, currentPage: 1 });
    const loaded = await loadEditDraft(summary.id);
    expect(loaded.ok && loaded.draft.session.items).toHaveLength(1);
  });

  it("seleccionar un elemento (sin cambiar contenido) no provoca otro guardado", async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.drafts.checked).toBe(true));
    act(() => result.current.session.dispatch(textOp("n1")));
    await waitFor(async () => expect((await listEditDrafts()).length).toBe(1));
    const [before] = await listEditDrafts();
    await new Promise((r) => setTimeout(r, 20));
    act(() => result.current.session.select(null));
    act(() => result.current.session.select("n1"));
    await new Promise((r) => setTimeout(r, 600));
    const [after] = await listEditDrafts();
    expect(after.savedAt).toBe(before.savedAt);
  });

  it("deshabilitado (PDF protegido): no busca, no restaura y no guarda NADA", async () => {
    await seedDraft(1);
    const { result } = setup({ enabled: false });
    expect(result.current.drafts.checked).toBe(true);
    expect(result.current.drafts.id).toBeNull();
    act(() => result.current.session.dispatch(textOp("n1")));
    await new Promise((r) => setTimeout(r, 700));
    expect(result.current.session.items).toHaveLength(1);
    const drafts = await listEditDrafts();
    expect(drafts).toHaveLength(1); // solo el sembrado por la prueba
    expect(drafts[0].pendingCount).toBe(1);
  });

  it("«Empezar de cero» borra el borrador y vacia la sesion restaurada", async () => {
    await seedDraft(2);
    const { result } = setup();
    await waitFor(() => expect(result.current.drafts.restored).not.toBeNull());
    await act(async () => {
      await result.current.drafts.startFresh();
    });
    expect(result.current.session.items).toHaveLength(0);
    expect(result.current.drafts.restored).toBeNull();
    expect(await listEditDrafts()).toEqual([]);
  });

  it("un documento demasiado grande para el borrador lo comunica (tooBig) sin interrumpir la edicion", async () => {
    __setEditDraftsLimitsForTests({ maxDraftBytes: 4 });
    const { result } = setup();
    await waitFor(() => expect(result.current.drafts.checked).toBe(true));
    act(() => result.current.session.dispatch(textOp("n1")));
    await waitFor(() => expect(result.current.drafts.saveFailure).toBe("tooBig"));
    expect(result.current.session.items).toHaveLength(1);
  });

  it("descarta el borrador (clearAll) y la siguiente vez ya no se restaura", async () => {
    await seedDraft(1);
    await clearAllEditDrafts();
    const { result } = setup();
    await waitFor(() => expect(result.current.drafts.checked).toBe(true));
    expect(result.current.drafts.restored).toBeNull();
  });
});
