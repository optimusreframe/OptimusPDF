"use client";

import Link from "next/link";
import { useMemo, type Ref } from "react";
import { FilePlus2, History, ImagePlus, Layers } from "lucide-react";
import { ErrorBanner } from "@/components/tool/ErrorBanner";
import { errorActions, errorCopy } from "@/components/tool/errorCopy";
import { FileDropzone } from "@/components/tool/FileDropzone";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { PdfErrorCode } from "@/lib/pdf/core";
import { useI18n } from "@/lib/i18n";
import { ACCENT_BG_SOFT, ACCENT_TEXT, getTool, toolHref, type ToolSlug } from "@/lib/tools-registry";
import type { ProDraftSummary } from "@/app/pdf-pro/proDrafts";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { RecentDocumentsList } from "@/app/pdf-pro/session/RecentDocuments";
import { getSessionStrings } from "@/app/pdf-pro/session/sessionStrings";
import type { ProIntakeState } from "@/app/pdf-pro/useProSession";

const TOOL = getTool("pdf-pro");

/** Herramientas sueltas que se ofrecen desde el estado vacio. */
const LOOSE_TOOLS: readonly ToolSlug[] = [
  "merge-pdf",
  "split-pdf",
  "organize-pdf",
  "compress-pdf",
  "sign-pdf",
  "protect-pdf",
];

export type ProEmptyStateProps = {
  intake: ProIntakeState;
  drafts: ProDraftSummary[];
  draftsSupported: boolean;
  draftsLoaded: boolean;
  draftBusy: boolean;
  draftError: boolean;
  onFile: (file: File) => void;
  onDropzoneError: (code: PdfErrorCode) => void;
  onOpenDraft: (id: string) => void;
  onDismissProblem: () => void;
  /** «Nuevo desde imágenes»: abre el selector de imagenes. */
  onNewFromImages?: () => void;
  /** «Nuevo en blanco»: abre la hoja del documento en blanco. */
  onNewBlank?: () => void;
  dropzoneRef?: Ref<HTMLButtonElement>;
  bannerRef?: Ref<HTMLDivElement>;
};

/**
 * Estado vacio de `/pdf-pro`: arrastrar o elegir un PDF, retomar un borrador («Documentos
 * recientes») y los enlaces a las herramientas sueltas, que se mantienen.
 */
export function ProEmptyState({
  intake,
  drafts,
  draftsSupported,
  draftsLoaded,
  draftBusy,
  draftError,
  onFile,
  onDropzoneError,
  onOpenDraft,
  onDismissProblem,
  onNewFromImages,
  onNewBlank,
  dropzoneRef,
  bannerRef,
}: ProEmptyStateProps) {
  const { t, language } = useI18n();
  const strings = getProStrings(language);
  const session = getSessionStrings(language);
  const last = drafts[0];
  const Icon = TOOL.icon;
  const problem = intake.phase === "problem" ? intake : null;
  const copy = useMemo(() => (problem ? errorCopy(t, problem.code, { fileProblem: true }) : null), [problem, t]);

  return (
    <div className="mx-auto w-full max-w-[960px] px-4 pt-6 pb-16 md:px-6 md:pt-10">
      <header className="mb-8 flex items-start gap-4">
        <span
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-ios",
            ACCENT_BG_SOFT[TOOL.accent],
          )}
        >
          <Icon aria-hidden="true" className={cn("size-6", ACCENT_TEXT[TOOL.accent])} />
        </span>
        <div className="min-w-0">
          <h1 className="text-title-1 text-foreground">{t.tools["pdf-pro"].name}</h1>
          <p className="mt-1.5 max-w-2xl text-callout text-muted-foreground">
            {t.tools["pdf-pro"].description}
          </p>
        </div>
      </header>

      <ErrorBanner
        show={problem !== null && copy !== null}
        errorKey={problem ? `intake-${problem.code}` : undefined}
        title={copy?.title ?? ""}
        message={copy?.message ?? ""}
        hint={copy?.hint}
        detail={problem?.file ? problem.file.name : undefined}
        variant="error"
        onDismiss={onDismissProblem}
        dismissLabel={t.common.close}
        bannerRef={bannerRef}
        actions={
          problem?.code === "encrypted" || problem?.code === "certificateEncryption"
            ? [{ label: t.tool.errors.encryptedAction, href: toolHref("unlock-pdf"), primary: true }]
            : errorActions(t, problem?.code)
        }
      />

      <h2 className="text-title-3 text-foreground">{strings.empty.title}</h2>
      <p className="mt-1.5 mb-4 max-w-2xl text-subheadline text-muted-foreground">{strings.empty.subtitle}</p>

      <div aria-busy={intake.phase === "checking"}>
        <FileDropzone
          tool={TOOL}
          files={[]}
          onFilesChange={(files) => {
            const first = files[0];
            if (first) onFile(first);
          }}
          onError={onDropzoneError}
          buttonRef={dropzoneRef}
        />
      </div>
      {intake.phase === "checking" ? (
        <p className="mt-3 text-footnote text-muted-foreground">{strings.empty.checking}</p>
      ) : null}

      {onNewFromImages || onNewBlank || last ? (
        <section className="mt-8" aria-labelledby="pro-start-title" data-pro-start="">
          <h2 id="pro-start-title" className="sr-only">
            {session.actionsTitle}
          </h2>
          <div className="flex flex-wrap gap-2">
            {onNewFromImages ? (
              <Button variant="secondary" size="md" onClick={onNewFromImages} data-pro-new="images">
                <ImagePlus aria-hidden="true" className="size-4" />
                {session.newFromImages}
              </Button>
            ) : null}
            {onNewBlank ? (
              <Button variant="secondary" size="md" onClick={onNewBlank} data-pro-new="blank">
                <FilePlus2 aria-hidden="true" className="size-4" />
                {session.newBlank}
              </Button>
            ) : null}
            {last ? (
              <Button
                variant="secondary"
                size="md"
                aria-disabled={draftBusy || undefined}
                title={session.openLastHint(last.fileName)}
                onClick={() => {
                  if (!draftBusy) onOpenDraft(last.id);
                }}
                data-pro-reopen=""
              >
                <History aria-hidden="true" className="size-4" />
                {session.openLast}
              </Button>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className="mt-10" aria-labelledby="pro-recent-title">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3">
          <h2 id="pro-recent-title" className="text-title-3 text-foreground">
            {strings.empty.recentTitle}
          </h2>
          <p className="text-caption text-muted-foreground">{strings.empty.privacy}</p>
        </div>
        {!draftsSupported && draftsLoaded ? (
          <p className="text-subheadline text-muted-foreground">{strings.empty.draftsUnavailable}</p>
        ) : drafts.length === 0 ? (
          <p className="text-subheadline text-muted-foreground">{strings.empty.recentEmpty}</p>
        ) : (
          <RecentDocumentsList drafts={drafts} language={language} busy={draftBusy} onOpen={onOpenDraft} />
        )}
        {draftError ? (
          <p className="mt-3 text-footnote text-destructive-text">{strings.drafts.failed}</p>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="pro-tools-title">
        <h2 id="pro-tools-title" className="text-title-3 text-foreground">
          {strings.empty.toolsTitle}
        </h2>
        <p className="mt-1 mb-3 text-subheadline text-muted-foreground">{strings.empty.toolsHint}</p>
        <ul className="flex flex-wrap gap-2">
          {LOOSE_TOOLS.map((slug) => {
            const tool = getTool(slug);
            const ToolIcon = tool.icon;
            return (
              <li key={slug}>
                <Link
                  href={toolHref(slug)}
                  className={cn(
                    "surface-card inline-flex h-11 items-center gap-2 rounded-full px-4 text-subheadline font-medium text-foreground",
                    "transition-[scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
                    "hover:border-hairline-strong hover:bg-elevated active:scale-[0.98] active:duration-[80ms]",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                  )}
                >
                  <ToolIcon aria-hidden="true" className={cn("size-4", ACCENT_TEXT[tool.accent])} />
                  {t.tools[slug].name}
                </Link>
              </li>
            );
          })}
          <li>
            <Link
              href="/"
              className="inline-flex h-11 items-center gap-2 rounded-full px-3 text-subheadline font-semibold text-signal-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
            >
              <Layers aria-hidden="true" className="size-4" />
              {t.nav.allTools}
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
