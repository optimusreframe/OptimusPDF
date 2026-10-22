import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_VAULT_ENTRIES,
  clearVault,
  listVault,
  saveVaultEntry,
  type VaultEntry,
} from "@/app/sign-pdf/signVault";
import { makeImage, vaultInput } from "@/app/sign-pdf/vaultTestUtils";
import type { PreparedInk } from "@/app/sign-pdf/inkImportModel";
import {
  entryHas,
  executeSave,
  existingImageUrl,
  hasConflict,
  planSave,
  type SavePlanInput,
} from "@/app/extract-assets/saveModel";

/**
 * Guardado desde el Extractor: tipo (firma / iniciales) + firmante (existente o nuevo), con la regla «una entrada = un
 * firmante con firma e iniciales», el reemplazo ATOMICO y los limites del baul. IndexedDB falso (`fake-indexeddb`).
 */

beforeEach(async () => {
  await clearVault();
});

const ink = (seed: number): PreparedInk => {
  const image = makeImage({ seed, width: 60, height: 30 });
  return { png: image.png, width: image.width, height: image.height };
};

function entry(extra: Partial<VaultEntry> & { signerName: string }): VaultEntry {
  const image = makeImage({ seed: 1 });
  return {
    id: `vault-${extra.signerName}`,
    schema: 1,
    signerKey: extra.signerName.toLowerCase(),
    sourceDocument: "",
    createdAt: "2026-10-01T10:00:00.000Z",
    lastUsedAt: "2026-10-02T10:00:00.000Z",
    signature: image,
    initials: null,
    ...extra,
  } as VaultEntry;
}

function input(partial: Partial<SavePlanInput> = {}): SavePlanInput {
  return { entries: [], choice: { kind: "new" }, kind: "signature", conflict: null, name: "Ana Pérez", role: "", ink: ink(7), sourceDocument: "contrato.pdf", ...partial };
}

describe("planSave · firmante nuevo", () => {
  it("firma de un firmante nuevo: origin «extracted» y el documento SOLO en su campo", () => {
    const plan = planSave(input({ role: " Ajustadora " }));
    expect(plan.action).toBe("save");
    if (plan.action !== "save") return;
    expect(plan.completes).toBeNull();
    expect(plan.input).toMatchObject({ signerName: "Ana Pérez", role: "Ajustadora", origin: "extracted", sourceDocument: "contrato.pdf", initials: null });
    expect(plan.input.signature).not.toBeNull();
  });
  it("iniciales: la imagen va en `initials`", () => {
    const plan = planSave(input({ kind: "initials" }));
    expect(plan.action === "save" && plan.input.initials !== null && plan.input.signature === null).toBe(true);
  });
  it("sin nombre o con solo espacios: «nameNeeded»", () => {
    expect(planSave(input({ name: "" }))).toEqual({ action: "error", reason: "nameNeeded" });
    expect(planSave(input({ name: "   " }))).toEqual({ action: "error", reason: "nameNeeded" });
  });
  it("un nombre que ya esta en el baul (sin acentos ni mayusculas) se rechaza: «nameTaken»", () => {
    const entries = [entry({ signerName: "Ana Pérez", signerKey: "ana perez" })];
    expect(planSave(input({ entries, name: "ANA   perez" }))).toEqual({ action: "error", reason: "nameTaken" });
    expect(planSave(input({ entries, name: "Beatriz" })).action).toBe("save");
  });
  it("una imagen que no cabe (no es un PNG del baul) es «invalid»", () => {
    expect(planSave(input({ ink: { png: new Uint8Array([1, 2, 3]), width: 1, height: 1 } }))).toEqual({ action: "error", reason: "invalid" });
  });
});

describe("planSave · firmante existente", () => {
  const ana = entry({ signerName: "Ana Pérez", signerKey: "ana perez", role: "Ajustadora", initials: null });
  it("completar: la misma entrada con la imagen nueva junto a la que ya tenia (nombre y cargo del existente)", () => {
    const plan = planSave(input({ entries: [ana], choice: { kind: "existing", id: ana.id }, kind: "initials", name: "ignorado", role: "ignorado" }));
    expect(plan.action).toBe("save");
    if (plan.action !== "save") return;
    expect(plan.completes).toBe(ana);
    expect(plan.input.signerName).toBe("Ana Pérez");
    expect(plan.input.role).toBe("Ajustadora");
    expect(plan.input.signature?.png).toEqual(ana.signature!.png);
    expect(plan.input.initials).not.toBeNull();
    expect(plan.input.origin).toBe("extracted");
  });
  it("mismo tipo y sin elegir que hacer: «conflictNeeded»", () => {
    expect(planSave(input({ entries: [ana], choice: { kind: "existing", id: ana.id } }))).toEqual({ action: "error", reason: "conflictNeeded" });
  });
  it("reemplazar: conserva id, fecha de creacion, cargo y la otra imagen; cambia la imagen del tipo", () => {
    const both = entry({ signerName: "Ana Pérez", signerKey: "ana perez", initials: makeImage({ seed: 5 }) });
    const plan = planSave(input({ entries: [both], choice: { kind: "existing", id: both.id }, conflict: "replace" }), () => "2026-11-01T00:00:00.000Z");
    expect(plan.action).toBe("replace");
    if (plan.action !== "replace") return;
    expect(plan.merged.id).toBe(both.id);
    expect(plan.merged.createdAt).toBe(both.createdAt);
    expect(plan.merged.lastUsedAt).toBe("2026-11-01T00:00:00.000Z");
    expect(plan.merged.signature!.png).not.toEqual(both.signature!.png);
    expect(plan.merged.initials).toEqual(both.initials);
    expect(plan.merged.origin).toBe("extracted");
    expect(plan.merged.sourceDocument).toBe("contrato.pdf");
  });
  it("reemplazar sin documento de origen conserva el que ya tenia", () => {
    const old = entry({ signerName: "Ana Pérez", signerKey: "ana perez", sourceDocument: "viejo.pdf" });
    const plan = planSave(input({ entries: [old], choice: { kind: "existing", id: old.id }, conflict: "replace", sourceDocument: "" }));
    expect(plan.action === "replace" && plan.merged.sourceDocument).toBe("viejo.pdf");
  });
  it("«otro firmante» pide nombre y distinto del existente", () => {
    const base = { entries: [ana], choice: { kind: "existing" as const, id: ana.id }, conflict: "other" as const };
    expect(planSave(input({ ...base, name: "" }))).toEqual({ action: "error", reason: "nameNeeded" });
    expect(planSave(input({ ...base, name: "ana perez" }))).toEqual({ action: "error", reason: "nameTaken" });
    const ok = planSave(input({ ...base, name: "Beatriz Ruiz", role: "Perito" }));
    expect(ok.action === "save" && ok.completes === null && ok.input.signerName === "Beatriz Ruiz" && ok.input.role === "Perito").toBe(true);
  });
  it("un id que ya no existe: «notFound»", () => {
    expect(planSave(input({ entries: [ana], choice: { kind: "existing", id: "vault-fantasma" } }))).toEqual({ action: "error", reason: "notFound" });
  });
  it("hasConflict / entryHas", () => {
    expect(hasConflict(ana, "signature")).toBe(true);
    expect(hasConflict(ana, "initials")).toBe(false);
    expect(hasConflict(undefined, "signature")).toBe(false);
    expect(entryHas(ana, "initials")).toBe(false);
  });
  it("existingImageUrl da un data URL PNG solo si hay imagen de ese tipo", () => {
    expect(existingImageUrl(ana, "signature")).toMatch(/^data:image\/png;base64,/);
    expect(existingImageUrl(ana, "initials")).toBeNull();
  });
});

describe("executeSave sobre el baul real", () => {
  async function save(overrides: Partial<SavePlanInput>) {
    const { entries } = await listVault();
    const plan = planSave(input({ entries, ...overrides }));
    if (plan.action === "error") throw new Error(`plan: ${plan.reason}`);
    return executeSave(plan);
  }

  it("firma nueva; luego iniciales al mismo firmante: UNA entrada con las dos (mismo id)", async () => {
    expect(await save({ role: "Perito" })).toEqual({ ok: true, entryName: "Ana Pérez", kind: "new" });
    const first = (await listVault()).entries[0];
    const done = await save({ choice: { kind: "existing", id: first.id }, kind: "initials", ink: ink(9) });
    expect(done).toEqual({ ok: true, entryName: "Ana Pérez", kind: "completed" });
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(first.id);
    expect(entries[0].signature).not.toBeNull();
    expect(entries[0].initials).not.toBeNull();
    expect(entries[0].role).toBe("Perito");
    expect(entries[0].origin).toBe("extracted");
    expect(entries[0].sourceDocument).toBe("contrato.pdf");
  });

  it("guardar la MISMA imagen otra vez no duplica", async () => {
    await save({});
    const { entries } = await listVault();
    const again = await save({ choice: { kind: "existing", id: entries[0].id }, conflict: "replace" });
    expect(again.ok).toBe(true);
    expect((await listVault()).entries).toHaveLength(1);
  });

  it("reemplazar cambia la imagen en la misma entrada y deja intacta la otra", async () => {
    await save({});
    const first = (await listVault()).entries[0];
    await save({ choice: { kind: "existing", id: first.id }, kind: "initials", ink: ink(2) });
    const before = (await listVault()).entries[0];
    const replaced = await save({ choice: { kind: "existing", id: first.id }, conflict: "replace", ink: ink(3) });
    expect(replaced).toEqual({ ok: true, entryName: "Ana Pérez", kind: "replaced" });
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(first.id);
    expect(entries[0].signature!.png).not.toEqual(before.signature!.png);
    expect(entries[0].initials!.png).toEqual(before.initials!.png);
  });

  it("reemplazar es todo o nada: si otra pestana cambio la entrada, no escribe y dice «changed»", async () => {
    await save({});
    const stale = (await listVault()).entries[0];
    const plan = planSave(input({ entries: [stale], choice: { kind: "existing", id: stale.id }, conflict: "replace", ink: ink(4) }));
    if (plan.action !== "replace") throw new Error("plan");
    // Otra pestana la cambia mientras se decidia.
    await saveVaultEntry(vaultInput("Ana Pérez", { role: "", sourceDocument: "", initials: makeImage({ seed: 11 }), signature: stale.signature }));
    const result = await executeSave(plan);
    expect(result).toEqual({ ok: false, reason: "changed" });
    const { entries } = await listVault();
    expect(entries).toHaveLength(1);
    expect(entries[0].signature!.png).toEqual(stale.signature!.png);
  });

  it("como otro firmante: dos entradas, la primera intacta", async () => {
    await save({});
    const first = (await listVault()).entries[0];
    await save({ choice: { kind: "existing", id: first.id }, conflict: "other", name: "Beatriz Ruiz", ink: ink(8) });
    const { entries } = await listVault();
    expect(entries.map((e) => e.signerName).sort()).toEqual(["Ana Pérez", "Beatriz Ruiz"]);
    expect(entries.find((e) => e.signerName === "Ana Pérez")!.signature!.png).toEqual(first.signature!.png);
  });

  it(`con ${MAX_VAULT_ENTRIES} firmas, un firmante nuevo da «limit»; completar o reemplazar uno que ya esta, no`, async () => {
    for (let index = 0; index < MAX_VAULT_ENTRIES; index += 1) {
      const result = await saveVaultEntry(vaultInput(`Firmante ${index}`, { signature: makeImage({ seed: 100 + index }), initials: null }));
      expect(result.ok).toBe(true);
    }
    expect(await save({ name: "Uno Más" })).toEqual({ ok: false, reason: "limit" });
    expect((await listVault()).entries).toHaveLength(MAX_VAULT_ENTRIES);
    const target = (await listVault()).entries[0];
    expect(await save({ choice: { kind: "existing", id: target.id }, kind: "initials", ink: ink(40) })).toMatchObject({ ok: true, kind: "completed" });
    expect(await save({ choice: { kind: "existing", id: target.id }, kind: "signature", conflict: "replace", ink: ink(41) })).toMatchObject({ ok: true, kind: "replaced" });
    expect((await listVault()).entries).toHaveLength(MAX_VAULT_ENTRIES);
  });
});
