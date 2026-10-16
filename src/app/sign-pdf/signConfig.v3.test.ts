import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { blockGroups, groupsMatrix } from "@/app/sign-pdf/assignment";
import { sessionFromConfigSet } from "@/app/sign-pdf/configSession";
import { docIdOf, type SignerBlock } from "@/app/sign-pdf/docSet";
import {
  CONFIG_VERSION_GROUPS,
  CONFIG_VERSION_MULTI,
  configDocumentEntry,
  exportSignConfigSet,
  importSignConfig,
  importSignConfigSet,
  isSignConfigManifest,
  isSignConfigManifestV2,
  isSignConfigManifestV3,
  type ExportConfigDocument,
  type SignConfigManifestV3,
} from "@/app/sign-pdf/signConfig";
import { MAX_DOCUMENTS } from "@/app/sign-pdf/signLimits";
import type { SignatureField, Signer } from "@/lib/pdf/sign";

/*
 * Configuracion v3 (U1.1): v2 + `copies` por documento + `group`/`groupName` por bloque.
 *  - Los zip v1 y v2 «dorados» (`__fixtures__/config.v1.zip`, `config.v2.zip`, generados con el exportador de ANTES de
 *    U1.1) se siguen importando EXACTAMENTE igual: compatibilidad total hacia atras.
 *  - Se escribe v3 solo cuando hay algo que v1/v2 no sabe decir; si no, el formato de siempre.
 */

const FIXTURES = path.resolve(__dirname, "__fixtures__");
const ANA: Signer = { id: "sg-1", name: "Ana", color: "#0d4bff" };
const LUIS: Signer = { id: "sg-2", name: "Luis", color: "#0f9d68" };

function pdfFile(name: string, tag = name): File {
  return new File([new TextEncoder().encode(`%PDF-1.4\n% ${tag}\n%%EOF\n`) as BlobPart], name, { type: "application/pdf" });
}

function slot(id: string, signerId: string): SignatureField {
  return { id, signerId, pageIndex: 0, type: "signature", rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.1 } };
}

function exportDoc(name: string, over: Partial<ExportConfigDocument> = {}): ExportConfigDocument {
  const file = pdfFile(name);
  return { id: docIdOf(file), file, fields: [slot(`fld-${name}`, "sg-1")], textFields: [], textValues: {}, ...over };
}

function block(over: Partial<SignerBlock> & Pick<SignerBlock, "id" | "signerId">): SignerBlock {
  return { appliesTo: [], signature: null, initials: null, stamps: {}, auto: true, ...over };
}

const asFile = (blob: Blob, name = "config.zip") => new File([blob], name, { type: "application/zip" });

async function manifestOf(blob: Blob): Promise<Record<string, unknown> & { documents?: Record<string, unknown>[]; blocks?: Record<string, unknown>[] }> {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return JSON.parse(await zip.file("manifest.json")!.async("text"));
}

/** Un manifiesto v3 valido de dos documentos, para deformarlo en cada caso. */
function validV3(over: Partial<SignConfigManifestV3> = {}): SignConfigManifestV3 {
  return {
    version: 3,
    mode: "multi",
    signMode: "independent",
    signers: [ANA],
    blocks: [
      { id: "bk-1", signerId: "sg-1", appliesTo: ["doc-1"], auto: false, group: "A" },
      { id: "bk-2", signerId: "sg-1", appliesTo: ["doc-2"], auto: false, group: "B", groupName: "Firma de cierre" },
    ],
    documents: [
      { id: "doc-1", entry: configDocumentEntry(0), name: "uno.pdf", fields: [slot("f1", "sg-1")], textFields: [], textValues: {}, copies: 2 },
      { id: "doc-2", entry: configDocumentEntry(1), name: "dos.pdf", fields: [], textFields: [], textValues: {}, copies: 1 },
    ],
    ...over,
  };
}

async function buildZip(manifest: unknown, entries?: Record<string, string>): Promise<File> {
  const zip = new JSZip();
  const files = entries ?? { "documentos/01.pdf": "%PDF-1.4\n% 1", "documentos/02.pdf": "%PDF-1.4\n% 2" };
  for (const [name, data] of Object.entries(files)) zip.file(name, data, { createFolders: false });
  zip.file("manifest.json", JSON.stringify(manifest));
  return asFile(await zip.generateAsync({ type: "blob" }));
}

async function describeImport(file: File) {
  const set = await importSignConfigSet(file);
  return {
    ...set,
    documents: await Promise.all(set.documents.map(async (d) => ({ ...d, file: { name: d.file.name, text: await d.file.text() } }))),
  };
}

const goldenZip = (name: string): File =>
  new File([new Uint8Array(readFileSync(path.join(FIXTURES, name)))], name, { type: "application/zip" });
const goldenJson = (name: string): unknown => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

describe("compatibilidad con la v1 y la v2 (archivos dorados anteriores a U1.1)", () => {
  it("config.v1.zip se importa igual que antes (importador nuevo y viejo)", async () => {
    expect(await describeImport(goldenZip("config.v1.zip"))).toEqual(goldenJson("config.v1.expected.json"));
    const old = await importSignConfig(goldenZip("config.v1.zip"));
    expect(isSignConfigManifest(old.manifest)).toBe(true);
    expect(old.manifest.fields).toHaveLength(1);
  });

  it("config.v2.zip se importa igual que antes: version 2, sin `copies`, bloques sin `group`", async () => {
    const imported = await describeImport(goldenZip("config.v2.zip"));
    expect(imported).toEqual(goldenJson("config.v2.expected.json"));
    expect(imported.version).toBe(2);
    for (const doc of imported.documents) expect("copies" in doc).toBe(false);
    for (const b of imported.blocks) expect("group" in b || "groupName" in b).toBe(false);
  });

  it("el dorado v2 es el caso del usuario: la sesion que sale tiene a Ana en A,A,B,B y a Luis con una firma", async () => {
    const set = await importSignConfigSet(goldenZip("config.v2.zip"));
    const files = set.documents.map((d) => d.file);
    const patch = sessionFromConfigSet(set, files, files.map((_, i) => `k${i}`));
    const ids = files.map(docIdOf);
    expect(groupsMatrix(patch.blocks ?? [], ids, set.signers).cells).toEqual([
      ["A", "A"], ["A", "A"], ["B", "A"], ["B", "A"],
    ]);
    for (const state of Object.values(patch.docs ?? {})) expect("copies" in state).toBe(false);
  });

  it("el importador de UNA configuracion (v1) sigue rechazando la v2 y la v3", async () => {
    await expect(importSignConfig(goldenZip("config.v2.zip"))).rejects.toMatchObject({ code: "invalidConfig" });
    await expect(importSignConfig(await buildZip(validV3()))).rejects.toMatchObject({ code: "invalidConfig" });
  });
});

describe("exportSignConfigSet — que version escribe", () => {
  const docs = () => [exportDoc("a.pdf"), exportDoc("b.pdf")];
  const base = { mode: "multi" as const, signMode: "same" as const, signers: [ANA], blocks: [] as SignerBlock[] };

  it("sin copias ni nombres de grupo: el formato de siempre (v1 con un documento, v2 con varios) y SIN campos nuevos", async () => {
    const one = await manifestOf(await exportSignConfigSet([exportDoc("solo.pdf")], base));
    expect(one.version).toBe(1);
    const two = await manifestOf(await exportSignConfigSet(docs(), base));
    expect(two.version).toBe(CONFIG_VERSION_MULTI);
    for (const doc of two.documents!) expect("copies" in doc).toBe(false);
    // `copies: 1` explicito tampoco cambia nada.
    const explicit = await manifestOf(await exportSignConfigSet([exportDoc("a.pdf", { copies: 1 }), exportDoc("b.pdf", { copies: 1 })], base));
    expect(explicit.version).toBe(2);
    expect("copies" in explicit.documents![0]).toBe(false);
  });

  it("con alguna copia (>1): v3, `copies` en TODOS los documentos y `group` en los bloques", async () => {
    const [a, b] = [exportDoc("a.pdf", { copies: 3 }), exportDoc("b.pdf")];
    const blob = await exportSignConfigSet([a, b], {
      ...base,
      signMode: "independent",
      blocks: [
        block({ id: "bk-1", signerId: "sg-1", appliesTo: [a.id], auto: false }),
        block({ id: "bk-2", signerId: "sg-1", appliesTo: [b.id], auto: false }),
      ],
    });
    const manifest = await manifestOf(blob);
    expect(manifest.version).toBe(CONFIG_VERSION_GROUPS);
    expect(manifest.documents!.map((d) => d.copies)).toEqual([3, 1]);
    expect(manifest.blocks!.map((x) => x.group)).toEqual(["A", "B"]);
    expect(manifest.blocks!.every((x) => !("groupName" in x))).toBe(true);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["documentos/01.pdf", "documentos/02.pdf", "manifest.json"]);
  });

  it("UN solo documento con copias tambien es v3 (la v1 no guarda copias), con su PDF en documentos/01.pdf", async () => {
    const solo = exportDoc("solo.pdf", { copies: 2 });
    const blob = await exportSignConfigSet([solo], base);
    const manifest = await manifestOf(blob);
    expect(manifest.version).toBe(3);
    expect(manifest.documents).toHaveLength(1);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files).sort()).toEqual(["documentos/01.pdf", "manifest.json"]);
    const imported = await importSignConfigSet(asFile(blob));
    expect(imported.version).toBe(3);
    expect(imported.documents[0].copies).toBe(2);
    expect(imported.documents[0].file.name).toBe("solo.pdf");
  });

  it("con un nombre de grupo: v3 (aunque no haya copias) y el nombre viaja limpio; los vacios y los de bloques desconocidos se descartan", async () => {
    const [a, b] = docs();
    const blob = await exportSignConfigSet([a, b], {
      ...base,
      signMode: "independent",
      blocks: [
        block({ id: "bk-1", signerId: "sg-1", appliesTo: [a.id], auto: false }),
        block({ id: "bk-2", signerId: "sg-1", appliesTo: [b.id], auto: false }),
      ],
      groupNames: { "bk-1": "  Firma de cierre  ", "bk-2": "   ", "bk-zzz": "no existe", ["bk-3"]: "x".repeat(200) },
    });
    const manifest = await manifestOf(blob);
    expect(manifest.version).toBe(3);
    expect(manifest.blocks!.map((x) => x.groupName)).toEqual(["Firma de cierre", undefined]);
    // Y el manifiesto que sale lo acepta el lector.
    expect(isSignConfigManifestV3(manifest)).toBe(true);
  });

  it("solo nombres vacios: no hace falta v3", async () => {
    const [a, b] = docs();
    const manifest = await manifestOf(
      await exportSignConfigSet([a, b], { ...base, groupNames: { "bk-1": "  ", x: "" } }),
    );
    expect(manifest.version).toBe(2);
  });

  it("un nombre de grupo largo se recorta a 60 caracteres", async () => {
    const [a, b] = docs();
    const manifest = await manifestOf(
      await exportSignConfigSet([a, b], {
        ...base,
        blocks: [block({ id: "bk-1", signerId: "sg-1", appliesTo: [a.id, b.id] })],
        groupNames: { "bk-1": "n".repeat(200) },
      }),
    );
    expect(manifest.blocks![0].groupName).toBe("n".repeat(60));
  });

  it("las copias fuera de rango se escriben dentro de 1..5; la letra del grupo viene de `blockGroups`", async () => {
    const [a, b, c] = [exportDoc("a.pdf", { copies: 99 }), exportDoc("b.pdf", { copies: 0 }), exportDoc("c.pdf", { copies: 2.9 })];
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: [c.id], auto: false }),
      block({ id: "bk-2", signerId: "sg-1", appliesTo: [a.id, b.id], auto: false }),
    ];
    const manifest = await manifestOf(await exportSignConfigSet([a, b, c], { ...base, signMode: "independent", blocks }));
    expect(manifest.documents!.map((d) => d.copies)).toEqual([5, 1, 2]);
    // En el orden de los documentos exportados: el grupo de a y b es la «A» (aparece primero), el de c la «B».
    expect(blockGroups(blocks, [a.id, b.id, c.id], [ANA])).toEqual({ "bk-2": "A", "bk-1": "B" });
    expect(manifest.blocks!.map((x) => [x.id, x.group])).toEqual([["bk-1", "B"], ["bk-2", "A"]]);
  });

  it("los bloques sin ningun documento exportado se omiten tambien en la v3", async () => {
    const [a, b] = [exportDoc("a.pdf", { copies: 2 }), exportDoc("b.pdf")];
    const manifest = await manifestOf(
      await exportSignConfigSet([a, b], {
        ...base,
        blocks: [block({ id: "bk-1", signerId: "sg-1", appliesTo: [a.id, b.id] }), block({ id: "bk-x", signerId: "sg-1", appliesTo: ["otro"] })],
      }),
    );
    expect(manifest.blocks!.map((x) => x.id)).toEqual(["bk-1"]);
  });
});

describe("importSignConfigSet — v3", () => {
  it("ida y vuelta: copias, grupos y nombres; `copies` solo en los documentos con mas de una", async () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((n, i) => exportDoc(`${n}.pdf`, { copies: [2, 1, 5, undefined][i] }));
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: [a.id, b.id], auto: false }),
      block({ id: "bk-2", signerId: "sg-1", appliesTo: [c.id, d.id], auto: false }),
      block({ id: "bk-3", signerId: "sg-2", appliesTo: [a.id, b.id, c.id, d.id], auto: true }),
    ];
    const blob = await exportSignConfigSet([a, b, c, d], {
      mode: "multi", signMode: "independent", signers: [ANA, LUIS], blocks, groupNames: { "bk-2": "Cierre" },
    });
    const set = await importSignConfigSet(asFile(blob));
    expect(set.version).toBe(3);
    expect(set.documents.map((x) => x.copies)).toEqual([2, undefined, 5, undefined]);
    expect(set.blocks.map((x) => [x.id, x.group, x.groupName])).toEqual([
      ["bk-1", "A", undefined], ["bk-2", "B", "Cierre"], ["bk-3", "A", undefined],
    ]);
    expect(set.blocks.map((x) => x.appliesTo)).toEqual([["doc-1", "doc-2"], ["doc-3", "doc-4"], ["doc-1", "doc-2", "doc-3", "doc-4"]]);
    expect(set.signMode).toBe("independent");
  });

  it("la sesion que sale lleva las copias en SU documento y la tabla A,A,B,B", async () => {
    const [a, b, c, d] = ["a", "b", "c", "d"].map((n, i) => exportDoc(`${n}.pdf`, { copies: i === 2 ? 4 : 1 }));
    const blocks = [
      block({ id: "bk-1", signerId: "sg-1", appliesTo: [a.id, b.id], auto: false }),
      block({ id: "bk-2", signerId: "sg-1", appliesTo: [c.id, d.id], auto: false }),
    ];
    const blob = await exportSignConfigSet([a, b, c, d], { mode: "multi", signMode: "independent", signers: [ANA], blocks });
    const set = await importSignConfigSet(asFile(blob));
    const files = set.documents.map((x) => x.file);
    const patch = sessionFromConfigSet(set, files, files.map((_, i) => `k${i}`));
    const ids = files.map(docIdOf);
    expect(ids.map((id) => patch.docs?.[id].copies)).toEqual([undefined, undefined, 4, undefined]);
    expect(groupsMatrix(patch.blocks ?? [], ids, [ANA]).cells).toEqual([["A"], ["A"], ["B"], ["B"]]);
  });

  it("acepta un v3 construido a mano (con y sin grupos) y lo reconoce solo como v3", async () => {
    const manifest = validV3();
    expect(isSignConfigManifestV3(manifest)).toBe(true);
    expect(isSignConfigManifestV2(manifest)).toBe(false);
    expect(isSignConfigManifest(manifest)).toBe(false);
    const set = await importSignConfigSet(await buildZip(manifest));
    expect(set.version).toBe(3);
    expect(set.documents.map((x) => x.copies)).toEqual([2, undefined]);
    const noGroups = validV3({ blocks: [{ id: "bk-1", signerId: "sg-1", appliesTo: ["doc-1", "doc-2"], auto: true }] });
    expect(isSignConfigManifestV3(noGroups)).toBe(true);
  });

  it("v2 sigue siendo v2: no se reconoce como v3 y no lee `copies` ni `group` que no le corresponden", async () => {
    const v2 = { ...validV3(), version: 2 };
    expect(isSignConfigManifestV3(v2)).toBe(false);
    expect(isSignConfigManifestV2(v2)).toBe(true);
    const set = await importSignConfigSet(await buildZip(v2));
    expect(set.version).toBe(2);
    for (const doc of set.documents) expect("copies" in doc).toBe(false);
  });
});

describe("importSignConfigSet — v3 no valida o futura", () => {
  const rejects = async (manifest: unknown, entries?: Record<string, string>) =>
    expect(importSignConfigSet(await buildZip(manifest, entries))).rejects.toMatchObject({ code: "invalidConfig" });

  it("una v2 con la version cambiada a 3 (le falta `copies`) se rechaza: no se lee a medias", async () => {
    const v2Body = { ...validV3(), version: 3, documents: validV3().documents.map(({ copies, ...rest }) => (void copies, rest)) };
    expect(isSignConfigManifestV3(v2Body)).toBe(false);
    await rejects(v2Body);
  });

  it("una version futura (4) se rechaza", async () => {
    await rejects({ ...validV3(), version: 4 });
  });

  it("copies invalidas: 0, 6, decimales, texto, null, ausente en UN documento", async () => {
    for (const bad of [0, 6, 2.5, "2", null, -1, Number.MAX_SAFE_INTEGER]) {
      const manifest = validV3();
      (manifest.documents[1] as unknown as Record<string, unknown>).copies = bad;
      expect(isSignConfigManifestV3(manifest)).toBe(false);
      await rejects(manifest);
    }
    const missing = validV3();
    delete missing.documents[0].copies;
    expect(isSignConfigManifestV3(missing)).toBe(false);
  });

  it("copies en los limites (1 y 5) valen", () => {
    const manifest = validV3();
    manifest.documents[0].copies = 5;
    manifest.documents[1].copies = 1;
    expect(isSignConfigManifestV3(manifest)).toBe(true);
  });

  it("grupo invalido: minuscula, numero, demasiado largo, no texto; nombre de grupo largo o no texto", async () => {
    for (const group of ["a", "1", "AAAA", "A B", 7, null, ""]) {
      const manifest = validV3();
      (manifest.blocks[0] as unknown as Record<string, unknown>).group = group;
      expect(isSignConfigManifestV3(manifest)).toBe(false);
      await rejects(manifest);
    }
    for (const groupName of ["x".repeat(61), 5, null, {}]) {
      const manifest = validV3();
      (manifest.blocks[1] as unknown as Record<string, unknown>).groupName = groupName;
      expect(isSignConfigManifestV3(manifest)).toBe(false);
    }
    const ok = validV3();
    ok.blocks[1].groupName = "x".repeat(60);
    ok.blocks[0].group = "AA";
    expect(isSignConfigManifestV3(ok)).toBe(true);
  });

  it("las mismas reglas estrictas que la v2: bloque con documento o firmante inexistente, ids repetidos, rutas, demasiados documentos", async () => {
    await rejects(validV3({ blocks: [{ id: "bk-1", signerId: "sg-1", appliesTo: ["doc-9"], auto: false }] }));
    await rejects(validV3({ blocks: [{ id: "bk-1", signerId: "sg-9", appliesTo: ["doc-1"], auto: false }] }));
    await rejects(validV3({ blocks: [{ id: "bk-1", signerId: "sg-1", appliesTo: [], auto: false }] }));
    const dup = validV3();
    dup.documents[1].id = "doc-1";
    await rejects(dup);
    const badEntry = validV3();
    badEntry.documents[0].entry = "../etc/passwd";
    await rejects(badEntry);
    const many = validV3({
      blocks: [],
      documents: Array.from({ length: MAX_DOCUMENTS + 1 }, (_, i) => ({
        id: `doc-${i + 1}`, entry: configDocumentEntry(i), name: `d${i}.pdf`, fields: [], textFields: [], textValues: {}, copies: 1,
      })),
    });
    expect(isSignConfigManifestV3(many)).toBe(false);
  });

  it("faltan entradas o sobran entradas en el zip", async () => {
    await rejects(validV3(), { "documentos/01.pdf": "%PDF-1.4\n% 1" });
    await rejects(validV3(), { "documentos/01.pdf": "%PDF-1.4\n% 1", "documentos/02.pdf": "%PDF-1.4\n% 2", "documentos/03.pdf": "%PDF-1.4\n% 3" });
    await rejects(validV3(), { "documentos/01.pdf": "%PDF-1.4\n% 1", "documentos/02.pdf": "no es un pdf" });
  });
});

describe("versiones", () => {
  it("las constantes: v2 = 2, v3 = 3", () => {
    expect(CONFIG_VERSION_MULTI).toBe(2);
    expect(CONFIG_VERSION_GROUPS).toBe(3);
  });
});
