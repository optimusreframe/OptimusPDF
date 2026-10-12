import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PDFDocument } from "@cantoo/pdf-lib";
import { LANGUAGE_STORAGE_KEY } from "@/lib/i18n";
import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { PROTECT_STRINGS } from "@/app/protect-pdf/strings";
import { ProtectTab } from "@/app/pdf-pro/tabs/ProtectTab";
import { ProtectPanel } from "@/app/pdf-pro/tabs/ProtectPanel";
import { labelsOf, mountTab } from "@/app/pdf-pro/tabs/docTestUtils";

/**
 * Pestaña «Proteger» (U5): «Guardar con contraseña…» como opcion de guardado (no es un paso del historial,
 * el archivo cifrado nunca entra en el documento de trabajo) y «Quitar protección».
 */

const downloaded = vi.hoisted(() => ({ items: [] as { blob: Blob; name: string }[] }));
vi.mock("@/lib/pdf/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/core")>();
  return { ...actual, downloadBlob: (blob: Blob, name: string) => downloaded.items.push({ blob, name }) };
});

const unlockMock = vi.hoisted(() => ({
  inspect: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/pdf/unlock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pdf/unlock")>();
  return {
    ...actual,
    inspectProtection: (...args: unknown[]) => unlockMock.inspect(...args),
    removeProtection: (...args: unknown[]) => unlockMock.remove(...args),
  };
});

const S = PRO_STRINGS.es;
const T = S.docTools;
const P = PROTECT_STRINGS.es;

beforeAll(() => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, "es");
});

beforeEach(() => {
  downloaded.items.length = 0;
  unlockMock.inspect.mockReset();
  unlockMock.remove.mockReset();
  unlockMock.inspect.mockResolvedValue({ kind: "ready", profile: { hasSignatureRestrictions: false, encrypted: false } });
});

afterEach(() => cleanup());

/** Deja correr cualquier confirmacion asincrona que un fallo pudiera haber encolado en el documento de trabajo. */
const settle = () => act(async () => new Promise<void>((resolve) => setTimeout(resolve, 120)));

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const saveButton = () => screen.getByRole("button", { name: T.protect.saveButton });

function typePasswords(password: string, confirm = password) {
  fireEvent.change(field(P.passwordLabel), { target: { value: password } });
  fireEvent.change(field(P.confirmLabel), { target: { value: confirm } });
}

describe("Guardar con contraseña", () => {
  it("explica que es una opcion de guardado y no un paso del historial", async () => {
    await mountTab(<ProtectTab />);
    expect(screen.getByText(T.protect.intro)).toBeTruthy();
    expect(screen.getByText(T.protect.notAStep)).toBeTruthy();
  });

  it("sin contraseña el boton queda inactivo y dice el motivo", async () => {
    await mountTab(<ProtectTab />);
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(P.errors.empty)).toBeTruthy();
    expect(saveButton().getAttribute("aria-describedby")).toBe(screen.getByText(P.errors.empty).id);
  });

  it("contraseña demasiado corta, sin repetir y distinta: cada motivo", async () => {
    await mountTab(<ProtectTab />);
    fireEvent.change(field(P.passwordLabel), { target: { value: "ab" } });
    expect(screen.getByText(P.errors.tooShort)).toBeTruthy();
    fireEvent.change(field(P.passwordLabel), { target: { value: "secreto1" } });
    expect(screen.getByText(P.confirmRequired)).toBeTruthy();
    fireEvent.change(field(P.confirmLabel), { target: { value: "secreto2" } });
    expect(screen.getAllByText(P.errors.mismatch).length).toBeGreaterThan(0);
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("rechaza con nombre propio un caracter fuera de Latin-1 (€, emoji, chino)", async () => {
    await mountTab(<ProtectTab />);
    fireEvent.change(field(P.passwordLabel), { target: { value: "clave€uro" } });
    const reason = P.errors.unsupportedChars.replace("{chars}", "€");
    expect(screen.getByText(reason)).toBeTruthy();
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(field(P.passwordLabel), { target: { value: "clave😀" } });
    expect(screen.getByText(P.errors.unsupportedChars.replace("{chars}", "😀"))).toBeTruthy();
    fireEvent.change(field(P.passwordLabel), { target: { value: "密码密码" } });
    expect(screen.getByText(P.errors.unsupportedChars.replace("{chars}", "密 码"))).toBeTruthy();
  });

  it("acepta Latin-1 con acentos y eñes (contraseña «Año-ñandú»)", async () => {
    const { doc } = await mountTab(<ProtectTab />);
    typePasswords("Año-ñandú");
    expect(saveButton().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    await settle();
    expect(labelsOf(doc)).toEqual(["Original"]);
  });

  it("guarda un PDF CIFRADO descargable y NO toca el historial ni el documento de trabajo", async () => {
    const { doc, original } = await mountTab(<ProtectTab />, { name: "informe.pdf" });
    typePasswords("secreto1");
    fireEvent.click(saveButton());
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    await settle();

    const { blob, name } = downloaded.items[0];
    expect(name).toBe("informe-protegido.pdf");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    await expect(PDFDocument.load(bytes, { updateMetadata: false })).rejects.toThrow();
    expect((await PDFDocument.load(bytes, { password: "secreto1", updateMetadata: false } as never)).getPageCount()).toBe(3);

    // El documento de trabajo sigue editable: mismo historial, mismos bytes, sin cifrar.
    expect(labelsOf(doc)).toEqual(["Original"]);
    expect(doc.getState().document?.snapshots).toHaveLength(1);
    expect(doc.current()).toEqual(original);
    expect((await PDFDocument.load(doc.current()!)).getPageCount()).toBe(3);
  });

  it("tras guardar, la contraseña se borra del formulario y se anuncia el guardado", async () => {
    const { doc } = await mountTab(<ProtectTab />);
    typePasswords("secreto1");
    fireEvent.click(saveButton());
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    await waitFor(() => expect(field(P.passwordLabel).value).toBe(""));
    expect(field(P.confirmLabel).value).toBe("");
    expect(doc.getState().announcement?.text).toBe(T.protect.saved("informe-protegido.pdf"));
  });

  it("con cambios sin guardar, guardar con contraseña los marca como guardados (sigue sin haber pasos nuevos)", async () => {
    const { doc } = await mountTab(<ProtectTab />);
    await doc.commit(doc.current()!.slice(), "Cambio", "operation", { pageCount: 3 });
    expect(doc.getState().dirty).toBe(true);
    typePasswords("secreto1");
    fireEvent.click(saveButton());
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
    await settle();
    expect(doc.getState().dirty).toBe(false);
    expect(doc.getState().document?.snapshots).toHaveLength(2);
  });

  it("sin «pedir contraseña al abrir» y sin permisos restringidos no hay nada que cifrar", async () => {
    await mountTab(<ProtectTab />);
    typePasswords("secreto1");
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(P.requirePasswordLabel) }));
    expect(screen.getByText(P.errors.nothingToDo)).toBeTruthy();
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("con permisos restringidos y sin contraseña de apertura sí se guarda", async () => {
    await mountTab(<ProtectTab />);
    typePasswords("secreto1");
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(P.requirePasswordLabel) }));
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(P.permissionCopying) }));
    expect(saveButton().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(saveButton());
    await waitFor(() => expect(downloaded.items).toHaveLength(1));
  });

  it("una pulsacion con el boton inactivo no hace nada", async () => {
    await mountTab(<ProtectTab />);
    fireEvent.click(saveButton());
    await act(async () => {});
    expect(downloaded.items).toHaveLength(0);
  });

  it("con `onProtected` entrega el resultado en vez de descargar (integracion con Exportar)", async () => {
    const onProtected = vi.fn();
    const { doc } = await mountTab(<ProtectPanel onProtected={onProtected} />);
    typePasswords("secreto1");
    fireEvent.click(saveButton());
    await waitFor(() => expect(onProtected).toHaveBeenCalledTimes(1));
    const [result, fileName] = onProtected.mock.calls[0];
    expect(fileName).toBe("informe-protegido.pdf");
    expect(result.bytes).toBeInstanceOf(Uint8Array);
    expect(result.appliedEncryptionRevision).toBeGreaterThanOrEqual(2);
    expect(downloaded.items).toHaveLength(0);
    await settle();
    expect(doc.getState().document?.snapshots).toHaveLength(1);
  });

  it("avisa si hay firmas digitales activas", async () => {
    await mountTab(<ProtectTab />, { signatures: "active" });
    expect(screen.getByText(T.protect.signaturesWarning)).toBeTruthy();
  });

  it("si el archivo estaba cifrado lo explica y recuerda que sale sin contraseña salvo que se proteja", async () => {
    await mountTab(<ProtectTab />, { encrypted: true });
    expect(screen.getByText(T.protect.encryptedOriginTitle)).toBeTruthy();
    expect(screen.getByText(T.protect.encryptedOriginBody)).toBeTruthy();
    expect(screen.getAllByText(S.warnings.decryptedCopy).length).toBeGreaterThan(0);
  });

  it("los objetivos tactiles del boton y de los campos miden 44 px de alto (h-11)", async () => {
    await mountTab(<ProtectTab />);
    expect(saveButton().className).toContain("h-11");
    expect(field(P.passwordLabel).className).toMatch(/h-1[1-4]|h-\[4[4-9]px\]|min-h-11/);
  });
});

describe("Quitar protección", () => {
  it("comprueba el documento y, sin restricciones, lo explica y deja inactivo «Aplicar»", async () => {
    await mountTab(<ProtectTab />);
    expect(await screen.findAllByText(T.unlock.noRestrictions)).not.toHaveLength(0);
    const apply = screen.getByRole("button", { name: T.runner.apply });
    expect(apply.getAttribute("aria-disabled")).toBe("true");
  });

  it("explica que el documento de trabajo ya esta sin cifrar cuando el archivo venia cifrado", async () => {
    await mountTab(<ProtectTab />, { encrypted: true });
    expect(screen.getByText(T.unlock.decryptedTitle)).toBeTruthy();
    expect(screen.getByText(new RegExp(T.unlock.reprotectHint.slice(0, 20)))).toBeTruthy();
  });

  it("con restricciones de firma pide consentimiento y solo entonces aplica (un snapshot)", async () => {
    unlockMock.inspect.mockResolvedValue({ kind: "ready", profile: { hasSignatureRestrictions: true, encrypted: false } });
    const { doc } = await mountTab(<ProtectTab />, { signatures: "active" });
    unlockMock.remove.mockImplementation(async () => ({ blob: new Blob([doc.current()!.slice() as unknown as BlobPart]), action: "signaturesInvalidated" }));
    await screen.findByText(T.unlock.restrictionsFound);
    const apply = screen.getByRole("button", { name: T.runner.apply });
    expect(apply.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getAllByText(T.unlock.consentRequired).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("checkbox", { name: new RegExp(T.unlock.consent) }));
    expect(apply.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(apply);
    await waitFor(() => expect(labelsOf(doc)).toEqual(["Original", T.labels.unlock]));
    expect(unlockMock.remove).toHaveBeenCalledTimes(1);
    const options = unlockMock.remove.mock.calls[0][1];
    expect(options).toEqual({ password: "", acknowledgeSignatureInvalidation: true });
  });

  it("si la comprobacion falla, no se puede aplicar y se explica", async () => {
    unlockMock.inspect.mockRejectedValue(new Error("boom"));
    await mountTab(<ProtectTab />);
    expect((await screen.findAllByText(T.unlock.inspectFailed)).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: T.runner.apply }).getAttribute("aria-disabled")).toBe("true");
  });

  it("el panel de proteger y el de desproteger conviven en la pestaña", async () => {
    await mountTab(<ProtectTab />);
    const tab = document.querySelector("[data-doc-tab='protect']") as HTMLElement;
    expect(within(tab).getByRole("heading", { name: T.protect.saveTitle })).toBeTruthy();
    expect(within(tab).getByRole("heading", { name: T.tools.unlock.title })).toBeTruthy();
  });
});
