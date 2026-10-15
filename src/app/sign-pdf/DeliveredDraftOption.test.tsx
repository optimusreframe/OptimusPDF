import "fake-indexeddb/auto";
import { createRef, type MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DeliveredDraftOption, __setDeliveredDeleteDelayForTests } from "@/app/sign-pdf/DeliveredDraftOption";
import { __resetDraftActivityForTests } from "@/app/sign-pdf/draftActivity";
import { HASH, SESSION_ID, seedDocument, seedSession } from "@/app/sign-pdf/draftTestUtils";
import type { DeliveredDraft } from "@/app/sign-pdf/deliveredDraft";
import { clearAllDrafts, deleteSessionDraft, draftExists } from "@/app/sign-pdf/signDrafts";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";

/**
 * «Borrar el borrador de esta firma» en la pantalla de resultado (F0 · U0.4): marcada por defecto, borra SOLO al descargar,
 * respeta la casilla desmarcada y anuncia lo que paso.
 */

vi.mock("@/app/sign-pdf/signDrafts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/sign-pdf/signDrafts")>();
  return { ...actual, deleteSessionDraft: vi.fn(actual.deleteSessionDraft) };
});

const es = SIGN_STRINGS.es.draftPrivacy;
const en = SIGN_STRINGS.en.draftPrivacy;

type Hook = MutableRefObject<(() => void) | null>;

function hookRef(): Hook {
  return createRef<(() => void) | null>() as Hook;
}

function mount(draft: DeliveredDraft | null, options: { withSignatures?: boolean; language?: "es" | "en" } = {}) {
  const downloadedRef = hookRef();
  downloadedRef.current = null;
  const strings = options.language === "en" ? en : es;
  const resolveDraft = vi.fn(() => draft);
  const view = render(
    <DeliveredDraftOption
      resolveDraft={resolveDraft}
      strings={strings}
      withSignatures={options.withSignatures ?? true}
      downloadedRef={downloadedRef}
    />,
  );
  return { ...view, downloadedRef, resolveDraft };
}

/** El «Descargar» del shell: llama a lo que la casilla dejo registrado. */
function pressDownload(ref: Hook) {
  act(() => ref.current?.());
}

beforeEach(async () => {
  // F0-fix (D5): el borrado espera unos segundos tras «Descargar» (con «Deshacer»); aqui se acorta para los casos que no lo miden.
  __setDeliveredDeleteDelayForTests(25);
  __resetDraftActivityForTests();
  await clearAllDrafts();
  vi.mocked(deleteSessionDraft).mockClear();
});
afterEach(() => {
  __setDeliveredDeleteDelayForTests(null);
  cleanup();
});

describe("DeliveredDraftOption", () => {
  it("nace MARCADA y con el texto exacto de la decision (con las firmas guardadas lo dice)", async () => {
    const id = await seedSession();
    mount({ kind: "session", id });
    const box = screen.getByRole("checkbox", {
      name: "Borrar el borrador de esta firma (incluye las firmas guardadas en él)",
    });
    expect((box as HTMLInputElement).checked).toBe(true);
    // Y explica que pasa si no se marca.
    expect(screen.getByText(es.deleteHintKept)).toBeTruthy();
  });

  it("sin firmas guardadas (ajuste apagado) la etiqueta no promete firmas ni habla de los 7 dias", async () => {
    const id = await seedSession();
    mount({ kind: "session", id }, { withSignatures: false });
    expect(screen.getByRole("checkbox", { name: "Borrar el borrador de esta firma" })).toBeTruthy();
    expect(screen.queryByText(es.deleteHintKept)).toBeNull();
    expect(screen.queryByText(/incluye las firmas/)).toBeNull();
  });

  it("en ingles sale en ingles, sin claves crudas", async () => {
    const id = await seedSession();
    mount({ kind: "session", id }, { language: "en" });
    expect(screen.getByRole("checkbox", { name: en.deleteLabelWithSignatures })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/deleteLabel|deleteHint|draftPrivacy/);
  });

  it("NO borra al aparecer: el borrador sigue ahi hasta que se descarga", async () => {
    const id = await seedSession();
    mount({ kind: "session", id });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await draftExists("session", id)).toBe(true);
    expect(vi.mocked(deleteSessionDraft)).not.toHaveBeenCalled();
  });

  it("al descargar con la casilla marcada borra la SESION (todos sus bytes) y lo anuncia", async () => {
    const id = await seedSession();
    const other = await seedSession({ id: SESSION_ID("z"), keys: [HASH("e"), HASH("f")] });
    const { downloadedRef } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(es.deleteDone));
    expect(await draftExists("session", id)).toBe(false);
    // Ni toca otra ronda.
    expect(await draftExists("session", other)).toBe(true);
    // Hecho el borrado, la casilla ya no sigue ahi marcada.
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("al descargar con la casilla marcada borra el borrador de un DOCUMENTO suelto", async () => {
    const key = await seedDocument({ key: HASH("c") });
    const { downloadedRef } = mount({ kind: "document", id: key });
    pressDownload(downloadedRef);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(es.deleteDone));
    expect(await draftExists("document", key)).toBe(false);
  });

  it("con la casilla DESMARCADA, descargar conserva el borrador (con su caducidad) y no anuncia nada", async () => {
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id });
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    pressDownload(downloadedRef);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(await draftExists("session", id)).toBe(true);
    expect(vi.mocked(deleteSessionDraft)).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("marcar, desmarcar y volver a marcar: manda lo ultimo que dejo la persona", async () => {
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("checkbox"));
    pressDownload(downloadedRef);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(es.deleteDone));
    expect(await draftExists("session", id)).toBe(false);
  });

  it("si el borrado falla lo dice (no afirma «borrado») y un segundo «Descargar» lo reintenta", async () => {
    const id = await seedSession();
    vi.mocked(deleteSessionDraft).mockResolvedValueOnce(undefined);
    const { downloadedRef } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(es.deleteFailed));
    expect(screen.queryByText(es.deleteDone)).toBeNull();
    expect(await draftExists("session", id)).toBe(true);
    // La casilla sigue ahi y el siguiente «Descargar» borra de verdad.
    expect(screen.getByRole("checkbox")).toBeTruthy();
    pressDownload(downloadedRef);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(es.deleteDone));
    expect(await draftExists("session", id)).toBe(false);
  });

  it("descargar dos veces seguidas no vuelve a borrar ni lanza", async () => {
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(es.deleteDone));
    expect(downloadedRef.current).toBeNull();
    pressDownload(downloadedRef);
    expect(vi.mocked(deleteSessionDraft)).toHaveBeenCalledTimes(1);
  });

  it("sin borrador que ofrecer borrar no pinta nada ni registra nada", () => {
    const { container, downloadedRef } = mount(null);
    expect(container.textContent).toBe("");
    expect(downloadedRef.current).toBeNull();
  });

  it("al desmontar retira lo que registro (el «Descargar» de otro resultado no borra este borrador)", async () => {
    const id = await seedSession();
    const { downloadedRef, unmount } = mount({ kind: "session", id });
    expect(downloadedRef.current).toBeTypeOf("function");
    unmount();
    expect(downloadedRef.current).toBeNull();
    expect(await draftExists("session", id)).toBe(true);
  });

  it("resuelve el borrador UNA vez, al aparecer (no en cada render)", async () => {
    const id = await seedSession();
    const { resolveDraft, rerender, downloadedRef } = mount({ kind: "session", id });
    rerender(
      <DeliveredDraftOption resolveDraft={resolveDraft} strings={es} withSignatures downloadedRef={downloadedRef} />,
    );
    expect(resolveDraft).toHaveBeenCalledTimes(1);
  });

  it("la casilla mide 44 px y la region de estado es viva y siempre esta montada", async () => {
    const id = await seedSession();
    const { container } = mount({ kind: "session", id });
    expect(container.querySelector("[data-delete-draft] .min-h-11")).toBeTruthy();
    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });
});

describe("DeliveredDraftOption · el borrado espera y se puede deshacer (F0-fix, D5)", () => {
  /** Plazo largo: lo que se mira es que NO se borra de inmediato. */
  const LONG = 600;

  it("al pulsar «Descargar» NO borra en el acto: dice que se borrara en unos segundos, con «Deshacer» de 44 px, y el borrador sigue ahi", async () => {
    __setDeliveredDeleteDelayForTests(LONG);
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    expect(screen.getByRole("status").textContent).toBe(es.deleteSoon);
    const undo = screen.getByRole("button", { name: "Deshacer" });
    expect(undo.className).toContain("h-11");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await draftExists("session", id)).toBe(true);
    expect(vi.mocked(deleteSessionDraft)).not.toHaveBeenCalled();
    // Pasado el plazo, ahora si: borrado confirmado.
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(es.deleteDone), { timeout: 3000 });
    expect(await draftExists("session", id)).toBe(false);
    expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
  });

  it("«Deshacer» cancela el borrado: el borrador se queda aunque pase el plazo, lo dice, y la casilla queda desmarcada", async () => {
    __setDeliveredDeleteDelayForTests(120);
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    fireEvent.click(screen.getByRole("button", { name: "Deshacer" }));
    expect(screen.getByRole("status").textContent).toBe(es.deleteUndone);
    expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await draftExists("session", id)).toBe(true);
    expect(vi.mocked(deleteSessionDraft)).not.toHaveBeenCalled();
    // Una descarga posterior ya no lo borra (el «Deshacer» fue una decision).
    pressDownload(downloadedRef);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await draftExists("session", id)).toBe(true);
  });

  it("si la persona se va (desmontar) dentro del plazo, NO se borra nada: ante la duda el borrador se queda", async () => {
    __setDeliveredDeleteDelayForTests(120);
    const id = await seedSession();
    const { downloadedRef, unmount } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await draftExists("session", id)).toBe(true);
    expect(vi.mocked(deleteSessionDraft)).not.toHaveBeenCalled();
  });

  it("otra descarga mientras ya hay un borrado en marcha no lo reinicia (se borra a su hora, una sola vez)", async () => {
    __setDeliveredDeleteDelayForTests(200);
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    await new Promise((resolve) => setTimeout(resolve, 120));
    pressDownload(downloadedRef);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(es.deleteDone), { timeout: 1500 });
    expect(vi.mocked(deleteSessionDraft)).toHaveBeenCalledTimes(1);
  });

  it("el plazo por defecto es de unos segundos (no instantaneo y no eterno)", async () => {
    const { DELIVERED_DELETE_DELAY_MS } = await import("@/app/sign-pdf/DeliveredDraftOption");
    expect(DELIVERED_DELETE_DELAY_MS).toBeGreaterThanOrEqual(5000);
    expect(DELIVERED_DELETE_DELAY_MS).toBeLessThanOrEqual(15_000);
  });

  it("en ingles: «Undo» y el aviso en ingles", async () => {
    __setDeliveredDeleteDelayForTests(LONG);
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id }, { language: "en" });
    pressDownload(downloadedRef);
    expect(screen.getByRole("status").textContent).toBe(en.deleteSoon);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("status").textContent).toBe(en.deleteUndone);
  });
});

describe("DeliveredDraftOption · la casilla manda tambien durante la espera (F0-fix2, N1)", () => {
  it("desmarcar la casilla DURANTE la espera cancela el borrado: el borrador se conserva aunque pase el plazo, sin pulsar «Deshacer»", async () => {
    __setDeliveredDeleteDelayForTests(150);
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    expect(screen.getByRole("status").textContent).toBe(es.deleteSoon);
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    // Se anuncia en la region viva unica: se conserva y, con firmas guardadas, caduca a los 7 dias.
    expect(screen.getByRole("status").textContent).toBe(es.deleteKeptExpires);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    // Ya no hay nada que deshacer.
    expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await draftExists("session", id)).toBe(true);
    expect(vi.mocked(deleteSessionDraft)).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(es.deleteKeptExpires);
  });

  it("sin firmas guardadas el aviso no promete la caducidad de 7 dias", async () => {
    __setDeliveredDeleteDelayForTests(150);
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id }, { withSignatures: false });
    pressDownload(downloadedRef);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("status").textContent).toBe(es.deleteKept);
    expect(es.deleteKept).not.toMatch(/7 d/);
  });

  it("volver a marcarla vuelve a empezar la espera y, pasado el plazo, se borra una sola vez", async () => {
    __setDeliveredDeleteDelayForTests(250);
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.queryByRole("button", { name: "Deshacer" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fireEvent.click(screen.getByRole("checkbox"));
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("status").textContent).toBe(es.deleteSoon);
    expect(screen.getByRole("button", { name: "Deshacer" })).toBeTruthy();
    // La espera es nueva: a los ~200 ms desde el primer clic el temporizador viejo ya habria disparado.
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(await draftExists("session", id)).toBe(true);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(es.deleteDone), { timeout: 2000 });
    expect(await draftExists("session", id)).toBe(false);
    expect(vi.mocked(deleteSessionDraft)).toHaveBeenCalledTimes(1);
  });

  it("tras desmarcar durante la espera, una descarga posterior NO borra (manda lo que dice la casilla)", async () => {
    __setDeliveredDeleteDelayForTests(120);
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    fireEvent.click(screen.getByRole("checkbox"));
    pressDownload(downloadedRef);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await draftExists("session", id)).toBe(true);
    expect(vi.mocked(deleteSessionDraft)).not.toHaveBeenCalled();
  });

  it("«Deshacer» sigue funcionando: conserva el borrador, deja la casilla desmarcada y lo anuncia", async () => {
    __setDeliveredDeleteDelayForTests(120);
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    fireEvent.click(screen.getByRole("button", { name: "Deshacer" }));
    expect(screen.getByRole("status").textContent).toBe(es.deleteUndone);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await draftExists("session", id)).toBe(true);
  });

  it("desmarcar y marcar ANTES de descargar no anuncia nada (no hay espera que cancelar)", async () => {
    const id = await seedSession();
    mount({ kind: "session", id });
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("en ingles: se conserva (con caducidad) y vuelve a esperar al marcarla", async () => {
    __setDeliveredDeleteDelayForTests(600);
    const id = await seedSession();
    const { downloadedRef } = mount({ kind: "session", id }, { language: "en" });
    pressDownload(downloadedRef);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("status").textContent).toBe(en.deleteKeptExpires);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("status").textContent).toBe(en.deleteSoon);
    expect(document.body.textContent).not.toMatch(/deleteKept|clearStrokes/);
  });

  it("al desmontar con la espera cancelada tampoco se borra nada", async () => {
    __setDeliveredDeleteDelayForTests(100);
    const id = await seedSession();
    const { downloadedRef, unmount } = mount({ kind: "session", id });
    pressDownload(downloadedRef);
    fireEvent.click(screen.getByRole("checkbox"));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await draftExists("session", id)).toBe(true);
  });
});
