import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_DRAFTS,
  MAX_DRAFTS_TOTAL_BYTES,
  clearAllDrafts,
  deleteDraft,
  listDrafts,
  loadDraft,
  saveDraft,
  subscribeToDrafts,
  type SaveDraftParams,
} from "@/app/sign-pdf/signDrafts";

/**
 * `fake-indexeddb/auto` instala un `indexedDB` global real (mismo motor
 * que un navegador, sin mocks a mano) -- unico modo honesto de probar
 * transacciones de verdad (atomicidad, `onupgradeneeded`, expulsion).
 */

function draftParams(
  id: string,
  overrides: Partial<SaveDraftParams> = {},
): SaveDraftParams {
  return {
    id,
    fileBytes: new Uint8Array([1, 2, 3, 4]),
    fileName: `${id}.pdf`,
    manifest: {
      mode: "multi",
      signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }],
      fields: [],
      textFields: [],
      textValues: {},
    },
    step: "signers",
    captures: {},
    textFieldsDetectedFor: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await clearAllDrafts();
});

describe("saveDraft / listDrafts / loadDraft — src/app/sign-pdf/signDrafts.ts", () => {
  it("guarda y reanuda un borrador con los mismos bytes y metadatos", async () => {
    await saveDraft(draftParams("doc-1"));

    const drafts = await listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].id).toBe("doc-1");
    expect(drafts[0].fileName).toBe("doc-1.pdf");

    const loaded = await loadDraft("doc-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(loaded!.meta.signers[0].name).toBe("Ana");
  });

  it("los bytes se escriben una sola vez: un guardado posterior no los reemplaza", async () => {
    await saveDraft(draftParams("doc-1", { fileBytes: new Uint8Array([9, 9]) }));
    await saveDraft(
      draftParams("doc-1", {
        fileBytes: new Uint8Array([1, 1, 1]),
        step: "document",
      }),
    );

    const loaded = await loadDraft("doc-1");
    // Los bytes son los del PRIMER guardado...
    expect(loaded!.bytes).toEqual(new Uint8Array([9, 9]));
    // ...pero los metadatos si se actualizan en cada guardado.
    expect(loaded!.meta.step).toBe("document");
  });

  it("loadDraft de un id inexistente devuelve null", async () => {
    expect(await loadDraft("no-existe")).toBeNull();
  });

  it("listDrafts ordena del mas reciente al mas antiguo", async () => {
    await saveDraft(draftParams("viejo"));
    await new Promise((r) => setTimeout(r, 2));
    await saveDraft(draftParams("nuevo"));

    const drafts = await listDrafts();
    expect(drafts.map((d) => d.id)).toEqual(["nuevo", "viejo"]);
  });
});

describe("deleteDraft / clearAllDrafts — src/app/sign-pdf/signDrafts.ts", () => {
  it("borra un borrador puntual", async () => {
    await saveDraft(draftParams("doc-1"));
    await saveDraft(draftParams("doc-2"));
    await deleteDraft("doc-1");

    const drafts = await listDrafts();
    expect(drafts.map((d) => d.id)).toEqual(["doc-2"]);
    expect(await loadDraft("doc-1")).toBeNull();
  });

  it("clearAllDrafts borra todo", async () => {
    await saveDraft(draftParams("doc-1"));
    await saveDraft(draftParams("doc-2"));
    await clearAllDrafts();

    expect(await listDrafts()).toEqual([]);
  });
});

describe("expulsion por presupuesto — src/app/sign-pdf/signDrafts.ts", () => {
  it(`expulsa el mas antiguo al superar ${MAX_DRAFTS} borradores`, async () => {
    for (let i = 0; i < MAX_DRAFTS + 1; i += 1) {
      await saveDraft(draftParams(`doc-${i}`));
      // Marca de tiempo distinta y determinable para cada uno.
      await new Promise((r) => setTimeout(r, 2));
    }

    const drafts = await listDrafts();
    expect(drafts).toHaveLength(MAX_DRAFTS);
    expect(drafts.some((d) => d.id === "doc-0")).toBe(false);
    expect(await loadDraft("doc-0")).toBeNull();
  });

  it("expulsa por bytes totales aunque queden pocos borradores", async () => {
    const bigBytes = new Uint8Array(Math.ceil(MAX_DRAFTS_TOTAL_BYTES * 0.6));
    await saveDraft(draftParams("grande-1", { fileBytes: bigBytes }));
    await new Promise((r) => setTimeout(r, 2));
    await saveDraft(draftParams("grande-2", { fileBytes: bigBytes }));

    const drafts = await listDrafts();
    // El segundo (mas reciente) desplaza al primero: juntos superarian
    // el presupuesto total.
    expect(drafts.map((d) => d.id)).toEqual(["grande-2"]);
  });
});

describe("subscribeToDrafts — src/app/sign-pdf/signDrafts.ts", () => {
  it("avisa tras guardar y tras borrar", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToDrafts(listener);

    await saveDraft(draftParams("doc-1"));
    expect(listener).toHaveBeenCalledTimes(1);

    await deleteDraft("doc-1");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await saveDraft(draftParams("doc-2"));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
