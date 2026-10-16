import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  fakeFingerprintOf,
  freshLibrary,
  makePdfFile,
  minuteClock,
  noIndexedDb,
  seedDocument,
  seedReadyTemplate,
  seedSingleTemplate,
} from "@/app/documents/documents.testkit";
import { renderPreviewDataUrl } from "@/app/pdf-pro/ops/previewRender";
import { __clearThumbnailCacheForTests } from "@/app/documents/useDocumentThumbnail";
import { MyDocumentsView } from "@/components/views/MyDocumentsView";
import { createTemplate } from "@/lib/docLibrary/templatesStore";
import { sampleDraft } from "@/lib/docLibrary/testing/templateSamples";
import { resetSignHandoffForTests, SIGN_HANDOFF_KEY } from "@/lib/docLibrary/signHandoff";
import { getDocument, getDocumentBytes, getLibraryMeta, listDocuments, putDocument } from "@/lib/docLibrary/store";
import { sampleBytes, sampleInput } from "@/lib/docLibrary/testing/sampleDocs";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { es } from "@/lib/locales/es";

/**
 * «Mis documentos» (U2.5), jsdom + fake-indexeddb sobre el almacen REAL de la biblioteca. Se simulan solo pdf.js
 * (miniaturas), la huella (pdf.js en un worker) y el router.
 */

const nav = vi.hoisted(() => ({ push: vi.fn() }));
const render1 = vi.hoisted(() => ({ gate: null as Promise<void> | null, fail: false }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: nav.push }), usePathname: () => "/documents" }));
vi.mock("@/lib/docLibrary/fingerprint", async () => {
  const kit = await import("@/app/documents/documents.testkit");
  return { computeFingerprint: vi.fn(async (source: Uint8Array) => kit.fakeFingerprintOf(source)) };
});
vi.mock("@/app/pdf-pro/ops/previewRender", () => ({
  renderPreviewDataUrl: vi.fn(async () => {
    if (render1.gate) await render1.gate;
    return render1.fail ? null : "data:image/jpeg;base64,AAAA";
  }),
}));

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

function stubStorage(value: unknown) {
  Object.defineProperty(navigator, "storage", { configurable: true, value });
}

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(() => {
  freshLibrary();
  resetSignHandoffForTests();
  __clearThumbnailCacheForTests();
  nav.push.mockClear();
  vi.mocked(renderPreviewDataUrl).mockClear();
  render1.gate = null;
  render1.fail = false;
  stubStorage({ persist: vi.fn(async () => true), persisted: vi.fn(async () => false), estimate: vi.fn(async () => ({ usage: 1024, quota: 1e9 })) });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, "storage");
});

function renderView() {
  return render(
    <LanguageProvider>
      <MyDocumentsView />
    </LanguageProvider>,
  );
}

async function cards() {
  await screen.findByRole("heading", { name: es.documents.listLabel });
  return Array.from(document.querySelectorAll<HTMLElement>("[data-document-id]"));
}
const cardOf = (name: string) => screen.getByRole("heading", { level: 3, name }).closest("li") as HTMLElement;

async function openAdd() {
  fireEvent.click(await screen.findByRole("button", { name: es.documents.add }));
  return screen.findByRole("dialog", { name: es.documents.addTitle });
}
async function addContract(file: File, { name, docType }: { name?: string; docType?: string } = {}) {
  const dialog = await openAdd();
  const input = dialog.querySelector<HTMLInputElement>("[data-add-file]")!;
  fireEvent.change(input, { target: { files: [file] } });
  const nameField = within(dialog).getByLabelText(es.documents.nameLabel) as HTMLInputElement;
  await waitFor(() => expect(nameField.disabled).toBe(false));
  if (name !== undefined) fireEvent.change(nameField, { target: { value: name } });
  if (docType !== undefined) fireEvent.change(within(dialog).getByLabelText(es.documents.typeLabel), { target: { value: docType } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole("button", { name: es.documents.saveDocument }));
  });
  return dialog;
}
const live = () => document.querySelector("[data-documents-live]")!;

describe("estado vacío y privacidad", () => {
  it("vacío: mensaje, botón «Añadir contrato», aviso de privacidad y almacenamiento", async () => {
    renderView();
    expect(await screen.findByText(es.documents.emptyTitle)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: es.documents.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: es.documents.add })).toBeTruthy();
    expect(screen.getByText(es.documents.privacy)).toBeTruthy();
    expect(es.documents.privacy).toBe("Se guarda una copia en este navegador; usa contratos en blanco, sin datos de clientes.");
    expect(es.documents.emptyTitle).toBe("Sube tus contratos una vez y configura dónde firma cada quien");
    expect(document.querySelectorAll("[data-document-id]")).toHaveLength(0);
    const storage = document.querySelector("[data-documents-storage]")!;
    expect(within(storage as HTMLElement).getByText(/0 B usados de 400 MB · 0 de 50 documentos/)).toBeTruthy();
  });

  it("hueco «Respaldar mis documentos» deshabilitado con «Próximamente»", async () => {
    renderView();
    const backup = await screen.findByRole("button", { name: es.documents.backup });
    expect((backup as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(es.documents.backupSoon)).toBeTruthy();
  });

  it("sin IndexedDB explica el motivo, no ofrece añadir y no rompe", async () => {
    noIndexedDb();
    renderView();
    expect(await screen.findByRole("heading", { name: es.documents.unavailableTitle })).toBeTruthy();
    expect(screen.getByText(es.documents.unavailableBody)).toBeTruthy();
    expect(screen.queryByRole("button", { name: es.documents.add })).toBeNull();
    expect(screen.queryByText(es.documents.emptyTitle)).toBeNull();
    expect(screen.queryByRole("heading", { name: es.documents.storageTitle })).toBeNull();
  });
});

describe("lista con ✓ / ✓ parcial / ✗", () => {
  async function seedThree() {
    const clock = minuteClock();
    await seedDocument("ready-doc", { name: "Remediación de moho", pages: 9, now: clock });
    await seedDocument("single-doc", { name: "Mitigación", pages: 1, now: clock });
    await seedDocument("none-doc", { name: "Prueba de moho", pages: 8, now: clock });
    await seedReadyTemplate("ready-doc");
    await seedSingleTemplate("single-doc");
  }

  it("cada documento dice nombre, tipo, páginas y el estado de su plantilla (texto + marca, no solo color)", async () => {
    await seedThree();
    renderView();
    const list = await cards();
    expect(list).toHaveLength(3);
    // El más reciente primero.
    expect(list.map((c) => c.getAttribute("data-document-id"))).toEqual(["none-doc", "single-doc", "ready-doc"]);

    const ready = cardOf("Remediación de moho");
    expect(within(ready).getByText(es.documents.statusReady)).toBeTruthy();
    expect(ready.querySelector("[data-template-state]")?.getAttribute("data-template-state")).toBe("ready");
    expect(within(ready).getByText(/9 páginas/)).toBeTruthy();
    expect(within(ready).getByText(/contrato de servicio/)).toBeTruthy();

    const single = cardOf("Mitigación");
    expect(within(single).getByText(es.documents.statusSingle)).toBeTruthy();
    expect(single.querySelector("[data-template-state]")?.getAttribute("data-template-state")).toBe("single");
    expect(within(single).getByText(/1 página$/)).toBeTruthy();

    const none = cardOf("Prueba de moho");
    expect(within(none).getByText(es.documents.statusNone)).toBeTruthy();
    expect(none.querySelector("[data-template-state]")?.getAttribute("data-template-state")).toBe("none");
    // Marca distinta por estado (no solo color): ✓ en los dos primeros, ✗ en el tercero.
    expect(ready.querySelector("[data-template-state] svg")?.getAttribute("class")).toContain("lucide-check");
    expect(single.querySelector("[data-template-state] svg")?.getAttribute("class")).toContain("lucide-check");
    expect(none.querySelector("[data-template-state] svg")?.getAttribute("class")).toContain("lucide-x");
  });

  it("acciones de 44 px, nombres que dicen sobre qué documento actúan y casilla por documento", async () => {
    await seedThree();
    renderView();
    await cards();
    const ready = cardOf("Remediación de moho");
    const sign = within(ready).getByRole("button", { name: fill(es.documents.signNamed, { name: "Remediación de moho" }) });
    const configure = within(ready).getByRole("button", { name: fill(es.documents.configureNamed, { name: "Remediación de moho" }) });
    const more = within(ready).getByRole("button", { name: fill(es.documents.moreActions, { name: "Remediación de moho" }) });
    expect(sign.textContent).toBe(es.documents.sign);
    expect(configure.textContent).toBe(es.documents.configure);
    expect(sign.className).toContain("min-h-11");
    expect(configure.className).toContain("min-h-11");
    expect(more.className).toContain("size-11");
    expect(within(ready).getByRole("checkbox", { name: fill(es.documents.select, { name: "Remediación de moho" }) })).toBeTruthy();
    // Las partes que muestran texto largo parten líneas en vez de desbordar.
    expect(ready.querySelector("[data-document-name]")?.className).toContain("overflow-wrap:anywhere");
  });

  it("una sola región viva y los controles se alcanzan con el teclado (sin tabindex positivos)", async () => {
    await seedThree();
    renderView();
    await cards();
    expect(document.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(1);
    for (const el of Array.from(document.querySelectorAll("[tabindex]"))) {
      expect(Number(el.getAttribute("tabindex"))).toBeLessThanOrEqual(0);
    }
  });
});

describe("añadir contrato", () => {
  it("elegir el PDF rellena el nombre; guardar crea la tarjeta (✗ al principio), pide almacenamiento persistente y anuncia", async () => {
    renderView();
    await addContract(makePdfFile("Contrato de servicio", { pages: 4, seed: 11 }), { name: "Servicio 2026", docType: "contrato" });
    const card = await waitFor(() => cardOf("Servicio 2026"));
    expect(within(card).getByText(es.documents.statusNone)).toBeTruthy();
    expect(within(card).getByText(/contrato · 4 páginas/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(live().textContent).toBe(fill(es.documents.announceAdded, { name: "Servicio 2026" }));

    // Guardó entrada Y copia en la biblioteca, con la huella calculada.
    const { documents } = await listDocuments();
    expect(documents).toHaveLength(1);
    expect(documents[0].fingerprint.exact).toBe(fakeFingerprintOf(new TextEncoder().encode("pages=4 seed=11")).exact);
    expect((await getDocumentBytes(documents[0].id))?.length).toBeGreaterThan(10);
    // Primer documento: se pidió el almacenamiento persistente y se ve en la pantalla.
    expect((navigator.storage.persist as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((await getLibraryMeta()).persistence?.granted).toBe(true);
    await waitFor(() => expect(document.querySelector("[data-persist-state]")?.getAttribute("data-persist-state")).toBe("granted"));
  });

  it("el nombre sugerido es el del archivo sin .pdf y el tipo por defecto «Contrato»", async () => {
    renderView();
    const dialog = await openAdd();
    fireEvent.change(dialog.querySelector("[data-add-file]")!, { target: { files: [makePdfFile("Poder notarial")] } });
    await waitFor(() => expect((within(dialog).getByLabelText(es.documents.nameLabel) as HTMLInputElement).value).toBe("Poder notarial"));
    expect((within(dialog).getByLabelText(es.documents.typeLabel) as HTMLInputElement).value).toBe(es.documents.typeDefault);
    expect(within(dialog).getByRole("button", { name: es.documents.saveDocument }).hasAttribute("disabled")).toBe(false);
  });

  it("«Guardar» está deshabilitado sin archivo o con el nombre vacío", async () => {
    renderView();
    const dialog = await openAdd();
    const save = within(dialog).getByRole("button", { name: es.documents.saveDocument }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(dialog.querySelector("[data-add-file]")!, { target: { files: [makePdfFile("A")] } });
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.change(within(dialog).getByLabelText(es.documents.nameLabel), { target: { value: "   " } });
    expect(save.disabled).toBe(true);
  });

  it("un archivo que no es PDF se rechaza con un mensaje y no guarda nada", async () => {
    renderView();
    const dialog = await openAdd();
    fireEvent.change(dialog.querySelector("[data-add-file]")!, { target: { files: [new File(["hola"], "nota.docx", { type: "application/msword" })] } });
    expect((await within(dialog).findByText(es.documents.errorNotPdf))).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: es.documents.saveDocument }) as HTMLButtonElement).disabled).toBe(true);
    expect((await listDocuments()).documents).toHaveLength(0);
  });

  it("un PDF dañado muestra el error en la hoja, que sigue abierta, y no guarda nada", async () => {
    renderView();
    const dialog = await addContract(makePdfFile("corrupt"));
    expect(await within(dialog).findByText(es.documents.errorCorrupt)).toBeTruthy();
    expect(screen.getByRole("dialog", { name: es.documents.addTitle })).toBeTruthy();
    expect((await listDocuments()).documents).toHaveLength(0);
    expect(live().textContent).toBe("");
  });

  it("al llegar al máximo de documentos lo dice (50)", async () => {
    for (let i = 0; i < 50; i += 1) await putDocument(sampleInput(`bulk-${i}`, { name: `Doc ${i}` }), sampleBytes());
    renderView();
    const dialog = await addContract(makePdfFile("uno mas"));
    expect(await within(dialog).findByText(es.documents.errorFull)).toBeTruthy();
    expect((await listDocuments()).documents).toHaveLength(50);
  });

  it("el segundo documento ya no vuelve a pedir el almacenamiento persistente", async () => {
    renderView();
    await addContract(makePdfFile("Uno", { seed: 1 }));
    await waitFor(() => cardOf("Uno"));
    await addContract(makePdfFile("Dos", { seed: 2 }));
    await waitFor(() => cardOf("Dos"));
    expect((navigator.storage.persist as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

describe("renombrar, reemplazar y borrar (menú de la tarjeta)", () => {
  async function openMenu(name: string) {
    fireEvent.click(within(cardOf(name)).getByRole("button", { name: fill(es.documents.moreActions, { name }) }));
    return screen.findByRole("dialog", { name });
  }

  it("el menú ofrece renombrar, reemplazar PDF y borrar", async () => {
    await seedDocument("a", { name: "Contrato A" });
    renderView();
    await cards();
    const menu = await openMenu("Contrato A");
    for (const label of [es.documents.rename, es.documents.replace, es.documents.delete]) {
      expect(within(menu).getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("renombrar guarda el nombre nuevo, lo anuncia y conserva plantilla y tipo", async () => {
    await seedDocument("a", { name: "Contrato A" });
    await seedReadyTemplate("a");
    renderView();
    await cards();
    const menu = await openMenu("Contrato A");
    fireEvent.click(within(menu).getByRole("button", { name: es.documents.rename }));
    const dialog = await screen.findByRole("dialog", { name: es.documents.renameTitle });
    const field = within(dialog).getByLabelText(es.documents.nameLabel) as HTMLInputElement;
    expect(field.value).toBe("Contrato A");
    fireEvent.change(field, { target: { value: "  Servicio principal  " } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: es.documents.save }));
    });
    await waitFor(() => expect(cardOf("Servicio principal")).toBeTruthy());
    expect(screen.queryByRole("heading", { level: 3, name: "Contrato A" })).toBeNull();
    expect(live().textContent).toBe(fill(es.documents.announceRenamed, { name: "Servicio principal" }));
    expect((await getDocument("a"))?.name).toBe("Servicio principal");
    expect(within(cardOf("Servicio principal")).getByText(es.documents.statusReady)).toBeTruthy();
  });

  it("reemplazar el PDF recalcula la huella y conserva nombre y plantilla; si coincide no avisa", async () => {
    await seedDocument("a", { name: "Contrato A", seed: 7, pages: 3 });
    await seedReadyTemplate("a");
    renderView();
    await cards();
    const menu = await openMenu("Contrato A");
    const before = (await getDocument("a"))!;
    const input = document.querySelector<HTMLInputElement>("[data-replace-input]")!;
    const clicked = vi.spyOn(input, "click");
    fireEvent.click(within(menu).getByRole("button", { name: es.documents.replace }));
    expect(clicked).toHaveBeenCalledTimes(1);
    // Mismo contenido, otros bytes (re-exportado): misma semilla de texto pero distinto archivo.
    await act(async () => {
      fireEvent.change(input, { target: { files: [new File(["%PDF-1.7 pages=3 seed=7 re-exportado con otros bytes"], "nuevo.pdf", { type: "application/pdf" })] } });
    });
    await waitFor(async () => expect((await getDocument("a"))!.rev).toBeGreaterThan(before.rev));
    const after = (await getDocument("a"))!;
    expect(after.name).toBe("Contrato A");
    expect(after.fileName).toBe("nuevo.pdf");
    expect(after.templateIds).toEqual(before.templateIds);
    await waitFor(() => expect(live().textContent).toBe(fill(es.documents.announceReplaced, { name: "Contrato A" })));
    expect(document.querySelector("[data-documents-warning]")).toBeNull();
    expect(within(cardOf("Contrato A")).getByText(es.documents.statusReady)).toBeTruthy();
  });

  it("reemplazar por OTRO documento avisa que la plantilla ya no coincide", async () => {
    await seedDocument("a", { name: "Contrato A", seed: 7, pages: 3 });
    await seedReadyTemplate("a");
    renderView();
    await cards();
    const menu = await openMenu("Contrato A");
    fireEvent.click(within(menu).getByRole("button", { name: es.documents.replace }));
    const input = document.querySelector<HTMLInputElement>("[data-replace-input]")!;
    await act(async () => {
      fireEvent.change(input, { target: { files: [makePdfFile("otro", { pages: 6, seed: 99 })] } });
    });
    const warning = await waitFor(() => {
      const el = document.querySelector("[data-documents-warning]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(warning.textContent).toContain(fill(es.documents.replacedMismatch, { name: "Contrato A" }));
    expect(live().textContent).toBe(fill(es.documents.replacedMismatch, { name: "Contrato A" }));
    expect((await getDocument("a"))!.pageCount).toBe(6);
  });

  describe("plantilla desactualizada tras reemplazar el PDF (F2-fix · MAYOR 3)", () => {
    async function replaceWithOther(name: string, file: File) {
      const menu = await openMenu(name);
      fireEvent.click(within(menu).getByRole("button", { name: es.documents.replace }));
      await act(async () => {
        fireEvent.change(document.querySelector("[data-replace-input]")!, { target: { files: [file] } });
      });
    }

    it("tras reemplazar por OTRO contrato la tarjeta deja de decir «Plantilla lista»: icono + texto «Plantilla desactualizada», «Reconfigurar» y «sigue valiendo»", async () => {
      await seedDocument("a", { name: "Contrato A", seed: 7, pages: 3 });
      await seedReadyTemplate("a");
      renderView();
      await cards();
      expect(within(cardOf("Contrato A")).getByText(es.documents.statusReady)).toBeTruthy();
      expect(cardOf("Contrato A").querySelector('[data-template-state="ready"]')).not.toBeNull();
      await replaceWithOther("Contrato A", makePdfFile("otro", { pages: 6, seed: 99 }));
      await waitFor(() => expect(cardOf("Contrato A").querySelector('[data-template-state="stale"]')).not.toBeNull());
      const card = within(cardOf("Contrato A"));
      expect(card.getByText(es.documents.statusStale)).toBeTruthy();
      expect(card.queryByText(es.documents.statusReady)).toBeNull();
      expect(cardOf("Contrato A").querySelector('[data-template-state="ready"]')).toBeNull();
      // Nunca solo color: el estado lleva un icono (SVG) Y texto.
      expect(cardOf("Contrato A").querySelector('[data-template-state="stale"] svg')).not.toBeNull();
      expect(card.getByText(es.documents.staleHint)).toBeTruthy();
      expect(card.getByRole("button", { name: fill(es.documents.reconfigureNamed, { name: "Contrato A" }) })).toBeTruthy();
      expect(card.queryByRole("button", { name: fill(es.documents.configureNamed, { name: "Contrato A" }) })).toBeNull();
      expect(card.getByRole("button", { name: fill(es.documents.keepTemplateNamed, { name: "Contrato A" }) })).toBeTruthy();
      // Se persiste: sobrevive a volver a abrir la pantalla.
      expect((await getDocument("a"))!.templateStale).toBeDefined();
      cleanup();
      renderView();
      await cards();
      expect(cardOf("Contrato A").querySelector('[data-template-state="stale"]')).not.toBeNull();
    });

    it("«Esta plantilla sigue valiendo» quita el aviso, lo anuncia y no mueve el documento", async () => {
      await seedDocument("a", { name: "Contrato A", seed: 7, pages: 3 });
      await seedReadyTemplate("a");
      renderView();
      await cards();
      await replaceWithOther("Contrato A", makePdfFile("otro", { pages: 6, seed: 99 }));
      await waitFor(() => expect(cardOf("Contrato A").querySelector('[data-template-state="stale"]')).not.toBeNull());
      const updatedAt = (await getDocument("a"))!.updatedAt;
      await act(async () => {
        fireEvent.click(within(cardOf("Contrato A")).getByRole("button", { name: fill(es.documents.keepTemplateNamed, { name: "Contrato A" }) }));
      });
      await waitFor(() => expect(within(cardOf("Contrato A")).getByText(es.documents.statusReady)).toBeTruthy());
      expect(cardOf("Contrato A").querySelector('[data-template-state="stale"]')).toBeNull();
      expect(within(cardOf("Contrato A")).queryByText(es.documents.staleHint)).toBeNull();
      expect(live().textContent).toBe(fill(es.documents.announceKept, { name: "Contrato A" }));
      expect(document.querySelector("[data-documents-warning]")).toBeNull();
      const after = (await getDocument("a"))!;
      expect(after.templateStale).toBeUndefined();
      expect(after.updatedAt).toBe(updatedAt);
    });

    it("«Firmar» y «Reconfigurar» siguen dejando el traspaso por id (Firmar compara el PDF real; aquí no se decide nada)", async () => {
      await seedDocument("a", { name: "Contrato A", seed: 7, pages: 3 });
      await seedReadyTemplate("a");
      renderView();
      await cards();
      await replaceWithOther("Contrato A", makePdfFile("otro", { pages: 6, seed: 99 }));
      await waitFor(() => expect(cardOf("Contrato A").querySelector('[data-template-state="stale"]')).not.toBeNull());
      fireEvent.click(within(cardOf("Contrato A")).getByRole("button", { name: fill(es.documents.signNamed, { name: "Contrato A" }) }));
      expect(JSON.parse(window.sessionStorage.getItem(SIGN_HANDOFF_KEY) ?? "null")).toMatchObject({ documentIds: ["a"], mode: "sign" });
      fireEvent.click(within(cardOf("Contrato A")).getByRole("button", { name: fill(es.documents.reconfigureNamed, { name: "Contrato A" }) }));
      expect(JSON.parse(window.sessionStorage.getItem(SIGN_HANDOFF_KEY) ?? "null")).toMatchObject({ documentIds: ["a"], mode: "configure" });
    });

    it("reemplazar por el mismo contrato (re-exportado) NO la deja desactualizada; sin plantilla (✗) no hay nada desactualizado", async () => {
      await seedDocument("a", { name: "Contrato A", seed: 7, pages: 3 });
      await seedReadyTemplate("a");
      await seedDocument("b", { name: "Contrato B", seed: 11, pages: 3 });
      renderView();
      await cards();
      await replaceWithOther("Contrato A", new File(["%PDF-1.7 pages=3 seed=7 re-exportado con otros bytes"], "nuevo.pdf", { type: "application/pdf" }));
      await waitFor(() => expect(live().textContent).toBe(fill(es.documents.announceReplaced, { name: "Contrato A" })));
      expect(cardOf("Contrato A").querySelector('[data-template-state="ready"]')).not.toBeNull();
      await replaceWithOther("Contrato B", makePdfFile("otro", { pages: 6, seed: 99 }));
      await waitFor(() => expect(live().textContent).toBe(fill(es.documents.announceReplaced, { name: "Contrato B" })));
      expect(cardOf("Contrato B").querySelector('[data-template-state="none"]')).not.toBeNull();
      expect(cardOf("Contrato B").querySelector('[data-template-state="stale"]')).toBeNull();
      expect(within(cardOf("Contrato B")).queryByRole("button", { name: /sigue valiendo/ })).toBeNull();
    });

    it("el aviso de reemplazo compara con el PDF sobre el que se configuró la plantilla: volver a poner el contrato original no avisa y la deja al día", async () => {
      await seedDocument("a", { name: "Contrato A", seed: 7, pages: 3 });
      await seedReadyTemplate("a");
      renderView();
      await cards();
      await replaceWithOther("Contrato A", makePdfFile("otro", { pages: 6, seed: 99 }));
      await waitFor(() => expect(cardOf("Contrato A").querySelector('[data-template-state="stale"]')).not.toBeNull());
      expect(document.querySelector("[data-documents-warning]")).not.toBeNull();
      // El contrato ORIGINAL de nuevo (re-exportado): coincide con el de la plantilla aunque no con el reemplazo anterior.
      await replaceWithOther("Contrato A", new File(["%PDF-1.7 pages=3 seed=7 original reexportado"], "original.pdf", { type: "application/pdf" }));
      await waitFor(() => expect(live().textContent).toBe(fill(es.documents.announceReplaced, { name: "Contrato A" })));
      expect(document.querySelector("[data-documents-warning]")).toBeNull();
      await waitFor(() => expect(cardOf("Contrato A").querySelector('[data-template-state="ready"]')).not.toBeNull());
      expect((await getDocument("a"))!.templateStale).toBeUndefined();
    });

    it("una plantilla de 1 firmante también queda desactualizada (no «✓ de 1 firmante»)", async () => {
      await seedDocument("a", { name: "Contrato A", seed: 7, pages: 3 });
      await seedSingleTemplate("a");
      renderView();
      await cards();
      expect(cardOf("Contrato A").querySelector('[data-template-state="single"]')).not.toBeNull();
      await replaceWithOther("Contrato A", makePdfFile("otro", { pages: 6, seed: 99 }));
      await waitFor(() => expect(cardOf("Contrato A").querySelector('[data-template-state="stale"]')).not.toBeNull());
      expect(within(cardOf("Contrato A")).queryByText(es.documents.statusSingle)).toBeNull();
    });
  });

  it("reemplazar un documento SIN plantilla no avisa nada", async () => {
    await seedDocument("a", { name: "Contrato A", seed: 7 });
    renderView();
    await cards();
    const menu = await openMenu("Contrato A");
    fireEvent.click(within(menu).getByRole("button", { name: es.documents.replace }));
    await act(async () => {
      fireEvent.change(document.querySelector("[data-replace-input]")!, { target: { files: [makePdfFile("otro", { seed: 99 })] } });
    });
    await waitFor(() => expect(live().textContent).toBe(fill(es.documents.announceReplaced, { name: "Contrato A" })));
    expect(document.querySelector("[data-documents-warning]")).toBeNull();
  });

  it("reemplazar con un archivo que no es PDF avisa y no cambia nada", async () => {
    await seedDocument("a", { name: "Contrato A", seed: 7 });
    renderView();
    await cards();
    const menu = await openMenu("Contrato A");
    const before = (await getDocument("a"))!;
    fireEvent.click(within(menu).getByRole("button", { name: es.documents.replace }));
    await act(async () => {
      fireEvent.change(document.querySelector("[data-replace-input]")!, { target: { files: [new File(["x"], "x.txt", { type: "text/plain" })] } });
    });
    await waitFor(() => expect(live().textContent).toBe(es.documents.errorNotPdf));
    expect((await getDocument("a"))!.rev).toBe(before.rev);
  });

  it("borrar pide confirmación: «Cancelar» no borra; «Borrar» quita la tarjeta, la copia y lo anuncia", async () => {
    await seedDocument("a", { name: "Contrato A" });
    await seedDocument("b", { name: "Contrato B" });
    renderView();
    await cards();

    let menu = await openMenu("Contrato B");
    fireEvent.click(within(menu).getByRole("button", { name: es.documents.delete }));
    let confirm = await screen.findByRole("dialog", { name: fill(es.documents.deleteTitle, { name: "Contrato B" }) });
    expect(within(confirm).getByText(es.documents.deleteBody)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: es.common.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await listDocuments()).documents).toHaveLength(2);
    expect(cardOf("Contrato B")).toBeTruthy();

    menu = await openMenu("Contrato B");
    fireEvent.click(within(menu).getByRole("button", { name: es.documents.delete }));
    confirm = await screen.findByRole("dialog", { name: fill(es.documents.deleteTitle, { name: "Contrato B" }) });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: es.documents.deleteConfirm }));
    });
    await waitFor(() => expect(screen.queryByRole("heading", { level: 3, name: "Contrato B" })).toBeNull());
    expect(cardOf("Contrato A")).toBeTruthy();
    expect((await listDocuments()).documents.map((d) => d.id)).toEqual(["a"]);
    expect(await getDocumentBytes("b")).toBeNull();
    await waitFor(() => expect(live().textContent).toBe(fill(es.documents.announceDeleted, { name: "Contrato B" })));
    // El foco no cae a <body>: pasa al título.
    await waitFor(() => expect(document.activeElement?.tagName).toBe("H1"));
  });

  it("borrar un documento con plantillas las deja guardadas sin documento", async () => {
    await seedDocument("a", { name: "Contrato A" });
    await seedReadyTemplate("a");
    renderView();
    await cards();
    const menu = await openMenu("Contrato A");
    fireEvent.click(within(menu).getByRole("button", { name: es.documents.delete }));
    const confirm = await screen.findByRole("dialog", { name: fill(es.documents.deleteTitle, { name: "Contrato A" }) });
    await act(async () => {
      fireEvent.click(within(confirm).getByRole("button", { name: es.documents.deleteConfirm }));
    });
    await waitFor(() => expect(document.querySelectorAll("[data-document-id]")).toHaveLength(0));
    const { listTemplates } = await import("@/lib/docLibrary/templatesStore");
    const { templates } = await listTemplates();
    expect(templates).toHaveLength(1);
    expect(templates[0].documentId).toBeNull();
  });
});

describe("Firmar, Configurar plantilla y selección múltiple (traspaso a Firmar)", () => {
  const handoff = () => JSON.parse(window.sessionStorage.getItem(SIGN_HANDOFF_KEY) ?? "null");

  it("«Firmar» deja el traspaso {ids, mode:'sign'} y navega a /sign-pdf", async () => {
    await seedDocument("a", { name: "Contrato A" });
    renderView();
    await cards();
    fireEvent.click(within(cardOf("Contrato A")).getByRole("button", { name: fill(es.documents.signNamed, { name: "Contrato A" }) }));
    expect(nav.push).toHaveBeenCalledWith("/sign-pdf");
    expect(handoff()).toMatchObject({ documentIds: ["a"], mode: "sign" });
  });

  it("«Configurar plantilla» usa mode:'configure'", async () => {
    await seedDocument("a", { name: "Contrato A" });
    renderView();
    await cards();
    fireEvent.click(within(cardOf("Contrato A")).getByRole("button", { name: fill(es.documents.configureNamed, { name: "Contrato A" }) }));
    expect(nav.push).toHaveBeenCalledWith("/sign-pdf");
    expect(handoff()).toMatchObject({ documentIds: ["a"], mode: "configure" });
  });

  it("«Firmar seleccionados» lleva los 3 ids y solo aparece con selección; «Quitar selección» la limpia", async () => {
    const clock = minuteClock();
    for (const id of ["a", "b", "c", "d"]) await seedDocument(id, { name: `Contrato ${id.toUpperCase()}`, now: clock });
    renderView();
    await cards();
    expect(document.querySelector("[data-documents-selection]")).toBeNull();
    for (const name of ["Contrato A", "Contrato C", "Contrato D"]) {
      fireEvent.click(within(cardOf(name)).getByRole("checkbox"));
    }
    const bar = document.querySelector("[data-documents-selection]") as HTMLElement;
    expect(within(bar).getByText(fill(es.documents.selectedCount, { n: "3" }))).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: fill(es.documents.signSelected, { n: "3" }) }));
    expect(nav.push).toHaveBeenCalledWith("/sign-pdf");
    // En el orden de la lista (más reciente primero).
    expect(handoff()).toMatchObject({ documentIds: ["d", "c", "a"], mode: "sign" });

    fireEvent.click(within(bar).getByRole("button", { name: es.documents.clearSelection }));
    expect(document.querySelector("[data-documents-selection]")).toBeNull();
  });

  it("no deja elegir más de 10: con 10 elegidos las demás casillas se deshabilitan y se explica", async () => {
    const clock = minuteClock();
    for (let i = 0; i < 12; i += 1) await seedDocument(`doc-${String(i).padStart(2, "0")}`, { name: `Doc ${String(i).padStart(2, "0")}`, now: clock });
    renderView();
    await cards();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(12);
    for (const box of boxes.slice(0, 10)) fireEvent.click(box);
    expect(boxes.filter((b) => b.checked)).toHaveLength(10);
    expect(boxes.filter((b) => !b.checked).every((b) => b.disabled)).toBe(true);
    expect(boxes.filter((b) => b.checked).every((b) => !b.disabled)).toBe(true);
    expect(screen.getByText(fill(es.documents.selectionMax, { max: "10" }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: fill(es.documents.signSelected, { n: "10" }) }));
    expect(handoff().documentIds).toHaveLength(10);
  });

  it("un documento borrado desde otra pestaña sale también de la selección", async () => {
    await seedDocument("a", { name: "Contrato A" });
    await seedDocument("b", { name: "Contrato B" });
    renderView();
    await cards();
    fireEvent.click(within(cardOf("Contrato A")).getByRole("checkbox"));
    fireEvent.click(within(cardOf("Contrato B")).getByRole("checkbox"));
    const { deleteDocument } = await import("@/lib/docLibrary/store");
    await act(async () => {
      await deleteDocument("a");
    });
    await waitFor(() => expect(screen.queryByRole("heading", { level: 3, name: "Contrato A" })).toBeNull());
    expect(screen.getByText(es.documents.selectedOne)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: fill(es.documents.signSelected, { n: "1" }) }));
    expect(handoff().documentIds).toEqual(["b"]);
  });
});

describe("refresco en vivo (subscribeToLibrary)", () => {
  it("un documento que llega desde otra pestaña aparece solo; una plantilla nueva cambia ✗ por ✓", async () => {
    renderView();
    expect(await screen.findByText(es.documents.emptyTitle)).toBeTruthy();
    await act(async () => {
      await seedDocument("a", { name: "Contrato A" });
    });
    await waitFor(() => expect(cardOf("Contrato A")).toBeTruthy());
    expect(screen.queryByText(es.documents.emptyTitle)).toBeNull();
    expect(within(cardOf("Contrato A")).getByText(es.documents.statusNone)).toBeTruthy();

    await act(async () => {
      await createTemplate(sampleDraft("a"));
    });
    await waitFor(() => expect(within(cardOf("Contrato A")).getByText(es.documents.statusReady)).toBeTruthy());
  });
});

describe("almacenamiento persistente", () => {
  it("muestra el uso real y el botón pide el almacenamiento y lo anuncia", async () => {
    stubStorage({ persist: vi.fn(async () => true), persisted: vi.fn(async () => false), estimate: vi.fn(async () => ({ usage: 1, quota: 2 })) });
    await seedDocument("a", { name: "Contrato A" });
    renderView();
    await cards();
    const storage = document.querySelector("[data-documents-storage]") as HTMLElement;
    expect(within(storage).getByText(/de 400 MB · 1 de 50 documentos/)).toBeTruthy();
    expect(storage.querySelector("[data-persist-state]")?.getAttribute("data-persist-state")).toBe("unknown");
    await act(async () => {
      fireEvent.click(within(storage).getByRole("button", { name: es.documents.persistRequest }));
    });
    await waitFor(() => expect(storage.querySelector("[data-persist-state]")?.getAttribute("data-persist-state")).toBe("granted"));
    expect(live().textContent).toBe(es.documents.announcePersistGranted);
    expect(within(storage).queryByRole("button", { name: es.documents.persistRequest })).toBeNull();
  });

  it("si el navegador la niega, lo dice (con el aviso de Safari) y deja reintentar", async () => {
    stubStorage({ persist: vi.fn(async () => false), persisted: vi.fn(async () => false) });
    renderView();
    const storage = (await screen.findByRole("heading", { name: es.documents.storageTitle })).closest("section") as HTMLElement;
    await act(async () => {
      fireEvent.click(within(storage).getByRole("button", { name: es.documents.persistRequest }));
    });
    await waitFor(() => expect(storage.querySelector("[data-persist-state]")?.getAttribute("data-persist-state")).toBe("denied"));
    expect(within(storage).getByText(es.documents.persistDenied)).toBeTruthy();
    expect(es.documents.persistDenied).toMatch(/Safari/);
    expect(within(storage).getByText(es.documents.persistTip)).toBeTruthy();
    expect(es.documents.persistTip).toMatch(/pantalla de inicio/);
    expect(live().textContent).toBe(es.documents.announcePersistDenied);
    expect(within(storage).getByRole("button", { name: es.documents.persistRequest })).toBeTruthy();
  });

  it("sin API de almacenamiento persistente lo explica y no ofrece el botón", async () => {
    Reflect.deleteProperty(navigator, "storage");
    stubStorage(undefined);
    renderView();
    const storage = (await screen.findByRole("heading", { name: es.documents.storageTitle })).closest("section") as HTMLElement;
    // Primero «desconocido»: aún no se pidió; se pide y entonces dice que no lo ofrece.
    await act(async () => {
      fireEvent.click(within(storage).getByRole("button", { name: es.documents.persistRequest }));
    });
    await waitFor(() => expect(storage.querySelector("[data-persist-state]")?.getAttribute("data-persist-state")).toBe("unsupported"));
    expect(within(storage).getByText(es.documents.persistUnsupported)).toBeTruthy();
    expect(within(storage).queryByRole("button", { name: es.documents.persistRequest })).toBeNull();
  });
});

describe("miniaturas (en segundo plano, sin bloquear)", () => {
  it("la lista se pinta con icono y la miniatura llega después; queda cacheada por huella", async () => {
    let release!: () => void;
    render1.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await seedDocument("a", { name: "Contrato A" });
    renderView();
    await cards();
    const card = cardOf("Contrato A");
    expect(card.querySelector("[data-doc-thumb]")).toBeNull();
    expect(within(card).getByRole("button", { name: fill(es.documents.signNamed, { name: "Contrato A" }) })).toBeTruthy();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(card.querySelector("img[data-doc-thumb]")?.getAttribute("src")).toBe("data:image/jpeg;base64,AAAA"));
    const img = card.querySelector("img[data-doc-thumb]")!;
    expect(img.getAttribute("alt")).toBe("");
    expect(vi.mocked(renderPreviewDataUrl).mock.calls.length).toBe(1);
    // Volver a montar usa la cache: no se dibuja otra vez.
    cleanup();
    renderView();
    await cards();
    await waitFor(() => expect(cardOf("Contrato A").querySelector("img[data-doc-thumb]")).not.toBeNull());
    expect(vi.mocked(renderPreviewDataUrl).mock.calls.length).toBe(1);
  });

  it("si no se puede dibujar, la tarjeta se queda con el icono (sin error)", async () => {
    render1.fail = true;
    await seedDocument("a", { name: "Contrato A" });
    renderView();
    await cards();
    await waitFor(() => expect(vi.mocked(renderPreviewDataUrl).mock.calls.length).toBeGreaterThan(0));
    expect(cardOf("Contrato A").querySelector("img")).toBeNull();
  });
});

