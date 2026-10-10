import { describe, expect, it, vi } from "vitest";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  firstImageCandidate,
  readImageFile,
  type ImageDeps,
} from "@/app/edit-pdf/editImages";

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG_HEAD = [0xff, 0xd8, 0xff, 0xe0];

const png = (extra = 8) => new Blob([new Uint8Array([...PNG_HEAD, ...new Array(extra).fill(1)])], { type: "image/png" });
const jpg = () => new Blob([new Uint8Array([...JPG_HEAD, 1, 2, 3, 4])], { type: "image/jpeg" });
const measure =
  (width: number, height: number): ImageDeps["measure"] =>
  async () => ({ width, height });
const noScale: ImageDeps["downscale"] = async () => null;

describe("readImageFile: tipo, tamano y lectura", () => {
  it("acepta un PNG y calcula la proporcion alto / ancho", async () => {
    const result = await readImageFile(png(), { measure: measure(200, 100), downscale: noScale });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.mime).toBe("image/png");
    expect(result.image.ratio).toBe(0.5);
    expect(result.image.width).toBe(200);
    expect(result.image.previewUrl.startsWith("data:image/png")).toBe(true);
    expect(result.image.bytes[0]).toBe(0x89);
  });

  it("acepta un JPG", async () => {
    const result = await readImageFile(jpg(), { measure: measure(100, 300), downscale: noScale });
    expect(result.ok && result.image.mime).toBe("image/jpeg");
    expect(result.ok && result.image.ratio).toBe(3);
  });

  it("se fija en la FIRMA de los bytes, no en la extension ni en el type", async () => {
    const gif = new Blob([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 1, 1, 1])], { type: "image/png" });
    const result = await readImageFile(gif, { measure: measure(10, 10), downscale: noScale });
    expect(result).toEqual({ ok: false, reason: "type" });
  });

  it("rechaza un SVG y un texto aunque se llamen .png", async () => {
    const svg = new Blob(["<svg xmlns='http://www.w3.org/2000/svg'/>"], { type: "image/svg+xml" });
    expect(await readImageFile(svg, { measure: measure(1, 1), downscale: noScale })).toEqual({ ok: false, reason: "type" });
    const text = new File(["hola"], "foto.png", { type: "image/png" });
    expect(await readImageFile(text, { measure: measure(1, 1), downscale: noScale })).toEqual({ ok: false, reason: "type" });
  });

  it("rechaza un archivo vacio", async () => {
    expect(await readImageFile(new Blob([]), { measure: measure(1, 1), downscale: noScale })).toEqual({ ok: false, reason: "empty" });
  });

  it("rechaza lo que pesa mas que el maximo SIN leerlo", async () => {
    const big = { size: MAX_IMAGE_BYTES + 1, arrayBuffer: vi.fn() } as unknown as Blob;
    const result = await readImageFile(big, { measure: measure(1, 1), downscale: noScale });
    expect(result).toEqual({ ok: false, reason: "size" });
    expect((big.arrayBuffer as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it("acepta justo el maximo de bytes", async () => {
    const edge = new Blob([new Uint8Array([...PNG_HEAD, ...new Array(MAX_IMAGE_BYTES - PNG_HEAD.length).fill(0)])]);
    expect(edge.size).toBe(MAX_IMAGE_BYTES);
    const result = await readImageFile(edge, { measure: measure(10, 10), downscale: noScale });
    expect(result.ok).toBe(true);
  });

  it("rechaza una imagen con demasiados pixeles aunque pese poco", async () => {
    const result = await readImageFile(png(), { measure: measure(9000, Math.ceil(MAX_IMAGE_PIXELS / 9000) + 1), downscale: noScale });
    expect(result).toEqual({ ok: false, reason: "pixels" });
  });

  it("una firma valida con datos dañados (no se puede descodificar) es 'unreadable'", async () => {
    const result = await readImageFile(png(), { measure: async () => null, downscale: noScale });
    expect(result).toEqual({ ok: false, reason: "unreadable" });
  });

  it("si reducir la vista previa falla, se queda con el original", async () => {
    const result = await readImageFile(png(), {
      measure: measure(100, 100),
      downscale: async () => {
        throw new Error("sin canvas");
      },
    });
    expect(result.ok && result.image.previewUrl.startsWith("data:image/png")).toBe(true);
  });

  it("usa la vista previa reducida cuando hay una", async () => {
    const result = await readImageFile(png(), { measure: measure(4000, 3000), downscale: async () => "data:image/png;base64,REDUCIDA" });
    expect(result.ok && result.image.previewUrl).toBe("data:image/png;base64,REDUCIDA");
    // Pero la proporcion y los bytes son los de la original.
    expect(result.ok && result.image.ratio).toBe(0.75);
  });
});

describe("firstImageCandidate: soltar varios archivos", () => {
  const file = (name: string, type: string) => new File(["x"], name, { type });

  it("elige la primera imagen PNG o JPG de la lista", () => {
    const list = [file("a.pdf", "application/pdf"), file("b.jpg", "image/jpeg"), file("c.png", "image/png")];
    expect(firstImageCandidate(list)?.name).toBe("b.jpg");
  });

  it("sin imagenes devuelve el primero (para que se rechace con un motivo claro)", () => {
    expect(firstImageCandidate([file("a.pdf", "application/pdf")])?.name).toBe("a.pdf");
  });

  it("lista vacia o nula: nada", () => {
    expect(firstImageCandidate([])).toBeNull();
    expect(firstImageCandidate(null)).toBeNull();
  });

  it("reconoce por la extension cuando el navegador no da type", () => {
    expect(firstImageCandidate([file("a.txt", ""), file("foto.JPEG", "")])?.name).toBe("foto.JPEG");
  });
});
