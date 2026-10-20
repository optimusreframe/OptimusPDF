import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/crypto/sha256";
import { clearLibrary, listDocuments } from "@/lib/docLibrary/store";
import { listTemplates } from "@/lib/docLibrary/templatesStore";
import { buildPackage, readPackage, PackageError } from "@/lib/backup/package";
import { DEFAULT_MODULE_REGISTRY } from "@/lib/backup/registry";
import {
  applyLibraryImport,
  defaultLibraryDecisions,
  exportLibraryWithReport,
  loadLibraryExisting,
  planLibraryImport,
  type LibraryPlan,
} from "@/lib/backup/modules/library";
import { hostileCorpus } from "@/lib/backup/__fixtures__/hostileCorpus";
import { forgeZip } from "@/lib/backup/__fixtures__/zipForge";
import { countWrites, fakePdf, fingerprintOf, freshLibrary, seedDoc, seedTemplate } from "@/lib/backup/__fixtures__/libraryKit";
import { editManifest, rewriteZip, timed } from "@/lib/backup/__fixtures__/testKit";
import type { PackageFileInput, PackageModuleInput, ModuleRegistry } from "@/lib/backup/types";

/**
 * Corpus de zips HOSTILES específico del módulo «library»: cada uno se arma con un paquete bueno al que se le rompe UNA
 * cosa, y tiene que (1) aislar o rechazar lo malo, (2) no escribir lo malo, (3) no tocar la biblioteca que ya había y
 * (4) tardar < 2 s en leerse, planificarse y aplicarse.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytesOf = (value: unknown) => new Uint8Array(enc.encode(typeof value === "string" ? value : JSON.stringify(value)));

beforeEach(() => {
  freshLibrary();
});

/** Un módulo bueno: un documento «bueno» con su plantilla. Cada caso lo retoca antes de empaquetarlo. */
async function goodModule(): Promise<PackageModuleInput> {
  await seedDoc("bueno", 1, { name: "Bueno" });
  await seedTemplate("bueno", {}, "tpl-bueno");
  const { module: mod } = await exportLibraryWithReport();
  await clearLibrary();
  return mod;
}

const fileOf = (mod: PackageModuleInput, path: string): PackageFileInput => {
  const file = mod.files.find((f) => f.path === path);
  if (!file) throw new Error(`sin ${path}`);
  return file;
};
const jsonOf = (mod: PackageModuleInput, path: string) => JSON.parse(dec.decode(fileOf(mod, path).data));
function setJson(mod: PackageModuleInput, path: string, value: unknown) {
  const file = fileOf(mod, path);
  file.data = bytesOf(value);
}

type Outcome = { plan: LibraryPlan; result: Awaited<ReturnType<typeof applyLibraryImport>> };

/** Lee, planifica y aplica con las decisiones por defecto, midiendo el tiempo y las escrituras. */
async function run(blob: Blob, options: { guard?: boolean; existing?: boolean } = {}): Promise<Outcome & { writes: number }> {
  const { result, writes } = await countWrites(() =>
    timed(async () => {
      const read = await readPackage(blob);
      const plan = await planLibraryImport(read, await loadLibraryExisting(), {
        validatePdf: options.guard === false ? undefined : async (bytes) => bytes.length > 0,
      });
      const applied = await applyLibraryImport(plan, defaultLibraryDecisions(plan));
      return { plan, result: applied };
    }),
  );
  return { ...result, writes };
}

const pack = (mod: PackageModuleInput, registry?: ModuleRegistry) => buildPackage({ modules: [mod], registry });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

describe("PDF y huella", () => {
  it("un PDF falso (sin %PDF-, con el SHA-256 declarado bien) es inválido y no se escribe", async () => {
    const mod = await goodModule();
    const fake = bytesOf("esto no es un pdf, es un texto cualquiera ".repeat(10));
    const pdfPath = jsonOf(mod, "documents/index.json")[0].file;
    fileOf(mod, pdfPath).data = fake;
    const index = jsonOf(mod, "documents/index.json");
    index[0].fingerprint.exact = await sha256Hex(fake);
    setJson(mod, "documents/index.json", index);
    const { plan, result, writes } = await run(await pack(mod));
    const doc = plan.items.find((i) => i.key === "bueno")!;
    expect(doc).toMatchObject({ status: "invalid", reason: "invalidPdf" });
    // Su plantilla no entra sin documento: queda dentro del documento inválido.
    expect(doc.templates).toEqual([expect.objectContaining({ id: "tpl-bueno", status: "invalid", reason: "documentInvalid" })]);
    expect(plan.items).toHaveLength(1);
    expect(result).toMatchObject({ ok: true, documents: 0, templates: 0 });
    expect(writes).toBe(0);
    expect((await listDocuments()).documents).toHaveLength(0);
  });

  it("un PDF que pasa el encabezado pero la puerta de entrada rechaza es inválido", async () => {
    const mod = await goodModule();
    const blob = await pack(mod);
    const read = await readPackage(blob);
    const plan = await planLibraryImport(read, await loadLibraryExisting(), { validatePdf: async () => false });
    expect(plan.items.find((i) => i.key === "bueno")).toMatchObject({ status: "invalid", reason: "invalidPdf" });
    expect(plan.items.find((i) => i.key === "bueno")?.templates[0]).toMatchObject({ status: "invalid", reason: "documentInvalid" });
    expect(plan.items.every((i) => i.document === undefined && i.pdf === undefined)).toBe(true);
    // Una puerta que lanza cuenta como rechazo.
    const throwing = await planLibraryImport(read, await loadLibraryExisting(), {
      validatePdf: async () => {
        throw new Error("boom");
      },
    });
    expect(throwing.counts.invalid).toBe(1);
  });

  it("la puerta no se usa para lo que ya tienes (idéntico)", async () => {
    const mod = await goodModule();
    const blob = await pack(mod);
    await seedDoc("bueno", 1, { name: "Bueno" });
    await seedTemplate("bueno", {}, "tpl-bueno");
    let calls = 0;
    const plan = await planLibraryImport(await readPackage(blob), await loadLibraryExisting(), {
      validatePdf: async () => {
        calls += 1;
        return true;
      },
    });
    expect(plan.counts).toMatchObject({ identical: 1, new: 0 });
    expect(calls).toBe(0);
  });

  it("PDF enorme (más de 100 MiB): tooLarge, sin inflarlo, y no cuelga", async () => {
    const mod = await goodModule();
    const pdfPath = jsonOf(mod, "documents/index.json")[0].file;
    const huge = new Uint8Array(100 * 1024 * 1024 + 1);
    huge.set(fakePdf(1, 64));
    fileOf(mod, pdfPath).data = huge;
    const big: ModuleRegistry = { ...DEFAULT_MODULE_REGISTRY, library: { ...DEFAULT_MODULE_REGISTRY.library, maxFileBytes: 120 * 1024 * 1024 } };
    const blob = await pack(mod, big);
    const { plan, result, writes } = await run(blob);
    expect(plan.items.find((i) => i.key === "bueno")).toMatchObject({ status: "invalid", reason: "tooLarge" });
    expect(result).toMatchObject({ ok: true, documents: 0 });
    expect(writes).toBe(0);
  });

  it("huella con el SHA-256 de otro PDF: «fingerprint»; huella mal formada: «invalidEntry»", async () => {
    const mod = await goodModule();
    const index = jsonOf(mod, "documents/index.json");
    index[0].fingerprint.exact = "a".repeat(64);
    setJson(mod, "documents/index.json", index);
    expect((await run(await pack(mod))).plan.items[0]).toMatchObject({ status: "invalid", reason: "fingerprint" });

    for (const exact of ["zz", "A".repeat(64), "", 7, null]) {
      const again = await goodModule();
      const idx = jsonOf(again, "documents/index.json");
      idx[0].fingerprint.exact = exact;
      setJson(again, "documents/index.json", idx);
      const { plan, writes } = await run(await pack(again));
      expect(plan.items[0]).toMatchObject({ status: "invalid", reason: "invalidEntry" });
      expect(writes).toBe(0);
    }
  });

  it("minhash que no son 128 valores, páginas que no cuadran, nombre con bidi o controles", async () => {
    const mutations: Array<(index: Array<Loose>) => void> = [
      (i) => (i[0].fingerprint.pages[0].minhash = "AAAA"),
      (i) => (i[0].pageCount = 99),
      (i) => (i[0].name = "Bueno‮odnuef"),
      (i) => (i[0].name = "Bueno\u0000"),
      (i) => (i[0].name = ""),
      (i) => (i[0].name = "x".repeat(201)),
      (i) => (i[0].createdAt = "ayer"),
      (i) => (i[0].fingerprint.pageSizes[0].width = -5),
      (i) => (i[0].fingerprint = null),
      (i) => (i[0].fingerprint.version = 2),
    ];
    for (const mutate of mutations) {
      const mod = await goodModule();
      const index = jsonOf(mod, "documents/index.json");
      mutate(index);
      setJson(mod, "documents/index.json", index);
      const { plan, writes } = await run(await pack(mod));
      expect(plan.items.find((i) => i.key === "bueno")).toMatchObject({ status: "invalid", reason: "invalidEntry" });
      expect(writes).toBe(0);
    }
  });
});

describe("plantillas", () => {
  it("campos fuera de rango, roles de más, tipos desconocidos, textos con bidi: la plantilla es inválida y el documento entra", async () => {
    const mutations: Array<(template: Loose) => void> = [
      (t) => (t.variants["1"].fields[0].rect.x = 2),
      (t) => (t.variants["1"].fields[0].rect.width = -0.1),
      (t) => (t.variants["1"].fields[0].rect.x = 0.9),
      (t) => (t.variants["1"].fields[0].type = "script"),
      (t) => (t.variants["1"].fields[0].pageIndex = 1e9),
      (t) => (t.roles = [{ key: "a", label: "x" }, { key: "b", label: "y" }, { key: "c", label: "z" }]),
      (t) => (t.name = "Mala‮"),
      (t) => (t.schemaVersion = 9),
      (t) => (t.variants = null),
      (t) => (t.id = "otro-id"),
      (t) => (t.variants["1"].fields = Array.from({ length: 501 }, () => ({ ...t.variants["1"].fields[0] }))),
    ];
    for (const mutate of mutations) {
      const mod = await goodModule();
      const template = jsonOf(mod, "templates/tpl-bueno.json");
      mutate(template);
      setJson(mod, "templates/tpl-bueno.json", template);
      const { plan, result, writes } = await run(await pack(mod));
      expect(plan.items.find((i) => i.key === "tpl-bueno")).toMatchObject({ status: "invalid", reason: "invalidEntry" });
      expect(plan.items.find((i) => i.key === "bueno")?.status).toBe("new");
      expect(result).toMatchObject({ ok: true, documents: 1, templates: 0 });
      // Solo el documento bueno (PDF + fila + nada de plantilla).
      expect(writes).toBeLessThanOrEqual(2);
      expect((await listTemplates()).templates).toHaveLength(0);
      await clearLibrary();
    }
  });

  it("JSON profundo (20 000 niveles) en una plantilla: inválida; en el índice: paquete dañado", async () => {
    const mod = await goodModule();
    setJson(mod, "templates/tpl-bueno.json", "[".repeat(20_000) + "]".repeat(20_000));
    const { plan } = await run(await pack(mod));
    expect(plan.items.find((i) => i.key === "tpl-bueno")).toMatchObject({ status: "invalid" });
    expect(plan.items.find((i) => i.key === "bueno")?.status).toBe("new");
    await clearLibrary();

    const deep = await goodModule();
    setJson(deep, "documents/index.json", "[".repeat(20_000) + "]".repeat(20_000));
    const damaged = await run(await pack(deep));
    expect(damaged.plan.state).toBe("damaged");
    expect(damaged.result).toEqual({ ok: false, reason: "blocked" });
    expect(damaged.writes).toBe(0);
  });

  it("referencias a documentos inexistentes: la plantilla no se guarda huérfana", async () => {
    const mod = await goodModule();
    const template = jsonOf(mod, "templates/tpl-bueno.json");
    template.documentId = "no-existe";
    setJson(mod, "templates/tpl-bueno.json", template);
    const { plan, result } = await run(await pack(mod));
    expect(plan.items.find((i) => i.key === "tpl-bueno")).toMatchObject({ status: "invalid", reason: "noDocument" });
    expect(result).toMatchObject({ ok: true, documents: 1, templates: 0 });
    expect((await listTemplates()).templates).toHaveLength(0);
  });

  it("ids repetidos: solo entra el primero de documentos y de plantillas", async () => {
    const mod = await goodModule();
    const docs = jsonOf(mod, "documents/index.json");
    docs.push({ ...docs[0], file: docs[0].file });
    setJson(mod, "documents/index.json", docs);
    const templates = jsonOf(mod, "templates/index.json");
    templates.push({ ...templates[0] });
    setJson(mod, "templates/index.json", templates);
    const { plan, result } = await run(await pack(mod));
    expect(plan.items.filter((i) => i.reason === "duplicateId")).toHaveLength(2);
    expect(new Set(plan.items.map((i) => i.key)).size).toBe(plan.items.length);
    expect(result).toMatchObject({ ok: true, documents: 1, templates: 1 });
    expect((await listDocuments()).documents).toHaveLength(1);
  });

  it("dos plantillas con el mismo archivo, o un archivo reservado (index/kits/perfiles): inválidas", async () => {
    for (const file of ["templates/index.json", "templates/kits.json", "templates/insurer-profiles.json", "templates/../x.json", "signatures/x.json", "documents/x.json", "/etc/passwd"]) {
      const mod = await goodModule();
      const templates = jsonOf(mod, "templates/index.json");
      templates[0].file = file;
      setJson(mod, "templates/index.json", templates);
      const { plan, writes } = await run(await pack(mod));
      expect(plan.items.find((i) => i.key === "tpl-bueno")).toMatchObject({ status: "invalid" });
      expect(writes).toBeLessThanOrEqual(2);
      await clearLibrary();
    }
    const mod = await goodModule();
    const templates = jsonOf(mod, "templates/index.json");
    templates.push({ id: "copia", file: templates[0].file });
    setJson(mod, "templates/index.json", templates);
    const { plan } = await run(await pack(mod));
    expect(plan.items.find((i) => i.key === "copia")).toMatchObject({ status: "invalid" });
  });

  it("campos desconocidos y __proto__ se ignoran: no contaminan nada ni se guardan", async () => {
    const mod = await goodModule();
    const docs = jsonOf(mod, "documents/index.json");
    docs[0].extraSecreto = "no debe guardarse";
    docs[0].fingerprint.extra = 1;
    setJson(mod, "documents/index.json", docs);
    setJson(mod, "templates/tpl-bueno.json", { ...jsonOf(mod, "templates/tpl-bueno.json"), huerfano: { x: 1 } });
    // Entradas con __proto__ / constructor como claves.
    const raw = dec.decode(fileOf(mod, "templates/tpl-bueno.json").data).replace("{", '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},');
    fileOf(mod, "templates/tpl-bueno.json").data = bytesOf(raw);
    const { result } = await run(await pack(mod));
    expect(result).toMatchObject({ ok: true, documents: 1, templates: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
    const stored = (await listDocuments()).documents[0] as unknown as Record<string, unknown>;
    expect(stored.extraSecreto).toBeUndefined();
    expect((await listTemplates()).templates[0]).not.toHaveProperty("huerfano");
  });
});

describe("rutas e integridad", () => {
  it("rutas del índice fuera de la lista blanca (../, otra carpeta, absolutas, sin .pdf, compartidas)", async () => {
    for (const file of ["documents/../x.pdf", "signatures/a.png", "/documents/x.pdf", "documents/x.exe", "documents/x.pdf/", "templates/x.pdf", "documents/" + "a".repeat(200) + ".pdf", 7, null]) {
      const mod = await goodModule();
      const docs = jsonOf(mod, "documents/index.json");
      docs[0].file = file;
      setJson(mod, "documents/index.json", docs);
      const { plan, writes } = await run(await pack(mod));
      expect(plan.items.find((i) => i.key === "bueno")).toMatchObject({ status: "invalid" });
      expect(writes).toBe(0);
    }
    const mod = await goodModule();
    const docs = jsonOf(mod, "documents/index.json");
    docs.push({ ...docs[0], id: "gemelo" });
    setJson(mod, "documents/index.json", docs);
    const { plan } = await run(await pack(mod));
    expect(plan.items.find((i) => i.key === "gemelo")).toMatchObject({ status: "invalid" });
  });

  it("el SHA-256 del manifiesto no corresponde al PDF: «integrity»; archivo ausente: «integrity»", async () => {
    const mod = await goodModule();
    const blob = await pack(mod);
    const pdfPath = jsonOf(mod, "documents/index.json")[0].file;
    const bad = await editManifest(blob, (manifest) => {
      for (const file of manifest.files) if (file.path === pdfPath) file.sha256 = "0".repeat(64);
    });
    expect((await run(bad)).plan.items.find((i) => i.key === "bueno")).toMatchObject({ status: "invalid", reason: "integrity" });
    const missing = await rewriteZip(blob, (zip) => void zip.remove(pdfPath));
    const { plan, writes } = await run(missing);
    expect(plan.items.find((i) => i.key === "bueno")).toMatchObject({ status: "invalid", reason: "integrity" });
    expect(writes).toBe(0);
  });

  it("el índice con el SHA-256 mal, ausente o que no es una lista: paquete dañado", async () => {
    const mod = await goodModule();
    const blob = await pack(mod);
    const bad = await editManifest(blob, (manifest) => {
      for (const file of manifest.files) if (file.path === "documents/index.json") file.sha256 = "0".repeat(64);
    });
    expect((await run(bad)).plan.state).toBe("damaged");

    const none = await goodModule();
    none.files = none.files.filter((f) => !f.path.endsWith("index.json"));
    expect((await run(await pack(none))).plan.state).toBe("damaged");

    for (const value of [{ documents: [] }, "texto", 7, null]) {
      const again = await goodModule();
      setJson(again, "documents/index.json", value);
      const outcome = await run(await pack(again));
      expect(outcome.plan.state).toBe("damaged");
      expect(outcome.writes).toBe(0);
    }
  });

  it("módulo con esquema más nuevo: «newerVersion», sin inflar nada de él ni escribir", async () => {
    const mod = await goodModule();
    const blob = await editManifest(await pack(mod), (manifest) => {
      manifest.modules.library.schemaVersion = 9;
    });
    const { plan, result, writes } = await run(blob);
    expect(plan.state).toBe("newerVersion");
    expect(plan.message).toContain("versión más nueva");
    expect(result).toEqual({ ok: false, reason: "blocked" });
    expect(writes).toBe(0);
  });

  it("zips de contenedor con rutas de este módulo: ../, absolutas, 2 001 archivos en documents/, bomba de ratio", async () => {
    const cases: Array<[string, Uint8Array, string]> = [
      ["ruta con ../", forgeZip([{ name: "manifest.json", data: bytesOf("{}") }, { name: "documents/../../evil.pdf", data: bytesOf("x") }]), "unsafePath"],
      ["ruta absoluta de plantilla", forgeZip([{ name: "manifest.json", data: bytesOf("{}") }, { name: "/templates/a.json", data: bytesOf("x") }]), "unsafePath"],
      [
        "2 001 entradas en documents/",
        forgeZip(Array.from({ length: 2001 }, (_, i) => ({ name: `documents/f${i}.pdf`, data: bytesOf("x") }))),
        "tooManyEntries",
      ],
      [
        "PDF que descomprime a 20 MB de ceros",
        forgeZip([{ name: "manifest.json", data: bytesOf("{}") }, { name: "documents/a.pdf", data: new Uint8Array(20 * 1024 * 1024), crc: 0 }]),
        "bomb",
      ],
    ];
    for (const [name, bytes, code] of cases) {
      const { writes } = await countWrites(async () => {
        await timed(async () => {
          await expect(readPackage(new Blob([bytes as BlobPart]))).rejects.toMatchObject({ code });
        });
      });
      expect(writes, name).toBe(0);
    }
  });

  it("el corpus genérico del contenedor se rechaza igual aquí (sin tocar la biblioteca)", async () => {
    for (const hostile of hostileCorpus()) {
      const { writes } = await countWrites(async () => {
        await timed(async () => {
          await expect(readPackage(new Blob([hostile.bytes as BlobPart]))).rejects.toBeInstanceOf(PackageError);
        });
      });
      expect(writes, hostile.name).toBe(0);
    }
  });
});

describe("500 documentos", () => {
  it("un índice con 500 documentos (y sus 500 PDF) se rechaza como dañado: sin escribir y en < 2 s", async () => {
    const mod = await goodModule();
    const base = jsonOf(mod, "documents/index.json")[0];
    const entries: unknown[] = [];
    const files: PackageFileInput[] = mod.files.filter((f) => !f.path.endsWith(".pdf") && f.path !== "documents/index.json");
    for (let i = 0; i < 500; i += 1) {
      const pdf = fakePdf(500 + i, 90);
      const fp = await fingerprintOf(pdf);
      entries.push({ ...base, id: `m${i}`, file: `documents/m${i}.pdf`, fingerprint: { ...base.fingerprint, exact: fp.exact }, byteLength: pdf.length });
      files.push({ path: `documents/m${i}.pdf`, data: pdf, type: "application/pdf" });
    }
    files.unshift({ path: "documents/index.json", data: bytesOf(entries), type: "application/json" });
    const blob = await pack({ ...mod, files });
    const outcome = await run(blob);
    expect(outcome.plan.state).toBe("damaged");
    expect(outcome.writes).toBe(0);
    expect((await listDocuments()).documents).toHaveLength(0);
  });

  it("200 documentos válidos se leen y planifican en < 2 s, pero no caben (50) y no se escribe NINGUNO", async () => {
    const mod = await goodModule();
    const base = jsonOf(mod, "documents/index.json")[0];
    const entries: unknown[] = [];
    const files: PackageFileInput[] = [];
    for (let i = 0; i < 200; i += 1) {
      const pdf = fakePdf(900 + i, 90);
      const fp = await fingerprintOf(pdf);
      entries.push({ ...base, id: `m${i}`, file: `documents/m${i}.pdf`, fingerprint: { ...base.fingerprint, exact: fp.exact }, byteLength: pdf.length });
      files.push({ path: `documents/m${i}.pdf`, data: pdf, type: "application/pdf" });
    }
    files.unshift({ path: "documents/index.json", data: bytesOf(entries), type: "application/json" });
    files.push({ path: "templates/index.json", data: bytesOf([]), type: "application/json" });
    const { plan, result, writes } = await run(await pack({ ...mod, files }));
    expect(plan.items).toHaveLength(200);
    expect(plan.counts.new).toBe(200);
    expect(result).toMatchObject({ ok: false, reason: "limit", fits: 50, wanted: 200 });
    expect(writes).toBe(0);
  });
});
