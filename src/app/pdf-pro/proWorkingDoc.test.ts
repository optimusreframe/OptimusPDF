import { PRO_STRINGS } from "@/app/pdf-pro/proStrings";
import { describe, expect, it, vi } from "vitest";
import {
  PRO_MAX_SNAPSHOTS,
  PRO_MAX_SNAPSHOT_BYTES,
  ProWorkingDoc,
  createProWorkingDoc,
  enforceProBudget,
  groupRepeatedLabels,
} from "@/app/pdf-pro/proWorkingDoc";
import { fakeBytes, fakeDoc, fakeFile, makePdfBytes, pdfFile } from "@/app/pdf-pro/proTestUtils";
import { markDecryptedCopy } from "@/lib/pdf/inputGuard";
import type { ProSnapshot } from "@/app/pdf-pro/proTypes";

/** Documento de trabajo: historial lineal, presupuesto por bytes, ramas, dirty y avisos. */

async function opened(options: Parameters<typeof fakeDoc>[0] = {}, size = 64) {
  const doc = fakeDoc(options);
  const result = await doc.open(fakeFile(size));
  expect(result.ok).toBe(true);
  return doc;
}

const labels = (doc: ProWorkingDoc) => doc.getState().document!.snapshots.map((s) => s.label);
const cursorOf = (doc: ProWorkingDoc) => doc.getState().document!.cursor;

describe("open", () => {
  it("el original es el primer snapshot, con su nombre, paginas y bytes", async () => {
    const doc = fakeDoc();
    const file = fakeFile(40, "contrato.pdf");
    const result = await doc.open(file);
    expect(result.ok).toBe(true);
    const state = doc.getState();
    expect(state.document?.name).toBe("contrato.pdf");
    expect(state.document?.snapshots).toHaveLength(1);
    expect(state.document?.snapshots[0]).toMatchObject({
      label: "Original",
      source: "open",
      pageCount: 3,
      byteLength: 40,
    });
    expect(state.document?.cursor).toBe(0);
    expect(state.pageCount).toBe(3);
  });

  it("no hay cambios sin guardar ni deshacer/rehacer al abrir", async () => {
    const doc = await opened();
    const state = doc.getState();
    expect(state.dirty).toBe(false);
    expect(state.canUndo).toBe(false);
    expect(state.canRedo).toBe(false);
    expect(state.document?.savedSnapshotId).toBe(state.document?.snapshots[0].id);
  });

  it("calcula la huella del archivo abierto y las firmas", async () => {
    const doc = fakeDoc({ fingerprint: async () => "b".repeat(64), inspectSignatures: async () => "active" });
    await doc.open(fakeFile());
    expect(doc.fingerprint).toBe("b".repeat(64));
    expect(doc.getState().document?.signatures).toBe("active");
  });

  it("una huella o inspeccion que fallan degradan a null / unknown, nunca a «sin firmas»", async () => {
    const doc = fakeDoc({ fingerprint: async () => null, inspectSignatures: async () => "unknown" });
    await doc.open(fakeFile());
    expect(doc.fingerprint).toBeNull();
    expect(doc.getState().document?.signatures).toBe("unknown");
  });

  it("un archivo vacio devuelve emptyFile y no abre nada", async () => {
    const doc = fakeDoc();
    const result = await doc.open(new File([], "vacio.pdf"));
    expect(result).toEqual({ ok: false, code: "emptyFile" });
    expect(doc.getState().document).toBeNull();
  });

  it("un PDF que no se puede contar devuelve el codigo tipado", async () => {
    const doc = fakeDoc({
      countPages: async () => {
        throw new Error("Failed to parse PDF");
      },
    });
    const result = await doc.open(fakeFile());
    expect(result).toEqual({ ok: false, code: "corrupt" });
    expect(doc.getState().document).toBeNull();
  });

  it("con un PDF real cuenta las paginas con pdf-lib (sin dependencias falsas)", async () => {
    const doc = createProWorkingDoc({ fingerprint: async () => null, inspectSignatures: async () => "none" });
    const result = await doc.open(pdfFile(await makePdfBytes(4), "real.pdf"));
    expect(result.ok).toBe(true);
    expect(doc.pageCount).toBe(4);
  });

  it("una copia descifrada marca wasEncrypted (por la marca de inputGuard o por la opcion)", async () => {
    const doc = fakeDoc();
    const file = fakeFile();
    markDecryptedCopy(file);
    await doc.open(file);
    expect(doc.getState().document?.wasEncrypted).toBe(true);
    await doc.open(fakeFile());
    expect(doc.getState().document?.wasEncrypted).toBe(false);
    await doc.open(fakeFile(), { encrypted: true });
    expect(doc.getState().document?.wasEncrypted).toBe(true);
  });

  it("abrir otro documento reemplaza al anterior y sus snapshots", async () => {
    const doc = await opened();
    await doc.commit(fakeBytes(10), "Cambio", "operation");
    await doc.open(fakeFile(20, "otro.pdf"));
    expect(doc.getState().document?.name).toBe("otro.pdf");
    expect(doc.getState().document?.snapshots).toHaveLength(1);
  });

  it("un borrador restaurado queda con cambios sin guardar y lo explica", async () => {
    const doc = fakeDoc();
    await doc.open(fakeFile(), {
      restored: { savedAt: "2026-10-11T10:00:00.000Z", history: [] },
      fingerprint: "c".repeat(64),
    });
    const state = doc.getState();
    expect(state.dirty).toBe(true);
    expect(state.document?.restored?.savedAt).toBe("2026-10-11T10:00:00.000Z");
    expect(state.document?.snapshots[0].label).toBe("Borrador recuperado");
    expect(doc.fingerprint).toBe("c".repeat(64));
  });

  it("anuncia el documento abierto en la region viva", async () => {
    const doc = fakeDoc();
    await doc.open(fakeFile(8, "x.pdf"));
    expect(doc.getState().announcement?.text).toBe("Documento abierto: x.pdf");
  });

  it("una apertura lenta que otra reemplazo no pisa a la nueva", async () => {
    let release: (n: number) => void = () => {};
    const slow = new Promise<number>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const doc = createProWorkingDoc({
      countPages: () => (++calls === 1 ? slow : Promise.resolve(9)),
      fingerprint: async () => null,
      inspectSignatures: async () => "none",
    });
    const first = doc.open(fakeFile(10, "lento.pdf"));
    await Promise.resolve();
    await doc.open(fakeFile(10, "rapido.pdf"));
    release(1);
    expect(await first).toEqual({ ok: false, code: "cancelled" });
    expect(doc.getState().document?.name).toBe("rapido.pdf");
    expect(doc.pageCount).toBe(9);
  });
});

describe("commit", () => {
  it("anade un snapshot despues del actual y mueve el cursor", async () => {
    const doc = await opened();
    const snapshot = await doc.commit(fakeBytes(70), "Rotar", "operation", { opId: "rotate-all", pageCount: 3 });
    expect(snapshot).toMatchObject({ label: "Rotar", source: "operation", opId: "rotate-all", byteLength: 70, pageCount: 3 });
    expect(labels(doc)).toEqual(["Original", "Rotar"]);
    expect(cursorOf(doc)).toBe(1);
    expect(doc.current()).toBe(snapshot!.bytes);
  });

  it("cuenta las paginas si la operacion no las trae", async () => {
    const countPages = vi.fn(async () => 7);
    const doc = fakeDoc({ countPages });
    await doc.open(fakeFile(), { pageCount: 3 });
    const snapshot = await doc.commit(fakeBytes(20), "X", "operation");
    expect(snapshot?.pageCount).toBe(7);
    expect(countPages).toHaveBeenCalledTimes(1);
  });

  it("con pageCount informado no vuelve a contar", async () => {
    const countPages = vi.fn(async () => 99);
    const doc = fakeDoc({ countPages });
    await doc.open(fakeFile(), { pageCount: 3 });
    await doc.commit(fakeBytes(20), "X", "operation", { pageCount: 5 });
    expect(countPages).not.toHaveBeenCalled();
    expect(doc.pageCount).toBe(5);
  });

  it("los modos usan source mode-apply", async () => {
    const doc = await opened();
    const snapshot = await doc.commit(fakeBytes(30), "Editar", "mode-apply", { pageCount: 3 });
    expect(snapshot?.source).toBe("mode-apply");
  });

  it("marca el documento como sucio y habilita deshacer", async () => {
    const doc = await opened();
    await doc.commit(fakeBytes(30), "A", "operation", { pageCount: 3 });
    expect(doc.getState().dirty).toBe(true);
    expect(doc.getState().canUndo).toBe(true);
    expect(doc.getState().canRedo).toBe(false);
  });

  it("anuncia «Aplicado: …»", async () => {
    const doc = await opened();
    await doc.commit(fakeBytes(30), "Comprimir", "operation", { pageCount: 3 });
    expect(doc.getState().announcement?.text).toBe("Aplicado: Comprimir");
  });

  it("sin documento abierto no hace nada y devuelve null", async () => {
    const doc = fakeDoc();
    expect(await doc.commit(fakeBytes(10), "X", "operation")).toBeNull();
    expect(doc.getState().document).toBeNull();
  });

  it("las confirmaciones concurrentes se encolan y conservan el orden de llamada", async () => {
    let n = 0;
    const doc = createProWorkingDoc({
      // La primera cuenta MAS lento que la segunda: el orden final tiene que seguir siendo el de llamada.
      countPages: async () => {
        n += 1;
        if (n === 2) await new Promise((r) => setTimeout(r, 20));
        return n;
      },
      fingerprint: async () => null,
      inspectSignatures: async () => "none",
    });
    await doc.open(fakeFile());
    const first = doc.commit(fakeBytes(10, 1), "Primero", "operation");
    const second = doc.commit(fakeBytes(10, 2), "Segundo", "operation");
    await Promise.all([first, second]);
    expect(labels(doc)).toEqual(["Original", "Primero", "Segundo"]);
  });

  it("una confirmacion pendiente cuando se cierra el documento se descarta (null)", async () => {
    const doc = createProWorkingDoc({
      countPages: () => new Promise((r) => setTimeout(() => r(2), 15)),
      fingerprint: async () => null,
      inspectSignatures: async () => "none",
    });
    await doc.open(fakeFile(), { pageCount: 2 });
    const pending = doc.commit(fakeBytes(10), "Tarde", "operation");
    doc.close();
    expect(await pending).toBeNull();
    expect(doc.getState().document).toBeNull();
  });

  it("una confirmacion pendiente cuando se abre OTRO documento no se cuela en el nuevo", async () => {
    const doc = createProWorkingDoc({
      countPages: () => new Promise((r) => setTimeout(() => r(2), 15)),
      fingerprint: async () => null,
      inspectSignatures: async () => "none",
    });
    await doc.open(fakeFile(), { pageCount: 2 });
    const pending = doc.commit(fakeBytes(10), "Del viejo", "operation");
    await doc.open(fakeFile(20, "nuevo.pdf"), { pageCount: 2 });
    expect(await pending).toBeNull();
    expect(labels(doc)).toEqual(["Original"]);
  });
});

describe("deshacer, rehacer, ir a", () => {
  async function withSteps(count: number) {
    const doc = await opened({ maxSnapshots: 50 });
    for (let i = 1; i <= count; i += 1) await doc.commit(fakeBytes(10 + i, i), `Paso ${i}`, "operation", { pageCount: 3 });
    return doc;
  }

  it("undo y redo se mueven un paso y devuelven true", async () => {
    const doc = await withSteps(2);
    expect(doc.undo()).toBe(true);
    expect(cursorOf(doc)).toBe(1);
    expect(doc.undo()).toBe(true);
    expect(cursorOf(doc)).toBe(0);
    expect(doc.redo()).toBe(true);
    expect(cursorOf(doc)).toBe(1);
  });

  it("undo en el original y redo en el ultimo devuelven false", async () => {
    const doc = await withSteps(1);
    expect(doc.redo()).toBe(false);
    expect(doc.undo()).toBe(true);
    expect(doc.undo()).toBe(false);
  });

  it("current() sigue al cursor: los bytes son los del paso en el que se esta", async () => {
    const doc = await withSteps(2);
    const bytes = doc.getState().document!.snapshots.map((s) => s.bytes);
    expect(doc.current()).toBe(bytes[2]);
    doc.undo();
    expect(doc.current()).toBe(bytes[1]);
    doc.undo();
    expect(doc.current()).toBe(bytes[0]);
  });

  it("canUndo / canRedo reflejan la posicion", async () => {
    const doc = await withSteps(2);
    expect(doc.getState()).toMatchObject({ canUndo: true, canRedo: false });
    doc.undo();
    expect(doc.getState()).toMatchObject({ canUndo: true, canRedo: true });
    doc.undo();
    expect(doc.getState()).toMatchObject({ canUndo: false, canRedo: true });
    expect(doc.canUndo).toBe(false);
    expect(doc.canRedo).toBe(true);
  });

  it("anuncia «Deshecho: …» con el paso que se deja y «Rehecho: …» con el que se recupera", async () => {
    const doc = await withSteps(2);
    doc.undo();
    expect(doc.getState().announcement?.text).toBe("Deshecho: Paso 2");
    doc.redo();
    expect(doc.getState().announcement?.text).toBe("Rehecho: Paso 2");
  });

  it("goTo salta a un paso concreto (y fuera de rango no hace nada)", async () => {
    const doc = await withSteps(3);
    expect(doc.goTo(1)).toBe(true);
    expect(cursorOf(doc)).toBe(1);
    expect(doc.goTo(3)).toBe(true);
    expect(cursorOf(doc)).toBe(3);
    expect(doc.goTo(3)).toBe(false);
    expect(doc.goTo(-1)).toBe(false);
    expect(doc.goTo(99)).toBe(false);
    expect(cursorOf(doc)).toBe(3);
  });

  it("cada anuncio tiene un id nuevo (el mismo texto dos veces se vuelve a leer)", async () => {
    const doc = await withSteps(1);
    doc.undo();
    const first = doc.getState().announcement!;
    doc.redo();
    doc.undo();
    const second = doc.getState().announcement!;
    expect(second.text).toBe(first.text);
    expect(second.id).toBeGreaterThan(first.id);
  });

  it("sin documento, undo/redo/goTo no hacen nada", () => {
    const doc = fakeDoc();
    expect(doc.undo()).toBe(false);
    expect(doc.redo()).toBe(false);
    expect(doc.goTo(0)).toBe(false);
  });
});

describe("rama de rehacer", () => {
  it("confirmar un cambio tras deshacer DESCARTA lo que habia por delante", async () => {
    const doc = await opened({ maxSnapshots: 50 });
    for (const label of ["A", "B", "C"]) await doc.commit(fakeBytes(12), label, "operation", { pageCount: 3 });
    doc.undo();
    doc.undo();
    expect(labels(doc)).toEqual(["Original", "A", "B", "C"]);
    await doc.commit(fakeBytes(13), "Nuevo", "operation", { pageCount: 3 });
    expect(labels(doc)).toEqual(["Original", "A", "Nuevo"]);
    expect(cursorOf(doc)).toBe(2);
    expect(doc.getState().canRedo).toBe(false);
  });

  it("al volver al original y confirmar, la rama entera se va", async () => {
    const doc = await opened({ maxSnapshots: 50 });
    await doc.commit(fakeBytes(12), "A", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(12), "B", "operation", { pageCount: 3 });
    doc.goTo(0);
    await doc.commit(fakeBytes(12), "Otro", "operation", { pageCount: 3 });
    expect(labels(doc)).toEqual(["Original", "Otro"]);
  });

  it("la rama descartada libera sus bytes del recuento (no cuenta para el presupuesto)", async () => {
    const doc = await opened({ maxSnapshots: 50, maxBytes: 300 }, 100);
    await doc.commit(fakeBytes(100), "A", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(100), "B", "operation", { pageCount: 3 });
    doc.undo();
    // Quedan 100 (orig) + 100 (A) en pie; B (100) se descarta al confirmar y el nuevo (50) cabe.
    await doc.commit(fakeBytes(50), "C", "operation", { pageCount: 3 });
    expect(labels(doc)).toEqual(["Original", "A", "C"]);
    expect(doc.getState().document?.trimmedCount).toBe(0);
  });

  it("deshacer y rehacer no destruyen la rama mientras no se confirme nada", async () => {
    const doc = await opened({ maxSnapshots: 50 });
    await doc.commit(fakeBytes(12), "A", "operation", { pageCount: 3 });
    doc.undo();
    doc.redo();
    expect(labels(doc)).toEqual(["Original", "A"]);
  });
});

describe("presupuesto de memoria por bytes", () => {
  it("los limites por defecto son 50 snapshots (red de seguridad) y ~400 MB (el limite que manda)", () => {
    expect(PRO_MAX_SNAPSHOTS).toBe(50);
    expect(PRO_MAX_SNAPSHOT_BYTES).toBe(400 * 1024 * 1024);
  });

  it("por numero: al pasar del tope se descarta el mas antiguo que no es el original", async () => {
    const doc = fakeDoc({ maxSnapshots: 5 });
    await doc.open(fakeFile(), { pageCount: 3 });
    for (const label of ["A", "B", "C", "D", "E"]) {
      await doc.commit(fakeBytes(10), label, "operation", { pageCount: 3 });
    }
    expect(labels(doc)).toEqual(["Original", "B", "C", "D", "E"]);
    expect(doc.getState().document?.trimmedCount).toBe(1);
  });

  it("se conservan SIEMPRE el original y el actual", async () => {
    const doc = fakeDoc({ maxSnapshots: 5 });
    await doc.open(fakeFile(), { pageCount: 3 });
    for (let i = 0; i < 12; i += 1) await doc.commit(fakeBytes(10, i), `P${i}`, "operation", { pageCount: 3 });
    const names = labels(doc);
    expect(names[0]).toBe("Original");
    expect(names[names.length - 1]).toBe("P11");
    expect(names).toHaveLength(5);
    expect(doc.getState().document?.trimmedCount).toBe(8);
  });

  it("con el tope por defecto, 10 operaciones en un PDF pequeno dan 10 pasos de deshacer exactos", async () => {
    const doc = fakeDoc();
    await doc.open(fakeFile(), { pageCount: 3 });
    for (let i = 1; i <= 10; i += 1) await doc.commit(fakeBytes(10, i), `Op ${i}`, "operation", { pageCount: 3 });
    expect(labels(doc)).toHaveLength(11);
    expect(doc.getState().document?.trimmedCount).toBe(0);
    for (let i = 10; i >= 1; i -= 1) {
      expect(doc.undo()).toBe(true);
      expect(doc.getState().announcement?.text).toBe(PRO_STRINGS.es.announce.undone(`Op ${i}`));
    }
    expect(doc.getState().canUndo).toBe(false);
    expect(doc.currentSnapshot()?.label).toBe("Original");
  });

  it("al descartar por bytes, deshacer anuncia el salto en vez de saltarse pasos en silencio", async () => {
    const doc = fakeDoc({ maxBytes: 350 });
    await doc.open(fakeFile(100), { pageCount: 3 });
    await doc.commit(fakeBytes(100), "Marca de agua", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(100), "Numerar", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(100), "Rotar", "operation", { pageCount: 3 });
    // Original + 3 pasos = 400 > 350: salen los mas antiguos hasta caber.
    expect(labels(doc)).toEqual(["Original", "Numerar", "Rotar"]);
    expect(doc.getState().announcement?.text).toContain(PRO_STRINGS.es.announce.historyTrimmed);
    expect(doc.undo()).toBe(true);
    expect(doc.undo()).toBe(true);
    // Lo ultimo que se deshizo cruzo «Numerar» y el paso descartado «Marca de agua».
    expect(doc.getState().announcement?.text).toBe(PRO_STRINGS.es.announce.undone("Numerar, Marca de agua"));
    expect(doc.redo()).toBe(true);
    expect(doc.getState().announcement?.text).toBe(PRO_STRINGS.es.announce.redone("Marca de agua, Numerar"));
  });

  it("un salto largo con etiquetas repetidas las agrupa: «Rotar ×3», sin perder ningun paso", async () => {
    const doc = fakeDoc();
    await doc.open(fakeFile(100), { pageCount: 3 });
    await doc.commit(fakeBytes(100), "Rotar", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(100), "Rotar", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(100), "Rotar", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(100), "Recortar", "operation", { pageCount: 3 });
    expect(doc.goTo(0)).toBe(true);
    expect(doc.getState().announcement?.text).toBe(PRO_STRINGS.es.announce.undone("Recortar, Rotar ×3"));
    expect(doc.goTo(4)).toBe(true);
    expect(doc.getState().announcement?.text).toBe(PRO_STRINGS.es.announce.wentTo("Rotar ×3, Recortar"));
  });

  it("un solo paso o etiquetas distintas no llevan contador", async () => {
    const doc = fakeDoc();
    await doc.open(fakeFile(100), { pageCount: 3 });
    await doc.commit(fakeBytes(100), "Rotar", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(100), "Recortar", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(100), "Rotar", "operation", { pageCount: 3 });
    doc.goTo(0);
    expect(doc.getState().announcement?.text).toBe(PRO_STRINGS.es.announce.undone("Rotar, Recortar, Rotar"));
  });

  it("por bytes: descarta los mas antiguos hasta caber, aunque queden menos de 5", async () => {
    const doc = fakeDoc({ maxBytes: 250 });
    await doc.open(fakeFile(100), { pageCount: 3 });
    await doc.commit(fakeBytes(100), "A", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(100), "B", "operation", { pageCount: 3 });
    // Original (100) + A (100) + B (100) = 300 > 250: se va A.
    expect(labels(doc)).toEqual(["Original", "B"]);
    expect(doc.getState().document?.snapshots.reduce((n, s) => n + s.byteLength, 0)).toBe(200);
  });

  it("un snapshot enorme expulsa los intermedios pero nunca el original ni a si mismo", async () => {
    const doc = fakeDoc({ maxBytes: 150 });
    await doc.open(fakeFile(100), { pageCount: 3 });
    await doc.commit(fakeBytes(20), "A", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(500), "Gigante", "operation", { pageCount: 3 });
    expect(labels(doc)).toEqual(["Original", "Gigante"]);
    expect(doc.getState().canUndo).toBe(true);
  });

  it("con el cursor atras (tras deshacer) el actual tampoco se descarta", async () => {
    const doc = fakeDoc({ maxSnapshots: 3 });
    await doc.open(fakeFile(), { pageCount: 3 });
    await doc.commit(fakeBytes(10), "A", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(10), "B", "operation", { pageCount: 3 });
    doc.goTo(1); // actual = A
    // Confirmar otro cambio descarta B (rama) y deja [Original, A, Nuevo]: cabe en 3.
    await doc.commit(fakeBytes(10), "Nuevo", "operation", { pageCount: 3 });
    expect(labels(doc)).toEqual(["Original", "A", "Nuevo"]);
  });

  it("el cursor se reajusta cuando se descartan snapshots por delante de el", async () => {
    const result = enforceProBudget(
      {
        snapshots: ["o", "a", "b", "c"].map((id) => ({ id, byteLength: 10 }) as ProSnapshot),
        cursor: 3,
      },
      { maxSnapshots: 3, maxBytes: 1_000 },
    );
    expect(result.snapshots.map((s) => s.id)).toEqual(["o", "b", "c"]);
    expect(result.cursor).toBe(2);
    expect(result.evicted.map((s) => s.id)).toEqual(["a"]);
  });

  it("enforceProBudget no toca nada si cabe", () => {
    const snapshots = ["o", "a"].map((id) => ({ id, byteLength: 10 }) as ProSnapshot);
    const result = enforceProBudget({ snapshots, cursor: 1 }, { maxSnapshots: 5, maxBytes: 100 });
    expect(result.evicted).toEqual([]);
    expect(result.snapshots).toEqual(snapshots);
    expect(result.cursor).toBe(1);
  });

  it("enforceProBudget con solo original y actual no descarta aunque se pase de bytes", () => {
    const snapshots = ["o", "a"].map((id) => ({ id, byteLength: 1_000 }) as ProSnapshot);
    const result = enforceProBudget({ snapshots, cursor: 1 }, { maxSnapshots: 5, maxBytes: 10 });
    expect(result.evicted).toEqual([]);
    expect(result.snapshots).toHaveLength(2);
  });

  it("enforceProBudget con el cursor en el original descarta los mas antiguos de los demas", () => {
    const snapshots = ["o", "a", "b", "c"].map((id) => ({ id, byteLength: 10 }) as ProSnapshot);
    const result = enforceProBudget({ snapshots, cursor: 0 }, { maxSnapshots: 2, maxBytes: 1_000 });
    expect(result.snapshots.map((s) => s.id)).toEqual(["o", "c"]);
    expect(result.cursor).toBe(0);
  });

  it("avisa de que el historial mas antiguo se descarto (region viva) y llama a onEvict", async () => {
    const onEvict = vi.fn();
    const doc = fakeDoc({ maxSnapshots: 2, onEvict });
    await doc.open(fakeFile(), { pageCount: 3 });
    await doc.commit(fakeBytes(10), "A", "operation", { pageCount: 3 });
    await doc.commit(fakeBytes(10), "B", "operation", { pageCount: 3 });
    expect(doc.getState().announcement?.text).toBe(
      "Aplicado: B. El historial más antiguo se descartó para liberar memoria.",
    );
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict.mock.calls[0][0].label).toBe("A");
  });

  it("tras descartar, deshacer salta directo al original (sin pasos fantasma)", async () => {
    const doc = fakeDoc({ maxSnapshots: 3 });
    await doc.open(fakeFile(), { pageCount: 3 });
    for (const label of ["A", "B", "C"]) await doc.commit(fakeBytes(10), label, "operation", { pageCount: 3 });
    expect(labels(doc)).toEqual(["Original", "B", "C"]);
    doc.undo();
    doc.undo();
    expect(doc.getState().canUndo).toBe(false);
    expect(doc.getState().document?.snapshots[doc.getState().document!.cursor].label).toBe("Original");
  });

  it("la memoria que ocupa la lista nunca supera el presupuesto salvo original + actual", async () => {
    const doc = fakeDoc({ maxBytes: 1_000, maxSnapshots: 50 });
    await doc.open(fakeFile(100), { pageCount: 3 });
    for (let i = 0; i < 30; i += 1) await doc.commit(fakeBytes(300, i), `P${i}`, "operation", { pageCount: 3 });
    const total = doc.getState().document!.snapshots.reduce((n, s) => n + s.byteLength, 0);
    expect(total).toBeLessThanOrEqual(1_000);
  });
});

describe("dirty / markSaved", () => {
  it("markSaved deja el documento limpio y deshacer/rehacer vuelve a ensuciarlo", async () => {
    const doc = await opened();
    await doc.commit(fakeBytes(10), "A", "operation", { pageCount: 3 });
    expect(doc.dirty).toBe(true);
    doc.markSaved();
    expect(doc.dirty).toBe(false);
    await doc.commit(fakeBytes(10), "B", "operation", { pageCount: 3 });
    expect(doc.dirty).toBe(true);
    doc.undo();
    expect(doc.dirty).toBe(false); // vuelve al paso guardado
    doc.undo();
    expect(doc.dirty).toBe(true); // el original ya no es el guardado
  });

  it("deshacer hasta el original deja limpio un documento recien abierto", async () => {
    const doc = await opened();
    await doc.commit(fakeBytes(10), "A", "operation", { pageCount: 3 });
    doc.undo();
    expect(doc.dirty).toBe(false);
  });

  it("si el paso guardado se descarto por el presupuesto, el documento sigue sucio hasta guardar de nuevo", async () => {
    const doc = fakeDoc({ maxSnapshots: 2 });
    await doc.open(fakeFile(), { pageCount: 3 });
    await doc.commit(fakeBytes(10), "A", "operation", { pageCount: 3 });
    doc.markSaved();
    await doc.commit(fakeBytes(10), "B", "operation", { pageCount: 3 }); // descarta A (guardado)
    doc.undo();
    expect(doc.getState().document?.snapshots[0].label).toBe("Original");
    expect(doc.dirty).toBe(true);
  });

  it("markSaved sin documento o sin cambios no notifica", async () => {
    const doc = fakeDoc();
    const listener = vi.fn();
    doc.subscribe(listener);
    doc.markSaved();
    expect(listener).not.toHaveBeenCalled();
    await doc.open(fakeFile());
    listener.mockClear();
    doc.markSaved();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("currentFile y bytes inmutables", () => {
  it("currentFile devuelve un File PDF con el nombre del documento y los bytes del paso actual", async () => {
    const doc = fakeDoc();
    await doc.open(fakeFile(30, "informe.pdf"), { pageCount: 3 });
    await doc.commit(fakeBytes(44, 9), "A", "operation", { pageCount: 3 });
    const file = doc.currentFile()!;
    expect(file.name).toBe("informe.pdf");
    expect(file.type).toBe("application/pdf");
    expect(file.size).toBe(44);
    doc.undo();
    expect(doc.currentFile()!.size).toBe(30);
  });

  it("devuelve el mismo File mientras no cambie el snapshot", async () => {
    const doc = await opened();
    expect(doc.currentFile()).toBe(doc.currentFile());
  });

  it("sin documento, current() y currentFile() son null", () => {
    const doc = fakeDoc();
    expect(doc.current()).toBeNull();
    expect(doc.currentFile()).toBeNull();
    expect(doc.currentSnapshot()).toBeNull();
  });

  it("los snapshots anteriores no cambian al confirmar uno nuevo (inmutables)", async () => {
    const doc = await opened();
    const original = doc.getState().document!.snapshots[0];
    const before = Array.from(original.bytes);
    await doc.commit(fakeBytes(64, 5), "A", "operation", { pageCount: 3 });
    expect(doc.getState().document!.snapshots[0]).toBe(original);
    expect(Array.from(original.bytes)).toEqual(before);
  });
});

describe("suscripcion", () => {
  it("getState devuelve la MISMA referencia mientras nada cambia", async () => {
    const doc = await opened();
    expect(doc.getState()).toBe(doc.getState());
  });

  it("cada cambio produce un estado nuevo y avisa a los suscritos una sola vez", async () => {
    const doc = await opened();
    const listener = vi.fn();
    const stop = doc.subscribe(listener);
    const before = doc.getState();
    await doc.commit(fakeBytes(10), "A", "operation", { pageCount: 3 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(doc.getState()).not.toBe(before);
    stop();
    doc.undo();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("close suelta los bytes y deja el estado vacio", async () => {
    const doc = await opened();
    await doc.commit(fakeBytes(10), "A", "operation", { pageCount: 3 });
    doc.close();
    const state = doc.getState();
    expect(state.document).toBeNull();
    expect(state.dirty).toBe(false);
    expect(state.canUndo).toBe(false);
    expect(state.pageCount).toBe(0);
    expect(doc.current()).toBeNull();
    expect(state.announcement?.text).toBe("Documento cerrado");
  });

  it("announce publica un texto arbitrario con id creciente", async () => {
    const doc = fakeDoc();
    doc.announce("Hola");
    const first = doc.getState().announcement!;
    doc.announce("Hola");
    expect(doc.getState().announcement!.id).toBeGreaterThan(first.id);
    expect(first.text).toBe("Hola");
  });

  it("los anuncios salen en ingles tras setLanguage('en')", async () => {
    const doc = fakeDoc();
    doc.setLanguage("en");
    await doc.open(fakeFile(8, "x.pdf"));
    expect(doc.getState().announcement?.text).toBe("Document opened: x.pdf");
    await doc.commit(fakeBytes(10), "Rotate", "operation", { pageCount: 3 });
    doc.undo();
    expect(doc.getState().announcement?.text).toBe("Undone: Rotate");
  });
});

describe("modos con sesion propia (registerMode)", () => {
  it("registerMode marca el modo activo y lo retira al soltar", () => {
    const doc = fakeDoc();
    const release = doc.registerMode("edit", { hasOwnUndo: true });
    expect(doc.getState().activeModes).toEqual(["edit"]);
    expect(doc.getState().ownUndoActive).toBe(true);
    expect(doc.isOwnUndoActive()).toBe(true);
    release();
    expect(doc.getState().activeModes).toEqual([]);
    expect(doc.getState().ownUndoActive).toBe(false);
  });

  it("un modo SIN deshacer propio no bloquea el global", () => {
    const doc = fakeDoc();
    doc.registerMode("annotate", { hasOwnUndo: false });
    expect(doc.getState().activeModes).toEqual(["annotate"]);
    expect(doc.getState().ownUndoActive).toBe(false);
  });

  it("varios modos: el global queda bloqueado mientras quede alguno con deshacer propio", () => {
    const doc = fakeDoc();
    const a = doc.registerMode("edit", { hasOwnUndo: true });
    const b = doc.registerMode("sign", { hasOwnUndo: true });
    a();
    expect(doc.isOwnUndoActive()).toBe(true);
    b();
    expect(doc.isOwnUndoActive()).toBe(false);
  });

  it("soltar dos veces es inofensivo, y el mismo modo registrado dos veces cuenta dos", () => {
    const doc = fakeDoc();
    const first = doc.registerMode("fill", { hasOwnUndo: true });
    const second = doc.registerMode("fill", { hasOwnUndo: true });
    first();
    first();
    expect(doc.getState().activeModes).toEqual(["fill"]);
    second();
    expect(doc.getState().activeModes).toEqual([]);
  });

  it("los modos sobreviven a abrir otro documento (son de la interfaz, no del documento)", async () => {
    const doc = fakeDoc();
    doc.registerMode("crop", { hasOwnUndo: true });
    await doc.open(fakeFile());
    expect(doc.getState().activeModes).toEqual(["crop"]);
  });
});

describe("instancias", () => {
  it("cada documento de trabajo es independiente", async () => {
    const a = new ProWorkingDoc({ countPages: async () => 1, fingerprint: async () => null, inspectSignatures: async () => "none" });
    const b = new ProWorkingDoc({ countPages: async () => 1, fingerprint: async () => null, inspectSignatures: async () => "none" });
    await a.open(fakeFile(10, "a.pdf"));
    expect(b.getState().document).toBeNull();
    expect(a.getState().document?.name).toBe("a.pdf");
  });
});

describe("groupRepeatedLabels", () => {
  it("agrupa solo vecinas iguales y conserva el orden", () => {
    expect(groupRepeatedLabels(["Rotar", "Rotar", "Rotar", "Recortar", "Rotar"])).toEqual(["Rotar ×3", "Recortar", "Rotar"]);
    expect(groupRepeatedLabels([])).toEqual([]);
    expect(groupRepeatedLabels(["A"])).toEqual(["A"]);
    expect(groupRepeatedLabels(["A", "A"])).toEqual(["A ×2"]);
  });
});

describe("announce con mergeWithinMs", () => {
  function clocked() {
    let time = 1_000;
    const doc = fakeDoc({ now: () => time });
    return { doc, advance: (ms: number) => (time += ms) };
  }
  const text = (doc: ReturnType<typeof fakeDoc>) => doc.getState().announcement?.text;

  it("sin la opcion cada anuncio pisa al anterior (como siempre)", () => {
    const { doc } = clocked();
    doc.announce("uno");
    doc.announce("dos");
    expect(text(doc)).toBe("dos");
  });

  it("con la opcion, un anuncio pegado al anterior se suma y uno tardio lo pisa", () => {
    const { doc, advance } = clocked();
    doc.announce("uno");
    advance(300);
    doc.announce("dos", { mergeWithinMs: 1000 });
    expect(text(doc)).toBe("uno dos");
    advance(300);
    doc.announce("tres", { mergeWithinMs: 1000 });
    expect(text(doc)).toBe("uno dos tres");
    advance(5000);
    doc.announce("cuatro", { mergeWithinMs: 1000 });
    expect(text(doc)).toBe("cuatro");
  });

  it("no se suma a un anuncio que NO hizo `announce` (abrir, aplicar, deshacer): ese manda", async () => {
    const { doc, advance } = clocked();
    await doc.open(fakeFile(100), { pageCount: 3 });
    const opened = text(doc);
    advance(100);
    doc.announce("aviso del modo", { mergeWithinMs: 1000 });
    expect(text(doc)).toBe("aviso del modo");
    expect(text(doc)).not.toContain(opened ?? "?");
  });

  it("cada anuncio sumado es un anuncio nuevo (id distinto) para que la region vuelva a leerse", () => {
    const { doc } = clocked();
    doc.announce("uno");
    const first = doc.getState().announcement!.id;
    doc.announce("dos", { mergeWithinMs: 1000 });
    expect(doc.getState().announcement!.id).toBeGreaterThan(first);
  });
});
