import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { PROTECT_STRINGS } from "@/app/protect-pdf/strings";
import { useProSave } from "@/app/pdf-pro/save/useProSave";
import { labelsOf, mountTab } from "@/app/pdf-pro/tabs/docTestUtils";
import { __clearProActionsForTests, registerProAction } from "@/app/pdf-pro/shell/proActions";
import { useProWorkingDoc } from "@/app/pdf-pro/useProWorkingDoc";
import { makePdfBytes } from "@/app/pdf-pro/proTestUtils";

/**
 * «Descargar PDF», «Guardar como…» y «Guardar con contraseña…» (U8) con un documento de trabajo real: nombres,
 * avisos previos (firmas, copia sin cifrar), dirty limpio y SIN tocar el historial.
 */

const downloaded = vi.hoisted(() => ({ items: [] as { blob: Blob; name: string }[] }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: (blob: Blob, name: string) => downloaded.items.push({ blob, name }) };
});

const S = PRO_STRINGS.es.save;
const P = PROTECT_STRINGS.es;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});
beforeEach(() => {
  downloaded.items.length = 0;
  __clearProActionsForTests();
});
afterEach(() => cleanup());

function Harness({ guard = (run: () => void) => run() }: { guard?: (run: () => void) => void }) {
  const save = useProSave(guard);
  const { dirty, document } = useProWorkingDoc();
  return (
    <div>
      <button onClick={save.download}>descargar</button>
      <button onClick={save.openSaveAs}>como</button>
      <button onClick={save.openProtect}>proteger</button>
      <output data-testid="state">{`${dirty ? "dirty" : "clean"}|${document?.name}|${document?.renamed ? "renamed" : "plain"}`}</output>
      {save.sheets}
    </div>
  );
}

/**
 * Deja que termine TODO el trabajo asincrono pendiente del documento de trabajo (`commit` cuenta paginas con `await`).
 * Sin esto, un `commit` espurio que aun no aterrizo hace pasar «el historial no cambia» por casualidad.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let round = 0; round < 3; round += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  });
}

type Doc = Awaited<ReturnType<typeof mountTab>>["doc"];
const historyOf = (doc: Doc) => ({
  labels: labelsOf(doc),
  cursor: doc.getState().document!.cursor,
  snapshots: doc.getState().document!.snapshots.length,
});

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const state = () => screen.getByTestId("state").textContent;

async function dirtyDoc(options: Parameters<typeof mountTab>[1] = {}) {
  const mounted = await mountTab(<Harness />, options);
  await act(async () => {
    await mounted.doc.commit(await makePdfBytes(3), "Rotar", "operation", { pageCount: 3 });
  });
  return mounted;
}

describe("Descargar PDF", () => {
  it("un documento sin cambios se descarga con su nombre y sigue limpio", async () => {
    await mountTab(<Harness />, { name: "tal-cual.pdf" });
    click("descargar");
    expect(downloaded.items.map((item) => item.name)).toEqual(["tal-cual.pdf"]);
    expect(downloaded.items[0].blob.type).toBe("application/pdf");
    expect(state()).toBe("clean|tal-cual.pdf|plain");
  });

  it("con cambios: nombre con -pro, el dirty queda limpio y se anuncia", async () => {
    const { doc } = await dirtyDoc({ name: "informe.pdf" });
    expect(state()).toContain("dirty");
    click("descargar");
    expect(downloaded.items.map((item) => item.name)).toEqual(["informe-pro.pdf"]);
    expect(state()).toBe("clean|informe.pdf|plain");
    expect(doc.getState().announcement?.text).toBe(S.downloaded("informe-pro.pdf"));
  });

  it("los bytes descargados son los del snapshot ACTUAL (tras deshacer, el original)", async () => {
    const { doc, original } = await dirtyDoc();
    act(() => {
      doc.undo();
    });
    click("descargar");
    const bytes = new Uint8Array(await downloaded.items[0].blob.arrayBuffer());
    expect(bytes.byteLength).toBe(original.byteLength);
  });

  it("descargar no cambia el historial", async () => {
    const { doc } = await dirtyDoc();
    const before = historyOf(doc);
    click("descargar");
    await settle();
    expect(historyOf(doc)).toEqual(before);
    expect(doc.getState().canUndo).toBe(true);
  });

  it("el guard (modos con cambios sin aplicar) puede impedir la descarga", async () => {
    const guard = vi.fn();
    await mountTab(<Harness guard={guard} />);
    click("descargar");
    expect(guard).toHaveBeenCalledTimes(1);
    expect(downloaded.items).toHaveLength(0);
  });

  it("una accion `save` registrada por otra unidad manda sobre la descarga por defecto", async () => {
    const custom = vi.fn();
    registerProAction("save", custom);
    await mountTab(<Harness />);
    click("descargar");
    expect(custom).toHaveBeenCalledTimes(1);
    expect(downloaded.items).toHaveLength(0);
  });
});

describe("aviso previo: firmas digitales", () => {
  it("firmas activas + cambios: pide confirmar y NO descarga hasta entonces", async () => {
    await dirtyDoc({ signatures: "active" });
    click("descargar");
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(S.confirmSignatures)).toBeTruthy();
    expect(downloaded.items).toHaveLength(0);
    fireEvent.click(within(sheet).getByRole("button", { name: S.confirmDownload }));
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    expect(state()).toContain("clean");
  });

  it("cancelar el aviso no descarga y deja los cambios sin guardar", async () => {
    await dirtyDoc({ signatures: "active" });
    click("descargar");
    const sheet = await screen.findByRole("dialog");
    fireEvent.click(within(sheet).getByRole("button", { name: S.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(downloaded.items).toHaveLength(0);
    expect(state()).toContain("dirty");
  });

  it("firmas activas pero SIN cambios: no hay aviso (el original intacto no pierde las firmas)", async () => {
    await mountTab(<Harness />, { signatures: "active" });
    click("descargar");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(downloaded.items).toHaveLength(1);
  });

  it("firmas desconocidas no bloquean la descarga", async () => {
    await dirtyDoc({ signatures: "unknown" });
    click("descargar");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(downloaded.items).toHaveLength(1);
  });

  it("sin firmas no hay aviso", async () => {
    await dirtyDoc({ signatures: "none" });
    click("descargar");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("aviso previo: copia sin cifrar", () => {
  it("un PDF que venia cifrado avisa de que sale sin contraseña y ofrece volver a protegerlo", async () => {
    await mountTab(<Harness />, { encrypted: true });
    click("descargar");
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(S.confirmDecrypted)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: S.confirmProtect })).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: S.confirmDownloadPlain })).toBeTruthy();
  });

  it("«Descargar sin contraseña» descarga y el aviso no se repite en ese documento", async () => {
    await mountTab(<Harness />, { encrypted: true });
    click("descargar");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: S.confirmDownloadPlain }));
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    click("descargar");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(downloaded.items).toHaveLength(2);
  });

  it("«Guardar con contraseña…» desde el aviso abre el panel de contraseña", async () => {
    await mountTab(<Harness />, { encrypted: true });
    click("descargar");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: S.confirmProtect }));
    expect(await screen.findByLabelText(P.passwordLabel)).toBeTruthy();
    expect(downloaded.items).toHaveLength(0);
  });

  it("cifrado + firmas + cambios: un solo aviso con las dos cosas", async () => {
    await dirtyDoc({ encrypted: true, signatures: "active" });
    click("descargar");
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByText(S.confirmSignatures)).toBeTruthy();
    expect(within(sheet).getByText(S.confirmDecrypted)).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: S.confirmDownload })).toBeTruthy();
  });
});

describe("Guardar como…", () => {
  it("abre con el nombre que se descargaria y descarga con el elegido", async () => {
    await dirtyDoc({ name: "informe.pdf" });
    click("como");
    const field = (await screen.findByLabelText(S.nameLabel)) as HTMLInputElement;
    expect(field.value).toBe("informe-pro.pdf");
    fireEvent.change(field, { target: { value: "Contrato final" } });
    fireEvent.click(screen.getByRole("button", { name: S.saveAsButton }));
    await waitFor(() => expect(downloaded.items.map((item) => item.name)).toEqual(["Contrato final.pdf"]));
    expect(state()).toBe("clean|Contrato final.pdf|renamed");
  });

  it("el nombre elegido se conserva en las descargas siguientes (sin -pro)", async () => {
    await dirtyDoc();
    click("como");
    fireEvent.change(await screen.findByLabelText(S.nameLabel), { target: { value: "Acta" } });
    fireEvent.click(screen.getByRole("button", { name: S.saveAsButton }));
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    click("descargar");
    expect(downloaded.items.map((item) => item.name)).toEqual(["Acta.pdf", "Acta.pdf"]);
  });

  it("un nombre vacio no se puede usar: el boton queda inactivo y no descarga", async () => {
    await mountTab(<Harness />);
    click("como");
    const field = (await screen.findByLabelText(S.nameLabel)) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: S.saveAsButton }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.submit(field.closest("form")!);
    expect(downloaded.items).toHaveLength(0);
  });

  it("un nombre con barras y caracteres prohibidos se limpia", async () => {
    await mountTab(<Harness />);
    click("como");
    fireEvent.change(await screen.findByLabelText(S.nameLabel), { target: { value: "a/b:c" } });
    fireEvent.click(screen.getByRole("button", { name: S.saveAsButton }));
    await waitFor(() => expect(downloaded.items.map((item) => item.name)).toEqual(["a b c.pdf"]));
  });

  it("cancelar no cambia el nombre ni descarga", async () => {
    await mountTab(<Harness />, { name: "informe.pdf" });
    click("como");
    await screen.findByLabelText(S.nameLabel);
    fireEvent.click(screen.getByRole("button", { name: S.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(state()).toBe("clean|informe.pdf|plain");
    expect(downloaded.items).toHaveLength(0);
  });

  it("renombrar no crea un snapshot", async () => {
    const { doc } = await mountTab(<Harness />);
    click("como");
    fireEvent.change(await screen.findByLabelText(S.nameLabel), { target: { value: "Otro" } });
    fireEvent.click(screen.getByRole("button", { name: S.saveAsButton }));
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    await settle();
    expect(historyOf(doc)).toEqual({ labels: ["Original"], cursor: 0, snapshots: 1 });
  });
});

describe("foco al abrir «Guardar como…»", () => {
  it("el cursor queda en el campo del nombre, con el texto seleccionado", async () => {
    await mountTab(<Harness />, { name: "informe.pdf" });
    click("como");
    const field = (await screen.findByLabelText(S.nameLabel)) as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(0);
    expect(field.selectionEnd).toBe(field.value.length);
  });
});

describe("Guardar con contraseña…", () => {
  const typePasswords = (password: string) => {
    fireEvent.change(screen.getByLabelText(P.passwordLabel), { target: { value: password } });
    fireEvent.change(screen.getByLabelText(P.confirmLabel), { target: { value: password } });
  };

  it("descarga el PDF cifrado con el sufijo de la herramienta suelta y NO toca el historial", async () => {
    const { doc } = await dirtyDoc({ name: "informe.pdf" });
    const before = historyOf(doc);
    click("proteger");
    await screen.findByLabelText(P.passwordLabel);
    typePasswords("secreto1");
    fireEvent.click(screen.getByRole("button", { name: PRO_STRINGS.es.docTools.protect.saveButton }));
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    expect(downloaded.items[0].name).toBe("informe-protegido.pdf");
    const bytes = new Uint8Array(await downloaded.items[0].blob.arrayBuffer());
    expect(new TextDecoder("latin1").decode(bytes)).toContain("/Encrypt");
    await settle();
    expect(historyOf(doc)).toEqual(before);
    expect(before.snapshots).toBe(2);
    // Se guardo una copia de este snapshot: ya no hay cambios sin guardar.
    expect(state()).toContain("clean");
  });

  it("el documento de trabajo sigue SIN cifrar: se puede seguir editando", async () => {
    const { doc } = await mountTab(<Harness />);
    click("proteger");
    await screen.findByLabelText(P.passwordLabel);
    typePasswords("secreto1");
    fireEvent.click(screen.getByRole("button", { name: PRO_STRINGS.es.docTools.protect.saveButton }));
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    const bytes = doc.current()!;
    expect(new TextDecoder("latin1").decode(bytes)).not.toContain("/Encrypt");
  });

  it("sin contraseña no descarga: el boton explica el motivo", async () => {
    await mountTab(<Harness />);
    click("proteger");
    await screen.findByLabelText(P.passwordLabel);
    const button = screen.getByRole("button", { name: PRO_STRINGS.es.docTools.protect.saveButton });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(downloaded.items).toHaveLength(0);
  });

  it("la hoja se cierra tras guardar", async () => {
    await mountTab(<Harness />);
    click("proteger");
    await screen.findByLabelText(P.passwordLabel);
    typePasswords("secreto1");
    fireEvent.click(screen.getByRole("button", { name: PRO_STRINGS.es.docTools.protect.saveButton }));
    await waitFor(() => expect(screen.queryByLabelText(P.passwordLabel)).toBeNull());
  });
});
