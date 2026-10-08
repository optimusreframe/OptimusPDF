import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName } from "@cantoo/pdf-lib";
import {
  SOLO_SIGNER_ID,
  SOLO_SLOT_ID,
  UNPLACED_RECT,
  buildSoloPlacements,
  buildTextPlacements,
  defaultSoloRect,
  hasFilledField,
  hasPlacedSignature,
  refitSoloRect,
  soloPlacementFromSlots,
  soloReady,
  soloSlotsFrom,
} from "@/app/sign-pdf/soloSignature";
import { signPdfMulti, type SignatureField } from "@/lib/pdf/sign";
import type { DetectedField } from "@/lib/pdf/detectFields";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const field = (patch: Partial<DetectedField> & { id: string }): DetectedField => ({
  pageIndex: 0,
  rect: { x: 0.1, y: 0.1, width: 0.3, height: 0.05 },
  source: "manual",
  confidence: "high",
  ...patch,
});

describe("soloSignature — modelo de la firma propia", () => {
  it("sin colocar no hay hueco; colocada, un unico hueco con id y dueño fijos", () => {
    expect(soloSlotsFrom({ rect: UNPLACED_RECT, pageIndex: 3 })).toEqual([]);
    const rect = { x: 0.2, y: 0.5, width: 0.3, height: 0.1 };
    expect(soloSlotsFrom({ rect, pageIndex: 1 })).toEqual([
      { id: SOLO_SLOT_ID, signerId: SOLO_SIGNER_ID, pageIndex: 1, type: "signature", rect },
    ]);
  });

  it("de vuelta a las opciones manda el ultimo hueco; sin ninguno queda sin colocar en la pagina 0", () => {
    const a: SignatureField = {
      id: "a",
      signerId: SOLO_SIGNER_ID,
      pageIndex: 0,
      type: "signature",
      rect: { x: 0, y: 0, width: 0.1, height: 0.1 },
    };
    const b = { ...a, id: "b", pageIndex: 2, rect: { x: 0.4, y: 0.4, width: 0.2, height: 0.1 } };
    expect(soloPlacementFromSlots([a, b])).toEqual({ rect: b.rect, pageIndex: 2 });
    expect(soloPlacementFromSlots([])).toEqual({ rect: UNPLACED_RECT, pageIndex: 0 });
  });

  it("colocacion por defecto: 32 % de ancho, centrada, centro vertical al 74 %, con la proporcion del PNG", () => {
    const rect = defaultSoloRect(0.4, 0.75);
    expect(rect.width).toBeCloseTo(0.32, 9);
    expect(rect.height).toBeCloseTo(0.32 * 0.4 * 0.75, 9);
    expect(rect.x).toBeCloseTo(0.34, 9);
    expect(rect.y + rect.height / 2).toBeCloseTo(0.74, 9);
    // Una firma altisima nunca se sale de la pagina.
    const tall = defaultSoloRect(20, 0.75);
    expect(tall.height).toBe(0.9);
    expect(tall.y + tall.height).toBeLessThanOrEqual(1);
  });

  it("ajustar a otra proporcion conserva posicion y ancho y la sube si se saldria", () => {
    const rect = { x: 0.3, y: 0.9, width: 0.3, height: 0.05 };
    const fitted = refitSoloRect(rect, 0.6, 0.75);
    expect(fitted.x).toBe(0.3);
    expect(fitted.width).toBe(0.3);
    expect(fitted.height).toBeCloseTo(0.3 * 0.6 * 0.75, 9);
    expect(fitted.y + fitted.height).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("soloSignature — que se aplica", () => {
  const base = {
    signaturePng: PNG,
    rect: { x: 0.2, y: 0.6, width: 0.3, height: 0.1 },
    pageIndex: 1,
    textFields: [] as DetectedField[],
    textValues: {} as Record<string, string>,
  };

  it("firma creada y colocada, o algun campo relleno; una casilla sin marcar cuenta como respuesta", () => {
    expect(soloReady({ ...base, signaturePng: "" })).toBe(false);
    expect(soloReady({ ...base, rect: UNPLACED_RECT })).toBe(false);
    expect(hasPlacedSignature(base)).toBe(true);
    expect(soloReady(base)).toBe(true);
    const text = field({ id: "t1" });
    expect(soloReady({ ...base, signaturePng: "", textFields: [text], textValues: {} })).toBe(false);
    expect(soloReady({ ...base, signaturePng: "", textFields: [text], textValues: { t1: "Ana" } })).toBe(true);
    expect(hasFilledField([field({ id: "c", type: "checkbox" })], {})).toBe(true);
  });

  it("sola, la firma es exactamente la colocacion de siempre (una imagen en su pagina y rectangulo)", () => {
    const placements = buildSoloPlacements(base, "es");
    expect(placements).toHaveLength(1);
    expect(placements[0]).toMatchObject({ kind: "image", pageIndex: 1, rect: base.rect });
  });

  it("firma + campos: la imagen primero y despues solo los campos con valor ('X' centrada para la casilla, fecha legible)", () => {
    const placements = buildSoloPlacements(
      {
        ...base,
        textFields: [
          field({ id: "t1" }),
          field({ id: "t2" }),
          field({ id: "c1", type: "checkbox" }),
          field({ id: "c2", type: "checkbox" }),
          field({ id: "d1", type: "date" }),
        ],
        textValues: { t1: "Ana Perez", c1: "true", d1: "2026-10-08" },
      },
      "es",
    );
    expect(placements.map((p) => p.kind)).toEqual(["image", "text", "text", "text"]);
    const [, text, check, date] = placements;
    expect(text).toMatchObject({ value: "Ana Perez", align: "left" });
    expect(check).toMatchObject({ value: "X", align: "center" });
    expect(date.kind === "text" && date.value).toMatch(/2026/);
  });

  it("sin firma colocada solo salen los campos; sin nada, ninguna colocacion", () => {
    const text = field({ id: "t1" });
    expect(
      buildSoloPlacements({ ...base, rect: UNPLACED_RECT, textFields: [text], textValues: { t1: "x" } }, "en").map(
        (p) => p.kind,
      ),
    ).toEqual(["text"]);
    expect(buildSoloPlacements({ ...base, signaturePng: "" }, "es")).toEqual([]);
  });

  it("buildTextPlacements da lo mismo para los dos modos y descarta vacios", () => {
    const fields = [field({ id: "a" }), field({ id: "b" })];
    expect(buildTextPlacements(fields, { a: "Hola", b: "" }, "es")).toHaveLength(1);
  });

  it("de punta a punta con el motor real: el PDF resultante lleva la imagen y es valido", async () => {
    const source = await PDFDocument.create();
    source.addPage([300, 400]);
    const bytes = await source.save();
    const file = new File([bytes as unknown as BlobPart], "doc.pdf", { type: "application/pdf" });
    const blob = await signPdfMulti(file, {
      placements: buildSoloPlacements(
        { ...base, pageIndex: 0, textFields: [field({ id: "t1" })], textValues: { t1: "Ana" } },
        "es",
      ),
    });
    const out = await PDFDocument.load(await blob.arrayBuffer());
    expect(out.getPageCount()).toBe(1);
    const resources = out.getPage(0).node.Resources();
    const xobjects = resources?.lookup(PDFName.of("XObject"));
    expect(xobjects).toBeTruthy();
  });
});
