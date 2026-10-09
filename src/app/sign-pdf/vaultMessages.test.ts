import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  importReasonMessage,
  rememberDrafts,
  saveResultMessage,
} from "@/app/sign-pdf/vaultMessages";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { ImportVaultReason } from "@/app/sign-pdf/signVaultFile";
import {
  MAX_VAULT_ENTRIES,
  clearVault,
  listVault,
  saveVaultEntry,
} from "@/app/sign-pdf/signVault";
import { makeImage, pngDataUrl, vaultInput } from "@/app/sign-pdf/vaultTestUtils";

/**
 * Mensajes humanos del baul (src/app/sign-pdf/vaultMessages.ts): cada motivo
 * de error distinto tiene su texto, en es y en en.
 */

beforeEach(async () => {
  await clearVault();
});

describe("importReasonMessage", () => {
  const reasons: ImportVaultReason[] = [
    "invalid",
    "tooLarge",
    "wrongPassword",
    "unsupportedVersion",
    "encryptionUnavailable",
  ];

  for (const language of ["es", "en"] as const) {
    it(`cada motivo tiene un mensaje propio y no vacio (${language})`, () => {
      const strings = SIGN_STRINGS[language];
      const messages = reasons.map((reason) => importReasonMessage(strings, reason));
      for (const message of messages) expect(message.length).toBeGreaterThan(10);
      expect(new Set(messages).size).toBe(reasons.length);
    });
  }

  it("needsPassword (que la interfaz resuelve pidiendo la contraseña) cae en el mensaje generico", () => {
    expect(importReasonMessage(SIGN_STRINGS.es, "needsPassword")).toBe(
      SIGN_STRINGS.es.vaultImportInvalid,
    );
  });
});

describe("saveResultMessage", () => {
  it("distingue guardada, ya estaba guardada y cada motivo de fallo", () => {
    const strings = SIGN_STRINGS.es;
    const entry = {} as never;
    const texts = [
      saveResultMessage(strings, { ok: true, entry, duplicate: false }),
      saveResultMessage(strings, { ok: true, entry, duplicate: true }),
      saveResultMessage(strings, { ok: false, reason: "limit" }),
      saveResultMessage(strings, { ok: false, reason: "tooLarge" }),
      saveResultMessage(strings, { ok: false, reason: "invalid" }),
      saveResultMessage(strings, { ok: false, reason: "unavailable" }),
    ];
    expect(new Set(texts).size).toBe(6);
    expect(texts[2]).toBe(strings.vaultSaveLimit);
  });
});

describe("rememberDrafts", () => {
  const strings = SIGN_STRINGS.es;

  it("guarda la firma y las iniciales en UNA entrada y lo cuenta como exito", async () => {
    const notice = await rememberDrafts(strings, {
      signerName: "Ana Pérez",
      sourceDocument: "contrato.pdf",
      signature: { dataUrl: pngDataUrl({ seed: 1 }), ratio: 0.5 },
      initials: { dataUrl: pngDataUrl({ width: 20, height: 20, seed: 2 }), ratio: 1 },
    });
    expect(notice).toEqual({ text: strings.vaultSaved, tone: "success" });
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].signature?.ratio).toBe(0.5);
    expect(entries[0].initials).not.toBeNull();
  });

  it("guardar dos veces lo mismo dice que ya estaba guardada", async () => {
    const params = {
      signerName: "Ana Pérez",
      sourceDocument: "a.pdf",
      signature: { dataUrl: pngDataUrl({ seed: 1 }), ratio: 0.5 },
      initials: null,
    };
    await rememberDrafts(strings, params);
    const again = await rememberDrafts(strings, params);
    expect(again).toEqual({ text: strings.vaultSavedDuplicate, tone: "success" });
    expect((await listVault()).entries).toHaveLength(1);
  });

  it("un PNG ilegible no se guarda a medias", async () => {
    const notice = await rememberDrafts(strings, {
      signerName: "Ana Pérez",
      sourceDocument: "",
      signature: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", ratio: 0.3 },
      initials: null,
    });
    expect(notice).toEqual({ text: strings.vaultSaveInvalid, tone: "error" });
    expect((await listVault()).entries).toHaveLength(0);
  });

  it("con el baul lleno devuelve el motivo del limite", async () => {
    for (let index = 0; index < MAX_VAULT_ENTRIES; index += 1) {
      await saveVaultEntry(
        vaultInput(`Firmante ${index}`, {
          signature: makeImage({ seed: index + 30 }),
          initials: null,
        }),
      );
    }
    const notice = await rememberDrafts(strings, {
      signerName: "Una Mas",
      sourceDocument: "",
      signature: { dataUrl: pngDataUrl({ seed: 200 }), ratio: 0.5 },
      initials: null,
    });
    expect(notice).toEqual({ text: strings.vaultSaveLimit, tone: "error" });
  });

  it("sin firma ni iniciales no guarda nada", async () => {
    const notice = await rememberDrafts(strings, {
      signerName: "Ana",
      sourceDocument: "",
      signature: null,
      initials: null,
    });
    expect(notice.tone).toBe("error");
    expect((await listVault()).entries).toHaveLength(0);
  });
});

describe("texto por tipo y concordancia (W3 r2)", () => {
  it("al guardar iniciales el aviso habla de iniciales, no de firma (es y en)", async () => {
    for (const language of ["es", "en"] as const) {
      const strings = SIGN_STRINGS[language];
      const entry = {} as never;
      expect(saveResultMessage(strings, { ok: true, entry, duplicate: false }, "initials")).toBe(
        strings.vaultSavedInitials,
      );
      expect(saveResultMessage(strings, { ok: true, entry, duplicate: true }, "initials")).toBe(
        strings.vaultSavedDuplicateInitials,
      );
      expect(strings.vaultSavedInitials).not.toBe(strings.vaultSaved);
      expect(strings.vaultSavedInitials).toMatch(/(nicial|nitials)/);
    }
  });

  it("rememberDrafts con created=initials usa el texto de iniciales", async () => {
    const strings = SIGN_STRINGS.es;
    const notice = await rememberDrafts(strings, {
      signerName: "Ana Pérez",
      sourceDocument: "",
      signature: null,
      initials: { dataUrl: pngDataUrl({ width: 20, height: 20, seed: 6 }), ratio: 1 },
      created: "initials",
    });
    expect(notice).toEqual({ text: strings.vaultSavedInitials, tone: "success" });
  });

  it("vaultAppliedPartial concuerda en genero y numero", () => {
    expect(SIGN_STRINGS.es.vaultAppliedPartial("Ana", ["initials"])).toMatch(
      /No incluye las iniciales: créalas aparte/,
    );
    expect(SIGN_STRINGS.es.vaultAppliedPartial("Ana", ["signature"])).toMatch(
      /No incluye la firma: créala aparte/,
    );
    expect(SIGN_STRINGS.es.vaultAppliedPartial("Ana", ["signature", "initials"])).toMatch(
      /la firma ni las iniciales: créalas aparte/,
    );
    expect(SIGN_STRINGS.en.vaultAppliedPartial("Ana", ["initials"])).toMatch(
      /doesn't include initials: create them separately/,
    );
    expect(SIGN_STRINGS.en.vaultAppliedPartial("Ana", ["signature"])).toMatch(
      /doesn't include the signature: create it separately/,
    );
  });
});
