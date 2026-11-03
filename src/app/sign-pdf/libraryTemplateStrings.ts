import type { Language } from "@/lib/i18n";
import type { ExplainHeadline, PageVerdict, RowLevel } from "@/app/sign-pdf/templateCandidates";

/*
 * Textos (ES/EN) de la hoja «Plantillas» con las plantillas de «Mis documentos» (W3-A2): filas con su parecido, «Por que no
 * coincidio», el paso «Usar esta plantilla», el aviso «Hay N plantillas…» y la copia de las plantillas antiguas. Un modulo propio
 * (mismo patron que `templateStrings.ts`) para no tocar `strings.ts`.
 */

export type LibraryTemplateStrings = {
  sectionLibrary: string;
  sectionLibraryHint: string;
  sectionLegacy: string;
  sectionLegacyHint: string;
  loading: string;
  libraryEmpty: string;
  libraryUnavailable: string;
  nothingSaved: string;
  noFile: string;
  cannotCompare: string;
  /** Cabecera de la lista de plantillas que se parecen al PDF cargado. */
  levelLabel: (level: RowLevel) => string;
  levelWithPercent: (level: RowLevel, percent: number | null) => string;
  fromDocument: (name: string) => string;
  noDocument: string;
  pagesOf: (count: number) => string;
  summary: (args: { signers: 0 | 1 | 2; both: boolean; signatures: number; initials: number; text: number }) => string;
  staleNote: string;
  lastUsed: (date: string) => string;
  useButton: string;
  useButtonFor: (name: string) => string;
  useAll: string;
  detailShow: (level: RowLevel) => string;
  detailHide: string;
  showMore: (count: number) => string;
  /** Detalle: por que coincide o no. */
  headline: (headline: ExplainHeadline, args: { templatePages: number; documentPages: number; reviewPages: number }) => string;
  tableCaption: (name: string) => string;
  colPage: string;
  colDetail: string;
  pageCell: (templatePage: number, documentPage: number | null) => string;
  sameSize: (same: boolean | null) => string;
  kind: (kind: "text" | "image" | "none") => string;
  verdict: (verdict: PageVerdict) => string;
  extraPages: (pages: readonly number[]) => string;
  previewLabel: (name: string) => string;
  previewLegend: string;
  /** Paso «Usar esta plantilla». */
  planTitle: (name: string) => string;
  planLevel: (level: RowLevel, percent: number | null) => string;
  planNotIdentical: string;
  planNotIdenticalMatching: string;
  planNoOrigin: string;
  scopeLabel: string;
  scopeAll: string;
  scopeMatching: (matching: number, total: number) => string;
  scopeAllHint: string;
  scopeMatchingHint: string;
  signersLabel: string;
  signersOne: string;
  signersTwo: string;
  existingWork: (fields: number) => string;
  allWarning: (docs: number) => string;
  planConfirm: string;
  planConfirmAll: string;
  planCancel: string;
  planClose: string;
  planBusy: string;
  /** Plantillas antiguas. */
  migrate: string;
  migrateHint: string;
  migrating: string;
  migrateDone: (copied: number, kept: number) => string;
  migrateNothing: string;
  migrateFailed: string;
  legacyAlready: string;
  /** Aviso al cargar un PDF sin plantilla automatica. */
  offerTitle: (count: number) => string;
  offerBody: string;
  offerChoose: string;
  offerDismiss: string;
  /** Paginas colocadas por posicion que hay que revisar (en el aviso «Plantilla aplicada»). */
  flaggedTitle: (pages: readonly number[]) => string;
  flaggedBody: string;
  goToPage: (page: number) => string;
};

const pl = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const listEs = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`);
const listEn = (items: readonly string[]) => (items.length <= 1 ? (items[0] ?? "") : items.length === 2 ? `${items[0]} and ${items[1]}` : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

function displayLevel(level: RowLevel): "match" | "similar" | "none" | "unknown" {
  return level === "exact" || level === "match" ? "match" : level;
}

const levelEs = { match: "Coincide", similar: "Parece", none: "Distinto", unknown: "Sin comparar" } as const;
const levelEn = { match: "Matches", similar: "Looks similar", none: "Different", unknown: "Not compared" } as const;

const es: LibraryTemplateStrings = {
  sectionLibrary: "Mis documentos",
  sectionLibraryHint: "Las plantillas que guardaste en este navegador, ordenadas por parecido con el PDF cargado.",
  sectionLegacy: "Plantillas antiguas",
  sectionLegacyHint: "Guardadas aquí antes de «Mis documentos». Se siguen aplicando como siempre.",
  loading: "Buscando tus plantillas…",
  libraryEmpty: "Todavía no tienes plantillas en Mis documentos. Crea una con «Configurar plantilla».",
  libraryUnavailable: "Este navegador no deja abrir Mis documentos (sin almacenamiento local). Prueba con una ventana que no sea privada.",
  nothingSaved: "No has guardado ninguna plantilla en este navegador todavía.",
  noFile: "Carga un PDF para ver cuáles de tus plantillas se parecen a él.",
  cannotCompare: "No se pudo leer este PDF para compararlo. Se ofrecen todas tus plantillas, sin porcentaje.",
  levelLabel: (level) => levelEs[displayLevel(level)],
  levelWithPercent: (level, percent) => (percent === null || displayLevel(level) === "unknown" ? levelEs[displayLevel(level)] : `${levelEs[displayLevel(level)]} · ${percent} %`),
  fromDocument: (name) => `Documento: ${name}`,
  noDocument: "Sin documento de origen",
  pagesOf: (count) => pl(count, "página", "páginas"),
  summary: ({ signers, both, signatures, initials, text }) => {
    const parts: string[] = [];
    if (signers > 0) parts.push(both ? "1 o 2 firmantes" : signers === 1 ? "1 firmante" : "2 firmantes");
    if (signatures > 0) parts.push(pl(signatures, "firma", "firmas"));
    if (initials > 0) parts.push(`${initials} iniciales`);
    if (text > 0) parts.push(pl(text, "campo de texto", "campos de texto"));
    return parts.length > 0 ? parts.join(" · ") : "Sin campos";
  },
  staleNote: "Se cambió el PDF base de este documento: se compara con el PDF sobre el que se configuró la plantilla.",
  lastUsed: (date) => `Usada el ${date}`,
  useButton: "Usar esta plantilla",
  useButtonFor: (name) => `Usar esta plantilla: ${name}`,
  useAll: "Usar en todos los documentos",
  detailShow: (level) => {
    const kind = displayLevel(level);
    return kind === "match" ? "Ver detalle por página" : kind === "unknown" ? "Ver detalle" : "Por qué no coincidió";
  },
  detailHide: "Ocultar detalle",
  showMore: (count) => `Mostrar las ${count} restantes`,
  headline: (headline, { templatePages, documentPages, reviewPages }) => {
    switch (headline) {
      case "same":
        return "Este PDF coincide con el documento de origen de la plantilla: todas las páginas se parecen lo bastante.";
      case "similar":
        return reviewPages > 0
          ? `Se parece, pero ${reviewPages === 1 ? "1 página cambió" : `${reviewPages} páginas cambiaron`} respecto a la plantilla. Sus campos solo se colocan si lo confirmas.`
          : "Se parece, pero no lo suficiente para aplicarla sola.";
      case "differentPages":
        return `La plantilla es de ${pl(templatePages, "página", "páginas")} y este PDF tiene ${documentPages}. Con otro número de páginas solo se reconoce sola si casi todas se parecen.`;
      case "differentText":
        return "Coincide menos de tres cuartas partes del texto: parece otro contrato u otra versión.";
      case "partial":
        return "El PDF o el documento de origen tiene demasiadas páginas (más de 200) para compararlos página a página.";
      case "empty":
        return "No se encontró texto ni imágenes que comparar.";
      case "version":
        return "La huella de este documento se guardó con otra versión del programa y no se puede comparar. Vuelve a guardar la plantilla desde Mis documentos.";
      case "noOrigin":
        return "Esta plantilla no tiene un documento de origen en Mis documentos, así que no se puede comparar con el PDF. Se coloca por posición.";
      case "unreadable":
        return "No se pudo leer el PDF cargado para compararlo.";
    }
  },
  tableCaption: (name) => `Comparación página a página con «${name}»`,
  colPage: "Página y parecido",
  colDetail: "Detalle",
  pageCell: (templatePage, documentPage) => `${templatePage + 1} → ${documentPage === null ? "—" : documentPage + 1}`,
  sameSize: (same) => (same === null ? "Tamaño: sin comparar" : same ? "Mismo tamaño: sí" : "Mismo tamaño: no"),
  kind: (kind) => (kind === "text" ? "Texto" : kind === "image" ? "Imagen" : "Sin texto ni imagen"),
  verdict: (verdict) => {
    switch (verdict) {
      case "identical":
        return "Idéntica.";
      case "same":
        return "El texto coincide.";
      case "contained":
        return "Está todo el texto de la plantilla y la página trae más (datos rellenados): se revisa.";
      case "changed":
        return "El texto cambió algo: se revisa antes de colocar campos.";
      case "scan":
        return "Página escaneada: se compara por imagen y es menos fiable.";
      case "notFound":
        return "Ninguna página del PDF se parece a esta.";
      case "differentSize":
        return "La página del PDF tiene otro tamaño.";
      case "missing":
        return "El PDF no tiene esta página.";
    }
  },
  extraPages: (pages) => `${pages.length === 1 ? "Página nueva" : "Páginas nuevas"} en el PDF que no ${pages.length === 1 ? "está" : "están"} en la plantilla: ${listEs(pages.map((page) => String(page + 1)))}.`,
  previewLabel: (name) => `Primera página de «${name}» con los campos de la plantilla`,
  previewLegend: "Los recuadros son los campos de la plantilla en la página 1.",
  planTitle: (name) => `Usar «${name}»`,
  planLevel: (level, percent) => {
    const kind = displayLevel(level);
    if (kind === "match") return `Este PDF coincide con el documento de origen${percent === null ? "" : ` (${percent} %)`}.`;
    if (kind === "similar") return `Este PDF se parece al documento de origen${percent === null ? "" : ` (${percent} %)`}, pero no es idéntico.`;
    if (kind === "none") return `Este PDF no se parece al documento de origen${percent === null ? "" : ` (${percent} %)`}.`;
    return "No se puede comparar este PDF con la plantilla (no tiene documento de origen).";
  },
  planNotIdentical: "Las páginas no son idénticas: los campos se colocarán por posición y quedarán marcados para revisar.",
  planNotIdenticalMatching: "Las páginas no son idénticas: solo se colocarán los campos de las páginas que coinciden.",
  planNoOrigin: "Los campos se colocarán en la misma página y posición que tiene la plantilla. Revísalos antes de firmar.",
  scopeLabel: "Páginas",
  scopeAll: "Todas, por posición",
  scopeMatching: (matching, total) => `Solo las que coinciden (${matching} de ${total})`,
  scopeAllHint: "Se colocan los campos de todas las páginas; las que no coinciden del todo quedan marcadas para revisar.",
  scopeMatchingHint: "Solo se colocan los campos de las páginas que coinciden. El resto queda en «Revisar» para añadirlo a mano.",
  signersLabel: "Firmantes",
  signersOne: "1 firmante",
  signersTwo: "2 firmantes",
  existingWork: (fields) => `Este documento ya tiene ${pl(fields, "campo puesto", "campos puestos")}: se reemplazarán por los de la plantilla. Si hay valores escritos en ellos, te lo preguntamos antes de quitarlos.`,
  allWarning: (docs) => `Se aplica a los ${docs} documentos: reemplaza los campos de cada uno y quita lo escrito en ellos. Las firmas ya recogidas se conservan.`,
  planConfirm: "Usar esta plantilla",
  planConfirmAll: "Usar en todos los documentos",
  planCancel: "Cancelar",
  planClose: "Cerrar",
  planBusy: "Aplicando…",
  migrate: "Pasar a Mis documentos",
  migrateHint: "Se copian a Mis documentos y solo se quitan de aquí si no se pierde ningún campo.",
  migrating: "Copiando…",
  migrateDone: (copied, kept) =>
    `${copied === 0 ? "No hubo plantillas nuevas que copiar" : `Se copiaron ${pl(copied, "plantilla", "plantillas")} a Mis documentos`}.${kept > 0 ? ` ${kept === 1 ? "1 se conserva aquí porque" : `${kept} se conservan aquí porque`} no se pudo pasar sin perder algún campo.` : ""}`,
  migrateNothing: "No hay plantillas antiguas que pasar.",
  migrateFailed: "No se pudieron copiar las plantillas (sin espacio o sin almacenamiento local). Siguen aquí, sin cambios.",
  legacyAlready: "Ya está copiada en Mis documentos.",
  offerTitle: (count) => (count === 1 ? "Hay 1 plantilla en Mis documentos" : `Hay ${count} plantillas en Mis documentos`),
  offerBody: "Ninguna se aplicó sola a este PDF. Puedes elegir una a mano y ver cuánto se parece.",
  offerChoose: "Elegir",
  offerDismiss: "Ahora no",
  flaggedTitle: (pages) => `Revisa ${pages.length === 1 ? "la página" : "las páginas"} ${listEs(pages.map((page) => String(page + 1)))}`,
  flaggedBody: "Esas páginas no coinciden del todo con la plantilla: colocamos sus campos por posición. Comprueba que caen donde deben.",
  goToPage: (page) => `Ir a la página ${page}`,
};

const en: LibraryTemplateStrings = {
  sectionLibrary: "My documents",
  sectionLibraryHint: "The templates you saved in this browser, sorted by how much they look like the loaded PDF.",
  sectionLegacy: "Older templates",
  sectionLegacyHint: "Saved here before “My documents”. They keep working as before.",
  loading: "Looking for your templates…",
  libraryEmpty: "You don't have templates in My documents yet. Create one with “Set up template”.",
  libraryUnavailable: "This browser can't open My documents (no local storage). Try a window that isn't private.",
  nothingSaved: "You haven't saved any template in this browser yet.",
  noFile: "Load a PDF to see which of your templates look like it.",
  cannotCompare: "This PDF couldn't be read to compare it. All your templates are offered, without a percentage.",
  levelLabel: (level) => levelEn[displayLevel(level)],
  levelWithPercent: (level, percent) => (percent === null || displayLevel(level) === "unknown" ? levelEn[displayLevel(level)] : `${levelEn[displayLevel(level)]} · ${percent}%`),
  fromDocument: (name) => `Document: ${name}`,
  noDocument: "No source document",
  pagesOf: (count) => pl(count, "page", "pages"),
  summary: ({ signers, both, signatures, initials, text }) => {
    const parts: string[] = [];
    if (signers > 0) parts.push(both ? "1 or 2 signers" : signers === 1 ? "1 signer" : "2 signers");
    if (signatures > 0) parts.push(pl(signatures, "signature", "signatures"));
    if (initials > 0) parts.push(`${initials} initials`);
    if (text > 0) parts.push(pl(text, "text field", "text fields"));
    return parts.length > 0 ? parts.join(" · ") : "No fields";
  },
  staleNote: "This document's base PDF was replaced: it is compared with the PDF the template was set up on.",
  lastUsed: (date) => `Used on ${date}`,
  useButton: "Use this template",
  useButtonFor: (name) => `Use this template: ${name}`,
  useAll: "Use on all documents",
  detailShow: (level) => {
    const kind = displayLevel(level);
    return kind === "match" ? "See details per page" : kind === "unknown" ? "See details" : "Why it didn't match";
  },
  detailHide: "Hide details",
  showMore: (count) => `Show the other ${count}`,
  headline: (headline, { templatePages, documentPages, reviewPages }) => {
    switch (headline) {
      case "same":
        return "This PDF matches the template's source document: every page looks alike enough.";
      case "similar":
        return reviewPages > 0
          ? `It looks similar, but ${reviewPages === 1 ? "1 page changed" : `${reviewPages} pages changed`} from the template. Their fields are only placed if you confirm.`
          : "It looks similar, but not enough to apply on its own.";
      case "differentPages":
        return `The template has ${pl(templatePages, "page", "pages")} and this PDF has ${documentPages}. With a different number of pages it is only recognised on its own if almost all of them look alike.`;
      case "differentText":
        return "Less than three quarters of the text matches: it looks like another contract or another version.";
      case "partial":
        return "The PDF or the source document has too many pages (over 200) to compare page by page.";
      case "empty":
        return "No text or images were found to compare.";
      case "version":
        return "This document's fingerprint was saved with another version of the program and can't be compared. Save the template again from My documents.";
      case "noOrigin":
        return "This template has no source document in My documents, so it can't be compared with the PDF. It is placed by position.";
      case "unreadable":
        return "The loaded PDF couldn't be read to compare it.";
    }
  },
  tableCaption: (name) => `Page-by-page comparison with “${name}”`,
  colPage: "Page and similarity",
  colDetail: "Details",
  pageCell: (templatePage, documentPage) => `${templatePage + 1} → ${documentPage === null ? "—" : documentPage + 1}`,
  sameSize: (same) => (same === null ? "Size: not compared" : same ? "Same size: yes" : "Same size: no"),
  kind: (kind) => (kind === "text" ? "Text" : kind === "image" ? "Image" : "No text or image"),
  verdict: (verdict) => {
    switch (verdict) {
      case "identical":
        return "Identical.";
      case "same":
        return "The text matches.";
      case "contained":
        return "All of the template's text is there and the page has more (filled-in data): it is reviewed.";
      case "changed":
        return "The text changed a little: it is reviewed before placing fields.";
      case "scan":
        return "Scanned page: compared by image, which is less reliable.";
      case "notFound":
        return "No page of the PDF looks like this one.";
      case "differentSize":
        return "The PDF page has a different size.";
      case "missing":
        return "The PDF doesn't have this page.";
    }
  },
  extraPages: (pages) => `${pages.length === 1 ? "New page" : "New pages"} in the PDF that ${pages.length === 1 ? "isn't" : "aren't"} in the template: ${listEn(pages.map((page) => String(page + 1)))}.`,
  previewLabel: (name) => `First page of “${name}” with the template's fields`,
  previewLegend: "The boxes are the template's fields on page 1.",
  planTitle: (name) => `Use “${name}”`,
  planLevel: (level, percent) => {
    const kind = displayLevel(level);
    if (kind === "match") return `This PDF matches the source document${percent === null ? "" : ` (${percent}%)`}.`;
    if (kind === "similar") return `This PDF looks similar to the source document${percent === null ? "" : ` (${percent}%)`}, but it isn't identical.`;
    if (kind === "none") return `This PDF doesn't look like the source document${percent === null ? "" : ` (${percent}%)`}.`;
    return "This PDF can't be compared with the template (it has no source document).";
  },
  planNotIdentical: "The pages are not identical: the fields will be placed by position and marked for review.",
  planNotIdenticalMatching: "The pages are not identical: only the fields of the pages that match will be placed.",
  planNoOrigin: "The fields will be placed on the same page and position the template has. Check them before signing.",
  scopeLabel: "Pages",
  scopeAll: "All, by position",
  scopeMatching: (matching, total) => `Only the ones that match (${matching} of ${total})`,
  scopeAllHint: "The fields of every page are placed; pages that don't fully match are marked for review.",
  scopeMatchingHint: "Only the fields of the pages that match are placed. The rest stays in “Review” so you can add it by hand.",
  signersLabel: "Signers",
  signersOne: "1 signer",
  signersTwo: "2 signers",
  existingWork: (fields) => `This document already has ${pl(fields, "field placed", "fields placed")}: they will be replaced by the template's. If any of them has typed values, we ask before removing them.`,
  allWarning: (docs) => `It applies to all ${docs} documents: it replaces each one's fields and removes what was typed in them. Signatures already collected are kept.`,
  planConfirm: "Use this template",
  planConfirmAll: "Use on all documents",
  planCancel: "Cancel",
  planClose: "Close",
  planBusy: "Applying…",
  migrate: "Move to My documents",
  migrateHint: "They are copied to My documents and only removed from here if no field is lost.",
  migrating: "Copying…",
  migrateDone: (copied, kept) =>
    `${copied === 0 ? "There were no new templates to copy" : `${pl(copied, "template", "templates")} copied to My documents`}.${kept > 0 ? ` ${kept === 1 ? "1 stays here because" : `${kept} stay here because`} it couldn't be moved without losing a field.` : ""}`,
  migrateNothing: "There are no older templates to move.",
  migrateFailed: "The templates couldn't be copied (no space or no local storage). They are still here, unchanged.",
  legacyAlready: "Already copied to My documents.",
  offerTitle: (count) => (count === 1 ? "There is 1 template in My documents" : `There are ${count} templates in My documents`),
  offerBody: "None was applied to this PDF on its own. You can pick one by hand and see how much it looks like it.",
  offerChoose: "Choose",
  offerDismiss: "Not now",
  flaggedTitle: (pages) => `Check ${pages.length === 1 ? "page" : "pages"} ${listEn(pages.map((page) => String(page + 1)))}`,
  flaggedBody: "Those pages don't fully match the template: their fields were placed by position. Check they land where they should.",
  goToPage: (page) => `Go to page ${page}`,
};

export function libraryTemplateStrings(language: Language): LibraryTemplateStrings {
  return language === "en" ? en : es;
}
