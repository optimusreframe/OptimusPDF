import { describe, expect, it } from "vitest";
import { createFakeEngine } from "@/lib/pdf/extractAssets/testing/fakeEngine";
import { EXTRACT_LIMITS, type ExtractProgress } from "@/lib/pdf/extractAssets/types";

/** El motor falso de pruebas: determinista, variado y fiel al contrato (lo que la interfaz y los E2E suponen de el). */

const file = new Uint8Array([37, 80, 68, 70]);
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

async function head(blob: Blob, count = 4): Promise<number[]> {
  return Array.from(new Uint8Array(await blob.slice(0, count).arrayBuffer()));
}

describe("escenario mixed", () => {
  it("trae los tipos, con y sin alfa, con formatos variados y la pagina escaneada con su aviso", async () => {
    const result = await createFakeEngine().extractAssets(file);
    expect(result.pageCount).toBe(6);
    expect(result.assets.map((asset) => asset.kind).sort()).toEqual(
      ["drawing", "image", "initials", "logo", "photo", "signature", "signature", "signature", "stamp", "watermark"].sort(),
    );
    expect(new Set(result.assets.map((asset) => asset.id)).size).toBe(result.assets.length);
    expect(result.assets.some((asset) => asset.pixel?.hasAlpha === true)).toBe(true);
    expect(result.assets.some((asset) => asset.pixel?.hasAlpha === false)).toBe(true);
    expect(result.scannedPages).toEqual([4]);
    expect(result.warnings).toEqual([{ code: "scanned-page", pageIndex: 4 }]);
    expect(result.truncated).toBe(false);
    const watermark = result.assets.find((asset) => asset.kind === "watermark")!;
    expect(watermark.pixel).toBeNull();
    expect(watermark.ref).toEqual({ engine: "text", text: "CONFIDENCIAL" });
    expect(watermark.formats[0]).toBe("txt");
    const logo = result.assets.find((asset) => asset.kind === "logo")!;
    expect(logo.occurrences).toHaveLength(6);
    expect(result.assets.some((asset) => asset.formats.includes("jpg-original"))).toBe(true);
    expect(result.assets.some((asset) => asset.formats.includes("svg"))).toBe(true);
    // Confianzas para los dos mundos: «probable» y seguro.
    expect(Math.min(...result.assets.map((asset) => asset.confidence))).toBeLessThan(0.9);
    expect(Math.max(...result.assets.map((asset) => asset.confidence))).toBeGreaterThanOrEqual(0.95);
    for (const asset of result.assets) {
      for (const occurrence of asset.occurrences) {
        expect(occurrence.pageIndex).toBeGreaterThanOrEqual(0);
        expect(occurrence.pageIndex).toBeLessThan(6);
        expect(occurrence.rect.x + occurrence.rect.width).toBeLessThanOrEqual(1);
        expect(occurrence.rect.y + occurrence.rect.height).toBeLessThanOrEqual(1);
      }
    }
  });

  it("las miniaturas son PNG de 256 px como maximo y renderAsset devuelve los formatos pedidos", async () => {
    const engine = createFakeEngine();
    const result = await engine.extractAssets(file);
    for (const asset of result.assets) {
      if (asset.pixel === null) {
        expect(asset.thumb).toBeNull();
        continue;
      }
      expect(asset.thumb).not.toBeNull();
      expect(await head(asset.thumb!)).toEqual(PNG_MAGIC);
    }
    const signature = result.assets.find((asset) => asset.id === "fx-sig-1")!;
    const full = await engine.renderAsset(file, signature, "png");
    expect(await head(full)).toEqual(PNG_MAGIC);
    expect(full.size).toBeGreaterThan(signature.thumb!.size);
    const view = new DataView(await full.slice(0, 24).arrayBuffer());
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([420, 140]);
    const withJpg = result.assets.find((asset) => asset.id === "fx-sig-2")!;
    expect(await head(await engine.renderAsset(file, withJpg, "jpg-original"), 3)).toEqual([0xff, 0xd8, 0xff]);
    const text = result.assets.find((asset) => asset.kind === "watermark")!;
    expect(await (await engine.renderAsset(file, text, "txt")).text()).toBe("CONFIDENCIAL");
    const ink = result.assets.find((asset) => asset.source === "ink-annot")!;
    expect(await (await engine.renderAsset(file, ink, "svg")).text()).toContain("<svg");
  });

  it("es determinista: dos ejecuciones dan exactamente lo mismo, miniaturas incluidas", async () => {
    const one = await createFakeEngine().extractAssets(file);
    const two = await createFakeEngine().extractAssets(file);
    const strip = (result: typeof one) => result.assets.map(({ thumb, ...rest }) => ({ ...rest, thumbSize: thumb?.size ?? 0 }));
    expect(strip(one)).toEqual(strip(two));
    const a = new Uint8Array(await one.assets[0].thumb!.arrayBuffer());
    const b = new Uint8Array(await two.assets[0].thumb!.arrayBuffer());
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe("otros escenarios", () => {
  it("signatures: solo firmas e iniciales", async () => {
    const result = await createFakeEngine({ scenario: "signatures" }).extractAssets(file);
    expect(result.assets.map((asset) => asset.kind).sort()).toEqual(["initials", "signature", "signature", "signature"]);
    expect(result.scannedPages).toEqual([]);
  });

  it("empty: sin elementos y con una pagina escaneada", async () => {
    const result = await createFakeEngine({ scenario: "empty" }).extractAssets(file);
    expect(result.assets).toEqual([]);
    expect(result.scannedPages).toEqual([0]);
  });

  it("warnings: un aviso de cada clase", async () => {
    const result = await createFakeEngine({ scenario: "warnings" }).extractAssets(file);
    expect(new Set(result.warnings.map((warning) => warning.code))).toEqual(new Set(["scanned-page", "digital-signature", "decode-failed", "image-too-large", "encrypted"]));
  });

  it("many: 520 se cortan en 500 con `truncated` y su aviso; con maxAssets menor, en ese tope", async () => {
    const engine = createFakeEngine({ scenario: "many" });
    const result = await engine.extractAssets(file);
    expect(result.assets).toHaveLength(EXTRACT_LIMITS.maxAssets);
    expect(result.truncated).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain("too-many-assets");
    expect(new Set(result.assets.map((asset) => asset.id)).size).toBe(500);
    expect((await engine.extractAssets(file, { maxAssets: 40 })).assets).toHaveLength(40);
  });

  it("tooManyPages: 450 paginas -> analiza 300 con aviso; con rango, lo pedido (sin aviso)", async () => {
    const engine = createFakeEngine({ scenario: "tooManyPages" });
    const all = await engine.extractAssets(file);
    expect(all.pageCount).toBe(450);
    expect(all.warnings.map((warning) => warning.code)).toContain("too-many-pages");
    expect(all.truncated).toBe(true);
    const ranged = await engine.extractAssets(file, { pageRange: { from: 300, to: 449 } });
    expect(ranged.warnings.map((warning) => warning.code)).not.toContain("too-many-pages");
    expect(ranged.truncated).toBe(false);
  });

  it("failWith: rechaza con ese PdfError; failRender rechaza solo ese elemento", async () => {
    const failing = createFakeEngine({ failWith: "encrypted" });
    await expect(failing.extractAssets(file)).rejects.toMatchObject({ name: "PdfError", code: "encrypted" });
    const engine = createFakeEngine({ failRender: ["fx-sig-1"] });
    const result = await engine.extractAssets(file);
    await expect(engine.renderAsset(file, result.assets.find((asset) => asset.id === "fx-sig-1")!)).rejects.toMatchObject({ code: "unknown" });
    await expect(engine.renderAsset(file, result.assets.find((asset) => asset.id === "fx-sig-2")!)).resolves.toBeInstanceOf(Blob);
    const all = createFakeEngine({ failRender: true });
    const list = await all.extractAssets(file);
    await expect(all.renderAsset(file, list.assets[0])).rejects.toMatchObject({ code: "unknown" });
  });

  it("configure cambia el escenario en caliente", async () => {
    const engine = createFakeEngine();
    engine.configure({ scenario: "empty" });
    expect((await engine.extractAssets(file)).assets).toHaveLength(0);
    engine.configure({ scenario: "signatures", pageCount: 3 });
    const result = await engine.extractAssets(file);
    expect(result.pageCount).toBe(3);
    expect(result.assets.every((asset) => asset.occurrences.every((o) => o.pageIndex <= 2))).toBe(true);
    expect(engine.calls.map((call) => call.method)).toEqual(["extractAssets", "extractAssets"]);
  });
});

describe("progreso y cancelacion", () => {
  it("informa pagina a pagina (0-based) con el total y los hallados hasta ahora", async () => {
    const seen: ExtractProgress[] = [];
    await createFakeEngine({ pageCount: 4 }).extractAssets(file, { onProgress: (value) => seen.push(value) });
    expect(seen.map((value) => value.pageIndex)).toEqual([0, 1, 2, 3]);
    expect(seen.every((value) => value.pageCount === 4)).toBe(true);
    expect(seen.map((value) => value.assetsSoFar)).toEqual([...seen.map((value) => value.assetsSoFar)].sort((a, b) => a - b));
  });

  it("cancelar a mitad rechaza con AbortError (y no sigue avisando)", async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const promise = createFakeEngine({ pageCount: 6, delayMs: 5 }).extractAssets(file, {
      signal: controller.signal,
      onProgress: (value) => {
        seen.push(value.pageIndex);
        if (value.pageIndex === 1) controller.abort();
      },
    });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual([0, 1]);
  });

  it("ya cancelado antes de empezar, ni arranca", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createFakeEngine().extractAssets(file, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("cropRegion falso", () => {
  it("devuelve un PNG del tamano de la region y respeta la cancelacion", async () => {
    const engine = createFakeEngine();
    const out = await engine.cropRegion(file, 2, { x: 0.1, y: 0.1, width: 0.4, height: 0.1 });
    expect([out.width, out.height]).toEqual([400, 100]);
    expect(await head(out.png)).toEqual(PNG_MAGIC);
    const controller = new AbortController();
    controller.abort();
    await expect(engine.cropRegion(file, 0, { x: 0, y: 0, width: 1, height: 1 }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });
});
