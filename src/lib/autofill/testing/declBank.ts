/**
 * BANCO DE «DECLARATION PAGES» (ensamblado): 28 plantillas x N instancias, cada una con su VERDAD y tres formas de entrada:
 *   - `text`  : PDF con capa de texto;
 *   - `scan`  : PDF escaneado (solo imagen);
 *   - `photo` : foto del telefono (giro, perspectiva, sombra, ruido, JPEG). Una foto por hoja de declaraciones.
 * Todo se genera en memoria y de forma determinista a partir de la semilla; `cacheDir` guarda los archivos para mirarlos o repetir
 * una medicion sin volver a dibujar. No se versiona ningun binario.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeRng } from "@/lib/scan/__fixtures__/rng";
import type { AutofillSource } from "@/lib/autofill/types";
import { buildTruth, makeDeclData, type DeclData, type DeclLang, type DeclTruth } from "@/lib/autofill/testing/declData";
import { HELDOUT_TEMPLATES, TEMPLATES, initMeasure, layoutTemplate, type DPage, type Template } from "@/lib/autofill/testing/declLayouts";
import { buildDeclPdf, buildScanPdf, hardPhotoParams, photoJpeg, photoParams, type PhotoParams } from "@/lib/autofill/testing/declRender";

/**
 * `hard` = una foto en malas condiciones (poca luz, desenfoque, ruido, JPEG muy comprimido). `photo2` = DOS fotos independientes de la misma hoja (otra inclinacion, otra luz, otro ruido): mide la combinacion de varias fuentes (dos lecturas
 * que coinciden se refuerzan; dos que se contradicen quedan las dos en revision). `combo` = el PDF con texto Y una foto de la misma hoja.
 */
export type InputKind = "text" | "scan" | "photo" | "photo2" | "combo" | "hard";
export const INPUT_KINDS: readonly InputKind[] = ["text", "scan", "photo"];

export type DeclDoc = {
  id: string;
  template: string;
  family: string;
  locale: DeclLang;
  truth: DeclTruth;
  data: DeclData;
  pages: DPage[];
  decPages: number[];
  photoParams: PhotoParams;
  /** Fuentes del documento en la forma pedida (PDF de texto / PDF escaneado / una o mas fotos). */
  sources(kind: InputKind): Promise<AutofillSource[]>;
};

export type BankOptions = {
  instances?: number;
  baseSeed?: number;
  /** Solo estas plantillas (id). */
  only?: readonly string[];
  /** Guarda PDFs y fotos aqui (y los reutiliza). */
  cacheDir?: string;
  /** Las plantillas de reserva (redaccion no usada al afinar las reglas) en vez de las 28 de desarrollo. */
  held?: boolean;
};

function fileOf(bytes: Uint8Array, name: string, type: string): File {
  return new File([bytes as BlobPart], name, { type });
}

export async function buildBank(options: BankOptions = {}): Promise<DeclDoc[]> {
  await initMeasure();
  const docs: DeclDoc[] = [];
  const instances = options.instances ?? 1;
  const cache = options.cacheDir;
  if (cache) mkdirSync(cache, { recursive: true });
  const cached = async (name: string, make: () => Promise<Uint8Array> | Uint8Array): Promise<Uint8Array> => {
    if (!cache) return make();
    const file = path.join(cache, name);
    if (existsSync(file)) return new Uint8Array(readFileSync(file));
    const bytes = await make();
    writeFileSync(file, bytes);
    return bytes;
  };

  (options.held ? HELDOUT_TEMPLATES : TEMPLATES).forEach((template: Template, templateIndex) => {
    if (options.only && !options.only.includes(template.id)) return;
    for (let n = 0; n < instances; n += 1) {
      const seed = (options.baseSeed ?? (options.held ? 91_000 : 7000)) + templateIndex * 1009 + n * 97;
      const rng = makeRng(seed);
      const data = makeDeclData(rng, { ...template.data, mortgagee: template.data.mortgagee ?? template.content.mortgagee !== false });
      const locale: DeclLang = data.lang;
      const built = layoutTemplate(template, data, rng);
      const truth = buildTruth(data, built.shown, locale);
      const id = `${template.id}#${n}`;
      const slug = `${template.id}-${n}`;
      const params = photoParams(seed + 5);
      docs.push({
        id,
        template: template.id,
        family: template.family,
        locale,
        truth: { ...truth, note: id },
        data,
        pages: built.pages,
        decPages: built.decPages,
        photoParams: params,
        async sources(kind) {
          if (kind === "text") {
            const bytes = await cached(`${slug}.text.pdf`, () => buildDeclPdf(built.pages));
            return [{ kind: "pdf", file: fileOf(bytes, `${slug}.pdf`, "application/pdf"), origin: "file" }];
          }
          if (kind === "scan") {
            const bytes = await cached(`${slug}.scan.pdf`, () => buildScanPdf(built.pages, seed + 3));
            return [{ kind: "pdf", file: fileOf(bytes, `${slug}-scan.pdf`, "application/pdf"), origin: "scan" }];
          }
          if (kind === "combo") {
            const [pdf] = await this.sources("text");
            const [photo] = await this.sources("photo");
            return [pdf, photo];
          }
          const which = template.splitPhotos ? built.decPages : [built.decPages[0]];
          const out: AutofillSource[] = [];
          const takes = kind === "photo2" ? 2 : 1;
          for (let take = 0; take < takes; take += 1) {
            // La segunda toma cambia de inclinacion, luz y ruido (otra semilla).
            const shot = kind === "hard" ? hardPhotoParams(seed + 7000) : take === 0 ? params : photoParams(seed + 5000);
            for (const [i, pageIndex] of which.entries()) {
              const tag = kind === "hard" ? `hard${i}` : take === 0 ? `photo${i}` : `photoB${i}`;
              const bytes = await cached(`${slug}.${tag}.jpg`, () => photoJpeg(built.pages[pageIndex], shot, seed + 11 + i + take * 5000).jpeg);
              out.push({ kind: "image", file: fileOf(bytes, `${slug}-${tag}.jpg`, "image/jpeg"), origin: "camera" });
            }
          }
          return out;
        },
      });
    }
  });
  return docs;
}
