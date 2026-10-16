import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  SignatureExportSheet,
  SignatureRestoreSheet,
} from "@/app/sign-pdf/SignatureBackupSheet";
import { applyBackupImport, buildSignaturesExport } from "@/app/sign-pdf/backupFlow";
import {
  MAX_VAULT_ENTRIES,
  clearVault,
  commitVaultImport,
  listVault,
  readPngSize,
  saveVaultEntry,
  updateVaultEntry,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import { exportVaultEntry } from "@/app/sign-pdf/signVaultFile";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { LANGUAGE_STORAGE_KEY, LanguageProvider } from "@/lib/i18n";
import { downloadBlob } from "@/lib/pdf/core";
import JSZip from "jszip";
import { buildPackage, readPackage } from "@/lib/backup/package";
import { signaturesModuleFromEntries } from "@/lib/backup/modules/signatures";
import { makeRealPng, pngPixelBomb, pngWithChunk, pngWithCorruptIdat } from "@/lib/backup/__fixtures__/pngFactory";
import { sha256Hex } from "@/lib/crypto/sha256";
import { hostileCorpus } from "@/lib/backup/__fixtures__/hostileCorpus";
import { asFile, editManifest, rewriteZip, vaultEntry, vaultInput } from "@/lib/backup/__fixtures__/testKit";

vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: vi.fn() };
});
vi.mock("@/app/sign-pdf/backupFlow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/sign-pdf/backupFlow")>();
  return { ...actual, applyBackupImport: vi.fn(actual.applyBackupImport) };
});

const strings = SIGN_STRINGS.es;
const copy = strings.vaultBackup;

beforeEach(async () => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
  vi.mocked(downloadBlob).mockClear();
  await clearVault();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function seed(...inputs: ReturnType<typeof vaultInput>[]) {
  for (const input of inputs) {
    const result = await saveVaultEntry(input);
    if (!result.ok) throw new Error(`seed: ${result.reason}`);
  }
}
const vault = async (): Promise<VaultEntry[]> => (await listVault()).entries;

async function fingerprint(entries: VaultEntry[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of entries) {
    out.push(
      [
        entry.signerName,
        entry.signature ? await sha256Hex(entry.signature.png) : "-",
        entry.initials ? await sha256Hex(entry.initials.png) : "-",
      ].join("|"),
    );
  }
  return out.sort();
}

/* ------------------------------------------------------------------ *
 * Exportar
 * ------------------------------------------------------------------ */

function renderExport(count = 2) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <LanguageProvider>
      <SignatureExportSheet open onClose={onClose} strings={strings} count={count} onDone={onDone} />
    </LanguageProvider>,
  );
  return { onClose, onDone };
}

const typePassword = (value: string, repeat = value) => {
  fireEvent.change(screen.getByLabelText(copy.password), { target: { value } });
  fireEvent.change(screen.getByLabelText(copy.confirmPassword), { target: { value: repeat } });
};
/** El texto visible de «N firmas exportadas…» (la region de estado lleva el mismo texto, solo para lectores). */
const doneText = (message: string) =>
  screen.findByText(new RegExp(message.replace(/[().]/g, "\\$&")), { selector: "p.text-subheadline" });
const statusText = () => within(screen.getByRole("dialog")).getByRole("status").textContent ?? "";

describe("Exportar todas mis firmas", () => {
  it("«Proteger con contraseña» viene marcada, pide contraseña + confirmacion y muestra el medidor", async () => {
    renderExport();
    const protect = (await screen.findByRole("checkbox", { name: copy.protect })) as HTMLInputElement;
    expect(protect.checked).toBe(true);
    expect(screen.getByLabelText(copy.password)).toBeTruthy();
    expect(screen.getByLabelText(copy.confirmPassword)).toBeTruthy();
    expect(screen.queryByText(copy.plainWarning)).toBeNull();
    const meter = screen.getByRole("meter", { name: copy.strengthLabel });
    expect(meter.getAttribute("aria-valuenow")).toBe("0");
    expect(meter.getAttribute("aria-valuetext")).toBe(copy.strengthNone);
    fireEvent.change(screen.getByLabelText(copy.password), { target: { value: "abc" } });
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toBe(copy.strength[0]);
    fireEvent.change(screen.getByLabelText(copy.password), { target: { value: "Abcdefg1" } });
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("2");
    fireEvent.change(screen.getByLabelText(copy.password), { target: { value: "correcto-caballo" } });
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("3");
  });

  it("desmarcarla avisa con claridad de que las firmas quedarian sin cifrar y quita los campos de contraseña", async () => {
    renderExport();
    fireEvent.click(await screen.findByRole("checkbox", { name: copy.protect }));
    expect(screen.getByText(copy.plainWarning)).toBeTruthy();
    expect(copy.plainWarning).toMatch(/sin cifrar/);
    expect(screen.queryByLabelText(copy.password)).toBeNull();
  });

  it("contraseña corta o que no coincide: error claro y no se exporta nada", async () => {
    renderExport();
    await screen.findByRole("checkbox", { name: copy.protect });
    typePassword("corta");
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(statusText()).toBe(copy.passwordTooShort));
    typePassword("una-clave-larga", "otra-clave-larga");
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(statusText()).toBe(copy.passwordMismatch));
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("con contraseña: descarga firmas-optimuspdf-AAAA-MM-DD.optimuspdf.zip cifrado y confirma «N firmas exportadas»", async () => {
    await seed(vaultInput("Ana Pérez"), vaultInput("Luis Gómez", { sig: 3, ini: null }));
    const { onDone } = renderExport(2);
    await screen.findByRole("checkbox", { name: copy.protect });
    typePassword("una-clave-larga");
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await doneText(copy.done(2, true));
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, filename] = vi.mocked(downloadBlob).mock.calls[0];
    expect(filename).toMatch(/^firmas-optimuspdf-\d{4}-\d{2}-\d{2}\.optimuspdf\.zip$/);
    await expect(readPackage(blob)).rejects.toMatchObject({ code: "needsPassword" });
    expect((await readPackage(blob, "una-clave-larga")).encrypted).toBe(true);
    expect(onDone).toHaveBeenCalledWith(copy.done(2, true));
    expect(screen.getByRole("button", { name: copy.doneClose })).toBeTruthy();
  });

  it("sin contraseña (desmarcada): el zip sale en claro y el aviso lo dice", async () => {
    await seed(vaultInput("Ana Pérez"));
    renderExport(1);
    fireEvent.click(await screen.findByRole("checkbox", { name: copy.protect }));
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await doneText(copy.done(1, false));
    const [blob] = vi.mocked(downloadBlob).mock.calls[0];
    expect((await readPackage(blob)).encrypted).toBe(false);
  });

  it("sin firmas guardadas: «no hay firmas que exportar»", async () => {
    renderExport(1);
    fireEvent.click(await screen.findByRole("checkbox", { name: copy.protect }));
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await waitFor(() => expect(statusText()).toBe(copy.exportEmpty));
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it("sin WebCrypto (http): la casilla queda desmarcada y deshabilitada con la explicacion, y exportar sin contraseña funciona", async () => {
    await seed(vaultInput("Ana Pérez"));
    vi.stubGlobal("crypto", {});
    renderExport(1);
    const protect = (await screen.findByRole("checkbox", { name: copy.protect })) as HTMLInputElement;
    expect(protect.checked).toBe(false);
    expect(protect.disabled).toBe(true);
    expect(screen.getAllByText(copy.encryptionUnavailable).length).toBeGreaterThan(0);
    expect(screen.getByText(copy.plainWarning)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
    await doneText(copy.done(1, false));
  });

  describe("iPad: hoja de compartir del sistema", () => {
    function stubTouchShare(share: ReturnType<typeof vi.fn>) {
      vi.stubGlobal("matchMedia", (query: string) => ({
        matches: query.includes("pointer: coarse"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }));
      vi.stubGlobal("navigator", { ...navigator, share, canShare: () => true });
    }

    async function toReady() {
      await seed(vaultInput("Ana Pérez"));
      const view = renderExport(1);
      fireEvent.click(await screen.findByRole("checkbox", { name: copy.protect }));
      fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
      await screen.findByRole("button", { name: copy.shareButton });
      return view;
    }

    it("con share({files}) disponible y puntero tactil: primero «listo», y compartir en un segundo toque (gesto de usuario)", async () => {
      const share = vi.fn().mockResolvedValue(undefined);
      stubTouchShare(share);
      const { onDone } = await toReady();
      expect(downloadBlob).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: copy.downloadButton })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: copy.shareButton }));
      await doneText(copy.done(1, false));
      const data = share.mock.calls[0][0] as { files: File[] };
      expect(data.files).toHaveLength(1);
      expect(data.files[0].name).toMatch(/\.optimuspdf\.zip$/);
      expect(data.files[0].type).toBe("application/zip");
      expect(downloadBlob).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledWith(copy.done(1, false));
    });

    it("cerrar la hoja de compartir sin elegir NO cuenta como exportado y se puede reintentar", async () => {
      const share = vi.fn().mockRejectedValueOnce(new DOMException("cancel", "AbortError")).mockResolvedValue(undefined);
      stubTouchShare(share);
      const { onDone } = await toReady();
      fireEvent.click(screen.getByRole("button", { name: copy.shareButton }));
      await waitFor(() => expect(statusText()).toBe(copy.shareCancelled));
      expect(onDone).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: copy.shareButton }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
    });

    it("si compartir falla, cae a la descarga normal", async () => {
      const share = vi.fn().mockRejectedValue(new DOMException("no", "NotAllowedError"));
      stubTouchShare(share);
      await toReady();
      fireEvent.click(screen.getByRole("button", { name: copy.shareButton }));
      await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    });

    it("«Descargar» tambien esta a mano", async () => {
      stubTouchShare(vi.fn());
      await toReady();
      fireEvent.click(screen.getByRole("button", { name: copy.downloadButton }));
      await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    });

    it("en escritorio (sin puntero tactil) descarga directamente aunque exista share", async () => {
      await seed(vaultInput("Ana Pérez"));
      vi.stubGlobal("navigator", { ...navigator, share: vi.fn(), canShare: () => true });
      renderExport(1);
      fireEvent.click(await screen.findByRole("checkbox", { name: copy.protect }));
      fireEvent.click(screen.getByRole("button", { name: copy.exportConfirm }));
      await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    });
  });
});

/* ------------------------------------------------------------------ *
 * Importar
 * ------------------------------------------------------------------ */

function renderRestore(props: Partial<React.ComponentProps<typeof SignatureRestoreSheet>> = {}) {
  const onClose = vi.fn();
  const onDone = vi.fn();
  render(
    <LanguageProvider>
      <SignatureRestoreSheet open onClose={onClose} strings={strings} onDone={onDone} {...props} />
    </LanguageProvider>,
  );
  return { onClose, onDone };
}

const zipInput = () => document.querySelector("[data-backup-file-input]") as HTMLInputElement;
const restoreStatus = () => within(screen.getByRole("dialog")).getByRole("status").textContent ?? "";

async function pickZip(file: File) {
  await screen.findByRole("button", { name: copy.pickZip });
  fireEvent.change(zipInput(), { target: { files: [file] } });
}

/** Un paquete de `inputs` exportado y el baul vaciado: el estado «archivo en mano, baul nuevo». */
async function packageOf(inputs: ReturnType<typeof vaultInput>[], password?: string) {
  await seed(...inputs);
  const result = await buildSignaturesExport({ password });
  if (!result.ok) throw new Error("export");
  await clearVault();
  return asFile(result.blob, result.filename);
}

describe("Importar firmas", () => {
  it("elegir el .zip muestra la vista previa con cada firma «Nuevo» y «Importar N firmas»; al confirmar: «N importadas, M omitidas»", async () => {
    const file = await packageOf([
      vaultInput("Ana Pérez", { role: "Directora" }),
      vaultInput("Luis Gómez", { sig: 3, ini: null }),
      vaultInput("Marta Ruiz", { sig: null, ini: 4 }),
    ]);
    const { onDone } = renderRestore();
    expect(zipInput().accept).toContain(".zip");
    await pickZip(file);
    await screen.findByText(copy.previewIntro(3, false));
    expect(screen.getAllByText(copy.statusNew)).toHaveLength(3);
    expect(screen.getByText("Directora")).toBeTruthy();
    expect(screen.getByText(copy.contents(true, false))).toBeTruthy();
    expect(screen.getByText(copy.contents(false, true))).toBeTruthy();
    expect(screen.getByText(copy.limitOk(3, MAX_VAULT_ENTRIES))).toBeTruthy();
    expect(await vault()).toHaveLength(0); // nada se escribe en la vista previa
    fireEvent.click(screen.getByRole("button", { name: copy.importConfirm(3) }));
    await screen.findByText(copy.result(3, 0, 0), { selector: "p.text-foreground" });
    expect(onDone).toHaveBeenCalledWith(copy.result(3, 0, 0));
    expect(await vault()).toHaveLength(3);
  });

  it("omitir un elemento: el boton cuenta solo lo aprobado y lo omitido se informa", async () => {
    const file = await packageOf([vaultInput("Ana Pérez"), vaultInput("Luis Gómez", { sig: 3 })]);
    renderRestore();
    await pickZip(file);
    await screen.findByText(copy.previewIntro(2, false));
    const [firstGroup] = screen.getAllByRole("radiogroup");
    fireEvent.click(within(firstGroup).getByRole("radio", { name: copy.decisionOmit }));
    fireEvent.click(screen.getByRole("button", { name: copy.importConfirm(1) }));
    await screen.findByText(copy.result(1, 1, 0), { selector: "p.text-foreground" });
    expect(await vault()).toHaveLength(1);
  });

  it("paquete cifrado: pide la contraseña; una incorrecta lo dice sin revelar nada mas y deja reintentar; la buena abre la vista previa", async () => {
    const file = await packageOf([vaultInput("Ana Pérez")], "dorada-2026");
    renderRestore();
    await pickZip(file);
    const input = await screen.findByLabelText(copy.passwordLabel);
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.change(input, { target: { value: "mala-clave" } });
    fireEvent.click(screen.getByRole("button", { name: copy.passwordOpen }));
    await waitFor(() => expect(restoreStatus()).toBe(copy.wrongPassword));
    expect(copy.wrongPassword).toMatch(/o el archivo está dañado/);
    const again = screen.getByLabelText(copy.passwordLabel) as HTMLInputElement;
    expect(again.value).toBe("");
    fireEvent.change(again, { target: { value: "dorada-2026" } });
    fireEvent.click(screen.getByRole("button", { name: copy.passwordOpen }));
    await screen.findByText(copy.previewIntro(1, true));
    expect(await vault()).toHaveLength(0);
  });

  it("«Ya lo tienes (idéntico)»: sin nada que importar, el boton esta deshabilitado", async () => {
    const file = await packageOf([vaultInput("Ana Pérez")]);
    await seed(vaultInput("Ana Pérez"));
    renderRestore();
    await pickZip(file);
    await screen.findByText(copy.statusIdentical);
    const button = screen.getByRole("button", { name: copy.importNothing }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.queryAllByRole("radiogroup")).toHaveLength(0);
  });

  it("«Distinto»: ofrece Reemplazar / Conservar ambos / Omitir y respeta la eleccion", async () => {
    const file = await packageOf([vaultInput("Ana Pérez", { sig: 1, ini: 2 })]);
    await seed(vaultInput("Ana Pérez", { sig: 9, ini: 8 }));
    const before = await fingerprint(await vault());
    renderRestore();
    await pickZip(file);
    await screen.findByText(copy.statusDifferent);
    expect(screen.getByText(copy.differentHint("Ana Pérez"))).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: copy.decisionGroup("Ana Pérez") });
    expect(within(group).getAllByRole("radio").map((radio) => radio.textContent)).toEqual([
      copy.decisionReplace,
      copy.decisionKeepBoth,
      copy.decisionOmit,
    ]);
    // las imagenes del archivo no incluyen las que ya tienes: lo seguro es «Conservar ambos»
    expect(within(group).getByRole("radio", { name: copy.decisionKeepBoth }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(within(group).getByRole("radio", { name: copy.decisionReplace }));
    expect(screen.getByText(copy.replaceLoses)).toBeTruthy();
    fireEvent.click(within(group).getByRole("radio", { name: copy.decisionOmit }));
    expect(screen.getByRole("button", { name: copy.importNothing })).toBeTruthy();
    expect(await fingerprint(await vault())).toEqual(before);
    fireEvent.click(within(group).getByRole("radio", { name: copy.decisionKeepBoth }));
    fireEvent.click(screen.getByRole("button", { name: copy.importConfirm(1) }));
    await screen.findByText(copy.result(1, 0, 0), { selector: "p.text-foreground" });
    expect(await vault()).toHaveLength(2);
  });

  it("«Reemplazar» (sugerido cuando el archivo trae todo lo que ya tienes, y mas) sustituye y lo cuenta en el resultado", async () => {
    const file = await packageOf([vaultInput("Ana Pérez", { sig: 1, ini: 2 })]);
    await seed(vaultInput("Ana Pérez", { sig: 1, ini: null }));
    renderRestore();
    await pickZip(file);
    await screen.findByText(copy.statusDifferent);
    const group = screen.getByRole("radiogroup", { name: copy.decisionGroup("Ana Pérez") });
    expect(within(group).getByRole("radio", { name: copy.decisionReplace }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText(copy.replaceLoses)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: copy.importConfirm(1) }));
    await screen.findByText(copy.result(1, 0, 1), { selector: "p.text-foreground" });
    expect(await vault()).toHaveLength(1);
  });

  it("limites del baul: avisa de cuantas caben, bloquea el boton y se libera omitiendo", async () => {
    const file = await packageOf([vaultInput("Ana Pérez"), vaultInput("Luis Gómez", { sig: 3 })]);
    for (let i = 0; i < MAX_VAULT_ENTRIES - 1; i += 1) {
      await seed(vaultInput(`Otro ${i}`, { sig: 100 + i, ini: null }));
    }
    renderRestore();
    await pickZip(file);
    const limitText = await screen.findByText(copy.limitExceeded(1, 2, MAX_VAULT_ENTRIES));
    expect(limitText.className).toContain("text-destructive-text");
    expect((screen.getByRole("button", { name: copy.importConfirm(2) }) as HTMLButtonElement).disabled).toBe(true);
    const [firstGroup] = screen.getAllByRole("radiogroup");
    fireEvent.click(within(firstGroup).getByRole("radio", { name: copy.decisionOmit }));
    const okText = await screen.findByText(copy.limitOk(MAX_VAULT_ENTRIES, MAX_VAULT_ENTRIES));
    expect(okText.className).not.toContain("text-destructive-text");
    fireEvent.click(screen.getByRole("button", { name: copy.importConfirm(1) }));
    await screen.findByText(copy.result(1, 1, 0), { selector: "p.text-foreground" });
    expect(await vault()).toHaveLength(MAX_VAULT_ENTRIES);
  });

  it("si al aplicar falla (limite/almacen), se dice que NO se importo nada y el baul queda igual", async () => {
    const file = await packageOf([vaultInput("Ana Pérez")]);
    await seed(vaultInput("Otra Persona", { sig: 50 }));
    const before = await fingerprint(await vault());
    vi.mocked(applyBackupImport).mockResolvedValueOnce({ ok: false, reason: "limit" });
    renderRestore();
    await pickZip(file);
    await screen.findByText(copy.statusNew);
    fireEvent.click(screen.getByRole("button", { name: copy.importConfirm(1) }));
    await waitFor(() => expect(restoreStatus()).toBe(copy.applyFailed.limit));
    expect(copy.applyFailed.limit).toMatch(/No se ha importado nada/);
    expect(await fingerprint(await vault())).toEqual(before);
    // la vista previa sigue ahi para corregir
    expect(screen.getByRole("button", { name: copy.importConfirm(1) })).toBeTruthy();
  });

  it("elemento corrupto del paquete: se aisla con su motivo y el resto se puede importar", async () => {
    const file = await packageOf([vaultInput("Ana Pérez"), vaultInput("Luis Gómez", { sig: 3, ini: null })]);
    const broken = await editManifest(file, (manifest) => {
      const target = manifest.files.find((entry: { path: string }) => entry.path.endsWith("-signature.png"));
      target.sha256 = "0".repeat(64);
    });
    renderRestore();
    await pickZip(asFile(broken));
    await screen.findByText(copy.statusInvalid);
    expect(screen.getByText(copy.invalidReasons.integrity)).toBeTruthy();
    expect(screen.getAllByText(copy.statusNew)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: copy.importConfirm(1) }));
    await screen.findByText(copy.result(1, 1, 0), { selector: "p.text-foreground" });
  });

  it("creado con una version mas nueva: «actualiza la página», sin vista previa", async () => {
    const file = await packageOf([vaultInput("Ana Pérez")]);
    const newer = await editManifest(file, (manifest) => {
      manifest.modules.signatures.schemaVersion = 99;
    });
    renderRestore();
    await pickZip(asFile(newer));
    await waitFor(() => expect(restoreStatus()).toBe(copy.readErrors.newer));
    expect(copy.readErrors.newer).toMatch(/actualiza la página/);
    expect(screen.getByRole("button", { name: copy.pickZip })).toBeTruthy();
  });

  it("el archivo de UNA firma (formato anterior) lo recibe el importador de siempre", async () => {
    await seed(vaultInput("Ana Pérez"));
    const [entry] = await vault();
    // fake-indexeddb devuelve Uint8Array de otro reino y JSZip (instanceof) los rechazaria: se copian al de jsdom
    const sameRealm = <T extends { png: Uint8Array } | null>(image: T): T =>
      image ? ({ ...image, png: new Uint8Array(image.png) } as T) : image;
    const exported = await exportVaultEntry(
      { ...entry, signature: sameRealm(entry.signature), initials: sameRealm(entry.initials) },
      {},
    );
    if (!exported.ok) throw new Error("export");
    const onLegacyFile = vi.fn();
    const { onClose } = renderRestore({ onLegacyFile });
    await pickZip(asFile(exported.blob, "Firma-ana.zip"));
    await waitFor(() => expect(onLegacyFile).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalled();
  });

  it("arrastrar y soltar el .zip funciona igual que elegirlo", async () => {
    const file = await packageOf([vaultInput("Ana Pérez")]);
    renderRestore();
    const button = await screen.findByRole("button", { name: copy.pickZip });
    const zone = button.closest("div") as HTMLElement;
    fireEvent.dragOver(zone, { dataTransfer: { files: [] } });
    expect(await screen.findByText(copy.dropZipActive)).toBeTruthy();
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    await screen.findByText(copy.previewIntro(1, false));
  });

  describe("zips hostiles del corpus de la libreria", () => {
    for (const hostile of hostileCorpus()) {
      it(`${hostile.name}: rechazo claro, sin colgar y sin escribir nada`, async () => {
        await seed(vaultInput("Ana Pérez"));
        const before = await fingerprint(await vault());
        renderRestore();
        const started = performance.now();
        await pickZip(asFile(new Blob([hostile.bytes as unknown as BlobPart]), "hostil.optimuspdf.zip"));
        await waitFor(() => expect(restoreStatus()).not.toBe(""), { timeout: 4000 });
        expect(performance.now() - started).toBeLessThan(4000);
        const expected = {
          badZip: copy.readErrors.badFile,
          bomb: copy.readErrors.unsafe,
          unsafePath: copy.readErrors.unsafe,
          duplicateEntry: copy.readErrors.unsafe,
          tooLarge: copy.readErrors.tooLarge,
          tooManyEntries: copy.readErrors.tooLarge,
        }[hostile.code as string];
        expect(restoreStatus()).toBe(expected);
        expect(screen.queryByText(copy.statusNew)).toBeNull();
        expect(screen.getByRole("button", { name: copy.pickZip })).toBeTruthy();
        expect(await fingerprint(await vault())).toEqual(before);
      });
    }
  });
});

describe("accesibilidad de las hojas de respaldo", () => {
  it("hoja modal con titulo y UNA region de estado (exportar e importar)", async () => {
    renderExport();
    const dialog = await screen.findByRole("dialog", { name: copy.exportTitle });
    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
  });

  it("importar: una region de estado en cada paso y el foco pasa a la vista previa", async () => {
    const file = await packageOf([vaultInput("Ana Pérez")]);
    renderRestore();
    const dialog = await screen.findByRole("dialog", { name: copy.importTitle });
    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
    await pickZip(file);
    await screen.findByText(copy.previewIntro(1, false));
    expect(within(dialog).getAllByRole("status")).toHaveLength(1);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: copy.previewTitle })));
  });

  it("en ingles todo sale en ingles", async () => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    const en = SIGN_STRINGS.en.vaultBackup;
    render(
      <LanguageProvider>
        <SignatureRestoreSheet open onClose={() => {}} strings={SIGN_STRINGS.en} />
      </LanguageProvider>,
    );
    expect(await screen.findByRole("button", { name: en.pickZip })).toBeTruthy();
    fireEvent.change(zipInput(), { target: { files: [new File(["no zip"], "x.zip")] } });
    await waitFor(() => expect(restoreStatus()).toBe(en.readErrors.badFile));
  });
});

/* ------------------------------------------------------------------ *
 * U4.4-fix: D2 / D3 / D4 / D5 / T3 en pantalla
 * ------------------------------------------------------------------ */

async function packageOfEntries(entries: VaultEntry[]): Promise<File> {
  return asFile(await buildPackage({ modules: [signaturesModuleFromEntries(entries)] }));
}
async function putEntries(...entries: VaultEntry[]) {
  const result = await commitVaultImport({ puts: entries, deleteIds: [] });
  if (!result.ok) throw new Error(`put: ${result.reason}`);
}
const radios = (name: string) =>
  within(screen.getByRole("radiogroup", { name: copy.decisionGroup(name) })).getAllByRole("radio");

describe("D2 — firmante renombrado: «Mismos dibujos, datos distintos»", () => {
  async function renamedScenario() {
    const file = await packageOfEntries([vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: 2 })]);
    await putEntries({ ...vaultEntry("vault-a", "Anita Pérez", { sig: 1, ini: 2 }), role: "Directora" });
    return file;
  }

  it("etiqueta, nota correcta (qué cambia), «Conservar la que ya tienes» marcada por defecto y botón sin nada que importar", async () => {
    const file = await renamedScenario();
    renderRestore();
    await pickZip(file);
    await screen.findByText(copy.statusSameDrawings);
    expect(screen.queryByText(copy.statusDifferent)).toBeNull();
    expect(screen.getByText(copy.sameDrawingsHint("Anita Pérez", ["name"]))).toBeTruthy();
    // la nota falsa de antes («con otra imagen») ya no sale
    expect(screen.queryByText(copy.differentHint("Anita Pérez"))).toBeNull();
    const options = radios("Ana Pérez");
    expect(options.map((radio) => radio.textContent)).toEqual([copy.decisionReplace, copy.decisionKeepExisting]);
    expect(options[1].getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("button", { name: copy.importNothing }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("«Reemplazar» actualiza el nombre, avisa de lo que se conserva y NO pierde el cargo", async () => {
    const file = await renamedScenario();
    renderRestore();
    await pickZip(file);
    await screen.findByText(copy.statusSameDrawings);
    fireEvent.click(radios("Ana Pérez")[0]);
    expect(screen.getByText(copy.replaceKeeps)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: copy.importConfirm(1) }));
    await screen.findByText(copy.result(1, 0, 1), { selector: "p.text-foreground" });
    const [entry] = await vault();
    expect(entry).toMatchObject({ id: "vault-a", signerName: "Ana Pérez", role: "Directora" });
  });

  it("dejarla como esta no cambia nada", async () => {
    const file = await renamedScenario();
    const before = await fingerprint(await vault());
    renderRestore();
    await pickZip(file);
    await screen.findByText(copy.statusSameDrawings);
    expect(await fingerprint(await vault())).toEqual(before);
    expect((await vault())[0]).toMatchObject({ signerName: "Anita Pérez", role: "Directora" });
  });
});

describe("D3 — un id que coincide con el de OTRA persona", () => {
  it("no ofrece «Reemplazar»; ofrece «Conservar ambos» (marcada) y «Omitir», con la nota de que es otra persona; conservar ambos no toca a Luis", async () => {
    const file = await packageOfEntries([vaultEntry("vault-l", "Ana", { sig: 1, ini: 2 })]);
    await putEntries(vaultEntry("vault-l", "Luis", { sig: 5, ini: null }));
    renderRestore();
    await pickZip(file);
    await screen.findByText(copy.statusDifferent);
    expect(screen.getByText(copy.otherPersonHint("Luis"))).toBeTruthy();
    const options = radios("Ana");
    expect(options.map((radio) => radio.textContent)).toEqual([copy.decisionKeepBoth, copy.decisionOmit]);
    expect(screen.queryByRole("radio", { name: copy.decisionReplace })).toBeNull();
    expect(options[0].getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: copy.importConfirm(1) }));
    await screen.findByText(copy.result(1, 0, 0), { selector: "p.text-foreground" });
    const list = await vault();
    expect(list.map((e) => e.signerName).sort()).toEqual(["Ana", "Luis"]);
    expect(list.find((e) => e.signerName === "Luis")?.id).toBe("vault-l");
  });
});

describe("D4 — «Esta firma cambió mientras decidías»", () => {
  it("otra pestaña cambia el cargo tras la vista previa: no se escribe nada, se avisa y la vista previa se rehace con el baul de ahora", async () => {
    const file = await packageOfEntries([vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: 2 })]);
    await putEntries(vaultEntry("vault-a", "Ana Pérez", { sig: 1, ini: null }));
    renderRestore();
    await pickZip(file);
    await screen.findByText(copy.statusDifferent);
    expect(radios("Ana Pérez")[0].getAttribute("aria-checked")).toBe("true"); // sugerido: reemplazar
    await updateVaultEntry("vault-a", { role: "Gerente" }); // «otra pestaña»
    const afterOtherTab = await fingerprint(await vault());
    fireEvent.click(screen.getByRole("button", { name: copy.importConfirm(1) }));
    await waitFor(() => expect(restoreStatus()).toBe(copy.applyFailed.changed));
    expect(copy.applyFailed.changed).toMatch(/cambió mientras decidías/);
    expect(await fingerprint(await vault())).toEqual(afterOtherTab);
    expect((await vault())[0].role).toBe("Gerente");
    // sigue en la vista previa, ya con el estado actual, y se puede decidir de nuevo
    const retry = await screen.findByRole("button", { name: copy.importConfirm(1) });
    fireEvent.click(retry);
    await screen.findByText(copy.result(1, 0, 1), { selector: "p.text-foreground" });
    expect((await vault())[0]).toMatchObject({ role: "Gerente" });
    expect((await vault())[0].initials).not.toBeNull();
  });
});

describe("D5 — imágenes que no se pueden decodificar", () => {
  const forged: [string, () => Uint8Array][] = [
    ["IDAT corrupto", () => pngWithCorruptIdat(makeRealPng({ seed: 1 }))],
    ["APNG", () => pngWithChunk(makeRealPng({ seed: 1 }), "acTL", new Uint8Array(8))],
    ["tEXt de 100 KB", () => pngWithChunk(makeRealPng({ seed: 1 }), "tEXt", new Uint8Array(100_000).fill(65))],
    ["4096x4096", () => pngPixelBomb()],
  ];
  for (const [label, forge] of forged) {
    it(`${label}: «${"imagen no válida"}», no se puede importar y la otra firma sí`, async () => {
      const png = forge();
      const size = readPngSize(png)!;
      const bad = { ...vaultEntry("vault-bad", "Mala", { sig: 1, ini: null }), signature: { png, ratio: size.height / size.width, width: size.width, height: size.height } };
      const file = await packageOfEntries([bad, vaultEntry("vault-ok", "Buena", { sig: 3, ini: null })]);
      renderRestore();
      await pickZip(file);
      await screen.findByText(copy.statusInvalid);
      expect(screen.getByText(copy.invalidReasons.invalidImage)).toBeTruthy();
      expect(copy.invalidReasons.invalidImage).toMatch(/Imagen no válida/);
      fireEvent.click(screen.getByRole("button", { name: copy.importConfirm(1) }));
      await screen.findByText(copy.result(1, 1, 0), { selector: "p.text-foreground" });
      expect((await vault()).map((e) => e.signerName)).toEqual(["Buena"]);
    });
  }
});

describe("T3 — el traspaso al importador de UNA firma solo ocurre con `invalidManifest`", () => {
  it("un zip cuyo manifiesto no es de paquete (`{}`) SI se entrega al importador antiguo y se cierra la hoja", async () => {
    const zip = new JSZip();
    zip.file("manifest.json", "{}");
    zip.file("firma.png", new Uint8Array([1, 2, 3]));
    const onLegacyFile = vi.fn();
    const { onClose } = renderRestore({ onLegacyFile });
    await pickZip(asFile(await zip.generateAsync({ type: "blob" }), "Firma-ana.zip"));
    await waitFor(() => expect(onLegacyFile).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cualquier otro fallo (zip roto, ruta peligrosa, JSON roto, formato mas nuevo, sin firmas, clave mala...) NO se entrega: se explica en la hoja", async () => {
    await seed(vaultInput("Ana Pérez"));
    const good = await buildSignaturesExport();
    if (!good.ok) throw new Error("export");
    const jsonBroken = await rewriteZip(good.blob, (zip) => void zip.file("manifest.json", "{ esto no es json"));
    const newerFormat = await editManifest(good.blob, (m) => void (m.formatVersion = 99));
    const noModule = await editManifest(good.blob, (m) => void (m.modules = {}));
    const noManifest = await rewriteZip(good.blob, (zip) => void zip.remove("manifest.json"));
    const cases: [string, File][] = [
      ["texto que no es un zip", asFile(new Blob(["hola, esto no es un zip, pero es largo largo largo"]), "x.zip")],
      ["JSON del manifiesto roto", asFile(jsonBroken)],
      ["formato mas nuevo", asFile(newerFormat)],
      ["sin modulo de firmas", asFile(noModule)],
      ["sin manifiesto", asFile(noManifest)],
      ...hostileCorpus().map((hostile): [string, File] => [hostile.name, asFile(new Blob([hostile.bytes as unknown as BlobPart]), "h.zip")]),
    ];
    for (const [label, file] of cases) {
      const onLegacyFile = vi.fn();
      const onClose = vi.fn();
      const view = render(
        <LanguageProvider>
          <SignatureRestoreSheet open onClose={onClose} strings={strings} onLegacyFile={onLegacyFile} />
        </LanguageProvider>,
      );
      await pickZip(file);
      await waitFor(() => expect(restoreStatus()).not.toBe(""), { timeout: 4000 });
      expect([label, onLegacyFile.mock.calls.length, onClose.mock.calls.length]).toEqual([label, 0, 0]);
      expect(screen.getByRole("button", { name: copy.pickZip })).toBeTruthy(); // sigue en «elegir archivo»
      view.unmount();
    }
  });
});
