import { createHash } from "node:crypto";
import { PDFDocument } from "@cantoo/pdf-lib";
import { buildPackage } from "../../src/lib/backup/package";
import { settingsModuleFromValues } from "../../src/lib/backup/modules/settings";
import { makeRealPng, pngPixelBomb } from "../../src/lib/backup/__fixtures__/pngFactory";

/**
 * Paquetes de borradores y ajustes FORJADOS en Node para las pruebas E2E del respaldo (U4.6): un borrador valido de Firmar
 * (con un trazo PNG real) del que se parte para romper una pieza cada vez. Los PDF son reales (pdf-lib, sin fechas).
 */

const enc = new TextEncoder();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export async function pdfBytes(label: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([300, 400]).drawText(label, { x: 30, y: 350, size: 16 });
  return doc.save({ useObjectStreams: false });
}

type Parts = { index: Record<string, unknown>; files: Map<string, Uint8Array> };

/** Un borrador de documento suelto, valido, con una firma. */
export async function validDocumentParts(label = "Forjado"): Promise<Parts & { fingerprint: string }> {
  const pdf = await pdfBytes(label);
  const fingerprint = sha256(pdf);
  const png = makeRealPng({ width: 60, height: 24, seed: 3 });
  const item = {
    ref: "d1",
    id: `${fingerprint.slice(0, 32)}${"ab".repeat(16)}`,
    fingerprint,
    fileName: `${label}.pdf`,
    savedAt: new Date().toISOString(),
    mode: "multi",
    step: "sign",
    signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }],
    fields: [{ id: "fld-1", signerId: "sg-1", pageIndex: 0, type: "signature", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } }],
    textFields: [],
    textValues: {},
    textFieldsDetectedFor: null,
    captures: { "sg-1": { signature: { png: "drafts/d1-k0.png", ratio: 0.4 }, initials: null, stamp: `${fingerprint}~fld-1|0|signature|0.1|0.1|0.2|0.1` } },
    expiresAt: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
  };
  return {
    fingerprint,
    index: { sign: { documents: [item], sessions: [] }, edit: [], pro: [] },
    files: new Map<string, Uint8Array>([
      ["drafts/d1.pdf", pdf],
      ["drafts/d1-k0.png", png],
    ]),
  };
}

export async function packDrafts(parts: Parts, index: unknown = parts.index): Promise<Buffer> {
  const files = [
    { path: "drafts/index.json", data: new Uint8Array(enc.encode(typeof index === "string" ? index : JSON.stringify(index))), type: "application/json" },
    ...Array.from(parts.files, ([path, data]) => ({
      path,
      data,
      type: path.endsWith(".pdf") ? "application/pdf" : path.endsWith(".png") ? "image/png" : "application/json",
    })),
  ];
  const blob = await buildPackage({ modules: [{ name: "drafts", schemaVersion: 1, files }] });
  return Buffer.from(await blob.arrayBuffer());
}

/** El corpus hostil del E2E: cada entrada es un paquete que NO debe escribir nada. */
export async function hostileDraftPackages(): Promise<Array<{ name: string; buffer: Buffer; expect: RegExp }>> {
  const out: Array<{ name: string; buffer: Buffer; expect: RegExp }> = [];

  const fake = await validDocumentParts("pdf-falso");
  fake.files.set("drafts/d1.pdf", enc.encode("esto no es un PDF, es solo texto que se hace pasar por uno"));
  // la huella ya no cuadra: la pieza que salta primero es la huella
  out.push({ name: "PDF falso", buffer: await packDrafts(fake), expect: /^sign-document:invalid:(fingerprint|invalidPdf)$/ });

  const truncated = await validDocumentParts("pdf-truncado");
  const half = (truncated.files.get("drafts/d1.pdf") as Uint8Array).subarray(0, 120);
  truncated.files.set("drafts/d1.pdf", new Uint8Array(half));
  // se re-huella el PDF truncado para que SOLO falle la apertura real (inputGuard / pdf.js)
  const item = (truncated.index.sign as { documents: Array<Record<string, unknown>> }).documents[0];
  item.fingerprint = sha256(half);
  item.id = `${sha256(half).slice(0, 32)}${"ab".repeat(16)}`;
  out.push({ name: "PDF truncado (pasa la cabecera, no se abre)", buffer: await packDrafts(truncated), expect: /^sign-document:invalid:invalidPdf$/ });

  const bomb = await validDocumentParts("bomba-de-pixeles");
  bomb.files.set("drafts/d1-k0.png", pngPixelBomb());
  const bombItem = (bomb.index.sign as { documents: Array<{ captures: Record<string, { signature: { ratio: number } }> }> }).documents[0];
  bombItem.captures["sg-1"].signature.ratio = 1;
  out.push({ name: "trazo PNG 4096x4096 que descomprime a 64 MB", buffer: await packDrafts(bomb), expect: /^sign-document:invalid:invalidImage$/ });

  const many = await validDocumentParts("10000-bloques");
  const sessionPdf = many.files.get("drafts/d1.pdf") as Uint8Array;
  many.files.set("drafts/s1-0.pdf", sessionPdf);
  many.files.delete("drafts/d1.pdf");
  many.files.delete("drafts/d1-k0.png");
  many.index = {
    sign: {
      documents: [],
      sessions: [
        {
          ref: "s1",
          id: "s-mgl1z-1k3v9x2a",
          savedAt: new Date().toISOString(),
          mode: "multi",
          signMode: "same",
          step: "sign",
          signers: [{ id: "sg-1", name: "Ana", color: "#0d4bff" }],
          blocks: Array.from({ length: 10_000 }, (_, i) => ({ id: `bk-${i}`, signerId: "sg-1", appliesTo: ["doc-1"], signature: null, initials: null, stamps: {}, auto: false })),
          documents: [{ id: "doc-1", fileName: "x.pdf" }],
          docStates: {},
          activeDocId: "doc-1",
        },
      ],
    },
    edit: [],
    pro: [],
  };
  out.push({ name: "sesion con 10 000 bloques", buffer: await packDrafts(many), expect: /^sign-session:invalid:tooMany$/ });

  const dup = await validDocumentParts("id-repetido");
  const docs = (dup.index.sign as { documents: Array<Record<string, unknown>> }).documents;
  docs.push({ ...docs[0], ref: "d2", captures: {} });
  dup.files.set("drafts/d2.pdf", dup.files.get("drafts/d1.pdf") as Uint8Array);
  out.push({ name: "id repetido", buffer: await packDrafts(dup), expect: /^sign-document:invalid:duplicateId$/ });

  return out;
}

/** Ajustes hostiles: claves ajenas, `__proto__`, tipos cambiados. */
export async function hostileSettingsPackage(): Promise<Buffer> {
  const base = await buildPackage({ modules: [settingsModuleFromValues({ "optimuspdf.theme": "dark" })] });
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await base.arrayBuffer());
  const body = '{"settings":{"apiKey":"sk-live","__proto__":{"polluted":true},"optimuspdf.lastBackup":"2026-01-01","optimuspdf.recent":"[]","optimuspdf.theme":{"x":1},"optimuspdf.language":"en","optimuspdf.signPdf.featureFlags":{"keyboardNav":"si"}}}';
  const bytes = new Uint8Array(enc.encode(body));
  zip.file("settings/settings.json", bytes);
  const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
  const entry = manifest.files.find((f: { path: string }) => f.path === "settings/settings.json");
  entry.sha256 = sha256(bytes);
  entry.bytes = bytes.length;
  zip.file("manifest.json", JSON.stringify(manifest));
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }));
}
