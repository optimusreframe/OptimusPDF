"use client";

import { useCallback, useMemo, useState } from "react";
import { LayoutTemplate, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { Sheet } from "@/components/ui/Sheet";
import { Spinner } from "@/components/ui/Spinner";
import { useI18n, localeTag } from "@/lib/i18n";
import { markMigrated, migrateLocalTemplates } from "@/lib/docLibrary/templateLegacy";
import {
  deleteTemplate,
  listTemplates as listLegacyTemplates,
  refreshSignTemplates,
  useSignTemplates,
  type SignTemplate,
} from "@/app/sign-pdf/signTemplates";
import type { DocId } from "@/app/sign-pdf/docSet";
import { libraryTemplateStrings } from "@/app/sign-pdf/libraryTemplateStrings";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { LibraryTemplateRow } from "@/app/sign-pdf/templateCandidates";
import { LibraryRow } from "@/app/sign-pdf/TemplateRows";
import { needsPlan, TemplatePlanSheet, type PlanChoice, type PlanTarget } from "@/app/sign-pdf/TemplatePlanSheet";
import { useTemplateCandidates } from "@/app/sign-pdf/useTemplateCandidates";
import type { ManualOutcome, ManualRequest } from "@/app/sign-pdf/useTemplateController";

/*
 * Hoja «Plantillas» de Firmar. Desde W3-A2 lista dos cosas:
 *   1. «Mis documentos»: TODAS las plantillas de la biblioteca (IndexedDB), con su parecido (Coincide / Parece / Distinto) con el
 *      PDF cargado, ordenadas por parecido y luego por uso reciente. «Usar esta plantilla» la aplica siempre, a mano, por el mismo
 *      camino que la aplicacion automatica (deshacible, con aviso); si el PDF no es identico se explica y se confirma antes.
 *   2. «Plantillas antiguas» (localStorage, maximo 10): se siguen aplicando como siempre (`onApply`/`onApplyAll`), y se pueden pasar
 *      a «Mis documentos» si no se pierde ningun campo.
 * Sin `library` la hoja es la de siempre (solo las antiguas).
 */

/** Plantillas de la biblioteca que se pintan antes de «Mostrar las N restantes» (con 200 posibles, la lista no se come la hoja). */
const VISIBLE_ROWS = 8;

export type TemplatesSheetLibrary = {
  /** PDF del documento activo: con el se comparan las plantillas. */
  file: File | null;
  docId: DocId | null;
  /** Todos los documentos de la ronda (para «Usar en todos los documentos»). */
  docIds: DocId[];
  /** Campos (firma y texto puestos a mano) que ya tiene el documento activo y una plantilla reemplazaria. */
  existingFields: number;
  /** Firmantes de la sesion: deciden cuantos se aplican por defecto. */
  signerCount: number;
  /** `useTemplateController().applyChosen`. */
  apply: (request: ManualRequest) => Promise<ManualOutcome>;
};

export type TemplatesSheetProps = {
  open: boolean;
  onClose: () => void;
  onApply: (template: SignTemplate) => void;
  /** Con varios documentos: aplica la plantilla a TODOS (firmantes una vez, huecos repetidos por documento). Ausente = un solo documento. */
  onApplyAll?: (template: SignTemplate) => void;
  strings: SignStrings;
  library?: TemplatesSheetLibrary;
};

type Migration = { state: "idle" } | { state: "busy" } | { state: "done"; message: string };

export function TemplatesSheet({ open, onClose, onApply, onApplyAll, strings, library }: TemplatesSheetProps) {
  const { t, language } = useI18n();
  const lib = libraryTemplateStrings(language);
  const legacy = useSignTemplates();
  const candidates = useTemplateCandidates(open && library !== undefined, library?.file ?? null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanTarget | null>(null);
  const [applying, setApplying] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [migration, setMigration] = useState<Migration>({ state: "idle" });

  const formatter = new Intl.DateTimeFormat(localeTag(language), { dateStyle: "medium", timeStyle: "short" });
  const dayFormatter = new Intl.DateTimeFormat(localeTag(language), { dateStyle: "medium" });
  const toDelete = legacy.find((template) => template.id === confirmDeleteId) ?? null;

  const rows = candidates.rows;
  const visibleRows = showAll ? rows : rows.slice(0, VISIBLE_ROWS);
  const loading = candidates.status !== "ready";
  const pendingLegacy = useMemo(() => legacy.filter((template) => !candidates.migratedLegacyIds.has(template.id)), [legacy, candidates.migratedLegacyIds]);

  /** Aplica de verdad (tras el paso de confirmacion si lo hubo) y cierra la hoja: el resultado se ve en el aviso «Plantilla aplicada». */
  const run = useCallback(
    async (row: LibraryTemplateRow, all: boolean, choice: PlanChoice | null) => {
      if (!library) return;
      setApplying(true);
      try {
        await library.apply({
          docIds: all ? library.docIds : library.docId ? [library.docId] : [],
          template: row.template,
          documentId: row.document?.id ?? null,
          scope: choice?.scope ?? "matching",
          ...(choice ? { count: choice.count } : {}),
          allowLoss: all,
        });
      } finally {
        setApplying(false);
        setPlan(null);
      }
      onClose();
    },
    [library, onClose],
  );

  const use = (row: LibraryTemplateRow, all: boolean) => {
    if (!library) return;
    if (needsPlan(row, all, library.existingFields)) setPlan({ row, all });
    else void run(row, false, null);
  };

  const migrate = async () => {
    setMigration({ state: "busy" });
    try {
      const copied = await migrateLocalTemplates();
      if (copied.status === "none") {
        setMigration({ state: "done", message: lib.migrateNothing });
        return;
      }
      if (copied.status !== "ok") {
        setMigration({ state: "done", message: lib.migrateFailed });
        return;
      }
      // Solo se quitan de `localStorage` las que se copiaron SIN perder ningun campo; el resto se conserva aqui.
      await markMigrated({ onlyLossless: true });
      refreshSignTemplates();
      candidates.reload();
      setMigration({ state: "done", message: lib.migrateDone(copied.created.length, listLegacyTemplates().length) });
    } catch {
      setMigration({ state: "done", message: lib.migrateFailed });
    }
  };

  const nothingAtAll = library !== undefined && !loading && candidates.libraryAvailable && rows.length === 0 && legacy.length === 0;

  return (
    <Sheet open={open} onClose={onClose} title={strings.templatesTitle} closeLabel={t.common.close}>
      {library ? (
        <section aria-labelledby="tpl-library-title" className="space-y-3 pb-4" data-templates-library="">
          <div className="space-y-1">
            <h3 id="tpl-library-title" className="text-headline text-foreground">
              {lib.sectionLibrary}
            </h3>
            <p className="text-footnote leading-relaxed text-muted-foreground">{lib.sectionLibraryHint}</p>
          </div>
          {!library.file ? <p className="text-footnote text-muted-foreground">{lib.noFile}</p> : null}
          {candidates.fingerprintFailed ? <p className="text-footnote text-muted-foreground">{lib.cannotCompare}</p> : null}
          {loading ? (
            <p className="flex items-center gap-2 py-2 text-footnote text-muted-foreground" role="status">
              <Spinner />
              {lib.loading}
            </p>
          ) : !candidates.libraryAvailable ? (
            <p className="text-footnote text-muted-foreground">{lib.libraryUnavailable}</p>
          ) : rows.length === 0 ? (
            <p className="text-footnote leading-relaxed text-muted-foreground">{nothingAtAll ? strings.templatesEmpty : lib.libraryEmpty}</p>
          ) : (
            <>
              <ul className="space-y-2">
                {visibleRows.map((row) => (
                  <LibraryRow
                    key={row.template.id}
                    row={row}
                    t={lib}
                    fingerprint={candidates.fingerprint}
                    fingerprintFailed={candidates.fingerprintFailed}
                    lastUsed={row.lastUsedAt ? dayFormatter.format(new Date(row.lastUsedAt)) : null}
                    expanded={expanded === row.template.id}
                    busy={applying}
                    multi={library.docIds.length > 1}
                    onToggle={() => setExpanded((current) => (current === row.template.id ? null : row.template.id))}
                    onUse={() => use(row, false)}
                    onUseAll={() => use(row, true)}
                  />
                ))}
              </ul>
              {rows.length > VISIBLE_ROWS && !showAll ? (
                <Button variant="secondary" size="md" fullWidth onClick={() => setShowAll(true)}>
                  {lib.showMore(rows.length - VISIBLE_ROWS)}
                </Button>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {legacy.length > 0 || !library || migration.state === "done" ? (
        <section aria-labelledby={library ? "tpl-legacy-title" : undefined} className="space-y-3" data-templates-legacy="">
          {library ? (
            <div className="space-y-1">
              <h3 id="tpl-legacy-title" className="text-headline text-foreground">
                {lib.sectionLegacy}
              </h3>
              <p className="text-footnote leading-relaxed text-muted-foreground">{lib.sectionLegacyHint}</p>
            </div>
          ) : null}
          {library && candidates.libraryAvailable && pendingLegacy.length > 0 ? (
            <div className="space-y-1.5">
              <Button variant="secondary" size="md" wrap disabled={migration.state === "busy"} onClick={() => void migrate()}>
                {migration.state === "busy" ? lib.migrating : lib.migrate}
              </Button>
              <p className="text-caption leading-relaxed text-muted-foreground">{lib.migrateHint}</p>
            </div>
          ) : null}
          {migration.state === "done" ? (
            <p role="status" className="text-footnote leading-relaxed text-foreground" data-templates-migration="">
              {migration.message}
            </p>
          ) : null}
          {legacy.length === 0 ? (
            library ? null : <p className="py-4 text-sm text-muted-foreground">{strings.templatesEmpty}</p>
          ) : (
            <ul className="space-y-2 pb-2">
              {legacy.map((template) => (
                <li key={template.id}>
                  <div className="surface-card rounded-ios-sm flex flex-wrap items-center gap-3 p-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-ios-sm bg-white/6">
                      <LayoutTemplate aria-hidden="true" className="size-4 text-signal" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{template.name}</p>
                      <p className="text-caption text-muted-foreground">
                        {strings.templatesSavedAt(formatter.format(new Date(template.savedAt)))}
                        {" · "}
                        {strings.templatesSummary(template.signers.length, template.fields.length, template.textFields.length)}
                      </p>
                      {candidates.migratedLegacyIds.has(template.id) ? <p className="text-caption text-muted-foreground">{lib.legacyAlready}</p> : null}
                    </div>
                    <Button size="sm" onClick={() => onApply(template)}>
                      {strings.templatesApply}
                    </Button>
                    <button
                      type="button"
                      aria-label={strings.templatesDelete(template.name)}
                      onClick={() => setConfirmDeleteId(template.id)}
                      className="shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:text-destructive"
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </button>
                    {onApplyAll ? (
                      <Button variant="secondary" size="md" fullWidth onClick={() => onApplyAll(template)}>
                        {strings.templatesApplyAll}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}

      <ConfirmSheet
        open={toDelete !== null}
        onClose={() => setConfirmDeleteId(null)}
        onConfirm={() => {
          if (toDelete) deleteTemplate(toDelete.id);
        }}
        title={strings.templatesConfirmDeleteTitle}
        body={strings.templatesConfirmDeleteBody}
        confirmLabel={strings.templatesDelete(toDelete?.name ?? "")}
        cancelLabel={strings.confirmCancel}
        closeLabel={strings.confirmClose}
      />

      {library ? (
        <TemplatePlanSheet
          target={plan}
          t={lib}
          docCount={library.docIds.length}
          existingFields={library.existingFields}
          signerCount={library.signerCount}
          busy={applying}
          onConfirm={(target, choice) => void run(target.row, target.all, choice)}
          onClose={() => setPlan(null)}
        />
      ) : null}
    </Sheet>
  );
}
