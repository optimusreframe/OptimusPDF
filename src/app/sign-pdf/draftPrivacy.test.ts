import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureMap } from "@/app/sign-pdf/captures";
import type { SignerBlock } from "@/app/sign-pdf/docSet";
import {
  SIGNATURE_DRAFT_TTL_DAYS,
  SIGNATURE_DRAFT_TTL_MS,
  blocksHaveStrokes,
  capturesHaveStrokes,
  expiryFor,
  isExpired,
  withoutBlockStrokes,
  withoutCaptureStrokes,
} from "@/app/sign-pdf/draftPrivacy";

/** Privacidad del borrador con firmas (F0 · U0.4): que se quita, cuando caduca y como se decide. */

const STROKE = { dataUrl: "data:image/png;base64,AAAA", ratio: 0.3 };
const DAY = 24 * 60 * 60 * 1000;

function block(overrides: Partial<SignerBlock> = {}): SignerBlock {
  return {
    id: "bk-1",
    signerId: "sg-1",
    appliesTo: ["doc-a", "doc-b"],
    signature: null,
    initials: null,
    stamps: {},
    auto: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("el plazo", () => {
  it("son 7 dias exactos", () => {
    expect(SIGNATURE_DRAFT_TTL_DAYS).toBe(7);
    expect(SIGNATURE_DRAFT_TTL_MS).toBe(7 * DAY);
  });
});

describe("blocksHaveStrokes / capturesHaveStrokes", () => {
  it("sin bloques, o con bloques vacios, no hay trazos", () => {
    expect(blocksHaveStrokes(undefined)).toBe(false);
    expect(blocksHaveStrokes([])).toBe(false);
    expect(blocksHaveStrokes([block(), block({ id: "bk-2" })])).toBe(false);
  });

  it("una firma, o solo unas iniciales, ya cuentan como trazo", () => {
    expect(blocksHaveStrokes([block({ signature: STROKE })])).toBe(true);
    expect(blocksHaveStrokes([block(), block({ id: "bk-2", initials: STROKE })])).toBe(true);
  });

  it("los sellos solos (sin trazo) no son un trazo", () => {
    expect(blocksHaveStrokes([block({ stamps: { "doc-a": "huella" } })])).toBe(false);
  });

  it("lo mismo en las capturas de un documento suelto", () => {
    expect(capturesHaveStrokes(undefined)).toBe(false);
    expect(capturesHaveStrokes({})).toBe(false);
    expect(capturesHaveStrokes({ "sg-1": { signature: null, initials: null, stamp: "x" } })).toBe(false);
    expect(capturesHaveStrokes({ "sg-1": { signature: STROKE, initials: null, stamp: "x" } })).toBe(true);
    expect(capturesHaveStrokes({ "sg-1": { signature: null, initials: STROKE, stamp: "x" } })).toBe(true);
  });
});

describe("withoutBlockStrokes", () => {
  it("quita firma, iniciales y sellos de TODOS los bloques y conserva el resto", () => {
    const input = [
      block({ signature: STROKE, initials: STROKE, stamps: { "doc-a": "s1", "doc-b": "s2" } }),
      block({ id: "bk-2", signerId: "sg-2", appliesTo: ["doc-b"], signature: STROKE, stamps: { "doc-b": "s3" }, auto: false }),
    ];
    const { blocks, stripped } = withoutBlockStrokes(input);
    expect(stripped).toBe(true);
    for (const item of blocks) {
      expect(item.signature).toBeNull();
      expect(item.initials).toBeNull();
      expect(item.stamps).toEqual({});
    }
    expect(blocks.map((item) => [item.id, item.signerId, item.appliesTo, item.auto])).toEqual([
      ["bk-1", "sg-1", ["doc-a", "doc-b"], true],
      ["bk-2", "sg-2", ["doc-b"], false],
    ]);
    expect(JSON.stringify(blocks)).not.toContain("data:image");
  });

  it("no toca la entrada (devuelve bloques nuevos)", () => {
    const input = [block({ signature: STROKE, stamps: { "doc-a": "s1" } })];
    withoutBlockStrokes(input);
    expect(input[0].signature).toEqual(STROKE);
    expect(input[0].stamps).toEqual({ "doc-a": "s1" });
  });

  it("sin trazos no hay nada que quitar: stripped = false y el contenido igual", () => {
    const input = [block(), block({ id: "bk-2", stamps: { "doc-a": "s1" } })];
    const { blocks, stripped } = withoutBlockStrokes(input);
    expect(stripped).toBe(false);
    expect(blocks).toEqual(input);
  });
});

describe("withoutCaptureStrokes", () => {
  it("con trazos devuelve el mapa vacio y dice que quito algo", () => {
    const captures: CaptureMap = { "sg-1": { signature: STROKE, initials: STROKE, stamp: "x" } };
    expect(withoutCaptureStrokes(captures)).toEqual({ captures: {}, stripped: true });
    expect(captures["sg-1"].signature).toEqual(STROKE);
  });

  it("sin trazos lo deja como esta", () => {
    const captures: CaptureMap = { "sg-1": { signature: null, initials: null, stamp: "x" } };
    expect(withoutCaptureStrokes(captures)).toEqual({ captures, stripped: false });
  });
});

describe("expiryFor / isExpired", () => {
  const savedAt = "2026-10-01T10:00:00.000Z";

  it("caduca 7 dias despues de guardarse", () => {
    expect(expiryFor(savedAt)).toBe("2026-10-08T10:00:00.000Z");
  });

  it("una fecha de guardado ilegible cuenta desde ahora (nunca queda sin fecha de salida ni lanza)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
    expect(expiryFor("no-es-una-fecha")).toBe("2026-10-21T12:00:00.000Z");
  });

  it("sin expiresAt no caduca nunca", () => {
    expect(isExpired({}, Date.now() + 1000 * DAY)).toBe(false);
  });

  it("justo en la fecha de caducidad ya caduco; un milisegundo antes, no", () => {
    const expiresAt = expiryFor(savedAt);
    const at = new Date(expiresAt).getTime();
    expect(isExpired({ expiresAt }, at - 1)).toBe(false);
    expect(isExpired({ expiresAt }, at)).toBe(true);
    expect(isExpired({ expiresAt }, at + 1)).toBe(true);
  });

  it("un expiresAt roto (no es fecha, o no es texto) cuenta como caducado", () => {
    expect(isExpired({ expiresAt: "mañana" }, 0)).toBe(true);
    expect(isExpired({ expiresAt: 12345 }, 0)).toBe(true);
    expect(isExpired({ expiresAt: null }, 0)).toBe(true);
  });
});
