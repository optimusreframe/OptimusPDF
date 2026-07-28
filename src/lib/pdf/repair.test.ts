import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import {
  RepairError,
  assessDamage,
  buildAttempts,
  findLastSequence,
  findSequence,
  readDeclaredPageCount,
  repairHeader,
  repairPdf,
  truncateToLastEndobj,
} from "@/lib/pdf/repair";

/**
 * QUE CUBRE ESTA SUITE (y que no).
 *
 * `repairPdf` tiene dos escaleras. La PRIMERA (reconstruccion estructural
 * con pdf-lib: reindexado, cabecera, recorte de cola) es logica de bytes y
 * de pdf-lib pura, asi que se ejecuta ENTERA y de verdad en el entorno
 * `node` de Vitest (ver `vitest.config.ts`) — sin mocks, sobre PDFs que se
 * corrompen aqui mismo byte a byte.
 *
 * La SEGUNDA (rescate visual con pdf.js: `openPdfDocument` +
 * `renderPageToCanvas` + `canvas.toBlob`) NO se puede ejecutar aqui. Este
 * proyecto corre Vitest con `environment: "node"` y sin `jsdom`/`canvas`,
 * y pdf.js lanza `ReferenceError: DOMMatrix is not defined` antes incluso
 * de rasterizar (mismo limite ya documentado en `compress.test.ts` y
 * `pdfToImages.test.ts`). Por eso aqui solo se verifica que, cuando la
 * primera escalera no puede hacer nada y la segunda tampoco arranca, el
 * motor FALLA en claro con `RepairError` en vez de devolver un PDF vacio
 * dandolo por reparado — que es justo la garantia de honestidad que
 * importa. La reparacion por rasterizado se verifico a mano en navegador
 * real; queda anotado como limitacion, no simulado con dobles.
 */

/* ------------------------------------------------------------------ *
 * Fixtures: un PDF sano y sus versiones corrompidas
 * ------------------------------------------------------------------ */

const ascii = (text: string) =>
  new Uint8Array([...text].map((c) => c.charCodeAt(0)));

async function healthyPdf(pages = 6): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i += 1) {
    const page = document.addPage([595, 842]);
    page.drawText(`Pagina ${i}`, { x: 60, y: 760, size: 18, font });
    // Relleno para que cada pagina tenga un content stream con cuerpo:
    // asi el truncado corta de verdad por la mitad de un stream.
    for (let line = 0; line < 25; line += 1) {
      page.drawText(`Linea ${line} de la pagina ${i}`, {
        x: 60,
        y: 700 - line * 20,
        size: 10,
        font,
      });
    }
  }
  // Sin object streams: deja una tabla `xref` clasica, que es la que se
  // corrompe en los casos reales que esta herramienta atiende.
  return document.save({ useObjectStreams: false });
}

function toFile(bytes: Uint8Array, name: string): File {
  return new File([bytes as unknown as BlobPart], name, {
    type: "application/pdf",
  });
}

/**
 * Pone a "0" las ENTRADAS de la tabla `xref`, dejando intactas la palabra
 * `xref` y la cabecera de subseccion. Es la corrupcion realista: el
 * indice sigue "estando ahi" pero sus offsets ya no valen nada.
 */
function corruptXref(valid: Uint8Array): Uint8Array {
  const copy = new Uint8Array(valid);
  // La tabla real va precedida de salto de linea; `startxref` contiene la
  // subcadena "xref" tambien, asi que se busca "\nxref".
  const table = findLastSequence(copy, ascii("\nxref"));
  const trailer = findSequence(copy, ascii("trailer"), table);
  // +6 salta "\nxref\n" y deja la palabra clave en pie.
  copy.fill(0x30, table + 6, trailer - 1);
  return copy;
}

/** Deja `startxref` apuntando a un offset imposible. */
function corruptStartxref(valid: Uint8Array): Uint8Array {
  const copy = new Uint8Array(valid);
  const pos = findLastSequence(copy, ascii("startxref"));
  copy.set(ascii("999999999"), pos + 10);
  return copy;
}

/** Corta el archivo a mitad de un stream: se pierde toda la cola. */
function truncate(valid: Uint8Array, fraction: number): Uint8Array {
  return valid.subarray(0, Math.floor(valid.length * fraction));
}

/** Machaca los bytes de la cabecera `%PDF-`. */
function corruptHeader(valid: Uint8Array): Uint8Array {
  const copy = new Uint8Array(valid);
  copy.set(ascii("XXXXXXXX"), 0);
  return copy;
}

/** Antepone basura antes de un PDF por lo demas intacto. */
function prependJunk(valid: Uint8Array, size = 300): Uint8Array {
  const junk = new Uint8Array(size).fill(0x41);
  const out = new Uint8Array(junk.length + valid.length);
  out.set(junk, 0);
  out.set(valid, junk.length);
  return out;
}

/* ------------------------------------------------------------------ *
 * Utilidades de bytes
 * ------------------------------------------------------------------ */

describe("findSequence / findLastSequence", () => {
  it("encuentra la primera y la ultima aparicion", () => {
    const hay = ascii("aXXbXXc");
    expect(findSequence(hay, ascii("XX"))).toBe(1);
    expect(findLastSequence(hay, ascii("XX"))).toBe(4);
  });

  it("devuelve -1 cuando no esta, y respeta el offset inicial", () => {
    const hay = ascii("abcabc");
    expect(findSequence(hay, ascii("zz"))).toBe(-1);
    expect(findLastSequence(hay, ascii("zz"))).toBe(-1);
    expect(findSequence(hay, ascii("abc"), 1)).toBe(3);
  });

  it("no se confunde con una coincidencia parcial al final del buffer", () => {
    // "ab" al final no llega a completar "abc": no hay coincidencia.
    expect(findSequence(ascii("zzab"), ascii("abc"))).toBe(-1);
    expect(findLastSequence(ascii("zzab"), ascii("abc"))).toBe(-1);
  });
});

/* ------------------------------------------------------------------ *
 * Diagnostico
 * ------------------------------------------------------------------ */

describe("assessDamage", () => {
  it("no senala ningun dano en un PDF sano", async () => {
    expect(assessDamage(await healthyPdf(2))).toEqual([]);
  });

  it("senala 'header' cuando la cabecera %PDF- no esta en el offset 0", async () => {
    const valid = await healthyPdf(2);
    expect(assessDamage(corruptHeader(valid))).toContain("header");
    expect(assessDamage(prependJunk(valid))).toContain("header");
  });

  it("senala 'startxrefOffset' cuando startxref apunta fuera del archivo", async () => {
    const valid = await healthyPdf(2);
    expect(assessDamage(corruptStartxref(valid))).toContain("startxrefOffset");
  });

  it("senala 'xrefEntries' cuando la tabla existe pero sus entradas son basura", async () => {
    // La palabra `xref` sigue ahi y `startxref` sigue apuntandole: solo
    // validando el FORMATO de las entradas se detecta este dano.
    const valid = await healthyPdf(2);
    const damage = assessDamage(corruptXref(valid));
    expect(damage).toContain("xrefEntries");
    expect(damage).not.toContain("startxrefOffset");
  });

  it("senala 'eof' y 'startxref' en un archivo truncado", async () => {
    const valid = await healthyPdf(6);
    const damage = assessDamage(truncate(valid, 0.62));
    expect(damage).toContain("eof");
    expect(damage).toContain("startxref");
  });

  it("senala 'danglingObject' cuando el ultimo objeto no llega a cerrarse", () => {
    const bytes = ascii("%PDF-1.7\n1 0 obj\n<< /A 1 >>\nendobj\n2 0 obj\n<< /B");
    expect(assessDamage(bytes)).toContain("danglingObject");
  });

  it("no senala nada en un buffer vacio (no hay nada que afirmar)", () => {
    expect(assessDamage(new Uint8Array(0))).toEqual([]);
  });
});

describe("readDeclaredPageCount", () => {
  it("lee el /Count del nodo /Type /Pages", async () => {
    expect(readDeclaredPageCount(await healthyPdf(6))).toBe(6);
  });

  it("sobrevive al truncado: sigue diciendo el total original", async () => {
    // Es lo que permite informar "4 de 6" en vez de solo "4".
    const valid = await healthyPdf(6);
    expect(readDeclaredPageCount(truncate(valid, 0.62))).toBe(6);
  });

  it("devuelve null si no hay ninguna declaracion legible", () => {
    expect(readDeclaredPageCount(ascii("no soy un pdf"))).toBeNull();
  });

  it("no confunde /Type /PagesFoo con /Type /Pages", () => {
    expect(readDeclaredPageCount(ascii("/Type /PagesFoo /Count 9"))).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Transformaciones de reparacion
 * ------------------------------------------------------------------ */

describe("repairHeader", () => {
  it("devuelve null si la cabecera ya esta en su sitio", async () => {
    expect(repairHeader(await healthyPdf(1))).toBeNull();
  });

  it("descarta la basura que haya delante de %PDF-", async () => {
    const valid = await healthyPdf(1);
    const result = repairHeader(prependJunk(valid, 300));
    expect(result).not.toBeNull();
    expect(result?.discarded).toBe(300);
    expect(result?.bytes.length).toBe(valid.length);
  });

  it("antepone una cabecera sintetica si no hay ninguna, sin perder bytes", async () => {
    const valid = await healthyPdf(1);
    const broken = corruptHeader(valid);
    const result = repairHeader(broken);
    expect(result).not.toBeNull();
    expect(result?.discarded).toBe(0);
    expect(result?.bytes.length).toBeGreaterThan(broken.length);
  });
});

describe("truncateToLastEndobj", () => {
  it("devuelve null si no hay ningun endobj", () => {
    expect(truncateToLastEndobj(ascii("basura sin objetos"))).toBeNull();
  });

  it("recorta la cola incompleta y cuenta los bytes descartados", () => {
    const bytes = ascii("1 0 obj\n<< >>\nendobj\n2 0 obj\n<< a medias");
    const result = truncateToLastEndobj(bytes);
    expect(result).not.toBeNull();
    expect(result?.discarded).toBe(bytes.length - result!.bytes.length);
    // El resultado termina EXACTAMENTE en "endobj".
    expect(findLastSequence(result!.bytes, ascii("endobj"))).toBe(
      result!.bytes.length - 6,
    );
  });
});

describe("buildAttempts", () => {
  it("el primer peldano es siempre el original sin tocar", async () => {
    const valid = await healthyPdf(1);
    const attempts = buildAttempts(valid);
    expect(attempts[0].discarded).toBe(0);
    expect(attempts[0].actions).toEqual(["reindexed"]);
  });

  it("acumula las acciones cuando cabecera y cola estan danadas a la vez", async () => {
    const valid = await healthyPdf(3);
    const broken = truncate(prependJunk(valid, 200), 0.7);
    const combined = buildAttempts(broken).find(
      (a) =>
        a.actions.includes("headerRestored") && a.actions.includes("tailTrimmed"),
    );
    expect(combined).toBeDefined();
    expect(combined!.discarded).toBeGreaterThan(200);
  });
});

/* ------------------------------------------------------------------ *
 * Motor completo — escalera estructural (se ejecuta de verdad)
 * ------------------------------------------------------------------ */

describe("repairPdf — reparacion estructural real", () => {
  it("recupera las 6 paginas de un PDF con la tabla xref destruida", async () => {
    const valid = await healthyPdf(6);
    const { blob, report } = await repairPdf(
      toFile(corruptXref(valid), "roto.pdf"),
    );

    expect(report.mode).toBe("structural");
    expect(report.pagesRecovered).toBe(6);
    expect(report.pagesDeclared).toBe(6);
    expect(report.textPreserved).toBe(true);
    expect(report.bytesDiscarded).toBe(0);
    expect(report.damage).toContain("xrefEntries");

    // El resultado es un PDF que se vuelve a abrir de verdad.
    const reopened = await PDFDocument.load(
      new Uint8Array(await blob.arrayBuffer()),
      { updateMetadata: false },
    );
    expect(reopened.getPageCount()).toBe(6);
  });

  it("recupera un PDF con startxref apuntando a la nada", async () => {
    const valid = await healthyPdf(4);
    const { report } = await repairPdf(
      toFile(corruptStartxref(valid), "roto.pdf"),
    );
    expect(report.pagesRecovered).toBe(4);
    expect(report.damage).toContain("startxrefOffset");
  });

  it("restaura la cabecera %PDF- machacada y conserva todas las paginas", async () => {
    const valid = await healthyPdf(6);
    const { report } = await repairPdf(
      toFile(corruptHeader(valid), "roto.pdf"),
    );
    expect(report.actions).toContain("headerRestored");
    expect(report.pagesRecovered).toBe(6);
    expect(report.damage).toContain("header");
  });

  it("con basura antes de %PDF- usa el peldano MENOS invasivo que funcione", async () => {
    // pdf-lib ya localiza la cabecera por su cuenta, asi que el primer
    // peldano (solo reindexar) basta: no hace falta descartar nada. La
    // escalera no debe "arreglar" de mas — pero el diagnostico si deja
    // constancia de que el archivo venia malformado.
    const valid = await healthyPdf(3);
    const junked = prependJunk(valid, 300);
    const { report } = await repairPdf(toFile(junked, "roto.pdf"));

    expect(report.pagesRecovered).toBe(3);
    expect(report.actions).toEqual(["reindexed"]);
    expect(report.bytesDiscarded).toBe(0);
    expect(report.damage).toContain("header");
  });

  it("de un PDF truncado recupera SOLO las paginas que sobrevivieron, y lo dice", async () => {
    // Es el caso que define la honestidad de la herramienta: no se puede
    // recuperar lo que ya no esta en el archivo, y el informe no finge que si.
    const valid = await healthyPdf(6);
    const { report } = await repairPdf(
      toFile(truncate(valid, 0.62), "roto.pdf"),
    );

    expect(report.mode).toBe("structural");
    expect(report.actions).toContain("tailTrimmed");
    expect(report.bytesDiscarded).toBeGreaterThan(0);
    // Se salva parte, no todo.
    expect(report.pagesRecovered).toBeGreaterThan(0);
    expect(report.pagesRecovered).toBeLessThan(6);
    // Y el denominador honesto sigue disponible para poder decir "X de 6".
    expect(report.pagesDeclared).toBe(6);
  });

  it("el PDF entregado NUNCA declara mas paginas de las que trae", async () => {
    // Regresion de un defecto real encontrado verificando en navegador: al
    // reserializar un archivo truncado, pdf-lib conservaba el nodo /Pages
    // original con "/Count 6" y "/Kids" apuntando a dos objetos que ya no
    // existian. El informe decia "4 de 6" pero el PDF entregado afirmaba
    // tener 6 paginas y traia dos referencias colgando.
    const valid = await healthyPdf(6);
    const { blob, report } = await repairPdf(
      toFile(truncate(valid, 0.62), "roto.pdf"),
    );
    const out = new Uint8Array(await blob.arrayBuffer());

    expect(report.actions).toContain("prunedPageTree");

    // El /Count del documento entregado coincide con lo que se informo...
    const reopened = await PDFDocument.load(out, { updateMetadata: false });
    expect(reopened.getPageCount()).toBe(report.pagesRecovered);
    expect(reopened.catalog.Pages().Count().asNumber()).toBe(
      report.pagesRecovered,
    );

    // ...y no queda ningun objeto de pagina de mas ni de menos.
    const text = String.fromCharCode(...out);
    const pageObjects = text.match(/\/Type\s*\/Page(?![s])/g) ?? [];
    expect(pageObjects.length).toBe(report.pagesRecovered);
  });

  it("un PDF sano se devuelve intacto (sin reindexar ni reserializar) y sin declarar danos", async () => {
    // Sin danos detectados no hace falta reescribir el archivo: hacerlo
    // igual invalidaria una firma digital que el original pudiera traer.
    // Ver la nota junto al atajo en `repairPdf` (repair.ts).
    const valid = await healthyPdf(5);
    const { blob, report } = await repairPdf(toFile(valid, "sano.pdf"));
    expect(report.damage).toEqual([]);
    expect(report.actions).toEqual([]);
    expect(report.pagesRecovered).toBe(5);
    expect(report.bytesDiscarded).toBe(0);
    expect(report.outputBytes).toBe(report.inputBytes);
    // Byte a byte: el atajo no debe tocar ni reserializar nada.
    const outBytes = new Uint8Array(await blob.arrayBuffer());
    expect(outBytes).toEqual(valid);
  });

  it("el informe mide los tamanos reales de entrada y salida", async () => {
    const valid = await healthyPdf(3);
    const input = corruptXref(valid);
    const { blob, report } = await repairPdf(toFile(input, "roto.pdf"));
    expect(report.inputBytes).toBe(input.length);
    expect(report.outputBytes).toBe(blob.size);
  });
});

/* ------------------------------------------------------------------ *
 * Fallos honestos
 * ------------------------------------------------------------------ */

describe("repairPdf — falla en claro en vez de fingir exito", () => {
  it("un archivo vacio da RepairError('empty')", async () => {
    await expect(
      repairPdf(toFile(new Uint8Array(0), "vacio.pdf")),
    ).rejects.toBeInstanceOf(RepairError);
    await expect(
      repairPdf(toFile(new Uint8Array(0), "vacio.pdf")),
    ).rejects.toMatchObject({ reason: "empty", code: "empty" });
  });

  it("basura que no contiene ningun PDF nunca devuelve un blob", async () => {
    const junk = new Uint8Array(20000);
    for (let i = 0; i < junk.length; i += 1) junk[i] = (i * 37) % 256;

    // No se acepta "devolvio un PDF de 0 paginas": debe lanzar.
    await expect(repairPdf(toFile(junk, "basura.pdf"))).rejects.toBeInstanceOf(
      RepairError,
    );
  });

  it("respeta la cancelacion por AbortSignal", async () => {
    const valid = await healthyPdf(2);
    const controller = new AbortController();
    controller.abort();
    await expect(
      repairPdf(toFile(valid, "x.pdf"), {}, undefined, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
  });

  it("informa progreso monotono entre 0 y 1 y termina en 1", async () => {
    const valid = await healthyPdf(3);
    const seen: number[] = [];
    await repairPdf(toFile(corruptXref(valid), "roto.pdf"), {}, (p) =>
      seen.push(p),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
    expect(seen.at(-1)).toBe(1);
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    }
  });
});
