import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { PDFDocument } from "@cantoo/pdf-lib";
import JSZip from "jszip";
import { downloadFile } from "../helpers/downloads";
import { getPageCount, getPageText } from "../helpers/pdf-inspection";
import {
  SIGN_PDF_FEATURE_FLAGS,
  SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY,
  SIGN_PDF_FEATURE_FLAGS_VERSION_KEY,
} from "../../src/app/sign-pdf/signFeatureFlags";
import {
  SIGNER_1,
  SIGNER_2,
  continueToSign,
  defineSigners,
  makeSyntheticPdf,
  makeTwoDocs,
  openSignAndUpload,
  placeSlotsInSingleDocument,
  prepareTwoDocsTwoSigners,
  signWholeTurn,
  drawInOpenComposer,
} from "../helpers/sign-flow";

/**
 * F0-U0.5 · «Registro de firmas» (antes «Certificado de finalizacion»): navegador real, headless, escritorio.
 *
 *  - Por defecto el PDF firmado tiene EXACTAMENTE las paginas del original (1 documento y ZIP de varios), sea un usuario
 *    nuevo o uno con ajustes ANTIGUOS (que tenia el certificado a `true` grabado: se migra a `false` una sola vez).
 *  - Con la pagina «Registro de firmas» activada, una pagina mas con la aclaracion de que no es una firma certificada.
 *  - Con «Incluir registro .json aparte»: `registro-firmas.json` en el ZIP (o «Descargar registro (.json)» con un solo
 *    documento), con el hash SHA-256 verificable recalculandolo. Nunca dentro del PDF.
 */

test.use({ locale: "es-ES", viewport: { width: 1280, height: 900 }, acceptDownloads: true });
test.setTimeout(180_000);

const ZIP_NAME = "Firmados - 2 documentos.zip";
const PAGES_PER_DOC = 2;

/** Todos los interruptores encendidos (menos los dos nuevos) con el certificado a `true`: lo que dejaba la version 1. */
function legacyFlags(): string {
  const all: Record<string, boolean> = {};
  for (const flag of SIGN_PDF_FEATURE_FLAGS) all[flag] = flag !== "signingRecordFile";
  return JSON.stringify(all);
}

/** Ajustes ya en la version 2 (sin migracion) con los interruptores indicados. */
function currentFlags(flags: Record<string, boolean>): Record<string, string> {
  return {
    [SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY]: JSON.stringify(flags),
    [SIGN_PDF_FEATURE_FLAGS_VERSION_KEY]: "2",
  };
}

/**
 * Siembra `localStorage` ANTES de que cargue la pagina y UNA sola vez por pestana: una recarga no vuelve a pisar los
 * ajustes (si no, no se podria comprobar que lo que la persona activa se respeta tras recargar).
 */
async function seedLocalStorage(page: Page, entries: Record<string, string>): Promise<void> {
  await page.addInitScript((data) => {
    if (window.sessionStorage.getItem("__seeded")) return;
    for (const [key, value] of Object.entries(data)) window.localStorage.setItem(key, value);
    window.sessionStorage.setItem("__seeded", "1");
  }, entries);
}

const sha256 = (bytes: Uint8Array | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/**
 * Dos documentos, dos firmantes con «Mismas firmas» (un bloque por firmante): la ronda entera hasta el ZIP descargado.
 * Ola 3: con el ultimo firmante la revision y el boton final son UNA pantalla y el ZIP se descarga SOLO al llegar al
 * resultado (la descarga se espera ANTES de pulsar «Firmar y descargar»); «Descargar» queda de respaldo.
 */
async function signTwoDocumentsAndDownloadZip(page: Page): Promise<Buffer> {
  await prepareTwoDocsTwoSigners(page, await makeTwoDocs(), "same");
  await continueToSign(page);
  await signWholeTurn(page, 1, 10, false);
  await signWholeTurn(page, 1, 20, true);
  const { bytes } = await downloadFile(page, async () => {
    await page.getByRole("button", { name: "Firmar y descargar" }).click();
  });
  // El nombre del ZIP sale dos veces (el archivo y la frase «Se ha descargado «…»»): se toma el texto entero.
  await expect(page.getByText(ZIP_NAME, { exact: true })).toBeVisible({ timeout: 60_000 });
  return bytes;
}

/**
 * UN documento de 2 paginas con dos firmantes (un bloque cada uno) hasta la pantalla «Listo». Devuelve el archivo que se
 * descargo SOLO al llegar al resultado (la descarga se espera ANTES de contestar la pregunta del nombre, que arranca el
 * procesado); «Descargar» queda de respaldo en pantalla.
 */
async function signOneDocumentWithTwoSigners(page: Page): Promise<{ bytes: Buffer; filename: string }> {
  await openSignAndUpload(page, [
    { name: "Contrato.pdf", mimeType: "application/pdf", buffer: await makeSyntheticPdf("C", PAGES_PER_DOC) },
  ]);
  await defineSigners(page);
  await placeSlotsInSingleDocument(page);
  await continueToSign(page);
  await signWholeTurn(page, 1, 10, false);
  await signWholeTurn(page, 1, 20, true);
  await page.getByRole("button", { name: "Firmar y descargar" }).click();
  const auto = await downloadFile(page, async () => {
    await page.getByRole("button", { name: "No, dejar el nombre como está" }).click();
  });
  await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible({ timeout: 60_000 });
  return auto;
}

async function pdfsIn(zip: JSZip): Promise<{ name: string; bytes: Buffer }[]> {
  const out: { name: string; bytes: Buffer }[] = [];
  for (const name of Object.keys(zip.files).filter((entry) => entry.endsWith(".pdf")).sort()) {
    out.push({ name, bytes: Buffer.from(await zip.file(name)!.async("uint8array")) });
  }
  return out;
}

async function infoOf(bytes: Buffer): Promise<PDFDocument> {
  return PDFDocument.load(new Uint8Array(bytes), { updateMetadata: false });
}

test.describe("Firmar PDF · registro de firmas · ajustes por defecto", () => {
  for (const scenario of [
    { title: "usuario nuevo (sin ajustes guardados)", seed: {} as Record<string, string>, migrated: false },
    {
      title: "usuario con ajustes ANTIGUOS (certificado a true grabado): migra a apagado",
      seed: { [SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY]: legacyFlags() },
      migrated: true,
    },
  ]) {
    test(`ZIP de dos documentos, ${scenario.title}: cada PDF tiene EXACTAMENTE las paginas del original y no hay mas archivos`, async ({ page }) => {
      await seedLocalStorage(page, scenario.seed);
      const zip = await JSZip.loadAsync(await signTwoDocumentsAndDownloadZip(page));

      // Solo los dos PDF: ni hoja de certificado ni registro .json.
      expect(Object.keys(zip.files).sort()).toEqual([
        "Ana y Luis - Anexo B-firmado.pdf",
        "Ana y Luis - Contrato A-firmado.pdf",
      ]);
      for (const pdf of await pdfsIn(zip)) {
        expect(await getPageCount(pdf.bytes), pdf.name).toBe(PAGES_PER_DOC);
        const text = `${await getPageText(pdf.bytes, 1)} ${await getPageText(pdf.bytes, PAGES_PER_DOC)}`;
        expect(text).not.toMatch(/Registro de firmas|Certificado de finalizaci|SHA-256/);
        // Rastro por defecto: solo metadatos, sin nombres de firmantes.
        const info = await infoOf(pdf.bytes);
        expect(info.getProducer()).toBe("OptimusPDF");
        expect(info.getKeywords()).toContain("optimuspdf-signed");
        expect(info.getModificationDate()).toBeTruthy();
        const meta = [info.getTitle(), info.getAuthor(), info.getSubject(), info.getKeywords(), info.getCreator(), info.getProducer()].join(" ");
        expect(meta).not.toMatch(new RegExp(`${SIGNER_1}|${SIGNER_2}`));
      }
      // Con ajustes antiguos, la migracion quedo grabada con la version (no se repite) y el certificado en `false`;
      // un usuario nuevo no tiene nada que migrar y no se le graba nada hasta que cambie un ajuste.
      const stored = await page.evaluate(
        ([flagsKey, versionKey]) => ({
          version: window.localStorage.getItem(versionKey),
          flags: window.localStorage.getItem(flagsKey),
        }),
        [SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, SIGN_PDF_FEATURE_FLAGS_VERSION_KEY],
      );
      if (scenario.migrated) {
        expect(stored.version).toBe("2");
        expect(JSON.parse(stored.flags ?? "{}").completionCertificate).toBe(false);
      } else {
        expect(stored.version).toBeNull();
        expect(stored.flags).toBeNull();
      }
    });
  }

  test("un documento con dos firmantes: el PDF descargado tiene las paginas del original y NO hay boton de registro", async ({ page }) => {
    const { bytes, filename } = await signOneDocumentWithTwoSigners(page);
    await expect(page.getByRole("button", { name: /Descargar registro/ })).toHaveCount(0);
    expect(filename).toMatch(/\.pdf$/);
    expect(await getPageCount(bytes)).toBe(PAGES_PER_DOC);
    // Respaldo: «Descargar» baja el MISMO archivo otra vez.
    const again = await downloadFile(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    expect(again.filename).toBe(filename);
    expect(await getPageCount(again.bytes)).toBe(PAGES_PER_DOC);
  });

  test("«Solo yo» con un documento de 3 paginas: el PDF descargado tiene 3 paginas", async ({ page }) => {
    await openSignAndUpload(page, [
      { name: "Contrato.pdf", mimeType: "application/pdf", buffer: await makeSyntheticPdf("S", 3) },
    ]);
    await page.getByRole("button", { name: "Crear firma" }).first().click();
    await drawInOpenComposer(page, 3);
    await page.getByRole("button", { name: "Procesar" }).click();
    await expect(page.getByRole("button", { name: "Descargar", exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: /Descargar registro/ })).toHaveCount(0);
    const { bytes } = await downloadFile(page, async () => {
      await page.getByRole("button", { name: "Descargar", exact: true }).click();
    });
    expect(await getPageCount(bytes)).toBe(3);
    expect((await infoOf(bytes)).getProducer()).toBe("OptimusPDF");
  });
});

test.describe("Firmar PDF · página «Registro de firmas» activada", () => {
  test("ZIP de dos documentos: una pagina mas por PDF, titulada «Registro de firmas», con la aclaracion de que no es una firma certificada", async ({ page }) => {
    await seedLocalStorage(page, currentFlags({ completionCertificate: true }));
    const zip = await JSZip.loadAsync(await signTwoDocumentsAndDownloadZip(page));
    const pdfs = await pdfsIn(zip);
    expect(pdfs).toHaveLength(2);
    for (const pdf of pdfs) {
      expect(await getPageCount(pdf.bytes), pdf.name).toBe(PAGES_PER_DOC + 1);
      const text = await getPageText(pdf.bytes, PAGES_PER_DOC + 1);
      expect(text).toContain("Registro de firmas");
      expect(text).not.toContain("Certificado de finalización");
      expect(text).toContain("No es una firma certificada: solo registra quién firmó y cuándo.");
      expect(text).toContain("SHA-256");
      expect(text).toContain("Ana");
      expect(text).toContain("Luis");
    }
    // El .json sigue apagado: nada mas en el ZIP.
    expect(Object.keys(zip.files).filter((name) => name.endsWith(".json"))).toEqual([]);
  });
});

test.describe("Firmar PDF · «Incluir registro .json aparte»", () => {
  test("ZIP de dos documentos: registro-firmas.json con el hash SHA-256 verificable de cada PDF; los PDF no ganan paginas", async ({ page }) => {
    await seedLocalStorage(page, currentFlags({ signingRecordFile: true }));
    const zip = await JSZip.loadAsync(await signTwoDocumentsAndDownloadZip(page));

    expect(Object.keys(zip.files).sort()).toEqual([
      "Ana y Luis - Anexo B-firmado.pdf",
      "Ana y Luis - Contrato A-firmado.pdf",
      "registro-firmas.json",
    ]);
    const record = JSON.parse(await zip.file("registro-firmas.json")!.async("string")) as {
      type: string;
      hashAlgorithm: string;
      note: string;
      documents: { file: string; sha256: string; pages: number; signers: string[]; signedAt: string }[];
    };
    expect(record.type).toBe("optimuspdf-signing-record");
    expect(record.hashAlgorithm).toBe("SHA-256");
    expect(record.note).toContain("No es una firma certificada");
    expect(record.documents).toHaveLength(2);

    for (const pdf of await pdfsIn(zip)) {
      // Nunca dentro del PDF.
      expect(await getPageCount(pdf.bytes), pdf.name).toBe(PAGES_PER_DOC);
      const row = record.documents.find((item) => item.file === pdf.name);
      expect(row, `fila de ${pdf.name}`).toBeTruthy();
      // Hash recalculado desde el propio ZIP descargado.
      expect(row!.sha256).toBe(sha256(pdf.bytes));
      expect(row!.pages).toBe(PAGES_PER_DOC);
      expect(row!.signers).toEqual([SIGNER_1, SIGNER_2]);
      expect(Number.isNaN(Date.parse(row!.signedAt))).toBe(false);
    }
  });

  test("un documento: «Descargar registro (.json)» entrega un .json cuyo hash es el del PDF descargado", async ({ page }) => {
    await seedLocalStorage(page, currentFlags({ signingRecordFile: true }));
    // El PDF es el que se descargo solo al llegar al resultado; el registro (.json) sale aparte, de su boton.
    const pdf = await signOneDocumentWithTwoSigners(page);
    const recordButton = page.getByRole("button", { name: "Descargar registro (.json)" });
    await expect(recordButton).toBeVisible();
    const record = await downloadFile(page, async () => {
      await recordButton.click();
    });

    expect(record.filename).toBe("registro-firmas.json");
    const json = JSON.parse(record.bytes.toString("utf8")) as {
      documents: { file: string; sha256: string; pages: number; signers: string[] }[];
    };
    expect(json.documents).toHaveLength(1);
    const [row] = json.documents;
    expect(row.file).toBe(pdf.filename);
    expect(row.sha256).toBe(sha256(pdf.bytes));
    expect(row.pages).toBe(PAGES_PER_DOC);
    expect(row.signers).toEqual([SIGNER_1, SIGNER_2]);
    // Y el PDF sigue siendo el del original.
    expect(await getPageCount(pdf.bytes)).toBe(PAGES_PER_DOC);
  });
});

test.describe("Ajustes · registro de firmas", () => {
  test("usuario con ajustes antiguos: «Registro de firmas (página final)» aparece apagado; si lo activa se respeta tras recargar", async ({ page }) => {
    await seedLocalStorage(page, { [SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY]: legacyFlags() });
    await page.goto("/settings");

    const certificate = page.getByRole("checkbox", { name: "Registro de firmas (página final)" });
    const jsonRecord = page.getByRole("checkbox", { name: "Incluir registro .json aparte" });
    await expect(certificate).not.toBeChecked();
    await expect(jsonRecord).not.toBeChecked();
    // Texto visible: lo que es y lo que NO es.
    await expect(page.getByText("No es una firma certificada: solo registra quién firmó y cuándo.").first()).toBeVisible();
    await expect(page.getByText(/Certificado de finalización/)).toHaveCount(0);

    // La casilla real queda tapada por su etiqueta (patron de Ajustes): se pulsa el texto, como hace la persona.
    await page.getByText("Registro de firmas (página final)", { exact: true }).click();
    await expect(certificate).toBeChecked();
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "Registro de firmas (página final)" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Incluir registro .json aparte" })).not.toBeChecked();

    const stored = await page.evaluate(
      ([flagsKey, versionKey]) => ({
        flags: JSON.parse(window.localStorage.getItem(flagsKey) ?? "{}") as Record<string, boolean>,
        version: window.localStorage.getItem(versionKey),
      }),
      [SIGN_PDF_FEATURE_FLAGS_STORAGE_KEY, SIGN_PDF_FEATURE_FLAGS_VERSION_KEY],
    );
    expect(stored.version).toBe("2");
    expect(stored.flags.completionCertificate).toBe(true);
  });

  test("EN: «Signature record (final page)» y «Include a separate .json record», sin textos de «Completion certificate»", async ({ page }) => {
    await seedLocalStorage(page, {});
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Inglés" }).click();
    await expect(page.getByRole("checkbox", { name: "Signature record (final page)" })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "Include a separate .json record" })).not.toBeChecked();
    await expect(page.getByText(/Completion certificate/)).toHaveCount(0);
    await expect(page.getByText(/not a certified signature/i).first()).toBeVisible();
  });
});
