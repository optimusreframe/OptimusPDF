"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import {
  SignatureComposer,
  type SignatureDraft,
} from "@/app/sign-pdf/SignatureComposer";
import { SignaturePlacer } from "@/app/sign-pdf/SignaturePlacer";
import { SignerManager } from "@/app/sign-pdf/SignerManager";
import { FieldPlacer } from "@/app/sign-pdf/FieldPlacer";
import {
  SigningCeremony,
  pendingSigners,
  validCapture,
  type CaptureMap,
} from "@/app/sign-pdf/SigningCeremony";
import {
  documentContentKey,
  useDocumentKey,
} from "@/app/sign-pdf/documentKey";
import { SIGN_STRINGS, type SignStrings } from "@/app/sign-pdf/strings";
import { useI18n } from "@/lib/i18n";
import { PdfError, withSuffix, type ProgressCallback } from "@/lib/pdf/core";
import {
  dataUrlToBytes,
  signPdf,
  signPdfMulti,
  type SignPlacement,
  type SignatureField,
  type SignatureFieldType,
  type Signer,
} from "@/lib/pdf/sign";
import type { NormalizedRect } from "@/lib/pdf/watermark";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("sign-pdf");

/** "Solo yo" es el camino rapido de siempre; "varios" abre la ronda por turnos. */
export type SignMode = "single" | "multi";

type MultiStep = "signers" | "fields" | "sign";

const MULTI_STEPS: readonly MultiStep[] = ["signers", "fields", "sign"] as const;

export type SignToolOptions = {
  mode: SignMode;

  /* --- Solo yo --- */
  signaturePng: string;
  /** alto / ancho del PNG; 0 mientras no hay firma. */
  ratio: number;
  pageIndex: number;
  /** `width: 0` significa "aún sin colocar". */
  rect: NormalizedRect;

  /* --- Varios firmantes --- */
  /** Documento al que pertenecen los huecos y los trazos guardados. */
  signature: string;
  step: MultiStep;
  signers: Signer[];
  fields: SignatureField[];
  captures: CaptureMap;
  activeSignerId: string | null;
  fieldType: SignatureFieldType;
  fieldPageIndex: number;
  selectedFieldId: string | null;
};

const DEFAULT_OPTIONS: SignToolOptions = {
  mode: "single",
  signaturePng: "",
  ratio: 0,
  pageIndex: 0,
  rect: { x: 0, y: 0, width: 0, height: 0 },
  signature: "",
  step: "signers",
  signers: [],
  fields: [],
  captures: {},
  activeSignerId: null,
  fieldType: "signature",
  fieldPageIndex: 0,
  selectedFieldId: null,
};

/**
 * Cada hueco se rellena con el trazo que creo su dueño. Un mismo PNG
 * puede repetirse en varios huecos, asi que se decodifica una sola vez.
 * Solo entran trazos cuya huella sigue describiendo estos huecos: una
 * captura anterior a un cambio de campos o de archivo no se reaplica.
 */
function buildPlacements(
  options: SignToolOptions,
  documentKey: string,
): SignPlacement[] {
  const decoded = new Map<string, Uint8Array>();
  const placements: SignPlacement[] = [];

  for (const field of options.fields) {
    const draft = validCapture(
      options.captures,
      options.fields,
      field.signerId,
      documentKey,
    )[field.type];
    if (!draft) throw new PdfError("nothingSelected", "sign:notAllSigned");
    let png = decoded.get(draft.dataUrl);
    if (!png) {
      png = dataUrlToBytes(draft.dataUrl);
      decoded.set(draft.dataUrl, png);
    }
    placements.push({
      png,
      pageIndex: field.pageIndex,
      rect: field.rect,
    });
  }
  return placements;
}

function multiReady(
  options: SignToolOptions,
  documentKey: string | null,
): boolean {
  return (
    options.fields.length > 0 &&
    pendingSigners(
      options.signers,
      options.fields,
      options.captures,
      documentKey,
    ).length === 0
  );
}

export function SignToolClient() {
  const { language } = useI18n();
  const strings = SIGN_STRINGS[language];
  const [composerOpen, setComposerOpen] = useState(false);
  const [pageCount, setPageCount] = useState(0);
  /** Lo rellena `ToolShell`: remata la ronda con el mismo procesado de siempre. */
  const runRef = useRef<(() => void) | null>(null);

  const process = useCallback(
    async (
      files: File[],
      options: SignToolOptions,
      onProgress: ProgressCallback,
    ): Promise<ProcessResult> => {
      const file = files[0];
      const filename = withSuffix(file.name, strings.filenameSuffix);

      if (options.mode === "single") {
        const blob = await signPdf(
          file,
          {
            signaturePng: options.signaturePng,
            placement: { pageIndex: options.pageIndex, rect: options.rect },
          },
          onProgress,
        );
        return { blob, filename };
      }

      if (options.fields.length === 0) {
        throw new PdfError("nothingSelected", "sign:noFields");
      }
      // Comprobacion definitiva justo antes de escribir: el archivo que
      // se firma tiene que ser el mismo que vieron los firmantes, aunque
      // lo hayan cambiado por otro de igual nombre, tamaño y fecha.
      const documentKey = await documentContentKey(file).catch(() => null);
      if (!documentKey) {
        throw new PdfError("inspectionIncomplete", "sign:documentKey");
      }
      const blob = await signPdfMulti(
        file,
        { placements: buildPlacements(options, documentKey) },
        onProgress,
      );
      return { blob, filename };
    },
    [strings.filenameSuffix],
  );

  return (
    <ToolShell<SignToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      progressMessage={strings.progressMessage}
      runRef={runRef}
      // "Solo yo" conserva la puerta de siempre (solo el minimo de
      // archivos); la ronda por turnos si exige tenerlo todo firmado.
      // `options.signature` es la huella del documento sobre el que se
      // reservaron los huecos; que siga siendo la del archivo cargado lo
      // vuelve a comprobar `process()` antes de escribir nada.
      canRun={(_files, options) =>
        options.mode === "single" ? true : multiReady(options, options.signature)
      }
      renderMain={({ files, options, setOptions }) => (
        <div className="space-y-6">
          <section>
            <SegmentedControl<SignMode>
              label={strings.modeLabel}
              value={options.mode}
              onChange={(mode) => setOptions({ mode })}
              options={[
                { value: "single", label: strings.modeSingle },
                { value: "multi", label: strings.modeMulti },
              ]}
            />
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {options.mode === "single"
                ? strings.modeSingleHint
                : strings.modeMultiHint}
            </p>
          </section>

          {options.mode === "single" ? (
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
          ) : (
            <MultiFlow
              file={files[0] ?? null}
              options={options}
              setOptions={setOptions}
              onFinish={() => runRef.current?.()}
              strings={strings}
            />
          )}
        </div>
      )}
      renderOptions={({ options }) =>
        options.mode === "single" ? (
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
        ) : (
          <section className="space-y-3">
            <span className="hud-label block text-[10px] text-muted-foreground">
              {strings.modeMulti}
            </span>
            <p className="text-sm text-foreground tabular-nums">
              {strings.totalFields(options.fields.length)}
            </p>
            {options.fields.length === 0 ? (
              <p className="text-xs leading-relaxed text-destructive">
                {strings.noFieldsError}
              </p>
            ) : multiReady(options, options.signature) ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {strings.allSignedBody}
              </p>
            ) : (
              <p className="text-xs leading-relaxed text-destructive">
                {strings.notAllSignedError}{" "}
                {strings.pendingBody(
                  pendingSigners(
                    options.signers,
                    options.fields,
                    options.captures,
                    options.signature,
                  ).length,
                )}
              </p>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              {strings.legalNote}
            </p>
          </section>
        )
      }
    />
  );
}

export type MultiFlowProps = {
  file: File | null;
  options: SignToolOptions;
  setOptions: (patch: Partial<SignToolOptions>) => void;
  onFinish: () => void;
  strings: SignStrings;
};

export function MultiFlow({
  file,
  options,
  setOptions,
  onFinish,
  strings,
}: MultiFlowProps) {
  /** Huella del contenido del archivo; `null` mientras se calcula. */
  const documentKey = useDocumentKey(file);

  /**
   * Los huecos y los trazos describen un documento concreto. Al cambiar
   * el archivo se empieza de cero: heredarlos colocaria firmas sobre
   * paginas que nadie llego a ver. Los firmantes si sobreviven, porque no
   * dependen del documento. Mientras no haya huella no se decide nada:
   * las capturas ya cuentan como invalidas hasta que llegue.
   */
  useEffect(() => {
    if (documentKey === null || options.signature === documentKey) return;
    setOptions({
      signature: documentKey,
      step: "signers",
      fields: [],
      captures: {},
      fieldPageIndex: 0,
      selectedFieldId: null,
    });
  }, [documentKey, options.signature, setOptions]);

  const stepLabels: Record<MultiStep, string> = {
    signers: strings.stepSigners,
    fields: strings.stepFields,
    sign: strings.stepSign,
  };

  /** Un paso solo se abre cuando el anterior ya tiene lo que necesita. */
  const reachable = (step: MultiStep): boolean => {
    if (step === "signers") return true;
    if (step === "fields") return options.signers.length > 0;
    return options.fields.length > 0;
  };

  const position = MULTI_STEPS.indexOf(options.step);
  const nextStep = MULTI_STEPS[position + 1];
  const previousStep = MULTI_STEPS[position - 1];

  const fieldCounts: Record<string, number> = {};
  for (const field of options.fields) {
    fieldCounts[field.signerId] = (fieldCounts[field.signerId] ?? 0) + 1;
  }

  /**
   * Al quitar a un firmante desaparecen tambien sus huecos y su trazo:
   * dejarlos sueltos convertiria el documento en algo imposible de
   * completar.
   */
  const onSignersChange = (signers: Signer[]) => {
    const alive = new Set(signers.map((signer) => signer.id));
    const fields = options.fields.filter((field) => alive.has(field.signerId));
    const captures: CaptureMap = {};
    for (const [id, capture] of Object.entries(options.captures)) {
      if (alive.has(id)) captures[id] = capture;
    }
    setOptions({ signers, fields, captures });
  };

  return (
    <div className="space-y-5">
      <nav aria-label={strings.ceremonyTitle} className="flex flex-wrap gap-1.5">
        {MULTI_STEPS.map((step, index) => {
          const active = step === options.step;
          const open = reachable(step);
          return (
            <button
              key={step}
              type="button"
              disabled={!open}
              aria-current={active ? "step" : undefined}
              onClick={() => setOptions({ step })}
              className={
                active
                  ? "hud-label min-h-11 rounded-ios-sm border border-signal/60 bg-signal/15 px-3 text-[10px] text-foreground"
                  : "hud-label min-h-11 rounded-ios-sm border border-white/10 bg-white/5 px-3 text-[10px] text-muted-foreground transition-colors enabled:hover:border-white/25 enabled:hover:text-foreground disabled:opacity-40"
              }
            >
              {index + 1}. {stepLabels[step]}
            </button>
          );
        })}
      </nav>

      {options.step === "signers" ? (
        <SignerManager
          signers={options.signers}
          onSignersChange={onSignersChange}
          activeSignerId={options.activeSignerId}
          onActiveSignerIdChange={(activeSignerId) =>
            setOptions({ activeSignerId })
          }
          fieldCounts={fieldCounts}
          strings={strings}
        />
      ) : null}

      {options.step === "fields" ? (
        <FieldPlacer
          file={file}
          signers={options.signers}
          activeSignerId={options.activeSignerId}
          fields={options.fields}
          onFieldsChange={(fields) => setOptions({ fields })}
          activeType={options.fieldType}
          onActiveTypeChange={(fieldType) => setOptions({ fieldType })}
          pageIndex={options.fieldPageIndex}
          onPageIndexChange={(fieldPageIndex) => setOptions({ fieldPageIndex })}
          selectedId={options.selectedFieldId}
          onSelectedIdChange={(selectedFieldId) =>
            setOptions({ selectedFieldId })
          }
          strings={strings}
        />
      ) : null}

      {options.step === "sign" ? (
        <SigningCeremony
          signers={options.signers}
          fields={options.fields}
          captures={options.captures}
          onCapturesChange={(captures) => setOptions({ captures })}
          documentKey={documentKey}
          onFinish={onFinish}
          strings={strings}
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        {previousStep ? (
          <Button
            variant="secondary"
            size="md"
            onClick={() => setOptions({ step: previousStep })}
          >
            {strings.back}
          </Button>
        ) : null}
        {nextStep ? (
          <Button
            size="md"
            disabled={!reachable(nextStep)}
            onClick={() => setOptions({ step: nextStep })}
          >
            {strings.next}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
