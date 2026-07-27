"use client";

import { useCallback, useState } from "react";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import {
  SignatureComposer,
  type SignatureDraft,
} from "@/app/sign-pdf/SignatureComposer";
import { SignaturePlacer } from "@/app/sign-pdf/SignaturePlacer";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { useI18n } from "@/lib/i18n";
import { withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import { signPdf } from "@/lib/pdf/sign";
import type { NormalizedRect } from "@/lib/pdf/watermark";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("sign-pdf");

export type SignToolOptions = {
  signaturePng: string;
  /** alto / ancho del PNG; 0 mientras no hay firma. */
  ratio: number;
  pageIndex: number;
  /** `width: 0` significa "aún sin colocar". */
  rect: NormalizedRect;
};

const DEFAULT_OPTIONS: SignToolOptions = {
  signaturePng: "",
  ratio: 0,
  pageIndex: 0,
  rect: { x: 0, y: 0, width: 0, height: 0 },
};

export function SignToolClient() {
  const { language } = useI18n();
  const strings = SIGN_STRINGS[language];
  const [composerOpen, setComposerOpen] = useState(false);
  const [pageCount, setPageCount] = useState(0);

  const process = useCallback(
    async (
      files: File[],
      options: SignToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const blob = await signPdf(
        file,
        {
          signaturePng: options.signaturePng,
          placement: { pageIndex: options.pageIndex, rect: options.rect },
        },
        onProgress,
      );
      return { blob, filename: withSuffix(file.name, strings.filenameSuffix) };
    },
    [strings.filenameSuffix],
  );

  return (
    <ToolShell<SignToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      renderMain={({ files, options, setOptions }) => (
        <>
          <SignaturePlacer
            file={files[0] ?? null}
            signature={options.signaturePng || null}
            ratio={options.ratio}
            rect={options.rect}
            onRectChange={(rect) => setOptions({ rect })}
            pageIndex={options.pageIndex}
            onPageIndexChange={(pageIndex) => setOptions({ pageIndex })}
            pageCount={pageCount}
            onPageCount={setPageCount}
            strings={strings}
          />
          <SignatureComposer
            open={composerOpen}
            onClose={() => setComposerOpen(false)}
            strings={strings}
            onSave={(draft: SignatureDraft) =>
              setOptions({
                signaturePng: draft.dataUrl,
                ratio: draft.ratio,
                // Fuerza el recálculo de la colocación por defecto.
                rect: { x: 0, y: 0, width: 0, height: 0 },
              })
            }
          />
        </>
      )}
      renderOptions={({ options }) => (
        <section className="space-y-4">
          <Button
            variant={options.signaturePng ? "secondary" : "primary"}
            size="md"
            fullWidth
            onClick={() => setComposerOpen(true)}
          >
            <PenLine aria-hidden="true" className="size-4" />
            {options.signaturePng
              ? strings.changeSignature
              : strings.createSignature}
          </Button>

          {options.signaturePng ? (
            <div className="rounded-ios-sm flex items-center justify-center border border-white/10 bg-white p-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={options.signaturePng}
                alt={strings.createTitle}
                className="max-h-24 w-auto max-w-full object-contain"
              />
            </div>
          ) : (
            <p role="alert" className="text-xs text-destructive">
              {strings.noSignature}
            </p>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            {strings.legalNote}
          </p>
        </section>
      )}
    />
  );
}
