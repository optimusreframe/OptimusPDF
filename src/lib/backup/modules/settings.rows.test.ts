import { describe, expect, it } from "vitest";
import { buildPackage, readPackage } from "@/lib/backup/package";
import {
  applySettingsImport,
  countSettingWrites,
  defaultSettingsDecisions,
  exportSettings,
  planSettingsImport,
  settingsModuleFromValues,
  settingsRows,
  type SettingsDecisions,
  type SettingsImportPlan,
} from "@/lib/backup/modules/settings";
import { SENSITIVE_SIGN_FLAGS } from "@/lib/backup/settingsRegistry";
import { MemoryStorage } from "@/lib/backup/__fixtures__/memoryStorage";
import { asFile } from "@/lib/backup/__fixtures__/testKit";

/**
 * H8 (verificación independiente): la vista previa de Ajustes solo mostraba recuentos y dejaba «Reemplazar» preseleccionado.
 * Ahora la lógica da una FILA por ajuste que cambiaría (clave, valor de ahora, valor del paquete, si es sensible), las
 * decisiones se pueden tomar por ajuste o para todos, y lo que afecta a la privacidad se OMITE por defecto.
 */

const FLAGS_KEY = "optimuspdf.signPdf.featureFlags";
const NOTICE_KEY = "optimuspdf.sign-pdf.privacyNoticeSeen";

function fill(values: Record<string, string>): MemoryStorage {
  const storage = new MemoryStorage();
  for (const [key, value] of Object.entries(values)) storage.setItem(key, value);
  storage.writes.length = 0;
  return storage;
}

async function planOf(packaged: Record<string, string>, local: Record<string, string> = {}): Promise<{ plan: SettingsImportPlan; target: MemoryStorage }> {
  const source = fill(packaged);
  const blob = await buildPackage({ modules: [await exportSettings({ storage: source })] });
  const target = fill(local);
  return { plan: planSettingsImport(await readPackage(asFile(blob)), { storage: target }), target };
}

const stored = (storage: MemoryStorage, key: string) => JSON.parse(storage.getItem(key) as string);

describe("H8 — filas de la vista previa", () => {
  it("una fila por interruptor que cambia de un ajuste de objeto; los iguales no salen", async () => {
    const { plan } = await planOf(
      { [FLAGS_KEY]: JSON.stringify({ keyboardNav: false, pinchZoom: true, signatureVault: false }) },
      { [FLAGS_KEY]: JSON.stringify({ keyboardNav: true, pinchZoom: true, signatureVault: true }) },
    );
    const rows = settingsRows(plan);
    expect(rows.map((r) => [r.id, r.status, r.local, r.value, r.sensitive])).toEqual([
      [`${FLAGS_KEY}#keyboardNav`, "different", true, false, false],
      [`${FLAGS_KEY}#signatureVault`, "different", true, false, true],
    ]);
    expect(rows[0]).toMatchObject({ key: FLAGS_KEY, flag: "keyboardNav", group: "sign", localStored: true });
  });

  it("sin nada guardado, el valor «de ahora» es el de por defecto y solo salen los que difieren de él", async () => {
    // por defecto: keyboardNav true, completionCertificate false
    const { plan } = await planOf({ [FLAGS_KEY]: JSON.stringify({ keyboardNav: true, completionCertificate: true }) });
    expect(plan.counts.new).toBe(1);
    const rows = settingsRows(plan);
    expect(rows.map((r) => [r.id, r.status, r.local, r.localStored, r.value])).toEqual([[`${FLAGS_KEY}#completionCertificate`, "new", false, false, true]]);
  });

  it("tema, idioma y avisos: una fila por clave; los avisos de privacidad son sensibles", async () => {
    const { plan } = await planOf({ "optimuspdf.theme": "dark", "optimuspdf.language": "en", [NOTICE_KEY]: "1" }, { "optimuspdf.theme": "light" });
    const rows = settingsRows(plan);
    expect(rows.map((r) => [r.id, r.status, r.local, r.value, r.sensitive])).toEqual([
      ["optimuspdf.theme", "different", "light", "dark", false],
      ["optimuspdf.language", "new", "es", "en", false],
      [NOTICE_KEY, "new", false, true, true],
    ]);
  });

  it("los sensibles de Firmar son exactamente guardar firmas y los trazos del borrador", () => {
    expect([...SENSITIVE_SIGN_FLAGS].sort()).toEqual(["signatureVault", "signaturesInDraft"]);
  });

  it("lo idéntico no tiene filas", async () => {
    const { plan } = await planOf({ "optimuspdf.theme": "dark" }, { "optimuspdf.theme": "dark" });
    expect(settingsRows(plan)).toEqual([]);
  });
});

describe("H8 — por defecto, lo sensible se omite", () => {
  it("defaultSettingsDecisions marca «omit» SOLO en las filas sensibles; el resto sigue al «Reemplazar» general", async () => {
    const { plan } = await planOf(
      { "optimuspdf.theme": "dark", [NOTICE_KEY]: "1", [FLAGS_KEY]: JSON.stringify({ keyboardNav: false, signatureVault: false, signaturesInDraft: false }) },
    );
    expect(defaultSettingsDecisions(plan)).toEqual({
      settings: "replace",
      valueHistory: "omit",
      rows: { [NOTICE_KEY]: "omit", [`${FLAGS_KEY}#signatureVault`]: "omit", [`${FLAGS_KEY}#signaturesInDraft`]: "omit" },
    });
  });

  it("aplicar con las sugeridas escribe lo no sensible (los interruptores sueltos se FUSIONAN con lo de ahora) y no toca lo sensible", async () => {
    const { plan, target } = await planOf(
      { "optimuspdf.theme": "dark", [NOTICE_KEY]: "1", [FLAGS_KEY]: JSON.stringify({ keyboardNav: false, signatureVault: false }) },
      { [FLAGS_KEY]: JSON.stringify({ keyboardNav: true, signatureVault: true, pinchZoom: false }) },
    );
    const result = await applySettingsImport(plan, defaultSettingsDecisions(plan), { storage: target });
    expect(result).toMatchObject({ ok: true, written: 2 });
    expect(target.getItem("optimuspdf.theme")).toBe("dark");
    expect(target.getItem(NOTICE_KEY)).toBeNull();
    // keyboardNav cambia; signatureVault (sensible) se queda como estaba; pinchZoom (que el paquete no trae) se conserva
    expect(stored(target, FLAGS_KEY)).toEqual({ keyboardNav: false, signatureVault: true, pinchZoom: false });
  });

  it("si TODAS las filas de un ajuste se omiten no se escribe ese ajuste ni su versión", async () => {
    const { plan, target } = await planOf({ [FLAGS_KEY]: JSON.stringify({ signatureVault: false }) });
    const result = await applySettingsImport(plan, defaultSettingsDecisions(plan), { storage: target });
    expect(result).toMatchObject({ ok: true, written: 0, reloadRequired: false });
    expect(target.writes).toEqual([]);
  });
});

describe("H8 — decidir por ajuste o todo", () => {
  async function mixed() {
    return planOf(
      { "optimuspdf.theme": "dark", "optimuspdf.language": "en", [FLAGS_KEY]: JSON.stringify({ keyboardNav: false, signatureVault: false }) },
      { "optimuspdf.theme": "light" },
    );
  }

  it("«Reemplazar todos» (sin filas) escribe también lo sensible", async () => {
    const { plan, target } = await mixed();
    expect(await applySettingsImport(plan, { settings: "replace" }, { storage: target })).toMatchObject({ ok: true, written: 3 });
    expect(stored(target, FLAGS_KEY)).toEqual({ keyboardNav: false, signatureVault: false });
  });

  it("«Omitir todos» no escribe nada", async () => {
    const { plan, target } = await mixed();
    expect(await applySettingsImport(plan, { settings: "omit" }, { storage: target })).toMatchObject({ ok: true, written: 0 });
    expect(target.writes).toEqual([]);
  });

  it("una fila decide aparte: omitir solo el tema, o reemplazar solo un interruptor sensible", async () => {
    const { plan, target } = await mixed();
    const decisions: SettingsDecisions = { settings: "replace", rows: { "optimuspdf.theme": "omit" } };
    expect(countSettingWrites(plan, decisions)).toBe(2);
    await applySettingsImport(plan, decisions, { storage: target });
    expect(target.getItem("optimuspdf.theme")).toBe("light");
    expect(target.getItem("optimuspdf.language")).toBe("en");

    const only = await mixed();
    const onlyVault: SettingsDecisions = { settings: "omit", rows: { [`${FLAGS_KEY}#signatureVault`]: "replace" } };
    expect(countSettingWrites(only.plan, onlyVault)).toBe(1);
    await applySettingsImport(only.plan, onlyVault, { storage: only.target });
    expect(stored(only.target, FLAGS_KEY)).toEqual({ signatureVault: false });
    expect(only.target.getItem("optimuspdf.language")).toBeNull();
  });

  it("countSettingWrites cuenta ajustes (claves) escritos, no filas", async () => {
    const { plan } = await mixed();
    expect(countSettingWrites(plan, { settings: "replace" })).toBe(3);
    expect(countSettingWrites(plan, { settings: "omit" })).toBe(0);
    expect(countSettingWrites(plan, { settings: "replace", rows: { [`${FLAGS_KEY}#keyboardNav`]: "omit", [`${FLAGS_KEY}#signatureVault`]: "omit" } })).toBe(2);
  });

  it("decisiones manipuladas (ids inventados, valores raros) no escriben nada fuera de la lista ni cuelan valores", async () => {
    const { plan, target } = await mixed();
    const tampered = { settings: "replace", rows: { evil: "replace", "__proto__": "replace", [`${FLAGS_KEY}#keyboardNav`]: "banana" } } as unknown as SettingsDecisions;
    const result = await applySettingsImport(plan, tampered, { storage: target });
    expect(result).toMatchObject({ ok: true, written: 3 });
    for (const key of target.keys()) expect(["optimuspdf.theme", "optimuspdf.language", FLAGS_KEY, "optimuspdf.signPdf.featureFlags.v"]).toContain(key);
  });

  it("un plan al que le cambian un valor a algo inválido se rechaza (revalidación) aunque las filas digan Reemplazar", async () => {
    const { plan, target } = await mixed();
    const item = plan.items.find((i) => i.key === FLAGS_KEY)!;
    (item as { value: unknown }).value = { keyboardNav: "sí", signatureVault: false };
    expect(await applySettingsImport(plan, { settings: "replace" }, { storage: target })).toEqual({ ok: false, reason: "invalid" });
    expect(target.writes).toEqual([]);
  });

  it("si otra pestaña cambió la clave desde la vista previa, `changed` y nada escrito (también con elección parcial)", async () => {
    const { plan, target } = await mixed();
    target.setItem("optimuspdf.theme", "system");
    target.writes.length = 0;
    expect(await applySettingsImport(plan, { settings: "replace" }, { storage: target })).toEqual({ ok: false, reason: "changed" });
    expect(target.writes).toEqual([]);
  });

  it("settingsModuleFromValues sigue siendo puro (sin filas ni decisiones)", () => {
    expect(settingsModuleFromValues({ "optimuspdf.theme": "dark" }).meta).toEqual({ count: 1, includesValueHistory: false });
  });
});
