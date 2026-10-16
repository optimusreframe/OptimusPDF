import { IDBFactory } from "fake-indexeddb";
import { __resetLibraryForTests, putDocument } from "@/lib/docLibrary/store";
import { createTemplate } from "@/lib/docLibrary/templatesStore";
import { sampleDraft, signField, variantOf } from "@/lib/docLibrary/testing/templateSamples";
import { sampleBytes, sampleFingerprint, sampleInput } from "@/lib/docLibrary/testing/sampleDocs";
import type { DocumentEntry, Fingerprint } from "@/lib/docLibrary/types";

/**
 * Utilidades SOLO de pruebas de «Mis documentos» / Recientes: base IndexedDB falsa nueva, PDF "de mentira" cuyo texto
 * dice cuantas paginas tienen y que semilla de huella (`pages=N seed=S`), huella falsa a juego y plantillas rapidas.
 */
/*
 * jsdom + fake-indexeddb: el clon estructurado de IndexedDB devuelve un `Uint8Array` del dominio de Node, y el
 * `Uint8Array` global de jsdom es otro: `value instanceof Uint8Array` da `false` y la biblioteca (que SI funciona en un
 * navegador, donde hay un solo dominio) creeria que la copia del PDF no existe. Solo para estas pruebas, `instanceof`
 * reconoce cualquier `Uint8Array` por su etiqueta.
 */
if (typeof window !== "undefined") {
  Object.defineProperty(Uint8Array, Symbol.hasInstance, {
    configurable: true,
    value: (value: unknown) => Object.prototype.toString.call(value) === "[object Uint8Array]",
  });
}

export function freshLibrary(): void {
  __resetLibraryForTests();
  globalThis.indexedDB = new IDBFactory();
}

export function noIndexedDb(): void {
  __resetLibraryForTests();
  // @ts-expect-error simula un navegador sin IndexedDB (p. ej. Safari en modo privado antiguo)
  delete globalThis.indexedDB;
}

const hex64 = (n: number) => n.toString(16).padStart(64, "0");

/** Huella falsa de un PDF de prueba: `exact` y paginas salen de `seed`/`pages` del texto del archivo. */
export function fakeFingerprintOf(bytes: Uint8Array): Fingerprint {
  const text = new TextDecoder().decode(bytes.subarray(0, 200));
  const pages = Number(/pages=(\d+)/.exec(text)?.[1] ?? 3);
  const seed = Number(/seed=(\d+)/.exec(text)?.[1] ?? 1);
  if (/corrupt/.test(text)) {
    const error = new Error("corrupt") as Error & { code: string };
    error.code = "corrupt";
    throw error;
  }
  return sampleFingerprint(pages, seed, hex64(seed));
}

export function makePdfFile(label: string, { pages = 3, seed = 1 }: { pages?: number; seed?: number } = {}): File {
  return new File([`%PDF-1.7 pages=${pages} seed=${seed} ${label}`], `${label}.pdf`, { type: "application/pdf" });
}

/** Siembra un documento en la biblioteca (sin pasar por la interfaz). */
export async function seedDocument(
  id: string,
  { name = `Contrato ${id}`, seed = id.length + 5, pages = 3, now }: { name?: string; seed?: number; pages?: number; now?: () => Date } = {},
): Promise<DocumentEntry> {
  const fingerprint = sampleFingerprint(pages, seed, hex64(seed));
  return putDocument(sampleInput(id, { name, fingerprint, fileName: `${name}.pdf` }), sampleBytes(), now ? { now } : {});
}

/** Plantilla lista (1 y 2 firmantes). */
export async function seedReadyTemplate(documentId: string): Promise<void> {
  await createTemplate(sampleDraft(documentId));
}

/** Plantilla solo de 1 firmante (parcial). */
export async function seedSingleTemplate(documentId: string): Promise<void> {
  await createTemplate(sampleDraft(documentId, { variants: { "1": variantOf([signField()]), "2": variantOf([]) } }));
}

/** Reloj que avanza un minuto por llamada: documentos con `updatedAt` distintos y ordenados. */
export function minuteClock(startIso = "2026-10-10T10:00:00.000Z"): () => Date {
  let t = Date.parse(startIso);
  return () => {
    const d = new Date(t);
    t += 60_000;
    return d;
  };
}
