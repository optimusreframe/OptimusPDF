"use client";

import { useMemo } from "react";
import type { Dictionary } from "@/lib/i18n";
import type { Language } from "@/lib/i18n";
import { TOOL_SLUGS, getTool, type ToolSlug } from "@/lib/tools-registry";
import { PRO_OPERATIONS } from "@/app/pdf-pro/proOperations";
import { getProStrings, proOperationLabel } from "@/app/pdf-pro/proStrings";
import { PRO_TAB_IDS, type ProTabId } from "@/app/pdf-pro/ProTabs";
import { normalizeSearch, type ProCommand } from "@/app/pdf-pro/shell/proCommands";
import type { ProOperation } from "@/app/pdf-pro/proTypes";
import type { ProViewerApi } from "@/app/pdf-pro/viewer/viewerTypes";

export type BuiltInCommandArgs = {
  /** Solo se generan con la paleta abierta (son decenas de objetos que no hace falta rehacer en cada pintado). */
  enabled?: boolean;
  language: Language;
  t: Dictionary;
  api: ProViewerApi;
  pageCount: number;
  canUndo: boolean;
  canRedo: boolean;
  /** Se esta aplicando una operacion: las demas esperan. */
  busy: boolean;
  goToTab: (tab: ProTabId) => void;
  applyOperation: (operation: ProOperation<unknown>) => void;
  undo: () => void;
  redo: () => void;
  download: () => void;
  exportDocument: () => void;
  /** «Guardar como…» / «Guardar con contraseña…» (Wave 7 · U8). */
  saveAs?: () => void;
  saveWithPassword?: () => void;
  /** Crear e importar (Wave 7 · U8); sin funcion no se ofrece el comando. */
  newFromImages?: () => void;
  newBlank?: () => void;
  insertConvert?: () => void;
  mergePdfs?: () => void;
  openAnother?: () => void;
  openRecents?: () => void;
  closeDocument: () => void;
  openShortcuts: () => void;
  toggleThumbs: () => void;
  togglePanel: () => void;
  openTool: (slug: ToolSlug) => void;
};

/** Comandos de la paleta que genera la propia suite desde su estado vivo (idioma, historial, paginas...). */
export function useBuiltInCommands(args: BuiltInCommandArgs): ProCommand[] {
  const {
    enabled = true,
    language,
    t,
    api,
    pageCount,
    canUndo,
    canRedo,
    busy,
    goToTab,
    applyOperation,
    undo,
    redo,
    download,
    exportDocument,
    saveAs,
    saveWithPassword,
    newFromImages,
    newBlank,
    insertConvert,
    mergePdfs,
    openAnother,
    openRecents,
    closeDocument,
    openShortcuts,
    toggleThumbs,
    togglePanel,
    openTool,
  } = args;

  return useMemo(() => {
    if (!enabled) return [];
    const strings = getProStrings(language);
    const p = strings.palette;
    const commands: ProCommand[] = [];

    // Documento
    commands.push(
      { id: "doc:undo", label: p.undo, group: "document", shortcut: "Ctrl+Z", keywords: ["deshacer", "undo"], disabled: !canUndo, run: undo },
      { id: "doc:redo", label: p.redo, group: "document", shortcut: "Ctrl+Shift+Z", keywords: ["rehacer", "redo"], disabled: !canRedo, run: redo },
      { id: "doc:download", label: p.download, group: "document", shortcut: "Ctrl+S", keywords: ["guardar", "save", "descargar", "download"], run: download },
      { id: "doc:export", label: p.exportDoc, group: "document", keywords: ["convertir", "convert", "export", "exportar", "word", "excel", "imagenes", "images", "texto", "text"], run: exportDocument },
      { id: "doc:shortcuts", label: p.shortcuts, group: "document", keywords: ["atajos", "teclado", "keyboard", "shortcuts", "ayuda", "help"], run: openShortcuts },
      { id: "doc:close", label: p.closeDoc, group: "document", keywords: ["cerrar", "close", "salir"], run: closeDocument },
    );

    // Guardar, crear e importar (Wave 7 · U8).
    const save = strings.save;
    const create = strings.create;
    if (saveAs) {
      commands.push({ id: "doc:save-as", label: save.saveAs, group: "document", shortcut: "Ctrl+Shift+S", keywords: ["guardar como", "save as", "nombre", "name", "rename"], run: saveAs });
    }
    if (saveWithPassword) {
      commands.push({ id: "doc:save-protect", label: save.saveWithPassword, group: "document", keywords: ["contraseña", "password", "proteger", "protect", "cifrar", "encrypt"], run: saveWithPassword });
    }
    if (openAnother) {
      commands.push({ id: "doc:open-another", label: create.menu.openAnother, group: "document", keywords: ["abrir", "open", "otro", "another"], run: openAnother });
    }
    if (openRecents) {
      commands.push({ id: "doc:recents", label: create.menu.recents, group: "document", keywords: ["recientes", "recent", "borrador", "draft", "reabrir", "reopen"], run: openRecents });
    }
    if (newFromImages) {
      commands.push({ id: "doc:new-images", label: create.menu.newFromImages, group: "document", keywords: ["nuevo", "new", "imagenes", "images", "crear", "create", "jpg", "png"], run: newFromImages });
    }
    if (newBlank) {
      commands.push({ id: "doc:new-blank", label: create.menu.newBlank, group: "document", keywords: ["nuevo", "new", "blanco", "blank", "vacio", "empty", "crear", "create"], run: newBlank });
    }
    if (insertConvert) {
      commands.push({ id: "doc:insert-convert", label: create.menu.insertConvert, group: "document", keywords: ["word", "excel", "html", "docx", "xlsx", "insertar", "insert", "importar", "import"], run: insertConvert });
    }
    if (mergePdfs) {
      commands.push({ id: "doc:merge", label: create.menu.mergePdfs, group: "document", keywords: ["unir", "merge", "combinar", "combine", "juntar"], run: mergePdfs });
    }

    // Operaciones de documento completo (las mismas «acciones rapidas» de Inicio).
    for (const operation of PRO_OPERATIONS) {
      if (operation.kind !== "document") continue;
      commands.push({
        id: `op:${operation.id}`,
        label: proOperationLabel(language, operation.labelKey),
        group: "operations",
        keywords: [operation.id, "aplicar", "apply"],
        disabled: busy,
        run: () => applyOperation(operation),
      });
    }

    // Pestañas
    for (const id of PRO_TAB_IDS) {
      const name = strings.suite.tabs[id];
      commands.push({
        id: `tab:${id}`,
        label: p.goToTab(name),
        group: "tabs",
        keywords: [name, id],
        run: () => goToTab(id),
      });
    }

    // Vista
    const last = Math.max(0, pageCount - 1);
    const hasPages = pageCount > 0;
    commands.push(
      { id: "view:next", label: p.nextPage, group: "view", shortcut: "PgDn", keywords: ["siguiente", "next"], disabled: !hasPages, run: () => api.scrollToPage(api.getCurrentPage() + 1, { focus: true }) },
      { id: "view:prev", label: p.prevPage, group: "view", shortcut: "PgUp", keywords: ["anterior", "previous", "back"], disabled: !hasPages, run: () => api.scrollToPage(api.getCurrentPage() - 1, { focus: true }) },
      { id: "view:first", label: p.firstPage, group: "view", shortcut: "Home", keywords: ["inicio", "primera", "first", "start"], disabled: !hasPages, run: () => api.scrollToPage(0, { focus: true, behavior: "auto" }) },
      { id: "view:last", label: p.lastPage, group: "view", shortcut: "End", keywords: ["fin", "ultima", "last", "end"], disabled: !hasPages, run: () => api.scrollToPage(last, { focus: true, behavior: "auto" }) },
      { id: "view:zoom-in", label: p.zoomIn, group: "view", shortcut: "+", keywords: ["zoom", "ampliar", "aumentar", "bigger"], run: () => api.zoomIn() },
      { id: "view:zoom-out", label: p.zoomOut, group: "view", shortcut: "−", keywords: ["zoom", "reducir", "smaller"], run: () => api.zoomOut() },
      { id: "view:fit", label: p.fitWidth, group: "view", shortcut: "0", keywords: ["zoom", "ancho", "width", "100"], run: () => api.fitWidth() },
      { id: "view:select-all", label: p.selectAll, group: "view", shortcut: "Ctrl+A", keywords: ["seleccionar", "select", "todas", "all"], disabled: !hasPages, run: () => api.selectAll() },
      { id: "view:clear-selection", label: p.clearSelection, group: "view", keywords: ["deseleccionar", "deselect", "limpiar", "clear"], run: () => api.clearSelection() },
      { id: "view:thumbs", label: p.toggleThumbs, group: "view", keywords: ["miniaturas", "thumbnails", "paginas", "pages"], run: toggleThumbs },
      { id: "view:panel", label: p.togglePanel, group: "view", keywords: ["panel", "herramienta", "tool"], run: togglePanel },
    );

    // Herramientas sueltas
    for (const slug of TOOL_SLUGS) {
      if (slug === "pdf-pro") continue;
      if (getTool(slug).status !== "live") continue;
      const entry = t.tools[slug];
      commands.push({
        id: `tool:${slug}`,
        label: p.openTool(entry.name),
        group: "tools",
        keywords: [entry.name, entry.description, slug],
        run: () => openTool(slug),
      });
    }
    return commands;
  }, [
    enabled,
    language,
    t,
    api,
    pageCount,
    canUndo,
    canRedo,
    busy,
    goToTab,
    applyOperation,
    undo,
    redo,
    download,
    exportDocument,
    saveAs,
    saveWithPassword,
    newFromImages,
    newBlank,
    insertConvert,
    mergePdfs,
    openAnother,
    openRecents,
    closeDocument,
    openShortcuts,
    toggleThumbs,
    togglePanel,
    openTool,
  ]);
}

/** Palabras que pueden acompañar al numero en «ir a la pagina 12», «pag. 12», «go to page 12» sin cambiar su sentido. */
const GO_TO_WORDS = new Set(["ir", "a", "la", "pagina", "pag", "p", "go", "to", "page", "pg"]);

/**
 * «Ir a la pagina N» cuando lo escrito es un numero (con o sin esas palabras): «rotar 90» NO lo es (el «90»
 * pertenece a otro comando), asi que no se ofrece saltar a la 90.
 */
export function goToPageCommands(
  language: Language,
  api: ProViewerApi,
  pageCount: number,
  query: string,
): ProCommand[] {
  const tokens = normalizeSearch(query)
    .replace(/[.,:;#]/g, " ")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);
  const numbers = tokens.filter((token) => /^\d{1,7}$/.test(token));
  const words = tokens.filter((token) => !/^\d{1,7}$/.test(token));
  if (numbers.length !== 1 || !words.every((word) => GO_TO_WORDS.has(word))) return [];
  const page = Number.parseInt(numbers[0], 10);
  if (!Number.isFinite(page) || page < 1 || page > pageCount) return [];
  return [
    {
      id: `goto:${page}`,
      label: getProStrings(language).palette.goToPage(page),
      group: "view",
      run: () => api.scrollToPage(page - 1, { focus: true, behavior: "auto" }),
    },
  ];
}
