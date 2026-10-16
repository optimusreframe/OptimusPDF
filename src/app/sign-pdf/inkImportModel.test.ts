import { describe, expect, it } from "vitest";
import { InkError } from "@/lib/image/inkCore";
import {
  CROP_MIN_FRACTION,
  DEFAULT_INK_SETTINGS,
  FULL_CROP,
  buildUploadEntry,
  cleaningFromThreshold,
  cropToRect,
  initialManualCrop,
  inkErrorCode,
  inkErrorKey,
  isAbortError,
  missingKind,
  moveCorner,
  normalizeCrop,
  nudgeCorner,
  settingsKey,
  settingsToInkOptions,
  shiftCrop,
  thresholdFromCleaning,
  vaultImageFromPng,
  vaultIsFull,
  type InkErrorKey,
} from "@/app/sign-pdf/inkImportModel";
import {
  MAX_VAULT_ENTRIES,
  MAX_VAULT_IMAGE_BYTES,
  MAX_VAULT_IMAGE_DIMENSION,
} from "@/app/sign-pdf/signVault";
import { makePng } from "@/lib/backup/__fixtures__/pngFactory";

/** Logica pura de la hoja «Subir firma o iniciales» (U6.2): ajustes, recorte, errores y guardado. */

describe("settingsToInkOptions", () => {
  const size = { width: 1000, height: 400 };

  it("por defecto: umbral automatico, iluminacion, motas, tinta original y recorte automatico", () => {
    expect(settingsToInkOptions(DEFAULT_INK_SETTINGS, size)).toEqual({
      threshold: "auto",
      ink: "original",
      cleanSpecks: "auto",
      evenLighting: true,
      crop: "auto",
      margin: "auto",
    });
  });

  it("«Quitar motas» apagado = cleanSpecks 0 (un punto legitimo no se pierde)", () => {
    const options = settingsToInkOptions({ ...DEFAULT_INK_SETTINGS, removeSpecks: false }, size);
    expect(options.cleanSpecks).toBe(0);
  });

  it("pasa umbral manual, color y la iluminacion apagada tal cual", () => {
    const options = settingsToInkOptions(
      { ...DEFAULT_INK_SETTINGS, threshold: 120, ink: "blue", evenLighting: false },
      size,
    );
    expect(options).toMatchObject({ threshold: 120, ink: "blue", evenLighting: false });
  });

  it("un recorte manual se convierte a pixeles de la imagen", () => {
    const options = settingsToInkOptions(
      { ...DEFAULT_INK_SETTINGS, crop: { x: 0.1, y: 0.25, width: 0.5, height: 0.5 } },
      size,
    );
    expect(options.crop).toEqual({ x: 100, y: 100, width: 500, height: 200 });
  });
});

describe("normalizeCrop / cropToRect", () => {
  it("lo que cubre (casi) toda la imagen equivale a automatico", () => {
    expect(normalizeCrop(FULL_CROP)).toBeNull();
    expect(normalizeCrop({ x: 0.005, y: 0.005, width: 0.995, height: 0.995 })).toBeNull();
    expect(normalizeCrop(null)).toBeNull();
  });

  it("recorta a la imagen, impone un lado minimo y descarta numeros no finitos", () => {
    expect(normalizeCrop({ x: -0.5, y: 0.2, width: 0.3, height: 0.3 })).toEqual({ x: 0, y: 0.2, width: 0.3, height: 0.3 });
    expect(normalizeCrop({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 })).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
    const tiny = normalizeCrop({ x: 0.3, y: 0.3, width: 0, height: 0 });
    expect(tiny?.width).toBe(CROP_MIN_FRACTION);
    expect(tiny?.height).toBe(CROP_MIN_FRACTION);
    expect(normalizeCrop({ x: Number.NaN, y: 0, width: 0.5, height: 0.5 })).toBeNull();
  });

  it("el rectangulo en pixeles nunca se sale de la imagen ni baja de 8 px", () => {
    const rect = cropToRect({ x: 0.9, y: 0.9, width: 0.3, height: 0.3 }, { width: 200, height: 100 });
    expect(rect).not.toBeNull();
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(200);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(100);
    const small = cropToRect({ x: 0.1, y: 0.1, width: 0.05, height: 0.05 }, { width: 100, height: 100 });
    expect(small!.width).toBeGreaterThanOrEqual(5);
    expect(cropToRect(null, { width: 10, height: 10 })).toBeNull();
  });
});

describe("«Limpiar fondo»: deslizador <-> umbral", () => {
  it("mas limpieza = umbral mas bajo, con extremos fijos", () => {
    expect(thresholdFromCleaning(0)).toBe(254);
    expect(thresholdFromCleaning(100)).toBe(34);
    expect(thresholdFromCleaning(50)).toBeLessThan(thresholdFromCleaning(20));
    expect(thresholdFromCleaning(-20)).toBe(254);
    expect(thresholdFromCleaning(500)).toBe(34);
  });

  it("ida y vuelta estable y acotada", () => {
    for (const level of [0, 1, 25, 50, 75, 99, 100]) {
      expect(Math.abs(cleaningFromThreshold(thresholdFromCleaning(level)) - level)).toBeLessThanOrEqual(1);
    }
    expect(cleaningFromThreshold(0)).toBe(100);
    expect(cleaningFromThreshold(255)).toBe(0);
  });
});

describe("settingsKey", () => {
  it("cambia con cada ajuste que cambia el resultado y es estable si no", () => {
    const base = settingsKey(DEFAULT_INK_SETTINGS);
    expect(settingsKey({ ...DEFAULT_INK_SETTINGS })).toBe(base);
    expect(settingsKey({ ...DEFAULT_INK_SETTINGS, threshold: 100 })).not.toBe(base);
    expect(settingsKey({ ...DEFAULT_INK_SETTINGS, ink: "black" })).not.toBe(base);
    expect(settingsKey({ ...DEFAULT_INK_SETTINGS, evenLighting: false })).not.toBe(base);
    expect(settingsKey({ ...DEFAULT_INK_SETTINGS, removeSpecks: false })).not.toBe(base);
    expect(settingsKey({ ...DEFAULT_INK_SETTINGS, crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } })).not.toBe(base);
    // un recorte que cubre todo es lo mismo que ninguno
    expect(settingsKey({ ...DEFAULT_INK_SETTINGS, crop: FULL_CROP })).toBe(base);
  });
});

describe("errores del motor -> clave de mensaje", () => {
  const cases: Array<[string, InkErrorKey]> = [
    ["empty-file", "empty"],
    ["file-too-large", "tooLargeFile"],
    ["unsupported-format", "unsupported"],
    ["decode-failed", "decode"],
    ["too-many-pixels", "tooManyPixels"],
    ["invalid-image", "invalid"],
    ["no-ink", "noInk"],
    ["too-dark", "tooDark"],
    ["encode-failed", "encode"],
  ];
  for (const [code, key] of cases) {
    it(`${code} -> ${key}`, () => {
      expect(inkErrorKey(new InkError(code as never))).toBe(key);
    });
  }

  it("HEIC que el navegador no abre pide JPG o PNG (tambien si llega como formato no admitido)", () => {
    expect(inkErrorKey(new InkError("decode-failed"), "heic")).toBe("heic");
    expect(inkErrorKey(new InkError("unsupported-format"), "heic")).toBe("heic");
    expect(inkErrorKey(new InkError("decode-failed"), "jpeg")).toBe("decode");
  });

  it("lo que no es un InkError es generico; abortar no es un fallo", () => {
    expect(inkErrorKey(new Error("boom"))).toBe("generic");
    expect(inkErrorKey("texto")).toBe("generic");
    expect(inkErrorCode(new InkError("no-ink"))).toBe("no-ink");
    expect(inkErrorCode(new Error("x"))).toBeNull();
    expect(isAbortError(new InkError("aborted"))).toBe(true);
    expect(isAbortError(new InkError("no-ink"))).toBe(false);
  });
});

describe("vaultImageFromPng", () => {
  it("acepta un PNG dentro de los topes del baul y deriva ancho, alto y proporcion", () => {
    const image = vaultImageFromPng(makePng({ width: 300, height: 120, seed: 3 }));
    expect(image).toMatchObject({ width: 300, height: 120, ratio: 0.4 });
  });

  it("rechaza vacio, no-PNG, > 600 KB y > 4096 px (y acepta justo en el tope)", () => {
    expect(vaultImageFromPng(new Uint8Array())).toBeNull();
    expect(vaultImageFromPng(new Uint8Array(64).fill(7))).toBeNull();
    expect(vaultImageFromPng(makePng({ totalBytes: MAX_VAULT_IMAGE_BYTES + 1 }))).toBeNull();
    expect(vaultImageFromPng(makePng({ totalBytes: MAX_VAULT_IMAGE_BYTES }))).not.toBeNull();
    expect(vaultImageFromPng(makePng({ width: MAX_VAULT_IMAGE_DIMENSION + 1, height: 10 }))).toBeNull();
    expect(vaultImageFromPng(makePng({ width: 10, height: MAX_VAULT_IMAGE_DIMENSION + 1 }))).toBeNull();
    expect(vaultImageFromPng(makePng({ width: MAX_VAULT_IMAGE_DIMENSION, height: MAX_VAULT_IMAGE_DIMENSION }))).not.toBeNull();
  });
});

describe("buildUploadEntry", () => {
  const png = (seed: number) => {
    const bytes = makePng({ width: 200, height: 80, seed });
    return { png: bytes, width: 200, height: 80 };
  };

  it("siempre con origin «uploaded», sin documento de origen, con nombre y cargo limpios", () => {
    const entry = buildUploadEntry({ signerName: "  Ana Pérez ", role: " Directora ", signature: png(1), initials: null });
    expect(entry).toMatchObject({
      signerName: "Ana Pérez",
      role: "Directora",
      origin: "uploaded",
      sourceDocument: "",
      initials: null,
    });
    expect(entry?.signature?.width).toBe(200);
  });

  it("sin nombre, sin imagenes o con una imagen fuera de topes no hay entrada", () => {
    expect(buildUploadEntry({ signerName: "   ", signature: png(1), initials: null })).toBeNull();
    expect(buildUploadEntry({ signerName: "Ana", signature: null, initials: null })).toBeNull();
    const huge = { png: makePng({ totalBytes: MAX_VAULT_IMAGE_BYTES + 5 }), width: 40, height: 20 };
    expect(buildUploadEntry({ signerName: "Ana", signature: png(1), initials: huge })).toBeNull();
  });

  it("firma + iniciales y cargo vacio (no se guarda)", () => {
    const entry = buildUploadEntry({ signerName: "Ana", role: "  ", signature: png(1), initials: png(2) });
    expect(entry?.signature).not.toBeNull();
    expect(entry?.initials).not.toBeNull();
    expect("role" in (entry ?? {})).toBe(false);
  });
});

describe("baul lleno y par firma + iniciales", () => {
  it("vaultIsFull cuenta desde el tope (30)", () => {
    expect(vaultIsFull(MAX_VAULT_ENTRIES - 1)).toBe(false);
    expect(vaultIsFull(MAX_VAULT_ENTRIES)).toBe(true);
    expect(vaultIsFull(MAX_VAULT_ENTRIES + 4)).toBe(true);
  });

  it("missingKind dice que imagen falta", () => {
    const some = { png: new Uint8Array(1), width: 1, height: 1 };
    expect(missingKind({ signature: null, initials: null })).toBe("signature");
    expect(missingKind({ signature: some, initials: null })).toBe("initials");
    expect(missingKind({ signature: null, initials: some })).toBe("signature");
    expect(missingKind({ signature: some, initials: some })).toBeNull();
  });
});

describe("geometria del recorte manual", () => {
  const rect = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };

  it("mover una esquina deja fija la opuesta", () => {
    const next = moveCorner(rect, "nw", 0.1, 0.05);
    expect(next).toMatchObject({ x: 0.1, y: 0.05 });
    expect(next.width).toBeCloseTo(0.5, 10);
    expect(next.height).toBeCloseTo(0.55, 10);
    const se = moveCorner(rect, "se", 0.9, 0.8);
    expect(se.x).toBe(0.2);
    expect(se.y).toBe(0.2);
    expect(se.width).toBeCloseTo(0.7, 10);
    expect(se.height).toBeCloseTo(0.6, 10);
  });

  it("una esquina no cruza a la opuesta (lado minimo) ni sale de la imagen", () => {
    const crossed = moveCorner(rect, "nw", 0.9, 0.9);
    expect(crossed.width).toBeCloseTo(CROP_MIN_FRACTION, 10);
    expect(crossed.height).toBeCloseTo(CROP_MIN_FRACTION, 10);
    const out = moveCorner(rect, "se", 3, -3);
    expect(out.x + out.width).toBeLessThanOrEqual(1);
    expect(out.height).toBeCloseTo(CROP_MIN_FRACTION, 10);
    const ne = moveCorner(rect, "ne", 0.9, 0.1);
    expect(ne).toMatchObject({ x: 0.2, y: 0.1 });
    const sw = moveCorner(rect, "sw", 0.1, 0.9);
    expect(sw.x).toBeCloseTo(0.1, 10);
  });

  it("el teclado mueve la esquina desde donde esta", () => {
    expect(nudgeCorner(rect, "se", 0.01, 0)).toMatchObject({ width: expect.closeTo(0.41, 10), height: expect.closeTo(0.4, 10) });
    expect(nudgeCorner(rect, "nw", 0, -0.05)).toMatchObject({ y: expect.closeTo(0.15, 10), height: expect.closeTo(0.45, 10) });
    expect(nudgeCorner(rect, "ne", -0.01, 0).width).toBeCloseTo(0.39, 10);
    expect(nudgeCorner(rect, "sw", 0, 0.02).height).toBeCloseTo(0.42, 10);
  });

  it("desplazar el recorte conserva su tamano y no se sale", () => {
    expect(shiftCrop(rect, 0.1, -0.1)).toEqual({ x: expect.closeTo(0.3, 10), y: expect.closeTo(0.1, 10), width: 0.4, height: 0.4 });
    expect(shiftCrop(rect, 5, 5)).toEqual({ x: 0.6, y: 0.6, width: 0.4, height: 0.4 });
    expect(shiftCrop(rect, -5, -5)).toEqual({ x: 0, y: 0, width: 0.4, height: 0.4 });
  });

  it("el recorte inicial a mano rodea la tinta con un respiro, o un 10 % si no hay datos", () => {
    const size = { width: 1000, height: 500 };
    const crop = initialManualCrop({ x: 200, y: 100, width: 500, height: 200 }, size);
    expect(crop.x).toBeLessThan(0.2);
    expect(crop.x + crop.width).toBeGreaterThan(0.7);
    expect(crop.y).toBeLessThan(0.2);
    expect(initialManualCrop(null, size)).toEqual({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
    expect(initialManualCrop({ x: 0, y: 0, width: 0, height: 0 }, size)).toEqual({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
    // tinta que ocupa toda la imagen: no queda un «recorte» que ya es todo
    expect(initialManualCrop({ x: 0, y: 0, width: 1000, height: 500 }, size)).toEqual({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
  });
});
