import { describe, expect, it } from "vitest";
import { newDocumentDraftId, newSessionCopyId, newTabId, randomHex } from "@/app/sign-pdf/draftIds";
import { isValidResumeId } from "@/lib/resumeLinks";

/** Ids de borrador y de pestana (F0-fix, D1 y D3). */

const FINGERPRINT = "0123456789abcdef".repeat(4);

describe("randomHex", () => {
  it("da el doble de caracteres hexadecimales que bytes, y no se repite", () => {
    const a = randomHex(16);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(16)).not.toBe(a);
    expect(randomHex(0)).toBe("");
  });
});

describe("newDocumentDraftId (D3)", () => {
  it("son 64 hexadecimales: la misma forma que una huella, asi que ?s= y ?resume= lo siguen validando", () => {
    const id = newDocumentDraftId(FINGERPRINT);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(isValidResumeId("sign", id)).toBe(true);
  });

  it("NO es la huella: dos sesiones de trabajo del MISMO PDF tienen ids distintos y conservan la mitad de la huella", () => {
    const a = newDocumentDraftId(FINGERPRINT);
    const b = newDocumentDraftId(FINGERPRINT);
    expect(a).not.toBe(FINGERPRINT);
    expect(a).not.toBe(b);
    expect(a.slice(0, 32)).toBe(FINGERPRINT.slice(0, 32));
    expect(b.slice(0, 32)).toBe(FINGERPRINT.slice(0, 32));
    expect(a.slice(32)).not.toBe(b.slice(32));
  });

  it("una huella que no es hexadecimal (solo pasa en pruebas) igual da un id valido", () => {
    expect(newDocumentDraftId("huella-vieja")).toMatch(/^[0-9a-f]{64}$/);
    expect(newDocumentDraftId("")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("newSessionCopyId y newTabId (D1)", () => {
  it("el id de una copia de sesion tiene la forma de un id de sesion y es unico", () => {
    const a = newSessionCopyId();
    expect(isValidResumeId("session", a)).toBe(true);
    expect(newSessionCopyId()).not.toBe(a);
  });

  it("cada pestana tiene un id distinto", () => {
    const a = newTabId();
    expect(a).toMatch(/^t-[0-9a-f]{16}$/);
    expect(newTabId()).not.toBe(a);
  });
});
