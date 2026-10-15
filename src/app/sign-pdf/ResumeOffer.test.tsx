import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ResumeCard, UploadOfferHost } from "@/app/sign-pdf/ResumeOffer";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { HASH, SESSION_ID, seedDocument, seedSession } from "@/app/sign-pdf/draftTestUtils";
import { clearAllDrafts, listAllDrafts, type DraftEntry } from "@/app/sign-pdf/signDrafts";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";

/** La tarjeta «Tienes una firma sin terminar» y la oferta «Retomar lo que tenias» (U0.3). */

const es = SIGN_STRINGS.es;
const en = SIGN_STRINGS.en;

beforeEach(async () => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  await clearAllDrafts();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const withLanguage = (node: React.ReactNode) => <LanguageProvider>{node}</LanguageProvider>;

async function entries(): Promise<DraftEntry[]> {
  return listAllDrafts();
}

describe("ResumeCard", () => {
  it("cuenta documentos, firmantes, quien ya firmo y hace cuanto, con «Retomar» de 44 px", async () => {
    await seedSession();
    const list = await entries();
    render(withLanguage(<ResumeCard entries={list} strings={es} onResume={() => {}} onViewAll={() => {}} onDiscarded={() => {}} />));
    const card = screen.getByRole("region", { name: es.resume.cardTitle });
    expect(within(card).getByRole("heading", { level: 2, name: "Tienes una firma sin terminar" })).toBeTruthy();
    expect(within(card).getByText("Documentos: Contrato A.pdf, Anexo B.pdf")).toBeTruthy();
    expect(within(card).getByText("Firmantes: Ana, Luis")).toBeTruthy();
    expect(within(card).getByText(/^Guardado /)).toBeTruthy();
    const resume = within(card).getByRole("button", { name: "Retomar" });
    expect(resume.className).toContain("h-11");
    expect(within(card).getByRole("button", { name: "Descartar" }).className).toContain("h-11");
    expect(within(card).getByRole("button", { name: "Ver todos" }).className).toContain("h-11");
    // El nombre accesible de «Retomar» es solo su texto; el detalle va como descripcion.
    expect(resume.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("«Retomar» y «Ver todos» llaman a sus manejadores con el borrador mas reciente", async () => {
    await seedSession({ id: SESSION_ID("a") });
    const list = await entries();
    const onResume = vi.fn();
    const onViewAll = vi.fn();
    render(withLanguage(<ResumeCard entries={list} strings={es} onResume={onResume} onViewAll={onViewAll} onDiscarded={() => {}} />));
    fireEvent.click(screen.getByRole("button", { name: "Retomar" }));
    expect(onResume).toHaveBeenCalledWith(list[0]);
    fireEvent.click(screen.getByRole("button", { name: "Ver todos" }));
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });

  it("con mas de un borrador dice cuantos mas hay", async () => {
    await seedSession({ id: SESSION_ID("a") });
    await seedSession({ id: SESSION_ID("b"), keys: [HASH("e"), HASH("f")] });
    await seedDocument();
    const list = await entries();
    render(withLanguage(<ResumeCard entries={list} strings={es} onResume={() => {}} onViewAll={() => {}} onDiscarded={() => {}} />));
    expect(screen.getByText("Hay 2 más sin terminar.")).toBeTruthy();
  });

  it("«Descartar» pide confirmacion: «Cancelar» no borra nada; confirmar borra el borrador de verdad y avisa", async () => {
    const id = await seedSession();
    const list = await entries();
    const onDiscarded = vi.fn();
    render(withLanguage(<ResumeCard entries={list} strings={es} onResume={() => {}} onViewAll={() => {}} onDiscarded={onDiscarded} />));
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    const dialog = await screen.findByRole("dialog", { name: es.resume.discardTitle });
    expect(within(dialog).getByText(es.resume.discardBody(2))).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: es.confirmCancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await entries()).map((entry) => entry.meta.id)).toEqual([id]);
    expect(onDiscarded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    const again = await screen.findByRole("dialog", { name: es.resume.discardTitle });
    fireEvent.click(within(again).getByRole("button", { name: es.resume.discardConfirm }));
    await waitFor(() => expect(onDiscarded).toHaveBeenCalledTimes(1));
    expect(await entries()).toEqual([]);
  });

  it("descartar el UNICO borrador mueve el foco a la zona de carga en vez de dejarlo en <body>", async () => {
    await seedSession();
    const list = await entries();
    render(
      withLanguage(
        <div>
          <ResumeCard entries={list} strings={es} onResume={() => {}} onViewAll={() => {}} onDiscarded={() => {}} />
          <div>
            <input type="file" accept="application/pdf" />
            <button type="button">Seleccionar archivos</button>
          </div>
        </div>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: es.resume.discardConfirm }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Seleccionar archivos" })));
  });

  it("descartar uno de VARIOS deja el foco en el «Retomar» de la tarjeta, que pasa a mostrar el siguiente", async () => {
    await seedSession({ id: SESSION_ID("a") });
    await seedSession({ id: SESSION_ID("b"), keys: [HASH("e"), HASH("f")] });
    const list = await entries();
    render(
      withLanguage(
        <div>
          <ResumeCard entries={list} strings={es} onResume={() => {}} onViewAll={() => {}} onDiscarded={() => {}} />
          <div>
            <input type="file" accept="application/pdf" />
            <button type="button">Seleccionar archivos</button>
          </div>
        </div>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Descartar" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: es.resume.discardConfirm }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Retomar" })));
    expect(await entries()).toHaveLength(1);
  });

  it("no pinta nada sin borradores", () => {
    const { container } = render(withLanguage(<ResumeCard entries={[]} strings={es} onResume={() => {}} onViewAll={() => {}} onDiscarded={() => {}} />));
    expect(container.textContent).toBe("");
  });

  it("en ingles, todo en ingles", async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    await seedSession();
    const list = await entries();
    render(withLanguage(<ResumeCard entries={list} strings={en} onResume={() => {}} onViewAll={() => {}} onDiscarded={() => {}} />));
    expect(screen.getByRole("heading", { name: "You have an unfinished signing" })).toBeTruthy();
    expect(screen.getByText("Documents: Contrato A.pdf, Anexo B.pdf")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "View all" })).toBeTruthy();
  });
});

async function pdfFile(name: string, byte: number): Promise<{ file: File; key: string }> {
  const file = new File([new Uint8Array([37, 80, 68, 70, byte, byte + 1])], name, { type: "application/pdf" });
  return { file, key: await documentContentKey(file) };
}

describe("UploadOfferHost", () => {
  it("ofrece «Retomar lo que tenias» cuando los PDF subidos son EXACTAMENTE los del borrador (por huella, no por nombre)", async () => {
    const a = await pdfFile("renombrado-1.pdf", 1);
    const b = await pdfFile("renombrado-2.pdf", 2);
    await seedSession({ keys: [a.key, b.key], names: ["Contrato A.pdf", "Anexo B.pdf"] });
    const list = await entries();
    const onResume = vi.fn();
    const onAnnounce = vi.fn();
    render(withLanguage(<UploadOfferHost files={[a.file, b.file]} entries={list} enabled strings={es} onResume={onResume} onAnnounce={onAnnounce} />));
    expect(await screen.findByRole("heading", { name: "Retomar lo que tenías" })).toBeTruthy();
    expect(screen.getByText("Documentos: Contrato A.pdf, Anexo B.pdf")).toBeTruthy();
    expect(onAnnounce).toHaveBeenCalledTimes(1);
    expect(onAnnounce).toHaveBeenCalledWith(es.resume.offerAnnounce);

    fireEvent.click(screen.getByRole("button", { name: "Retomar" }));
    expect(onResume).toHaveBeenCalledWith(list[0]);
  });

  it("subidos en otro orden tambien es el mismo trabajo", async () => {
    const a = await pdfFile("a.pdf", 1);
    const b = await pdfFile("b.pdf", 2);
    await seedSession({ keys: [a.key, b.key] });
    const list = await entries();
    render(withLanguage(<UploadOfferHost files={[b.file, a.file]} entries={list} enabled strings={es} onResume={() => {}} onAnnounce={() => {}} />));
    expect(await screen.findByRole("heading", { name: "Retomar lo que tenías" })).toBeTruthy();
  });

  it("OTROS PDF (aunque sean dos y se llamen igual) no reciben la oferta del borrador equivocado", async () => {
    const a = await pdfFile("Contrato A.pdf", 1);
    const b = await pdfFile("Anexo B.pdf", 2);
    const other = await pdfFile("Contrato A.pdf", 50);
    await seedSession({ keys: [a.key, b.key], names: ["Contrato A.pdf", "Anexo B.pdf"] });
    const list = await entries();
    const onAnnounce = vi.fn();
    render(withLanguage(<UploadOfferHost files={[a.file, other.file]} entries={list} enabled strings={es} onResume={() => {}} onAnnounce={onAnnounce} />));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByText("Retomar lo que tenías")).toBeNull();
    expect(onAnnounce).not.toHaveBeenCalled();
  });

  it("un solo PDF encuentra el borrador de un documento suelto; subir de mas, no", async () => {
    const solo = await pdfFile("Poliza.pdf", 7);
    const extra = await pdfFile("Extra.pdf", 8);
    await seedDocument({ key: solo.key, name: "Poliza.pdf" });
    const list = await entries();
    const view = render(withLanguage(<UploadOfferHost files={[solo.file]} entries={list} enabled strings={es} onResume={() => {}} onAnnounce={() => {}} />));
    expect(await screen.findByRole("heading", { name: "Retomar lo que tenías" })).toBeTruthy();
    view.rerender(withLanguage(<UploadOfferHost files={[solo.file, extra.file]} entries={list} enabled strings={es} onResume={() => {}} onAnnounce={() => {}} />));
    await waitFor(() => expect(screen.queryByText("Retomar lo que tenías")).toBeNull());
  });

  it("con trabajo ya en pantalla (`enabled = false`) no se ofrece nada que pudiera pisarlo", async () => {
    const a = await pdfFile("a.pdf", 1);
    const b = await pdfFile("b.pdf", 2);
    await seedSession({ keys: [a.key, b.key] });
    const list = await entries();
    render(withLanguage(<UploadOfferHost files={[a.file, b.file]} entries={list} enabled={false} strings={es} onResume={() => {}} onAnnounce={() => {}} />));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByText("Retomar lo que tenías")).toBeNull();
  });

  it("«Empezar de nuevo» retira la oferta SIN borrar el borrador; otros archivos vuelven a poder ofrecerlo", async () => {
    const a = await pdfFile("a.pdf", 1);
    const b = await pdfFile("b.pdf", 2);
    const c = await pdfFile("c.pdf", 3);
    await seedSession({ keys: [a.key, b.key] });
    const list = await entries();
    const view = render(withLanguage(<UploadOfferHost files={[a.file, b.file]} entries={list} enabled strings={es} onResume={() => {}} onAnnounce={() => {}} />));
    fireEvent.click(await screen.findByRole("button", { name: "Empezar de nuevo" }));
    await waitFor(() => expect(screen.queryByText("Retomar lo que tenías")).toBeNull());
    expect(await entries()).toHaveLength(1);
    // Otro conjunto (sin coincidencia) y de vuelta al primero: el rechazo era de ESE conjunto, y sigue siendolo.
    view.rerender(withLanguage(<UploadOfferHost files={[c.file]} entries={list} enabled strings={es} onResume={() => {}} onAnnounce={() => {}} />));
    view.rerender(withLanguage(<UploadOfferHost files={[a.file, b.file]} entries={list} enabled strings={es} onResume={() => {}} onAnnounce={() => {}} />));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(screen.queryByText("Retomar lo que tenías")).toBeNull();
  });

  it("mientras la lista de borradores no ha llegado (`null`) no hay oferta", async () => {
    const a = await pdfFile("a.pdf", 1);
    render(withLanguage(<UploadOfferHost files={[a.file]} entries={null} enabled strings={es} onResume={() => {}} onAnnounce={() => {}} />));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.queryByText("Retomar lo que tenías")).toBeNull();
  });
});

describe("tarjeta y oferta: borrador guardado SIN las firmas (F0 · U0.4)", () => {
  const STROKE = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 };

  /** Una sesion de dos firmantes cuyas firmas se dejaron fuera al guardar (ajuste apagado). */
  async function seedSessionWithoutSignatures(): Promise<DraftEntry[]> {
    const { saveSessionDraft } = await import("@/app/sign-pdf/signDrafts");
    const { EMPTY_DOC_STATE } = await import("@/app/sign-pdf/docSet");
    const { ANA, LUIS } = await import("@/app/sign-pdf/draftTestUtils");
    const field = (signerId: string) => ({
      id: `fld-${signerId}`,
      signerId,
      pageIndex: 0,
      type: "signature" as const,
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
    });
    const result = await saveSessionDraft({
      id: SESSION_ID("a"),
      mode: "multi",
      signMode: "same",
      signers: [ANA, LUIS],
      blocks: [ANA, LUIS].map((signer, index) => ({
        id: `bk-${index + 1}`,
        signerId: signer.id,
        appliesTo: ["d1"],
        signature: STROKE,
        initials: null,
        stamps: { d1: "x" },
        auto: true,
      })),
      documents: ["d1", "d2"].map((id, index) => ({
        id,
        fileName: `Doc ${index + 1}.pdf`,
        size: 5,
        state: { ...EMPTY_DOC_STATE, sealedKey: HASH(index === 0 ? "a" : "b"), fields: [field("sg-1"), field("sg-2")] },
        getBytes: async () => new Uint8Array([37, 80, 68, 70, index + 1]),
      })),
      activeDocId: "d1",
      step: "sign",
      keepSignatures: false,
    });
    expect(result.ok).toBe(true);
    return entries();
  }

  it("la tarjeta dice «Firmas: se volverán a pedir» en lugar de «Ana pendiente, Luis pendiente»", async () => {
    const list = await seedSessionWithoutSignatures();
    render(withLanguage(<ResumeCard entries={list} strings={es} onResume={() => {}} onViewAll={() => {}} onDiscarded={() => {}} />));
    const card = screen.getByRole("region", { name: es.resume.cardTitle });
    expect(within(card).getByText("Firmas: se volverán a pedir")).toBeTruthy();
    expect(within(card).queryByText(/Firmas recogidas/)).toBeNull();
    expect(within(card).queryByText(/pendiente/)).toBeNull();
    // Lo demas de la tarjeta sigue igual.
    expect(within(card).getByText("Firmantes: Ana, Luis")).toBeTruthy();
    expect(within(card).getByText("Documentos: Doc 1.pdf, Doc 2.pdf")).toBeTruthy();
  });

  it("en ingles: «Signatures: they will be asked for again»", async () => {
    const list = await seedSessionWithoutSignatures();
    render(withLanguage(<ResumeCard entries={list} strings={en} onResume={() => {}} onViewAll={() => {}} onDiscarded={() => {}} />));
    expect(screen.getByText("Signatures: they will be asked for again")).toBeTruthy();
  });

  it("con las firmas guardadas (lo de siempre) sigue diciendo quien ya firmo", async () => {
    await seedSession({ signed: ["sg-1"] });
    const list = await entries();
    render(withLanguage(<ResumeCard entries={list} strings={es} onResume={() => {}} onViewAll={() => {}} onDiscarded={() => {}} />));
    expect(screen.getByText("Firmas recogidas: Ana ✓, Luis pendiente")).toBeTruthy();
    expect(screen.queryByText(/se volverán a pedir/)).toBeNull();
  });
});

describe("UploadOfferHost · la misma plantilla para varios clientes (F0-fix, D3)", () => {
  it("con DOS borradores del mismo PDF ofrece el mas reciente, dice que hay otro y «Ver todos» abre la lista", async () => {
    const solo = await pdfFile("Plantilla.pdf", 70);
    const first = await seedDocument({ key: solo.key, id: "1".repeat(64), name: "Plantilla.pdf" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await seedDocument({ key: solo.key, id: "2".repeat(64), name: "Plantilla.pdf" });
    const list = await entries();
    expect(list.map((entry) => entry.meta.id)).toEqual([second, first]);
    const onResume = vi.fn();
    const onViewAll = vi.fn();
    render(withLanguage(<UploadOfferHost files={[solo.file]} entries={list} enabled strings={es} onResume={onResume} onAnnounce={() => {}} onViewAll={onViewAll} />));
    expect(await screen.findByRole("heading", { name: "Retomar lo que tenías" })).toBeTruthy();
    expect(screen.getByText("Hay 1 más sin terminar.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retomar" }));
    expect(onResume).toHaveBeenCalledWith(list[0]);
    const all = screen.getByRole("button", { name: "Ver todos" });
    expect(all.className).toContain("h-11");
    fireEvent.click(all);
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });

  it("con UN solo borrador no hay «Ver todos» ni «Hay N más»", async () => {
    const solo = await pdfFile("Plantilla.pdf", 71);
    await seedDocument({ key: solo.key, id: "3".repeat(64), name: "Plantilla.pdf" });
    const list = await entries();
    render(withLanguage(<UploadOfferHost files={[solo.file]} entries={list} enabled strings={es} onResume={() => {}} onAnnounce={() => {}} onViewAll={() => {}} />));
    expect(await screen.findByRole("heading", { name: "Retomar lo que tenías" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Ver todos" })).toBeNull();
    expect(screen.queryByText(/más sin terminar/)).toBeNull();
  });

  it("«Empezar de nuevo» retira la oferta SIN borrar ninguno de los dos borradores", async () => {
    const solo = await pdfFile("Plantilla.pdf", 72);
    await seedDocument({ key: solo.key, id: "4".repeat(64), name: "Plantilla.pdf" });
    await seedDocument({ key: solo.key, id: "5".repeat(64), name: "Plantilla.pdf" });
    const list = await entries();
    render(withLanguage(<UploadOfferHost files={[solo.file]} entries={list} enabled strings={es} onResume={() => {}} onAnnounce={() => {}} onViewAll={() => {}} />));
    fireEvent.click(await screen.findByRole("button", { name: "Empezar de nuevo" }));
    await waitFor(() => expect(screen.queryByText("Retomar lo que tenías")).toBeNull());
    expect(await entries()).toHaveLength(2);
  });
});
