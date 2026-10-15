import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { SignToolClient } from "@/app/sign-pdf/SignToolClient";
import { documentContentKey } from "@/app/sign-pdf/documentKey";
import { SESSION_ID, seedSession } from "@/app/sign-pdf/draftTestUtils";
import { __setSessionDeleteGraceForTests } from "@/app/sign-pdf/SessionDraftAutosave";
import { hasPendingDraftWrite } from "@/app/sign-pdf/draftActivity";
import { currentSessionParam } from "@/app/sign-pdf/sessionUrl";
import { clearAllDrafts, listAllDrafts, listDrafts, listSessionDrafts } from "@/app/sign-pdf/signDrafts";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { __resetSignPdfFeatureFlagsCacheForTests } from "@/app/sign-pdf/signFeatureFlags";
import { __resetSignTemplatesCacheForTests } from "@/app/sign-pdf/signTemplates";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { es } from "@/lib/locales/es";
import { detectFields } from "@/lib/pdf/detectFields";
import { __resetValueHistoryCacheForTests } from "@/lib/valueHistory";

/*
 * «Retomar sin buscar» y «no perder el trabajo al salir» (Fase 0 «Firma agil», U0.3) a traves de `SignToolClient` completo,
 * sobre IndexedDB falsa: la tarjeta de entrada, la oferta al subir los mismos PDF, `?s=` al recargar, el «Atras» del
 * navegador con su hoja, el contador de «Ver borradores» y «Deshacer» al quitar un documento.
 */

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return {
    ...actual,
    openPdfDocument: async () => ({ numPages: 2, getPage: async () => ({ cleanup: () => {} }) }),
    renderPageToDataUrl: async () => "data:image/png;base64,iVBORw0KGgo=",
    closePdfDocument: async () => {},
    downloadBlob: vi.fn(),
  };
});
vi.mock("@/lib/pdf/detectFields", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/detectFields")>();
  return { ...actual, detectFields: vi.fn(async () => []) };
});

vi.setConfig({ testTimeout: 30_000 });

const strings = SIGN_STRINGS.es;
const r = strings.resume;

beforeAll(() => {
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 600, height: 800, top: 0, left: 0, right: 600, bottom: 800, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
});

let seed = 500;
/** Un PDF real de 2 paginas, distinto en cada llamada (otra huella). */
async function pdf(name: string): Promise<File> {
  const document = await PDFDocument.create();
  seed += 1;
  document.addPage([300 + seed, 300]);
  document.addPage([300 + seed, 300]);
  const bytes = await document.save({ useObjectStreams: true });
  return new File([bytes as unknown as BlobPart], name, { type: "application/pdf" });
}

beforeEach(async () => {
  vi.mocked(detectFields).mockReset();
  vi.mocked(detectFields).mockResolvedValue([]);
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/sign-pdf");
  __resetValueHistoryCacheForTests();
  __resetSignPdfFeatureFlagsCacheForTests();
  __resetSignTemplatesCacheForTests();
  __setSessionDeleteGraceForTests(null);
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  await clearAllDrafts();
});

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await clearAllDrafts();
});

function renderTool() {
  return render(
    <LanguageProvider>
      <SignToolClient />
    </LanguageProvider>,
  );
}

const pdfInput = (container: HTMLElement) => container.querySelector('input[type="file"][accept*="pdf"]') as HTMLInputElement;
const docNav = () => screen.queryByRole("navigation", { name: strings.documentsLabel });
const docButtons = () => within(docNav()!).getAllByRole("button");

async function load(container: HTMLElement, ...files: File[]) {
  fireEvent.change(pdfInput(container), { target: { files } });
  await waitFor(() => expect(screen.getByText(es.tool.filesTitle)).toBeTruthy());
}

async function startRound() {
  fireEvent.click(await screen.findByRole("tab", { name: strings.modeMulti }));
  fireEvent.click(await screen.findByRole("button", { name: strings.addSigner }));
  await screen.findByRole("button", { name: strings.removeSigner(strings.defaultSignerName(1)) });
}

const waitSessions = (count: number) =>
  waitFor(async () => expect(await listSessionDrafts()).toHaveLength(count), { interval: 100 });

/** Guarda una sesion de dos documentos REALES (con su huella) y devuelve sus archivos y su id. */
async function seedRealSession(): Promise<{ id: string; a: File; b: File }> {
  const a = await pdf("Contrato A.pdf");
  const b = await pdf("Anexo B.pdf");
  const id = await seedSession({ keys: [await documentContentKey(a), await documentContentKey(b)] });
  return { id, a, b };
}

const pressBack = async () => {
  window.history.back();
  await new Promise((resolve) => setTimeout(resolve, 60));
};

describe("tarjeta «Tienes una firma sin terminar» al entrar", () => {
  it("con un borrador guardado, entrar en la herramienta lo ofrece; «Retomar» carga los dos documentos y los firmantes", async () => {
    await seedSession();
    renderTool();
    expect(await screen.findByRole("heading", { name: r.cardTitle })).toBeTruthy();
    expect(screen.getByText("Firmantes: Ana, Luis")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: r.resume }));
    await waitFor(() => expect(docNav()).not.toBeNull());
    expect(docButtons().map((button) => button.textContent)).toEqual(["1. Contrato A.pdf", "2. Anexo B.pdf"]);
    // La tarjeta ya no esta: hay un espacio de trabajo.
    expect(screen.queryByRole("heading", { name: r.cardTitle })).toBeNull();
  });

  it("sin borradores no aparece nada", async () => {
    renderTool();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole("heading", { name: r.cardTitle })).toBeNull();
  });

  it("«Descartar» confirma antes de borrar; al confirmar el borrador desaparece y se anuncia", async () => {
    await seedSession();
    renderTool();
    fireEvent.click(await screen.findByRole("button", { name: r.discard }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: r.discardTitle })).getByRole("button", { name: r.discardConfirm }));
    await waitFor(async () => expect(await listAllDrafts()).toEqual([]));
    await waitFor(() => expect(screen.queryByRole("heading", { name: r.cardTitle })).toBeNull());
    // La region viva se rellena un instante DESPUES del encabezado (carrera con la carga de la maquina): se espera, no se lee de golpe.
    await waitFor(() => expect(document.querySelector("[data-resume-live]")?.textContent).toBe(r.discarded));
  });

  it("«Ver todos» abre la hoja de borradores", async () => {
    await seedSession();
    renderTool();
    fireEvent.click(await screen.findByRole("button", { name: r.viewAll }));
    expect(await screen.findByRole("dialog", { name: strings.draftsTitle })).toBeTruthy();
  });

  it("«Ver borradores» es un boton visible de 44 px con el contador de borradores, sin tocar su nombre accesible", async () => {
    await seedSession();
    renderTool();
    const button = await screen.findByRole("button", { name: strings.draftsButton });
    expect(button.className).toContain("h-11");
    await waitFor(() => expect(button.querySelector("[data-drafts-count]")?.textContent).toBe("1"));
    const description = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(description?.textContent).toBe(r.draftsCount(1));
  });

  it("sin borradores el boton no lleva contador", async () => {
    renderTool();
    const button = await screen.findByRole("button", { name: strings.draftsButton });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(button.querySelector("[data-drafts-count]")).toBeNull();
    expect(button.getAttribute("aria-describedby")).toBeNull();
  });
});

describe("oferta «Retomar lo que tenias» al subir los mismos PDF", () => {
  it("al subir EXACTAMENTE los mismos documentos se ofrece; «Retomar» restaura la sesion guardada", async () => {
    const { a, b } = await seedRealSession();
    const { container } = renderTool();
    await load(container, a, b);
    expect(await screen.findByRole("heading", { name: r.offerTitle })).toBeTruthy();
    // El anuncio llega un instante DESPUES de que aparezca el encabezado (F0-fix D6: leerlo de golpe fallaba con la maquina cargada).
    await waitFor(() => expect(document.querySelector("[data-resume-live]")?.textContent).toBe(r.offerAnnounce));

    fireEvent.click(screen.getByRole("button", { name: r.resume }));
    await screen.findByRole("button", { name: strings.removeSigner("Ana") });
    expect(screen.getByRole("button", { name: strings.removeSigner("Luis") })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: r.offerTitle })).toBeNull();
  });

  it("otros PDF (aunque se llamen igual) NO reciben la oferta del borrador equivocado", async () => {
    await seedRealSession();
    const { container } = renderTool();
    await load(container, await pdf("Contrato A.pdf"), await pdf("Anexo B.pdf"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(screen.queryByRole("heading", { name: r.offerTitle })).toBeNull();
  });

  it("«Empezar de nuevo» quita la oferta y deja el borrador en su sitio", async () => {
    const { a, b } = await seedRealSession();
    const { container } = renderTool();
    await load(container, a, b);
    fireEvent.click(await screen.findByRole("button", { name: r.offerStartOver }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: r.offerTitle })).toBeNull());
    expect(await listSessionDrafts()).toHaveLength(1);
  });

  it("con trabajo ya empezado (un firmante) la oferta no se muestra: no pisa lo que hay", async () => {
    const { a, b } = await seedRealSession();
    const { container } = renderTool();
    await load(container, a, b);
    await screen.findByRole("heading", { name: r.offerTitle });
    await startRound();
    await waitFor(() => expect(screen.queryByRole("heading", { name: r.offerTitle })).toBeNull());
  });
});

describe("la sesion en la URL (?s=)", () => {
  it("al haber progreso la direccion pasa a ?s=<id del borrador>, sin nombres, y solo se añade UNA entrada", async () => {
    const before = window.history.length;
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    await waitSessions(1);
    const [meta] = await listSessionDrafts();
    await waitFor(() => expect(currentSessionParam()).toBe(meta.id));
    expect(window.location.href).not.toMatch(/\.pdf|Firmante/);
    expect(window.history.length).toBe(before + 1);
    // Mas cambios (otro firmante) no apilan entradas.
    fireEvent.click(await screen.findByRole("button", { name: strings.addSigner }));
    await waitFor(async () => expect((await listSessionDrafts())[0].signers).toHaveLength(2), { interval: 100 });
    expect(window.history.length).toBe(before + 1);
  });

  it("recargar con ?s=<id> restaura la sesion SOLA, sin tocar nada, y sin parpadeo de la tarjeta de entrada", async () => {
    const id = await seedSession();
    window.history.replaceState(null, "", `/sign-pdf?s=${id}`);
    renderTool();
    await waitFor(() => expect(docNav()).not.toBeNull());
    expect(docButtons().map((button) => button.textContent)).toEqual(["1. Contrato A.pdf", "2. Anexo B.pdf"]);
    await screen.findByRole("button", { name: strings.removeSigner("Ana") });
    expect(screen.queryByRole("heading", { name: r.cardTitle })).toBeNull();
    expect(currentSessionParam()).toBe(id);
  });

  it("un ?s= de un borrador que ya no existe avisa con el mensaje de siempre y se limpia", async () => {
    window.history.replaceState(null, "", `/sign-pdf?s=${SESSION_ID("z")}`);
    renderTool();
    expect(await screen.findByText(es.resume.gone)).toBeTruthy();
    expect(currentSessionParam()).toBeNull();
    expect(docNav()).toBeNull();
  });

  it("un ?s= manipulado no restaura nada, no avisa y se limpia", async () => {
    await seedSession();
    window.history.replaceState(null, "", "/sign-pdf?s=%3Cimg%20src%3Dx%3E");
    renderTool();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(currentSessionParam()).toBeNull();
    expect(screen.queryByText(es.resume.gone)).toBeNull();
    expect(docNav()).toBeNull();
  });

  it("si la carga del borrador FALLA (le faltan sus bytes) lo dice y no deja `?s=` en la direccion", async () => {
    const id = await seedSession();
    // Se pierden los bytes de un documento (otra pestana, el navegador liberando cuota): la sesion no se puede retomar.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("optimuspdf-sign-drafts");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("draftFiles", "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore("draftFiles").delete(`${id}/d1`);
    });
    db.close();
    window.history.replaceState(null, "", `/sign-pdf?s=${id}`);
    renderTool();
    expect(await screen.findByText(es.tool.errors.unknown)).toBeTruthy();
    await waitFor(() => expect(currentSessionParam()).toBeNull());
    expect(docNav()).toBeNull();
  });

  it("«Solo yo» no guarda borrador y por tanto no toca la direccion ni pregunta al salir", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(currentSessionParam()).toBeNull();
    window.history.pushState(null, "", "/sign-pdf?otra=1");
    await pressBack();
    expect(screen.queryByRole("dialog", { name: r.leaveTitle })).toBeNull();
  });
});

describe("«Atras» del navegador", () => {
  it("con trabajo, el «Atras» pregunta «¿Salir de la firma?»; «Seguir firmando» lo conserva todo y vuelve a proteger", async () => {
    const id = await seedSession();
    window.history.replaceState(null, "", `/sign-pdf?s=${id}`);
    renderTool();
    await waitFor(() => expect(docNav()).not.toBeNull());
    await screen.findByRole("button", { name: strings.removeSigner("Ana") });

    await pressBack();
    const sheet = await screen.findByRole("dialog", { name: r.leaveTitle });
    expect(sheet.textContent).toContain("Todo está guardado en este dispositivo");
    fireEvent.click(within(sheet).getByRole("button", { name: r.leaveStay }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: r.leaveTitle })).toBeNull());
    // Nada se perdio: los documentos y los firmantes siguen, y la direccion vuelve a tener la sesion.
    expect(docButtons().map((button) => button.textContent)).toEqual(["1. Contrato A.pdf", "2. Anexo B.pdf"]);
    expect(screen.getByRole("button", { name: strings.removeSigner("Luis") })).toBeTruthy();
    expect(currentSessionParam()).toBe(id);
    // El siguiente «Atras» pregunta de nuevo.
    await pressBack();
    expect(await screen.findByRole("dialog", { name: r.leaveTitle })).toBeTruthy();
  });
});

describe("quitar un documento con trabajo hecho", () => {
  it("avisa «Quitaste ...» con «Deshacer»; el borrador de la sesion se conserva; deshacer devuelve la ronda entera", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    await waitSessions(1);
    const [original] = await listSessionDrafts();

    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[1]);
    await waitFor(() => expect(docNav()).toBeNull());
    await waitFor(() => expect(document.querySelector("[data-resume-live]")?.textContent).toBe(r.removedOne("b.pdf")));
    const undo = screen.getByRole("button", { name: r.removedUndo });
    expect(undo.className).toContain("h-11");
    // El borrador de sesion sigue ahi mientras dure el «Deshacer».
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(await listSessionDrafts()).toHaveLength(1);

    fireEvent.click(undo);
    await waitFor(() => expect(docNav()).not.toBeNull());
    expect(docButtons().map((button) => button.textContent)).toEqual(["1. a.pdf", "2. b.pdf"]);
    await screen.findByRole("button", { name: strings.removeSigner(strings.defaultSignerName(1)) });
    expect(screen.queryByRole("button", { name: r.removedUndo })).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-resume-live]")?.textContent).toBe(r.removedRestored));
    // Y sigue siendo LA MISMA sesion guardada, con sus dos documentos.
    await new Promise((resolve) => setTimeout(resolve, 900));
    const after = await listSessionDrafts();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(original.id);
    expect(after[0].documents.map((doc) => doc.fileName)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("sin deshacer, pasada la ventana el borrador de la sesion se borra y el del documento restante toma el relevo", async () => {
    __setSessionDeleteGraceForTests(500);
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    await waitSessions(1);
    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[1]);
    await waitFor(() => expect(docNav()).toBeNull());
    await waitSessions(0);
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { interval: 100 });
  });

  it("el aviso se retira solo al expirar el «Deshacer»", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    await waitSessions(1);
    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[1]);
    await screen.findByRole("button", { name: r.removedUndo });
    await waitFor(() => expect(screen.queryByRole("button", { name: r.removedUndo })).toBeNull(), { timeout: 9000 });
  });

  it("quitar un documento SIN trabajo hecho no avisa de nada", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[1]);
    await waitFor(() => expect(docNav()).toBeNull());
    expect(screen.queryByRole("button", { name: r.removedUndo })).toBeNull();
  });

  it("añadir archivos despues de quitar descarta el «Deshacer» (ya no describe la ronda de ahora)", async () => {
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await startRound();
    await waitSessions(1);
    fireEvent.click(screen.getAllByRole("button", { name: es.tool.remove })[1]);
    await screen.findByRole("button", { name: r.removedUndo });
    fireEvent.change(pdfInput(container), { target: { files: [await pdf("c.pdf")] } });
    await waitFor(() => expect(screen.queryByRole("button", { name: r.removedUndo })).toBeNull());
  });
});

describe("aviso al cerrar (beforeunload) con la herramienta real", () => {
  const prevented = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  async function restoreRound(signed: string[]) {
    // Los PDF de la sesion son los de `seedSession` (bytes propios): sus huellas reales son las que pide la ronda.
    const files = [new File([new Uint8Array([37, 80, 68, 70, 1])], "Contrato A.pdf"), new File([new Uint8Array([37, 80, 68, 70, 2])], "Anexo B.pdf")];
    const keys = await Promise.all(files.map((file) => documentContentKey(file)));
    const id = await seedSession({ keys: [keys[0], keys[1]], signed });
    window.history.replaceState(null, "", `/sign-pdf?s=${id}`);
    renderTool();
    await waitFor(() => expect(docNav()).not.toBeNull());
    await waitFor(async () => expect(await listSessionDrafts()).toHaveLength(1));
    return id;
  }

  /** Espera a que el autoguardado de lo restaurado termine: lo que se mira despues ya no es «un cambio sin volcar». */
  const settled = () => waitFor(() => expect(hasPendingDraftWrite()).toBe(false), { timeout: 8000 });

  it("con la ronda a medias (firmo Ana, falta Luis) el navegador pregunta aunque todo este guardado", async () => {
    await restoreRound(["sg-1"]);
    await settled();
    // Sin escritura pendiente y con el borrador entero: lo unico que queda para preguntar es la ronda a medias.
    expect(prevented()).toBe(true);
  });

  it("con UN documento tambien: mientras su borrador esta agendado el navegador pregunta, y al guardarse deja de hacerlo", async () => {
    const { container } = renderTool();
    await load(container, await pdf("solo.pdf"));
    await startRound();
    // El autoguardado de un documento espera ~800 ms de calma: mientras tanto el borrador va por detras de la pantalla.
    await waitFor(() => expect(prevented()).toBe(true));
    await waitFor(async () => expect(await listDrafts()).toHaveLength(1), { interval: 100 });
    await waitFor(() => expect(prevented()).toBe(false), { timeout: 5000 });
  });

  it("con todos los trazos recogidos y el borrador al dia ya no pregunta", async () => {
    await restoreRound(["sg-1", "sg-2"]);
    await settled();
    expect(prevented()).toBe(false);
  });

  it("con progreso pero sin firmas recogidas y todo guardado, tampoco pregunta; «Solo yo» sin nada guardado, jamas", async () => {
    await restoreRound([]);
    await settled();
    expect(prevented()).toBe(false);
    cleanup();
    window.history.replaceState(null, "", "/sign-pdf");
    const { container } = renderTool();
    await load(container, await pdf("a.pdf"), await pdf("b.pdf"));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(prevented()).toBe(false);
  });
});
