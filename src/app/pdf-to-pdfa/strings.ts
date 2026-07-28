import type { Language } from "@/lib/i18n";
import { formatFileSize } from "@/lib/pdf/core";
import type {
  PdfaCheck,
  PdfaCheckId,
  PdfaCheckStatus,
  PdfaReport,
  PdfaVerdict,
} from "@/lib/pdf/pdfaCheck";

/**
 * Copy propia del verificador PDF/A (ES/EN).
 *
 * El motor (`lib/pdf/pdfaCheck.ts`) devuelve codigos, no frases: aqui se
 * convierten en texto. Regla de la herramienta: no prometer conversion ni
 * certificacion en ninguna cadena.
 */

export type PdfaStrings = {
  /** Entradilla de la pagina: se usa en vez de la descripcion global. */
  lead: string;
  noticeTitle: string;
  noticeBody: string;
  run: string;
  processing: string;
  startOver: string;
  downloadReport: string;
  reportFilename: (base: string) => string;
  needFile: string;
  summaryTitle: string;
  checklistTitle: string;
  documentTitle: string;
  verdictTitle: Record<PdfaVerdict, string>;
  verdictBody: Record<PdfaVerdict, string>;
  statusLabel: Record<PdfaCheckStatus, string>;
  countFailed: (count: number) => string;
  countWarnings: (count: number) => string;
  countUnknowns: (count: number) => string;
  countPassed: (count: number) => string;
  checkTitle: Record<PdfaCheckId, string>;
  checkDetail: (check: PdfaCheck) => string;
  factPages: (count: number) => string;
  factPagesUnknown: string;
  factVersion: (version: string) => string;
  factVersionUnknown: string;
  factSize: (size: string) => string;
  factClaim: (label: string) => string;
  factNoClaim: string;
  nextStepsTitle: string;
  nextSteps: string[];
  reportTitle: string;
  reportGenerated: (date: string) => string;
  reportFile: string;
  reportChecks: string;
  reportLimits: string;
};

/** "1" + "B" -> "PDF/A-1b"; sin conformance, "PDF/A-4". */
function claimLabel(report: PdfaReport): string {
  if (!report.claim) return "";
  const level = report.claim.conformance
    ? report.claim.conformance.toLowerCase()
    : "";
  return `PDF/A-${report.claim.part}${level}`;
}

const es: PdfaStrings = {
  lead: "Revisa si tu PDF cumple los requisitos de PDF/A y qué le falta para lograrlo. No convierte el archivo: lo analiza y te dice qué encuentra.",
  noticeTitle: "Qué es y qué no es esta revisión",
  noticeBody:
    "Comprobamos en tu navegador los marcadores estructurales de los que depende PDF/A: identificación en los metadatos, fuentes incrustadas, perfil de color de salida, cifrado, JavaScript y archivos adjuntos. Es un diagnóstico previo, no una certificación: solo un validador como veraPDF puede certificar la conformidad real, y hay requisitos (transparencia, espacios de color por operador, estructura lógica) que esta revisión no mira.",
  run: "Revisar documento",
  processing: "Revisando el documento",
  startOver: "Revisar otro documento",
  downloadReport: "Descargar informe",
  reportFilename: (base) => `${base}-revision-pdfa.md`,
  needFile: "Añade un PDF para revisarlo.",
  summaryTitle: "Resultado",
  checklistTitle: "Comprobaciones",
  documentTitle: "El documento",
  verdictTitle: {
    noIssuesFound: "Sin incumplimientos detectados",
    inconclusive: "Quedan cosas por confirmar",
    notCompliant: "No cumple PDF/A",
  },
  verdictBody: {
    noIssuesFound:
      "Todas las comprobaciones de esta herramienta pasan. Eso no equivale a un certificado PDF/A: para afirmarlo hace falta un validador como veraPDF.",
    inconclusive:
      "No hemos encontrado ningún incumplimiento claro, pero hay casillas que no podemos dar por buenas. Míralas una a una abajo.",
    notCompliant:
      "Hemos encontrado al menos un requisito de PDF/A que el documento no cumple. Abajo tienes cuál y por qué.",
  },
  statusLabel: {
    pass: "Cumple",
    fail: "No cumple",
    warn: "Aviso",
    unknown: "Sin comprobar",
  },
  countFailed: (count) =>
    count === 1 ? "1 incumplimiento" : `${count} incumplimientos`,
  countWarnings: (count) => (count === 1 ? "1 aviso" : `${count} avisos`),
  countUnknowns: (count) =>
    count === 1 ? "1 sin comprobar" : `${count} sin comprobar`,
  countPassed: (count) =>
    count === 1 ? "1 comprobación superada" : `${count} comprobaciones superadas`,
  checkTitle: {
    identification: "Identificación PDF/A en los metadatos",
    fonts: "Fuentes incrustadas",
    outputIntent: "Perfil de color de salida (OutputIntent)",
    encryption: "Sin cifrado",
    javascript: "Sin JavaScript",
    embeddedFiles: "Archivos adjuntos",
  },
  checkDetail: (check) => {
    const count = check.count ?? 0;
    switch (check.code) {
      case "encryptionNone":
        return "El documento no está cifrado.";
      case "encryptionStandard":
        return `El documento está cifrado${
          check.text ? ` (manejador ${check.text})` : ""
        }. PDF/A no admite ningún tipo de cifrado. Puedes quitarlo con Desbloquear PDF si tienes la contraseña.`;
      case "encryptionUnsupported":
        return "El documento usa un método de cifrado que no reconocemos. PDF/A no admite ningún cifrado.";
      case "encryptionUnknown":
        return "No hemos podido determinar si el documento está cifrado.";
      case "identificationClaim":
        return `Los metadatos XMP declaran ${check.text ?? "PDF/A"}. Esto es lo que el archivo dice ser, no una comprobación de que lo sea.`;
      case "identificationNoStream":
        return "El documento no tiene metadatos XMP. PDF/A exige un XMP con la identificación pdfaid:part.";
      case "identificationNoClaim":
        return "Hay metadatos XMP, pero no declaran ninguna parte de PDF/A (falta pdfaid:part). Sin esa declaración el archivo no es PDF/A aunque cumpla lo demás.";
      case "identificationUnreadable":
        return "No hemos podido leer los metadatos XMP del documento.";
      case "fontsNone":
        return "El documento no usa ninguna fuente, así que no hay nada que incrustar.";
      case "fontsAllEmbedded":
        return count === 1
          ? "La única fuente del documento lleva su programa incrustado."
          : `Las ${count} fuentes del documento llevan su programa incrustado.`;
      case "fontsMissing":
        return `${
          count === 1 ? "1 fuente" : `${count} fuentes`
        } sin incrustar: ${(check.names ?? []).join(", ")}. PDF/A exige que todas viajen dentro del archivo; si no, el texto puede cambiar de aspecto en otro equipo.`;
      case "fontsUnreadable":
        return "No hemos podido recorrer la estructura de fuentes del documento.";
      case "outputIntentValid":
        return `Hay un OutputIntent de PDF/A con su perfil de color incrustado${
          check.text ? ` (${check.text})` : ""
        }.`;
      case "outputIntentNoProfile":
        return "Hay un OutputIntent de PDF/A, pero sin el perfil de color (DestOutputProfile) que la norma exige incrustar.";
      case "outputIntentForeign":
        return `Hay ${count === 1 ? "un OutputIntent" : `${count} OutputIntent`} de otro estándar, pero ninguno de PDF/A.`;
      case "outputIntentNone":
        return "No hay OutputIntent. PDF/A lo exige en cuanto el documento usa color dependiente del dispositivo (DeviceRGB, DeviceCMYK o DeviceGray), que es lo habitual. No comprobamos qué colores usa el contenido.";
      case "outputIntentUnreadable":
        return "No hemos podido leer los OutputIntent del documento.";
      case "javascriptNone":
        return "No hemos encontrado acciones JavaScript.";
      case "javascriptFound":
        return `${
          count === 1 ? "1 acción JavaScript" : `${count} acciones JavaScript`
        } en el documento. PDF/A las prohíbe en todas sus partes.`;
      case "javascriptUnreadable":
        return "No hemos podido recorrer todo el documento para buscar acciones JavaScript: no podemos afirmar que no las tenga.";
      case "embeddedFilesNone":
        return "El documento no lleva archivos adjuntos.";
      case "embeddedFilesFound":
        return `${
          count === 1 ? "1 archivo adjunto" : `${count} archivos adjuntos`
        }. PDF/A-1 y PDF/A-2 no los permiten; PDF/A-3 y PDF/A-4 sí.`;
      case "embeddedFilesUnreadable":
        return "No hemos podido recorrer todo el documento para buscar archivos adjuntos: no podemos afirmar que no lleve.";
      default:
        return "";
    }
  },
  factPages: (count) => (count === 1 ? "1 página" : `${count} páginas`),
  factPagesUnknown: "Páginas no legibles",
  factVersion: (version) => `PDF ${version}`,
  factVersionUnknown: "Versión desconocida",
  factSize: (size) => size,
  factClaim: (label) => `Se declara ${label}`,
  factNoClaim: "No declara PDF/A",
  nextStepsTitle: "Si necesitas un PDF/A de verdad",
  nextSteps: [
    "Esta herramienta no convierte: para producir un PDF/A hay que reescribir el archivo (incrustar fuentes, añadir el perfil de color y la identificación XMP), algo que hoy no hacemos en el navegador.",
    "Exporta directamente a PDF/A desde el programa de origen: Word, LibreOffice, InDesign y Acrobat lo ofrecen en su diálogo de exportación.",
    "Para certificar el resultado, pásalo por veraPDF: es el validador de referencia del estándar.",
  ],
  reportTitle: "Revisión PDF/A",
  reportGenerated: (date) => `Generado el ${date} con OptimusPDF, en el navegador.`,
  reportFile: "Archivo",
  reportChecks: "Comprobaciones",
  reportLimits:
    "Esta revisión es heurística y estructural: no es una validación certificada. No comprueba transparencia, espacios de color por operador de contenido, compresiones prohibidas, mapas ToUnicode ni estructura lógica. Para certificar conformidad usa veraPDF.",
};

const en: PdfaStrings = {
  lead: "Check whether your PDF meets the PDF/A requirements and what it is missing. This tool does not convert the file: it inspects it and tells you what it finds.",
  noticeTitle: "What this check is and is not",
  noticeBody:
    "We check, in your browser, the structural markers PDF/A depends on: metadata identification, embedded fonts, output colour profile, encryption, JavaScript and attachments. This is a pre-flight diagnosis, not a certification: only a validator such as veraPDF can certify real conformance, and there are requirements (transparency, per-operator colour spaces, logical structure) this check does not look at.",
  run: "Check document",
  processing: "Checking the document",
  startOver: "Check another document",
  downloadReport: "Download report",
  reportFilename: (base) => `${base}-pdfa-check.md`,
  needFile: "Add a PDF to check it.",
  summaryTitle: "Result",
  checklistTitle: "Checks",
  documentTitle: "The document",
  verdictTitle: {
    noIssuesFound: "No breaches found",
    inconclusive: "Some things could not be confirmed",
    notCompliant: "Does not meet PDF/A",
  },
  verdictBody: {
    noIssuesFound:
      "Every check in this tool passes. That is not the same as a PDF/A certificate: claiming conformance needs a validator such as veraPDF.",
    inconclusive:
      "We found no clear breach, but some checks could not be confirmed. Go through them one by one below.",
    notCompliant:
      "We found at least one PDF/A requirement the document does not meet. Below is which one and why.",
  },
  statusLabel: {
    pass: "Meets it",
    fail: "Does not meet it",
    warn: "Warning",
    unknown: "Not checked",
  },
  countFailed: (count) => (count === 1 ? "1 breach" : `${count} breaches`),
  countWarnings: (count) => (count === 1 ? "1 warning" : `${count} warnings`),
  countUnknowns: (count) =>
    count === 1 ? "1 not checked" : `${count} not checked`,
  countPassed: (count) => (count === 1 ? "1 check passed" : `${count} checks passed`),
  checkTitle: {
    identification: "PDF/A identification in the metadata",
    fonts: "Embedded fonts",
    outputIntent: "Output colour profile (OutputIntent)",
    encryption: "No encryption",
    javascript: "No JavaScript",
    embeddedFiles: "Attachments",
  },
  checkDetail: (check) => {
    const count = check.count ?? 0;
    switch (check.code) {
      case "encryptionNone":
        return "The document is not encrypted.";
      case "encryptionStandard":
        return `The document is encrypted${
          check.text ? ` (${check.text} handler)` : ""
        }. PDF/A allows no encryption at all. You can remove it with Unlock PDF if you have the password.`;
      case "encryptionUnsupported":
        return "The document uses an encryption method we do not recognise. PDF/A allows no encryption at all.";
      case "encryptionUnknown":
        return "We could not determine whether the document is encrypted.";
      case "identificationClaim":
        return `The XMP metadata declares ${check.text ?? "PDF/A"}. That is what the file says it is, not proof that it is.`;
      case "identificationNoStream":
        return "The document has no XMP metadata. PDF/A requires XMP carrying the pdfaid:part identification.";
      case "identificationNoClaim":
        return "There is XMP metadata, but it declares no PDF/A part (pdfaid:part is missing). Without that declaration the file is not PDF/A even if it meets everything else.";
      case "identificationUnreadable":
        return "We could not read the document's XMP metadata.";
      case "fontsNone":
        return "The document uses no fonts, so there is nothing to embed.";
      case "fontsAllEmbedded":
        return count === 1
          ? "The document's only font carries its embedded font program."
          : `All ${count} fonts in the document carry their embedded font program.`;
      case "fontsMissing":
        return `${
          count === 1 ? "1 font is" : `${count} fonts are`
        } not embedded: ${(check.names ?? []).join(", ")}. PDF/A requires every font to travel inside the file; otherwise the text can look different on another machine.`;
      case "fontsUnreadable":
        return "We could not walk the document's font structure.";
      case "outputIntentValid":
        return `There is a PDF/A OutputIntent with its colour profile embedded${
          check.text ? ` (${check.text})` : ""
        }.`;
      case "outputIntentNoProfile":
        return "There is a PDF/A OutputIntent, but without the embedded colour profile (DestOutputProfile) the standard requires.";
      case "outputIntentForeign":
        return `There ${count === 1 ? "is 1 OutputIntent" : `are ${count} OutputIntents`} for another standard, but none for PDF/A.`;
      case "outputIntentNone":
        return "There is no OutputIntent. PDF/A requires one as soon as the document uses device-dependent colour (DeviceRGB, DeviceCMYK or DeviceGray), which is the usual case. We do not check which colours the content actually uses.";
      case "outputIntentUnreadable":
        return "We could not read the document's OutputIntents.";
      case "javascriptNone":
        return "We found no JavaScript actions.";
      case "javascriptFound":
        return `${
          count === 1 ? "1 JavaScript action" : `${count} JavaScript actions`
        } in the document. Every part of PDF/A forbids them.`;
      case "javascriptUnreadable":
        return "We could not walk the whole document looking for JavaScript actions: we cannot claim it has none.";
      case "embeddedFilesNone":
        return "The document carries no attachments.";
      case "embeddedFilesFound":
        return `${count === 1 ? "1 attachment" : `${count} attachments`}. PDF/A-1 and PDF/A-2 do not allow them; PDF/A-3 and PDF/A-4 do.`;
      case "embeddedFilesUnreadable":
        return "We could not walk the whole document looking for attachments: we cannot claim it has none.";
      default:
        return "";
    }
  },
  factPages: (count) => (count === 1 ? "1 page" : `${count} pages`),
  factPagesUnknown: "Page count unreadable",
  factVersion: (version) => `PDF ${version}`,
  factVersionUnknown: "Unknown version",
  factSize: (size) => size,
  factClaim: (label) => `Declares ${label}`,
  factNoClaim: "Declares no PDF/A",
  nextStepsTitle: "If you really need a PDF/A",
  nextSteps: [
    "This tool does not convert: producing a PDF/A means rewriting the file (embedding fonts, adding the colour profile and the XMP identification), which we do not do in the browser today.",
    "Export straight to PDF/A from the source program: Word, LibreOffice, InDesign and Acrobat all offer it in their export dialog.",
    "To certify the result, run it through veraPDF: it is the standard's reference validator.",
  ],
  reportTitle: "PDF/A check",
  reportGenerated: (date) => `Generated on ${date} with OptimusPDF, in the browser.`,
  reportFile: "File",
  reportChecks: "Checks",
  reportLimits:
    "This check is heuristic and structural: it is not a certified validation. It does not check transparency, per-operator colour spaces, forbidden compressions, ToUnicode maps or logical structure. To certify conformance, use veraPDF.",
};

export const PDFA_STRINGS: Record<Language, PdfaStrings> = { es, en };

/* ------------------------------------------------------------------ *
 * Informe descargable
 * ------------------------------------------------------------------ */

const STATUS_MARK: Record<PdfaCheckStatus, string> = {
  pass: "[OK]",
  fail: "[X]",
  warn: "[!]",
  unknown: "[?]",
};

/**
 * Informe en Markdown, con el mismo contenido que la pantalla. Se ofrece
 * como descarga opcional: el resultado de esta herramienta es la lista de
 * la pantalla, no un archivo.
 */
export function buildPdfaReportMarkdown(
  report: PdfaReport,
  strings: PdfaStrings,
  locale: string,
): string {
  const claim = claimLabel(report);
  const facts = [
    report.pageCount > 0
      ? strings.factPages(report.pageCount)
      : strings.factPagesUnknown,
    report.pdfVersion
      ? strings.factVersion(report.pdfVersion)
      : strings.factVersionUnknown,
    formatFileSize(report.fileSize, locale),
    claim ? strings.factClaim(claim) : strings.factNoClaim,
  ];

  const lines = [
    `# ${strings.reportTitle}`,
    "",
    `**${strings.reportFile}:** ${report.fileName}`,
    facts.map((fact) => `- ${fact}`).join("\n"),
    "",
    `## ${strings.verdictTitle[report.verdict]}`,
    "",
    strings.verdictBody[report.verdict],
    "",
    `## ${strings.reportChecks}`,
    "",
  ];

  for (const check of report.checks) {
    lines.push(
      `${STATUS_MARK[check.status]} **${strings.checkTitle[check.id]}** — ${
        strings.statusLabel[check.status]
      }`,
    );
    lines.push(`  ${strings.checkDetail(check)}`, "");
  }

  lines.push(
    `## ${strings.nextStepsTitle}`,
    "",
    ...strings.nextSteps.map((step) => `- ${step}`),
    "",
    "---",
    "",
    strings.reportLimits,
    "",
    strings.reportGenerated(
      new Intl.DateTimeFormat(locale, {
        dateStyle: "long",
        timeStyle: "short",
      }).format(new Date(report.checkedAt)),
    ),
    "",
  );

  return lines.join("\n");
}
