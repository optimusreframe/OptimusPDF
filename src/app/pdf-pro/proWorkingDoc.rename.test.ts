import { describe, expect, it, vi } from "vitest";
import { fakeBytes, fakeDoc, fakeFile } from "@/app/pdf-pro/proTestUtils";

describe("ProWorkingDoc.rename («Guardar como…»)", () => {
  async function opened() {
    const doc = fakeDoc();
    await doc.open(fakeFile(64, "informe.pdf"), { pageCount: 3 });
    return doc;
  }

  it("cambia el nombre y marca el documento como renombrado", async () => {
    const doc = await opened();
    expect(doc.rename("Contrato.pdf")).toBe(true);
    expect(doc.getState().document).toMatchObject({ name: "Contrato.pdf", renamed: true });
  });

  it("recorta espacios", async () => {
    const doc = await opened();
    doc.rename("   Acta   ");
    expect(doc.getState().document?.name).toBe("Acta");
  });

  it("un nombre vacio se rechaza y no cambia nada", async () => {
    const doc = await opened();
    expect(doc.rename("   ")).toBe(false);
    expect(doc.getState().document).toMatchObject({ name: "informe.pdf" });
    expect(doc.getState().document?.renamed).toBeUndefined();
  });

  it("sin documento devuelve false", () => {
    expect(fakeDoc().rename("x.pdf")).toBe(false);
  });

  it("NO crea snapshot, no toca el historial ni el estado guardado", async () => {
    const doc = await opened();
    await doc.commit(fakeBytes(10), "Rotar", "operation", { pageCount: 3 });
    const before = doc.getState().document!;
    doc.rename("Otro.pdf");
    const after = doc.getState().document!;
    expect(after.snapshots).toBe(before.snapshots);
    expect(after.cursor).toBe(before.cursor);
    expect(after.savedSnapshotId).toBe(before.savedSnapshotId);
    expect(doc.getState().dirty).toBe(true);
  });

  it("avisa a los suscritos (el titulo de la barra y el borrador lo leen)", async () => {
    const doc = await opened();
    const listener = vi.fn();
    doc.subscribe(listener);
    doc.rename("Nuevo.pdf");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("el mismo nombre no notifica de mas pero sigue siendo valido", async () => {
    const doc = await opened();
    const listener = vi.fn();
    doc.subscribe(listener);
    expect(doc.rename("informe.pdf")).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it("el `File` que ven los motores toma el nombre nuevo", async () => {
    const doc = await opened();
    const first = doc.currentFile()!;
    doc.rename("Nuevo.pdf");
    const second = doc.currentFile()!;
    expect(first.name).toBe("informe.pdf");
    expect(second.name).toBe("Nuevo.pdf");
  });

  it("abrir otro documento borra la marca de renombrado", async () => {
    const doc = await opened();
    doc.rename("Nuevo.pdf");
    await doc.open(fakeFile(64, "otro.pdf"), { pageCount: 3 });
    expect(doc.getState().document).toMatchObject({ name: "otro.pdf" });
    expect(doc.getState().document?.renamed).toBeUndefined();
  });
});
