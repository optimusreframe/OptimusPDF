import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { EMPTY_DOC_STATE, type DocState } from "@/app/sign-pdf/docSet";
import {
  __closeWarmDraftsConnectionForTests,
  clearAllDrafts,
  saveDraft,
  saveSessionDraft,
  type DraftEntry,
} from "@/app/sign-pdf/signDrafts";
import { useResumeFromUrl } from "@/app/sign-pdf/useResumeFromUrl";

/**
 * `/sign-pdf?resume=<tipo>:<id>`: busca ese borrador en los de este navegador y lo retoma por el mismo camino que
 * «Ver borradores» (sobre `fake-indexeddb`, sin mocks de los almacenes).
 */

const HEX = "ab".repeat(32);
const SESSION_ID = "s-mgx4k2w1-1a2b3c4d";

function setUrl(path: string) {
  window.history.replaceState(null, "", path);
}

function Probe({ onResume }: { onResume: (entry: DraftEntry) => void }) {
  const state = useResumeFromUrl(onResume);
  return <output data-testid="gone">{String(state.gone)}</output>;
}

async function saveSingle(id = HEX) {
  await saveDraft({
    id,
    fileBytes: new Uint8Array([1, 2, 3]),
    fileName: "Poder.pdf",
    manifest: { mode: "multi", signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }], fields: [], textFields: [], textValues: {} },
    step: "signers",
    captures: {},
    textFieldsDetectedFor: null,
  });
}

async function saveSession(id = SESSION_ID) {
  await saveSessionDraft({
    id,
    mode: "multi",
    signMode: "same",
    signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }],
    blocks: [],
    documents: ["doc-1", "doc-2"].map((docId) => ({
      id: docId,
      fileName: `${docId}.pdf`,
      size: 3,
      state: { ...EMPTY_DOC_STATE } as DocState,
      getBytes: async () => new Uint8Array([1, 2, 3]),
    })),
    activeDocId: "doc-1",
    step: "signers",
  });
}

beforeEach(async () => {
  __closeWarmDraftsConnectionForTests();
  await clearAllDrafts();
  setUrl("/sign-pdf");
});

afterEach(() => {
  cleanup();
  setUrl("/");
});

describe("useResumeFromUrl (Firmar)", () => {
  it("un borrador de sesion: lo retoma con la entrada de ESA sesion y limpia la URL", async () => {
    await saveSession();
    await saveSingle();
    setUrl(`/sign-pdf?resume=session:${SESSION_ID}`);
    const onResume = vi.fn();
    render(<Probe onResume={onResume} />);

    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    const entry = onResume.mock.calls[0][0] as DraftEntry;
    expect(entry.kind).toBe("session");
    expect(entry.meta.id).toBe(SESSION_ID);
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(screen.getByTestId("gone").textContent).toBe("false");
  });

  it("un borrador de UN documento: retoma ese y no otro", async () => {
    await saveSingle(HEX);
    await saveSingle("cd".repeat(32));
    setUrl(`/sign-pdf?resume=sign:${"cd".repeat(32)}`);
    const onResume = vi.fn();
    render(<Probe onResume={onResume} />);

    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
    const entry = onResume.mock.calls[0][0] as DraftEntry;
    expect(entry.kind).toBe("document");
    expect(entry.meta.id).toBe("cd".repeat(32));
  });

  it("un tipo de otra herramienta no restaura nada, aunque exista ese id", async () => {
    await saveSingle(HEX);
    setUrl(`/sign-pdf?resume=edit:${HEX}`);
    const onResume = vi.fn();
    render(<Probe onResume={onResume} />);
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(onResume).not.toHaveBeenCalled();
    expect(screen.getByTestId("gone").textContent).toBe("false");
  });

  it("el tipo `session` no retoma un documento suelto con el mismo id, ni al reves", async () => {
    await saveSingle(HEX);
    setUrl(`/sign-pdf?resume=session:${SESSION_ID}`);
    const onResume = vi.fn();
    render(<Probe onResume={onResume} />);
    await waitFor(() => expect(screen.getByTestId("gone").textContent).toBe("true"));
    expect(onResume).not.toHaveBeenCalled();
  });

  it("si el borrador ya no existe avisa (`gone`) y no llama a nadie", async () => {
    setUrl(`/sign-pdf?resume=session:${SESSION_ID}`);
    const onResume = vi.fn();
    render(<Probe onResume={onResume} />);
    await waitFor(() => expect(screen.getByTestId("gone").textContent).toBe("true"));
    expect(onResume).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
  });

  it("valores manipulados: ni retoma ni avisa, y limpia la URL", async () => {
    await saveSession();
    for (const value of ["<script>alert(1)</script>", "session:s-x", `sign:${HEX.slice(1)}`, "__proto__:1", "constructor:" + HEX]) {
      setUrl(`/sign-pdf?resume=${encodeURIComponent(value)}`);
      const onResume = vi.fn();
      const { unmount } = render(<Probe onResume={onResume} />);
      await waitFor(() => expect(window.location.search).toBe(""));
      expect(onResume).not.toHaveBeenCalled();
      expect(screen.getByTestId("gone").textContent).toBe("false");
      unmount();
    }
  });
});
