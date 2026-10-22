import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { es } from "@/lib/locales/es";
import { en } from "@/lib/locales/en";
import { MAX_VAULT_ENTRIES, clearVault, listVault, saveVaultEntry } from "@/app/sign-pdf/signVault";
import { makeImage, vaultInput } from "@/app/sign-pdf/vaultTestUtils";
import { makePng } from "@/lib/backup/__fixtures__/pngFactory";
import { SaveSignatureSheet, type SaveSignatureSheetProps } from "@/app/extract-assets/SaveSignatureSheet";
import { mount, setLanguage } from "@/app/extract-assets/testUtils";

/**
 * Hoja «Guardar en Firmas guardadas» (F7 · U7.4) en jsdom, con una imagen YA limpia (`preCleaned`: jsdom no decodifica
 * imagenes; la limpieza real con `inkExtract` se prueba en el motor y en los E2E). Aqui: tipo, firmante (nuevo o existente),
 * conflicto (reemplazar / otro firmante), limites del baul y el paso de exito.
 */

const x = es.extract;
let seed = 0;

beforeEach(async () => {
  setLanguage("es");
  URL.createObjectURL ??= () => "blob:test";
  URL.revokeObjectURL ??= () => {};
  seed = 10;
  await clearVault();
});
afterEach(() => vi.restoreAllMocks());

function png(width = 60, height = 30) {
  seed += 1;
  return new Blob([makePng({ width, height, seed }) as unknown as BlobPart], { type: "image/png" });
}

function renderSheet(props: Partial<SaveSignatureSheetProps> = {}) {
  const handlers = { onClose: vi.fn(), onSaved: vi.fn(), onCropAnother: vi.fn() };
  const blob = png();
  const load = async () => blob;
  const view = mount(
    <SaveSignatureSheet
      open
      instanceKey={1}
      strings={x}
      closeLabel="Cerrar"
      sourceDocument="Contrato Pérez.pdf"
      load={load}
      preCleaned
      hasAlpha
      defaultKind="signature"
      {...handlers}
      {...props}
    />,
  );
  return { ...view, ...handlers };
}

const dialog = () => screen.getByRole("dialog", { name: "Guardar en Firmas guardadas" });
const nameInput = () => document.querySelector("[data-extract-save-name]") as HTMLInputElement;
const submit = () => document.querySelector("[data-extract-save-submit]") as HTMLButtonElement;

async function ready() {
  await waitFor(() => expect(submit().disabled).toBe(false));
}

async function seedEntry(name: string, extra: Record<string, unknown> = {}) {
  const result = await saveVaultEntry(vaultInput(name, { role: "", sourceDocument: "", initials: null, ...extra }));
  if (!result.ok) throw new Error("no se pudo sembrar");
  return result.entry;
}

describe("abrir", () => {
  it("el foco empieza en el nombre; sin firmantes solo ofrece «Nuevo firmante»; el boton espera a la vista previa", async () => {
    renderSheet();
    await waitFor(() => expect(document.activeElement).toBe(nameInput()));
    expect(within(dialog()).getByRole("radio", { name: "Nuevo firmante" })).toBeTruthy();
    expect(within(dialog()).getAllByRole("radio", { name: /./ }).filter((radio) => radio.getAttribute("name") === "extract-save-signer")).toHaveLength(1);
    await ready();
    expect(within(dialog()).getByText(/Se anota el documento de origen \(«Contrato Pérez.pdf»\)/)).toBeTruthy();
    await waitFor(() => expect(document.querySelector("[data-extract-save-preview]")).not.toBeNull());
  });

  it("lo ya limpio (recorte) no ofrece el color de la tinta; lo detectado, si", async () => {
    const first = renderSheet();
    expect(within(dialog()).queryByRole("radio", { name: "Negro" })).toBeNull();
    first.unmount();
    renderSheet({ preCleaned: false, load: async () => { throw new Error("no se llega"); } });
    expect(within(dialog()).getByRole("radio", { name: "Negro" })).toBeTruthy();
  });

  it("el tipo propuesto es el que se pasa (iniciales) y se puede cambiar", async () => {
    renderSheet({ defaultKind: "initials" });
    expect((within(dialog()).getByRole("radio", { name: /^Iniciales$/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(dialog()).getByRole("radio", { name: /^Firma$/ }));
    expect((within(dialog()).getByRole("radio", { name: /^Firma$/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("si la imagen no se puede preparar lo dice y no deja guardar", async () => {
    renderSheet({ load: async () => new Blob(["no es un png"], { type: "image/png" }) });
    await waitFor(() => expect(within(dialog()).getByText(x.saveDecode)).toBeTruthy());
    expect(submit().disabled).toBe(true);
  });
});

describe("firmante nuevo", () => {
  it("nombre obligatorio: sin el no guarda y el foco va al campo; con el, guarda con origin «extracted»", async () => {
    const { onSaved } = renderSheet();
    await ready();
    fireEvent.click(submit());
    expect(await screen.findByText(x.saveNameNeeded)).toBeTruthy();
    expect(document.activeElement).toBe(nameInput());
    expect((await listVault()).entries).toHaveLength(0);
    fireEvent.change(nameInput(), { target: { value: "Ana Pérez" } });
    fireEvent.change(document.getElementById("extract-save-role")!, { target: { value: "Ajustadora" } });
    fireEvent.click(submit());
    expect(await screen.findByText("Guardada en Firmas guardadas: Ana Pérez.")).toBeTruthy();
    const [entry] = (await listVault()).entries;
    expect(entry).toMatchObject({ signerName: "Ana Pérez", role: "Ajustadora", origin: "extracted", sourceDocument: "Contrato Pérez.pdf", initials: null });
    expect(entry.signature).not.toBeNull();
    expect(onSaved).toHaveBeenCalledWith("Guardada en Firmas guardadas: Ana Pérez.");
  });

  it("tras guardar: «Ver en Firmas guardadas» (enlace a Firmar PDF), «Recortar otra» y «Cerrar»; el foco en «Recortar otra»", async () => {
    const { onCropAnother, onClose } = renderSheet();
    await ready();
    fireEvent.change(nameInput(), { target: { value: "Ana" } });
    fireEvent.click(submit());
    const done = await waitFor(() => {
      const element = document.querySelector("[data-extract-save-done]");
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(within(done).getByRole("link", { name: "Ver en Firmas guardadas" }).getAttribute("href")).toBe("/sign-pdf");
    expect(document.activeElement).toBe(within(done).getByRole("button", { name: "Recortar otra" }));
    fireEvent.click(within(done).getByRole("button", { name: "Recortar otra" }));
    expect(onCropAnother).toHaveBeenCalled();
    fireEvent.click(within(done).getByRole("button", { name: "Cerrar" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("un nombre ya guardado (sin acentos ni mayusculas) se rechaza y no se guarda nada mas", async () => {
    await seedEntry("Ana Pérez");
    renderSheet();
    await ready();
    fireEvent.change(nameInput(), { target: { value: "ana perez" } });
    fireEvent.click(submit());
    expect(await screen.findByText(x.saveNameTaken)).toBeTruthy();
    expect((await listVault()).entries).toHaveLength(1);
  });
});

describe("firmante existente", () => {
  it("la lista muestra nombre, cargo y lo que ya tiene; elegir a uno oculta el nombre y completa SU entrada", async () => {
    const ana = await seedEntry("Ana Pérez", { role: "Ajustadora" });
    renderSheet({ defaultKind: "initials" });
    const radio = await screen.findByRole("radio", { name: /^Ana Pérez · Ajustadora/ });
    expect(radio.closest("label")!.textContent).toContain("Firma");
    fireEvent.click(radio);
    expect(nameInput()).toBeNull();
    expect(document.querySelector("[data-extract-conflict]")).toBeNull();
    await ready();
    fireEvent.click(submit());
    expect(await screen.findByText("Iniciales añadidas a Ana Pérez: ahora la entrada tiene firma e iniciales.")).toBeTruthy();
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(ana.id);
    expect(entries[0].initials).not.toBeNull();
    expect(entries[0].signature).not.toBeNull();
    expect(entries[0].role).toBe("Ajustadora");
  });

  it("si ya tiene ese tipo: grupo «Reemplazar / otro firmante»; sin elegir no guarda; reemplazar conserva la entrada", async () => {
    const ana = await seedEntry("Ana Pérez");
    renderSheet();
    fireEvent.click(await screen.findByRole("radio", { name: /^Ana Pérez/ }));
    const conflict = document.querySelector("[data-extract-conflict]") as HTMLElement;
    expect(conflict.textContent).toContain("Ana Pérez ya tiene firma. ¿Qué hacemos?");
    await ready();
    fireEvent.click(submit());
    expect(await screen.findByText(x.saveConflictNeeded)).toBeTruthy();
    expect(Array.from((await listVault()).entries[0].signature!.png)).toEqual(Array.from(ana.signature!.png));
    fireEvent.click(within(conflict).getByRole("radio", { name: "Reemplazar la actual" }));
    fireEvent.click(submit());
    expect(await screen.findByText("Se reemplazó la firma de Ana Pérez.")).toBeTruthy();
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(ana.id);
    expect(Array.from(entries[0].signature!.png)).not.toEqual(Array.from(ana.signature!.png));
  });

  it("cambiar el tipo reevalua el conflicto: iniciales no chocan con una firma", async () => {
    await seedEntry("Ana Pérez");
    renderSheet();
    fireEvent.click(await screen.findByRole("radio", { name: /^Ana Pérez/ }));
    expect(document.querySelector("[data-extract-conflict]")).not.toBeNull();
    fireEvent.click(within(dialog()).getByRole("radio", { name: /^Iniciales$/ }));
    expect(document.querySelector("[data-extract-conflict]")).toBeNull();
  });

  it("«Guardar como otro firmante»: pide un nombre distinto y deja la primera entrada igual", async () => {
    const ana = await seedEntry("Ana Pérez");
    renderSheet();
    fireEvent.click(await screen.findByRole("radio", { name: /^Ana Pérez/ }));
    fireEvent.click(within(document.querySelector("[data-extract-conflict]") as HTMLElement).getByRole("radio", { name: "Guardar como otro firmante" }));
    await ready();
    fireEvent.click(submit());
    expect(await screen.findByText(x.saveNameNeeded)).toBeTruthy();
    fireEvent.change(nameInput(), { target: { value: "ANA PÉREZ" } });
    fireEvent.click(submit());
    expect(await screen.findByText(x.saveNameTaken)).toBeTruthy();
    fireEvent.change(nameInput(), { target: { value: "Beatriz Ruiz" } });
    fireEvent.click(submit());
    expect(await screen.findByText("Guardada en Firmas guardadas: Beatriz Ruiz.")).toBeTruthy();
    const { entries } = await listVault();
    expect(entries.map((entry) => entry.signerName).sort()).toEqual(["Ana Pérez", "Beatriz Ruiz"]);
    expect(Array.from(entries.find((entry) => entry.signerName === "Ana Pérez")!.signature!.png)).toEqual(Array.from(ana.signature!.png));
  });

  it("se elige con el teclado: las flechas recorren los radios (nativos) y Enter en el boton guarda", async () => {
    await seedEntry("Ana Pérez", { initials: null });
    renderSheet({ defaultKind: "initials" });
    const existing = await screen.findByRole("radio", { name: /^Ana Pérez/ });
    existing.focus();
    expect(document.activeElement).toBe(existing);
    // Los radios nativos comparten `name`: el navegador mueve la seleccion con las flechas; aqui se simula el cambio.
    fireEvent.click(existing);
    await ready();
    fireEvent.submit(document.querySelector("[data-extract-save]")!);
    expect(await screen.findByText(/Iniciales añadidas a Ana Pérez/)).toBeTruthy();
  });
});

describe("limites del baul", () => {
  it(`con ${MAX_VAULT_ENTRIES} firmas avisa y un firmante nuevo se rechaza con el mensaje de limite`, async () => {
    for (let index = 0; index < MAX_VAULT_ENTRIES; index += 1) {
      await saveVaultEntry(vaultInput(`Firmante ${index}`, { role: "", initials: null, signature: makeImage({ seed: 200 + index }) }));
    }
    renderSheet();
    expect(await screen.findByText(x.saveVaultFull)).toBeTruthy();
    await ready();
    fireEvent.change(nameInput(), { target: { value: "Uno más" } });
    fireEvent.click(submit());
    expect(await screen.findByText(x.saveLimit)).toBeTruthy();
    expect((await listVault()).entries).toHaveLength(MAX_VAULT_ENTRIES);
    // Con la hoja en error se puede intentar de nuevo: el boton sigue activo.
    expect(submit().disabled).toBe(false);
  });

  it("una imagen de mas de 600 KB se rechaza con su mensaje y no deja guardar", async () => {
    const huge = new Blob([makePng({ width: 60, height: 30, seed: 3 }), new Uint8Array(700 * 1024)] as unknown as BlobPart[], { type: "image/png" });
    renderSheet({ load: async () => huge });
    await waitFor(() => expect(submit().disabled).toBe(true));
    await ready().catch(() => undefined);
    fireEvent.change(nameInput(), { target: { value: "Ana" } });
    fireEvent.click(submit());
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("IndexedDB no disponible: lo explica y sugiere descargar", async () => {
    vi.spyOn(indexedDB, "open").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    renderSheet();
    await ready();
    fireEvent.change(nameInput(), { target: { value: "Ana" } });
    fireEvent.click(submit());
    expect(await screen.findByText(x.saveUnavailable)).toBeTruthy();
  });
});

describe("ingles", () => {
  it("etiquetas y mensajes en ingles", async () => {
    setLanguage("en");
    renderSheet({ strings: en.extract, closeLabel: "Close" });
    expect(await screen.findByRole("dialog", { name: "Save to Saved signatures" })).toBeTruthy();
    await waitFor(() => expect(submit().disabled).toBe(false));
    expect(within(screen.getByRole("dialog")).getByRole("radio", { name: "New signer" })).toBeTruthy();
    fireEvent.click(submit());
    expect(await screen.findByText("Type the name of the person who signs.")).toBeTruthy();
  });
});
