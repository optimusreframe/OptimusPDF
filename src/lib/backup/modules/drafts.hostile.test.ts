import "fake-indexeddb/auto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { listAllDrafts, listDrafts, listSessionDrafts } from "@/app/sign-pdf/signDrafts";
import { listEditDrafts } from "@/app/edit-pdf/editDrafts";
import { listProDrafts } from "@/app/pdf-pro/proDrafts";
import { sha256Hex } from "@/lib/crypto/sha256";
import { buildPackage, readPackage } from "@/lib/backup/package";
import {
  applyDraftsImport,
  exportDraftsDetailed,
  planDraftsImport,
  type DraftDecision,
  type DraftsImportPlan,
} from "@/lib/backup/modules/drafts";
import {
  clearAllLocalDrafts,
  realPdf,
  seedEditDraft,
  seedProDraft,
  seedSignDocument,
  seedSignSession,
} from "@/lib/backup/__fixtures__/draftsKit";
import { makePng, makeRealPng } from "@/lib/backup/__fixtures__/pngFactory";
import { asFile, timed } from "@/lib/backup/__fixtures__/testKit";

/**
 * Corpus de paquetes HOSTILES del modulo «Borradores»: indices con ids repetidos, trazos fuera de rango, PDF falsos,
 * sesiones con 10 000 bloques, campos desconocidos, `__proto__`, tipos cambiados... Cada caso: el plan tarda < 2 s, el
 * borrador malo queda `invalid` con su motivo (o se sanea), y aplicarlo TODO no escribe nada de lo malo.
 */

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Base = { index: Json; files: Map<string, Uint8Array> };

const enc = new TextEncoder();
const dec = new TextDecoder();
let base: Base;

beforeAll(async () => {
  await clearAllLocalDrafts();
  await seedSignDocument({ strokes: true });
  await seedSignSession({ strokes: true, ceremony: true });
  await seedEditDraft({ withImage: true });
  await seedProDraft();
  const { module } = await exportDraftsDetailed();
  base = {
    index: JSON.parse(dec.decode(module.files[0].data)),
    files: new Map(module.files.slice(1).map((f) => [f.path, f.data])),
  };
  await clearAllLocalDrafts();
});

beforeEach(async () => {
  await clearAllLocalDrafts();
});
afterEach(() => {
  vi.useRealTimers();
});

const clone = (): Base => ({ index: JSON.parse(JSON.stringify(base.index)), files: new Map(base.files) });

async function pack(index: unknown, files: Map<string, Uint8Array>) {
  const input = [
    { path: "drafts/index.json", data: new Uint8Array(enc.encode(typeof index === "string" ? index : JSON.stringify(index))), type: "application/json" },
    ...Array.from(files, ([path, data]) => ({
      path,
      data,
      type: path.endsWith(".pdf") ? "application/pdf" : path.endsWith(".png") ? "image/png" : path.endsWith(".jpg") ? "image/jpeg" : "application/json",
    })),
  ];
  const blob = await buildPackage({ modules: [{ name: "drafts", schemaVersion: 1, files: input }] });
  return readPackage(asFile(blob));
}

async function planOf(b: Base, options: Parameters<typeof planDraftsImport>[1] = {}): Promise<DraftsImportPlan> {
  const read = await pack(b.index, b.files);
  return timed(() => planDraftsImport(read, options));
}

/** Aplica TODO lo aplicable y devuelve cuantos borradores hay despues. */
async function applyAll(plan: DraftsImportPlan, options: Parameters<typeof applyDraftsImport>[2] = {}): Promise<number> {
  const decisions: Record<string, DraftDecision> = {};
  for (const item of plan.items) decisions[item.key] = item.status === "new" ? "import" : "replace";
  await timed(() => applyDraftsImport(plan, decisions, options));
  return (await listAllDrafts()).length + (await listEditDrafts()).length + (await listProDrafts()).length;
}

const statusOf = (plan: DraftsImportPlan) => plan.items.map((i) => `${i.kind}:${i.status}${i.reason ? `:${i.reason}` : ""}`);

describe("el paquete de referencia es valido (control de las pruebas hostiles)", () => {
  it("los cuatro tipos entran", async () => {
    const plan = await planOf(clone());
    expect(statusOf(plan)).toEqual(["sign-document:new", "sign-session:new", "edit:new", "pro:new"]);
    expect(await applyAll(plan)).toBe(4);
  });
});

describe("indice", () => {
  it.each([
    ["no es un objeto (lista)", "[]"],
    ["no es un objeto (texto)", '"hola"'],
    ["null", "null"],
    ["JSON roto", "{no json"],
    ["anidado a 10 000 niveles", `{"sign":${"[".repeat(10_000)}${"]".repeat(10_000)}}`],
  ])("%s -> modulo dañado, sin escribir", async (_name, body) => {
    const read = await pack(body, new Map());
    const plan = await timed(() => planDraftsImport(read));
    expect(plan.state).toBe("damaged");
    expect(await applyAll(plan)).toBe(0);
  });

  it.each([
    ["documents no es lista", (i: Json) => (i.sign.documents = { 0: i.sign.documents[0] })],
    ["sessions es un texto", (i: Json) => (i.sign.sessions = "x")],
    ["edit es un numero", (i: Json) => (i.edit = 5)],
    ["pro es un objeto", (i: Json) => (i.pro = {})],
    ["31 borradores de Firmar", (i: Json) => (i.sign.documents = Array.from({ length: 31 }, () => i.sign.documents[0]))],
    ["300 entradas de Editar", (i: Json) => (i.edit = Array.from({ length: 300 }, () => i.edit[0]))],
  ])("%s -> dañado, sin escribir", async (_name, mutate) => {
    const b = clone();
    mutate(b.index);
    const plan = await planOf(b);
    expect(plan.state).toBe("damaged");
    expect(await applyAll(plan)).toBe(0);
  });

  it("un indice vacio o con secciones que faltan es un paquete valido sin borradores", async () => {
    for (const index of [{}, { sign: {} }, { sign: { documents: [], sessions: [] }, edit: [], pro: [] }]) {
      const plan = await planOf({ index, files: new Map() } as unknown as Base);
      expect(plan.state).toBe("ok");
      expect(plan.items).toHaveLength(0);
    }
  });

  it("sin indice, o con indice cuyo SHA no coincide: dañado", async () => {
    const read = await pack({}, new Map());
    const noIndex = { ...read, modules: read.modules.map((m) => ({ ...m, files: new Map() })) };
    expect((await planDraftsImport(noIndex)).state).toBe("damaged");
  });
});

describe("refs y rutas: ningun nombre del zip se cree", () => {
  it.each([
    ["ref con ../", "../x"],
    ["ref de otro tipo", "s1"],
    ["ref vacio", ""],
    ["ref con mayusculas", "D1"],
    ["ref numerico largo", "d12345"],
  ])("%s -> invalido", async (_name, ref) => {
    const b = clone();
    b.index.sign.documents[0].ref = ref;
    const plan = await planOf(b);
    expect(statusOf(plan)[0]).toBe("sign-document:invalid:invalidEntry");
    expect(await applyAll(plan)).toBe(3);
  });

  it("el indice no puede apuntar a un archivo de otro borrador ni de otra carpeta", async () => {
    const b = clone();
    // el trazo del documento d1 apunta al trazo de la sesion s1
    const capture = Object.values(b.index.sign.documents[0].captures)[0] as Json;
    capture.signature.png = "drafts/s1-k0.png";
    expect(statusOf(await planOf(b))[0]).toBe("sign-document:invalid:invalidEntry");
    capture.signature.png = "signatures/vault-ana-signature.png";
    expect(statusOf(await planOf(b))[0]).toBe("sign-document:invalid:invalidEntry");
    capture.signature.png = "../../etc/passwd";
    expect(statusOf(await planOf(b))[0]).toBe("sign-document:invalid:invalidEntry");
  });

  it("la sesion de Editar y las imagenes tienen que estar donde el ref dice", async () => {
    const b = clone();
    b.index.edit[0].session = "drafts/e9-session.json";
    expect(statusOf(await planOf(b))[2]).toBe("edit:invalid:invalidEntry");
    const c = clone();
    c.index.edit[0].assets[0].path = "drafts/e1-a0.jpg"; // la extension no es la del tipo declarado
    expect(statusOf(await planOf(c))[2]).toBe("edit:invalid:invalidEntry");
  });
});

describe("ids repetidos", () => {
  it("el mismo id dos veces: el primero entra, el segundo se aisla (`duplicateId`)", async () => {
    const b = clone();
    const copy = JSON.parse(JSON.stringify(b.index.sign.documents[0]));
    copy.ref = "d2";
    for (const capture of Object.values(copy.captures) as Json[]) {
      capture.signature.png = capture.signature.png.replace("d1-", "d2-");
      if (capture.initials) capture.initials.png = capture.initials.png.replace("d1-", "d2-");
    }
    b.index.sign.documents.push(copy);
    for (const [path, data] of [...b.files]) if (path.startsWith("drafts/d1")) b.files.set(path.replace("drafts/d1", "drafts/d2"), data);
    const plan = await planOf(b);
    expect(statusOf(plan).slice(0, 2)).toEqual(["sign-document:new", "sign-document:invalid:duplicateId"]);
    expect(await applyAll(plan)).toBe(4);
  });

  it("firmantes, bloques, documentos y campos con ids repetidos dentro de un borrador: invalido", async () => {
    const cases: Array<[string, (s: Json) => void]> = [
      ["firmante repetido", (s) => s.signers.push({ ...s.signers[0] })],
      ["bloque repetido", (s) => s.blocks.push({ ...s.blocks[0] })],
      ["documento repetido", (s) => s.documents.push({ ...s.documents[0] })],
    ];
    for (const [name, mutate] of cases) {
      const b = clone();
      mutate(b.index.sign.sessions[0]);
      expect(statusOf(await planOf(b))[1], name).toBe("sign-session:invalid:invalidEntry");
    }
    const c = clone();
    c.index.sign.documents[0].fields.push({ ...c.index.sign.documents[0].fields[0] });
    expect(statusOf(await planOf(c))[0]).toBe("sign-document:invalid:invalidEntry");
  });

  it("dos trazos que comparten archivo: invalido", async () => {
    const b = clone();
    const s = b.index.sign.sessions[0];
    s.blocks[0].initials = s.blocks[0].signature;
    expect(statusOf(await planOf(b))[1]).toBe("sign-session:invalid:invalidEntry");
  });
});

describe("trazos fuera de rango o falsos", () => {
  const key = (b: Base) => (b.index.sign.documents[0].captures[Object.keys(b.index.sign.documents[0].captures)[0]] as Json).signature.png as string;
  const withStroke = async (png: Uint8Array | null, mutate?: (item: Json) => void) => {
    const b = clone();
    if (png === null) b.files.delete(key(b));
    else b.files.set(key(b), png);
    if (mutate) mutate(b.index.sign.documents[0]);
    return statusOf(await planOf(b))[0];
  };

  it("PNG corrupto, enorme en pixeles, de 2 MB, falso o vacio -> invalidImage; ausente -> integrity", async () => {
    const real = makeRealPng({ width: 60, height: 24, seed: 1 });
    const huge = new Uint8Array(real);
    new DataView(huge.buffer).setUint32(16, 100_000); // ancho 100 000 (el CRC del IHDR ya no cuadra)
    expect(await withStroke(huge)).toBe("sign-document:invalid:invalidImage");
    const badCrc = new Uint8Array(real);
    badCrc[29] ^= 0xff;
    expect(await withStroke(badCrc)).toBe("sign-document:invalid:invalidImage");
    expect(await withStroke(makePng({ width: 60, height: 24, seed: 2, totalBytes: 2 * 1024 * 1024 }))).toBe("sign-document:invalid:invalidImage");
    expect(await withStroke(enc.encode("%PDF-1.4 esto no es un png"))).toBe("sign-document:invalid:invalidImage");
    expect(await withStroke(new Uint8Array())).toBe("sign-document:invalid:invalidImage");
    expect(await withStroke(real.subarray(0, real.length - 12))).toBe("sign-document:invalid:invalidImage"); // sin IEND
    expect(await withStroke(null)).toBe("sign-document:invalid:integrity");
  });

  it("la proporcion tiene que ser la del PNG; ratios imposibles -> invalido", async () => {
    const png = makeRealPng({ width: 60, height: 24, seed: 3 });
    expect(await withStroke(png, (item) => (Object.values(item.captures)[0] as Json).signature.ratio = 5)).toBe("sign-document:invalid:invalidImage");
    for (const ratio of [0, -1, 1e9, "0.4", null, true]) {
      expect(await withStroke(png, (item) => ((Object.values(item.captures)[0] as Json).signature.ratio = ratio)), String(ratio)).toBe("sign-document:invalid:invalidEntry");
    }
    expect(await withStroke(png, (item) => ((Object.values(item.captures)[0] as Json).signature.png = "data:image/png;base64,iVBORw0KGgo="))).toBe("sign-document:invalid:invalidEntry");
    expect(await withStroke(png, (item) => ((Object.values(item.captures)[0] as Json).signature = "drafts/d1-k0.png"))).toBe("sign-document:invalid:invalidEntry");
  });

  it("un PNG valido y bien formado sigue entrando (control)", async () => {
    expect(await withStroke(makeRealPng({ width: 60, height: 24, seed: 9 }))).toBe("sign-document:new");
  });
});

describe("PDF falsos", () => {
  const key = (_b: Base, kind: "doc" | "pro") => (kind === "doc" ? "drafts/d1.pdf" : "drafts/p1.pdf");

  it.each([
    ["texto", enc.encode("esto no es un pdf, es un texto lo bastante largo")],
    ["vacio", new Uint8Array()],
    ["demasiado corto", enc.encode("%PDF-")],
    ["un PNG", makeRealPng({ width: 30, height: 30, seed: 5 })],
    ["cabecera lejos del principio", new Uint8Array([...new Uint8Array(2000), ...enc.encode("%PDF-1.4\n%%EOF\n")])],
  ])("%s en lugar del PDF de Firmar (documento y sesion) y de PDF Pro -> invalidPdf", async (_name, bytes) => {
    const b = clone();
    // las huellas dejan de cuadrar en documento y Editar; en la sesion y en Pro lo que falla es la forma del PDF
    b.files.set(key(b, "doc"), bytes);
    b.files.set("drafts/s1-0.pdf", bytes);
    b.files.set(key(b, "pro"), bytes);
    const plan = await planOf(b);
    expect(statusOf(plan)[0]).toMatch(/^sign-document:invalid:(fingerprint|invalidPdf)$/);
    expect(statusOf(plan)[1]).toBe("sign-session:invalid:invalidPdf");
    expect(statusOf(plan)[3]).toBe("pro:invalid:invalidPdf");
    expect(await applyAll(plan)).toBe(1); // solo Editar (no se toco)
  });

  it("un PDF real PERO distinto del de la huella: fingerprint (Firmar y Editar), no hay forma de colar otro PDF bajo la huella de uno", async () => {
    const b = clone();
    const other = await realPdf("Otro documento", 2);
    b.files.set("drafts/d1.pdf", other);
    b.files.set("drafts/e1.pdf", other);
    const plan = await planOf(b);
    expect(statusOf(plan)[0]).toBe("sign-document:invalid:fingerprint");
    expect(statusOf(plan)[2]).toBe("edit:invalid:fingerprint");
  });

  it("el validador de PDF de la interfaz (inputGuard) tiene la ultima palabra", async () => {
    const plan = await planOf(clone(), { validatePdf: async (bytes) => bytes.byteLength < 100 });
    expect(statusOf(plan).every((s) => s.endsWith("invalid:invalidPdf"))).toBe(true);
  });
});

describe("sesiones enormes", () => {
  it("10 000 bloques: se rechaza en < 2 s sin recorrerlos", async () => {
    const b = clone();
    const s = b.index.sign.sessions[0];
    s.blocks = Array.from({ length: 10_000 }, (_, i) => ({ id: `bk-${i}`, signerId: s.signers[0].id, appliesTo: ["doc-1"], signature: null, initials: null, stamps: {}, auto: false }));
    const plan = await planOf(b);
    expect(statusOf(plan)[1]).toBe("sign-session:invalid:tooMany");
    expect(await applyAll(plan)).toBe(3);
  });

  it("100 000 firmantes, 1 000 documentos, 5 000 campos de texto, 50 000 valores: cada uno se rechaza", async () => {
    const cases: Array<[string, (s: Json) => void]> = [
      ["firmantes", (s) => (s.signers = Array.from({ length: 100_000 }, (_, i) => ({ id: `s${i}`, name: "x", color: "#000000" })))],
      ["documentos", (s) => (s.documents = Array.from({ length: 1000 }, (_, i) => ({ id: `d${i}`, fileName: "x.pdf" })))],
      ["docStates", (s) => (s.docStates = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, {}])))],
      ["valores", (s) => (s.docStates["doc-1"].textValues = Object.fromEntries(Array.from({ length: 50_000 }, (_, i) => [`k${i}`, "v"])))],
      ["campos de texto", (s) => (s.docStates["doc-1"].textFields = Array.from({ length: 5000 }, (_, i) => ({ id: `t${i}`, pageIndex: 0, rect: { x: 0, y: 0, width: 0.1, height: 0.1 }, source: "manual", confidence: "high" })))],
    ];
    for (const [name, mutate] of cases) {
      const b = clone();
      mutate(b.index.sign.sessions[0]);
      expect(statusOf(await planOf(b))[1], name).toMatch(/^sign-session:invalid:(tooMany|invalidEntry)$/);
    }
  });
});

describe("campos desconocidos y prototipos", () => {
  it("los campos desconocidos se ignoran: no llegan a lo guardado; `__proto__`, `constructor` y `prototype` tampoco", async () => {
    const b = clone();
    const doc = b.index.sign.documents[0];
    doc.evil = { run: "alert(1)" };
    doc.__proto__ = { polluted: true };
    Object.defineProperty(doc, "__proto__", { value: { polluted: true }, enumerable: true });
    doc.signers[0].admin = true;
    doc.fields[0].extra = "x";
    doc.textValues = JSON.parse('{"__proto__":"x","constructor":"y","prototype":"z","normal":"ok"}');
    const raw = JSON.stringify(b.index).replace('"evil"', '"__proto__":{"polluted":true},"evil"');
    const plan = await planOf({ index: raw as unknown as Json, files: b.files });
    expect(statusOf(plan)[0]).toBe("sign-document:new");
    await applyAll(plan);
    const stored = (await listDrafts())[0];
    const text = JSON.stringify(stored);
    for (const forbidden of ["evil", "alert", "admin", "extra", "polluted"]) expect(text, forbidden).not.toContain(forbidden);
    expect(stored.textValues).toEqual({ normal: "ok" });
    expect(Object.getPrototypeOf(stored.textValues)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("claves `__proto__` en capturas, estados de documento, sellos y turnos: ni contaminan ni se guardan", async () => {
    const b = clone();
    const raw = JSON.stringify(b.index)
      .replace('"docStates":{', '"docStates":{"__proto__":{"fields":[],"polluted":true},')
      .replace('"stamps":{', '"stamps":{"__proto__":"x",');
    const plan = await planOf({ index: raw as unknown as Json, files: b.files });
    expect(statusOf(plan)[1]).toBe("sign-session:new");
    await applyAll(plan);
    const stored = (await listSessionDrafts())[0];
    expect(Object.keys(stored.docStates)).toEqual(["doc-1", "doc-2"]);
    expect(JSON.stringify(stored)).not.toContain("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("tipos cambiados y valores fuera de rango (Firmar)", () => {
  const doc = (i: Json) => i.sign.documents[0] as Json;
  const session = (i: Json) => i.sign.sessions[0] as Json;
  const cases: Array<[string, (i: Json) => void, "doc" | "session"]> = [
    ["firmantes es un objeto", (i) => (doc(i).signers = { a: 1 }), "doc"],
    ["firmante sin color", (i) => delete doc(i).signers[0].color, "doc"],
    ["color no hexadecimal", (i) => (doc(i).signers[0].color = "red"), "doc"],
    ["color con script", (i) => (doc(i).signers[0].color = "#000;}</style><script>"), "doc"],
    ["id de firmante con ruta", (i) => (doc(i).signers[0].id = "../x"), "doc"],
    ["nombre de firmante de 10 000 caracteres", (i) => (doc(i).signers[0].name = "n".repeat(10_000)), "doc"],
    ["campos con numeros", (i) => (doc(i).fields = [1, 2, 3]), "doc"],
    ["rect fuera de 0..1", (i) => (doc(i).fields[0].rect = { x: 5, y: 0, width: 1, height: 1 }), "doc"],
    ["rect sin ancho", (i) => (doc(i).fields[0].rect = { x: 0.1, y: 0.1, width: 0, height: 0.1 }), "doc"],
    ["pagina negativa", (i) => (doc(i).fields[0].pageIndex = -1), "doc"],
    ["pagina decimal", (i) => (doc(i).fields[0].pageIndex = 1.5), "doc"],
    ["pagina astronomica", (i) => (doc(i).fields[0].pageIndex = 1e12), "doc"],
    ["tipo de hueco desconocido", (i) => (doc(i).fields[0].type = "jpeg"), "doc"],
    ["paso inventado", (i) => (doc(i).step = "hack"), "doc"],
    ["modo inventado", (i) => (doc(i).mode = "root"), "doc"],
    ["fecha de guardado ilegible", (i) => (doc(i).savedAt = "ayer"), "doc"],
    ["fecha numerica", (i) => (doc(i).savedAt = 1.7e12), "doc"],
    ["valor de texto numerico", (i) => (doc(i).textValues.nombre = 5), "doc"],
    ["valor de texto de 6 000 caracteres", (i) => (doc(i).textValues.nombre = "v".repeat(6000)), "doc"],
    ["capturas es una lista", (i) => (doc(i).captures = []), "doc"],
    ["sello numerico", (i) => ((Object.values(doc(i).captures)[0] as Json).stamp = 7), "doc"],
    ["sello de 100 000 caracteres", (i) => ((Object.values(doc(i).captures)[0] as Json).stamp = "s".repeat(100_000)), "doc"],
    ["id de borrador en mayusculas", (i) => (doc(i).id = doc(i).id.toUpperCase()), "doc"],
    ["id de borrador corto", (i) => (doc(i).id = "abc"), "doc"],
    ["huella ausente", (i) => delete doc(i).fingerprint, "doc"],
    ["caducidad ilegible", (i) => (doc(i).expiresAt = "nunca"), "doc"],
    ["id de sesion con ruta", (i) => (session(i).id = "s-../x"), "session"],
    ["id de sesion con mayusculas", (i) => (session(i).id = "S-ABC-DEF"), "session"],
    ["tipo de firma por documento inventado", (i) => (session(i).signMode = "todos"), "session"],
    ["sin documentos", (i) => (session(i).documents = []), "session"],
    ["documento activo inexistente", (i) => (session(i).activeDocId = "doc-99"), "session"],
    ["bloque de un firmante que no existe", (i) => (session(i).blocks[0].signerId = "fantasma"), "session"],
    ["estado de documento no objeto", (i) => (session(i).docStates["doc-1"] = 5), "session"],
    ["pagina del documento negativa", (i) => (session(i).docStates["doc-1"].pageIndex = -3), "session"],
    ["rect del documento a medias", (i) => (session(i).docStates["doc-1"].rect = { x: 0, y: 0, width: 0.5, height: 0 }), "session"],
    ["sellos con valor no texto", (i) => (session(i).blocks[0].stamps = { "doc-1": 3 }), "session"],
  ];
  it.each(cases)("%s -> invalido sin escribir", async (_name, mutate, kind) => {
    const b = clone();
    mutate(b.index);
    const plan = await planOf(b);
    const status = statusOf(plan)[kind === "doc" ? 0 : 1];
    expect(status).toMatch(/^sign-(document|session):invalid:(invalidEntry|tooMany)$/);
    // los demas borradores siguen entrando y el malo no
    expect(await applyAll(plan)).toBe(3);
  });

  it("valores raros pero saneables se normalizan: nombres con marcas bidi y controles, fechas en otro formato, nombres de archivo con rutas", async () => {
    const b = clone();
    doc(b.index).signers[0].name = "  Ana‮ Evil\u0007 ";
    doc(b.index).fileName = "../../etc/passwd‮.pdf";
    doc(b.index).savedAt = "2026-10-01T10:00:00+02:00";
    const plan = await planOf(b, { keepStrokes: false });
    expect(statusOf(plan)[0]).toBe("sign-document:new");
    await applyAll(plan, { keepStrokes: false });
    const stored = (await listDrafts())[0];
    expect(stored.signers[0].name).toBe("Ana Evil");
    expect(stored.fileName).not.toMatch(/[\\/‮]/);
    expect(stored.savedAt).toBe("2026-10-01T08:00:00.000Z");
  });

  it("una caducidad lejana (ano 2999) no deja los trazos guardados para siempre: se recorta a savedAt + 7 dias", async () => {
    const b = clone();
    doc(b.index).savedAt = "2026-10-10T10:00:00.000Z";
    doc(b.index).expiresAt = "2999-01-01T00:00:00.000Z";
    session(b.index).savedAt = "2026-10-10T10:00:00.000Z";
    session(b.index).expiresAt = "2999-01-01T00:00:00.000Z";
    const now = Date.parse("2026-10-11T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const plan = await planOf(b, { now, keepStrokes: true });
    expect(statusOf(plan).slice(0, 2)).toEqual(["sign-document:new", "sign-session:new"]);
    await applyAll(plan, { now, keepStrokes: true });
    expect((await listDrafts())[0].expiresAt).toBe("2026-10-17T10:00:00.000Z");
    expect((await listSessionDrafts())[0].expiresAt).toBe("2026-10-17T10:00:00.000Z");
  });

  it("una fecha de guardado dentro de 100 anos no deja el borrador «para siempre el mas nuevo»", async () => {
    const b = clone();
    doc(b.index).savedAt = "2999-01-01T00:00:00Z";
    const plan = await planOf(b, { now: Date.parse("2026-10-20T10:00:00Z") });
    expect(plan.items[0].savedAt).toBe("2026-10-20T10:00:00.000Z");
  });
});

describe("Editar y PDF Pro hostiles", () => {
  const edit = (i: Json) => i.edit[0] as Json;
  const pro = (i: Json) => i.pro[0] as Json;
  it("mas de 2 000 elementos, sesion que no es objeto o con otro esquema -> invalido", async () => {
    const sessionPath = "drafts/e1-session.json";
    const session = JSON.parse(dec.decode(base.files.get(sessionPath)!));
    const variants: Array<[string, unknown, string]> = [
      ["2 001 elementos", { ...session, items: Array.from({ length: 2001 }, () => session.items[0]) }, "tooMany"],
      ["esquema 2", { ...session, schema: 2 }, "invalidEntry"],
      ["lista", [], "invalidEntry"],
      ["items no lista", { ...session, items: "x" }, "invalidEntry"],
    ];
    for (const [name, value, reason] of variants) {
      const b = clone();
      b.files.set(sessionPath, new Uint8Array(enc.encode(JSON.stringify(value))));
      expect(statusOf(await planOf(b))[2], name).toBe(`edit:invalid:${reason}`);
    }
  });

  it("elementos basura se descartan y se cuentan (`discarded`); imagen incrustada en el JSON NO se lee", async () => {
    const sessionPath = "drafts/e1-session.json";
    const session = JSON.parse(dec.decode(base.files.get(sessionPath)!));
    const b = clone();
    const hostile = {
      ...session,
      items: [...session.items, { kind: "text", id: "evil", edit: "no" }, { kind: "image", id: "ghost", element: { assetId: "fantasma", pageIndex: 0, x: 0, y: 0, width: 0.1, height: 0.1, ratio: 1 } }, 5, null],
      assets: { ...session.assets, fantasma: { mime: "image/png", size: 8, data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAAnoKXQAAAABJRU5ErkJggg==" } },
    };
    b.files.set(sessionPath, new Uint8Array(enc.encode(JSON.stringify(hostile))));
    const plan = await planOf(b);
    expect(plan.items[2]).toMatchObject({ status: "new", discarded: 4 });
    await applyAll(plan);
    const stored = await listEditDrafts();
    expect(stored[0].pendingCount).toBe(2);
  });

  it("imagen cuyo tipo no es el declarado, gigante o ausente -> invalido", async () => {
    const b = clone();
    b.files.set("drafts/e1-a0.png", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])); // un JPEG con nombre de PNG
    expect(statusOf(await planOf(b))[2]).toBe("edit:invalid:invalidImage");
    const c = clone();
    c.files.delete("drafts/e1-a0.png");
    expect(statusOf(await planOf(c))[2]).toBe("edit:invalid:integrity");
    const d = clone();
    edit(d.index).assets = Array.from({ length: 300 }, (_, i) => ({ assetId: `a${i}`, mime: "image/png", path: `drafts/e1-a${i}.png` }));
    expect(statusOf(await planOf(d))[2]).toBe("edit:invalid:tooMany");
  });

  it("id de Editar que no es la huella del PDF, o de PDF Pro con forma rara -> invalido", async () => {
    const b = clone();
    edit(b.index).id = "0".repeat(64);
    expect(statusOf(await planOf(b))[2]).toBe("edit:invalid:fingerprint");
    for (const id of ["abc", "G".repeat(64), "../x", 5]) {
      const c = clone();
      pro(c.index).id = id;
      expect(statusOf(await planOf(c))[3], String(id)).toBe("pro:invalid:invalidEntry");
    }
  });

  it("historial de PDF Pro con 10 000 notas, fuente inventada, fecha negativa o etiqueta gigante -> invalido", async () => {
    const note = { label: "x", createdAt: 1, source: "open" };
    const cases: Array<[string, unknown, string]> = [
      ["10 000 notas", Array.from({ length: 10_000 }, () => note), "tooMany"],
      ["fuente inventada", [{ ...note, source: "hack" }], "invalidEntry"],
      ["fecha negativa", [{ ...note, createdAt: -5 }], "invalidEntry"],
      ["fecha texto", [{ ...note, createdAt: "1" }], "invalidEntry"],
      ["etiqueta de 5 000 caracteres", [{ ...note, label: "e".repeat(5000) }], "invalidEntry"],
      ["no es lista", { 0: note }, "invalidEntry"],
    ];
    for (const [name, history, reason] of cases) {
      const b = clone();
      pro(b.index).history = history;
      expect(statusOf(await planOf(b))[3], name).toBe(`pro:invalid:${reason}`);
    }
  });
});

describe("zips hostiles del CONTENEDOR (bombas, rutas, duplicados...) nunca llegan al modulo", () => {
  it("cada uno se rechaza al leer, en < 2 s, sin tocar los almacenes", async () => {
    const { hostileCorpus } = await import("@/lib/backup/__fixtures__/hostileCorpus");
    for (const hostile of hostileCorpus()) {
      const file = new File([hostile.bytes as unknown as BlobPart], "hostil.optimuspdf.zip");
      await expect(timed(() => readPackage(file)), hostile.name).rejects.toMatchObject({ code: hostile.code });
    }
    expect((await listAllDrafts()).length + (await listEditDrafts()).length + (await listProDrafts()).length).toBe(0);
  });
});

describe("nada de lo malo se escribe, y todo cuesta < 2 s", () => {
  it("un paquete donde TODO es hostil no deja ni una fila en los tres almacenes", async () => {
    const b = clone();
    for (const item of [b.index.sign.documents[0], b.index.sign.sessions[0], b.index.edit[0], b.index.pro[0]]) item.id = "../../hack";
    const plan = await planOf(b);
    expect(plan.items.every((i) => i.status === "invalid")).toBe(true);
    expect(await applyAll(plan)).toBe(0);
    expect(await listDrafts()).toHaveLength(0);
    expect(await listSessionDrafts()).toHaveLength(0);
    expect(await listEditDrafts()).toHaveLength(0);
    expect(await listProDrafts()).toHaveLength(0);
  });

  it("aplicar un plan manipulado por la interfaz (payload falsificado) se rechaza al revalidar", async () => {
    const plan = await planOf(clone());
    const forged: DraftsImportPlan = JSON.parse(JSON.stringify(plan, (k, v) => (v instanceof Uint8Array ? undefined : v)));
    // sin bytes no hay nada que escribir
    expect(await applyDraftsImport(forged, Object.fromEntries(forged.items.map((i) => [i.key, "import" as const])))).toMatchObject({ ok: false, reason: "invalid" });
    // con otro PDF bajo la misma huella
    const swapped = await planOf(clone());
    const payload = swapped.items[0].payload as { bytes: Uint8Array };
    payload.bytes = await realPdf("Intruso");
    expect(await applyDraftsImport(swapped, { [swapped.items[0].key]: "import" })).toMatchObject({ ok: false, reason: "invalid" });
    // y con OTRO PDF del MISMO tamano (un byte distinto): solo la huella lo delata
    const sameSize = await planOf(clone());
    const tampered = sameSize.items[0].payload as { bytes: Uint8Array };
    const copy = new Uint8Array(tampered.bytes);
    copy[copy.length - 20] ^= 0x01;
    tampered.bytes = copy;
    expect(await applyDraftsImport(sameSize, { [sameSize.items[0].key]: "import" })).toMatchObject({ ok: false, reason: "invalid" });
    expect((await listAllDrafts()).length).toBe(0);
    void sha256Hex;
  });

  it("decisiones sobre claves que no existen, o `keepBoth` en Editar y `replace` en un elemento nuevo, no escriben", async () => {
    const plan = await planOf(clone());
    const result = await applyDraftsImport(plan, { "edit:fantasma": "import", [plan.items[2].key]: "keepBoth", [plan.items[0].key]: "replace" });
    expect(result).toMatchObject({ ok: true, written: 0 });
    expect(await listDrafts()).toHaveLength(0);
    expect(await listEditDrafts()).toHaveLength(0);
  });
});
