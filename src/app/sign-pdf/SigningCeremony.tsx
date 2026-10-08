"use client";

import { useState } from "react";
import { ArrowRight, Check, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/lib/cn";
import {
  SignatureComposer,
  type SignatureDraft,
} from "@/app/sign-pdf/SignatureComposer";
import type { SignStrings } from "@/app/sign-pdf/strings";
import {
  signerDisplayName,
  type SignatureField,
  type SignatureFieldType,
  type Signer,
} from "@/lib/pdf/sign";

/** Lo que cada firmante ha creado en su turno. */
export type SignerCapture = {
  signature: SignatureDraft | null;
  initials: SignatureDraft | null;
  /** Huella de `{ documento + huecos propios }` en el momento de crearlo. */
  stamp: string;
};

export const EMPTY_CAPTURE: SignerCapture = {
  signature: null,
  initials: null,
  stamp: "",
};

export type CaptureMap = Record<string, SignerCapture>;

/**
 * Huella de lo que un firmante llego a ver: el documento cargado y sus
 * huecos, con posicion, pagina y tipo. Es lo que ata el trazo a un estado
 * concreto del documento; si cambia, la captura ya no describe lo que esa
 * persona aprobo.
 */
export function captureStamp(
  documentKey: string,
  fields: readonly SignatureField[],
  signerId: string,
): string {
  const own = fields
    .filter((field) => field.signerId === signerId)
    .map((field) => {
      const { x, y, width, height } = field.rect;
      return `${field.id}|${field.pageIndex}|${field.type}|${x}|${y}|${width}|${height}`;
    })
    .sort();
  return [documentKey, ...own].join("~");
}

/**
 * La captura guardada solo vale si su huella coincide con la de ahora.
 * Ante cualquier duda se devuelve vacia: reaplicar una firma antigua en un
 * hueco que su dueño no vio seria falsificarla. Sin identidad del
 * documento (`null`: aun calculandose o imposible de calcular) tampoco
 * vale nada, por el mismo motivo.
 */
export function validCapture(
  captures: CaptureMap,
  fields: readonly SignatureField[],
  signerId: string,
  documentKey: string | null,
): SignerCapture {
  if (!documentKey) return EMPTY_CAPTURE;
  const stored = captures[signerId] ?? EMPTY_CAPTURE;
  return stored.stamp === captureStamp(documentKey, fields, signerId)
    ? stored
    : EMPTY_CAPTURE;
}

/** Tipos de trazo que un firmante tiene que crear, segun sus huecos. */
export function requiredCaptureTypes(
  fields: readonly SignatureField[],
  signerId: string,
): SignatureFieldType[] {
  const types: SignatureFieldType[] = [];
  for (const field of fields) {
    if (field.signerId !== signerId) continue;
    if (!types.includes(field.type)) types.push(field.type);
  }
  return types;
}

export function isSignerComplete(
  fields: readonly SignatureField[],
  captures: CaptureMap,
  signerId: string,
  documentKey: string | null,
): boolean {
  const required = requiredCaptureTypes(fields, signerId);
  if (required.length === 0) return true;
  const capture = validCapture(captures, fields, signerId, documentKey);
  return required.every((type) => capture[type] !== null);
}

/** Firmantes con huecos asignados, en el orden en que les toca. */
export function signingQueue(
  signers: readonly Signer[],
  fields: readonly SignatureField[],
): Signer[] {
  return signers.filter((signer) =>
    fields.some((field) => field.signerId === signer.id),
  );
}

/** Quienes tienen huecos y todavia no han dejado su trazo. */
export function pendingSigners(
  signers: readonly Signer[],
  fields: readonly SignatureField[],
  captures: CaptureMap,
  documentKey: string | null,
): Signer[] {
  return signingQueue(signers, fields).filter(
    (signer) => !isSignerComplete(fields, captures, signer.id, documentKey),
  );
}

type Stage = "handoff" | "capture" | "review";

export type SigningCeremonyProps = {
  signers: Signer[];
  fields: SignatureField[];
  captures: CaptureMap;
  onCapturesChange: (captures: CaptureMap) => void;
  /**
   * Identidad del archivo cargado; entra en la huella de cada captura.
   * `null` mientras se calcula: hasta tenerla no se firma nada.
   */
  documentKey: string | null;
  onFinish: () => void;
  strings: SignStrings;
  busy?: boolean;
};

/**
 * Ronda de firma en un solo dispositivo: cada persona recibe el aparato,
 * crea su trazo, comprueba como queda y se lo pasa a la siguiente. No hay
 * envio remoto ni servidor; todo ocurre en esta pestaña.
 */
export function SigningCeremony({
  signers,
  fields,
  captures,
  onCapturesChange,
  documentKey,
  onFinish,
  strings,
  busy = false,
}: SigningCeremonyProps) {
  const [turn, setTurn] = useState(0);
  const [stage, setStage] = useState<Stage>("handoff");
  const [composer, setComposer] = useState<SignatureFieldType | null>(null);

  // Sin identidad del documento la ronda no arranca: cualquier trazo que
  // se guardase ahora quedaria atado a un archivo sin comprobar.
  if (!documentKey) {
    return (
      <section className="space-y-4">
        <h3 className="ui-label text-muted-foreground">
          {strings.ceremonyTitle}
        </h3>
        <div className="glass rounded-ios flex items-center gap-3 p-6">
          <Spinner />
          <p className="text-sm text-muted-foreground">
            {strings.checkingDocument}
          </p>
        </div>
      </section>
    );
  }

  const queue = signingQueue(signers, fields);
  const pending = pendingSigners(signers, fields, captures, documentKey);
  const position = Math.min(turn, queue.length);
  const current = queue[position] ?? null;
  const required = current ? requiredCaptureTypes(fields, current.id) : [];
  const capture = current
    ? validCapture(captures, fields, current.id, documentKey)
    : EMPTY_CAPTURE;
  const currentFieldCount = current
    ? fields.filter((field) => field.signerId === current.id).length
    : 0;
  const ready = required.every((type) => capture[type] !== null);

  /** Nombre a mostrar de un firmante, con el mismo fallback numerado que `SignerManager`. */
  const displayNameOf = (signer: Signer): string =>
    signerDisplayName(
      signer.name,
      signers.findIndex((candidate) => candidate.id === signer.id),
      strings.defaultSignerName,
    );
  const currentDisplayName = current ? displayNameOf(current) : "";

  const typeLabel = (type: SignatureFieldType): string =>
    type === "signature" ? strings.fieldSignature : strings.fieldInitials;

  const saveDraft = (type: SignatureFieldType, draft: SignatureDraft) => {
    if (!current) return;
    // `capture` ya viene vacio si los huecos cambiaron: lo que se guarda
    // queda atado al documento y a la disposicion de ahora mismo.
    onCapturesChange({
      ...captures,
      [current.id]: {
        ...capture,
        [type]: draft,
        stamp: captureStamp(documentKey, fields, current.id),
      },
    });
  };

  const goToTurn = (next: number) => {
    setTurn(next);
    setStage("handoff");
  };

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="ui-label text-muted-foreground">
          {strings.ceremonyTitle}
        </h3>
        {current ? (
          <span className="text-footnote font-medium text-foreground tabular-nums">
            {strings.turnOf(position + 1, queue.length)}
          </span>
        ) : null}
      </div>

      {current && stage === "handoff" ? (
        <div className="glass rounded-ios p-6 text-center">
          <span
            className="mx-auto flex size-12 items-center justify-center rounded-full"
            /* Color del firmante: dato del documento, no un token del tema. */
            style={{ backgroundColor: `${current.color}33` }}
          >
            <Smartphone
              aria-hidden="true"
              className="size-6"
              style={{ color: current.color }}
            />
          </span>
          <h4 className="mt-4 text-title-3 text-foreground">
            {strings.handoffTitle(currentDisplayName)}
          </h4>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
            {strings.handoffBody(currentDisplayName)}
          </p>
          <div className="mt-5 flex justify-center">
            <Button size="lg" onClick={() => setStage("capture")}>
              {strings.handoffReady}
            </Button>
          </div>
        </div>
      ) : null}

      {current && stage === "capture" ? (
        <div className="glass rounded-ios p-5">
          <h4 className="text-headline text-foreground">
            {strings.captureTitle(currentDisplayName)}
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {strings.captureBody}
          </p>

          <ul className="mt-4 space-y-3">
            {required.map((type) => {
              const draft = capture[type];
              return (
                <li
                  key={type}
                  className="rounded-ios-sm flex flex-wrap items-center gap-3 border border-white/10 bg-white/5 p-3"
                >
                  <span className="ui-label min-w-20 text-muted-foreground">
                    {typeLabel(type)}
                  </span>
                  {draft ? (
                    <span className="rounded-ios-sm flex min-h-12 flex-1 items-center justify-center bg-white p-2">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={draft.dataUrl}
                        alt={typeLabel(type)}
                        className="max-h-12 w-auto max-w-full object-contain"
                      />
                    </span>
                  ) : (
                    <span className="flex-1 text-xs text-muted-foreground">
                      {strings.capturePending}
                    </span>
                  )}
                  <Button
                    variant={draft ? "ghost" : "primary"}
                    size="sm"
                    onClick={() => setComposer(type)}
                  >
                    {draft
                      ? strings.captureRedo
                      : type === "signature"
                        ? strings.captureSignature
                        : strings.captureInitials}
                  </Button>
                </li>
              );
            })}
          </ul>

          <div className="mt-4">
            <Button
              size="md"
              disabled={!ready}
              onClick={() => setStage("review")}
            >
              {strings.captureContinue}
              <ArrowRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      {current && stage === "review" ? (
        <div className="glass rounded-ios p-5">
          <h4 className="text-headline text-foreground">
            {strings.reviewTitle(currentDisplayName)}
          </h4>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {strings.reviewBody(currentFieldCount)}
          </p>

          <div className="mt-4 flex flex-wrap gap-3">
            {required.map((type) => {
              const draft = capture[type];
              if (!draft) return null;
              return (
                <figure
                  key={type}
                  className="rounded-ios-sm border border-white/10 bg-white p-3"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={draft.dataUrl}
                    alt={typeLabel(type)}
                    className="max-h-16 w-auto max-w-40 object-contain"
                  />
                  <figcaption className="mt-2 text-caption-2 text-neutral-500">
                    {typeLabel(type)}
                  </figcaption>
                </figure>
              );
            })}
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            <Button size="md" onClick={() => goToTurn(position + 1)}>
              {position + 1 < queue.length
                ? strings.reviewNext
                : strings.reviewFinish}
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={() => setStage("capture")}
            >
              {strings.reviewRedo}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Estado de la ronda */}
      <ul className="space-y-2">
        {queue.map((signer, index) => {
          const done = isSignerComplete(
            fields,
            captures,
            signer.id,
            documentKey,
          );
          return (
            <li
              key={signer.id}
              className="rounded-ios-sm flex items-center gap-3 border border-white/10 bg-white/5 p-3"
            >
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-full"
                /* Color del firmante: dato del documento, no un token del tema. */
                style={{ backgroundColor: signer.color }}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {displayNameOf(signer)}
              </span>
              <span
                className={cn(
                  "flex items-center gap-1 text-caption font-semibold",
                  done ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {done ? (
                  <Check aria-hidden="true" className="size-3.5" />
                ) : null}
                {done ? strings.statusSigned : strings.statusPending}
              </span>
              {!done ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => goToTurn(index)}
                >
                  {strings.handoffReady}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="glass rounded-ios p-5">
        <h4 className="text-headline text-foreground">
          {pending.length === 0 ? strings.allSignedTitle : strings.ceremonyTitle}
        </h4>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {pending.length === 0
            ? strings.allSignedBody
            : strings.pendingBody(pending.length)}
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="lg"
            disabled={pending.length > 0 || queue.length === 0 || busy}
            onClick={onFinish}
          >
            {strings.applyAndDownload}
          </Button>
          <Button
            variant="ghost"
            size="lg"
            onClick={() => {
              onCapturesChange({});
              goToTurn(0);
            }}
          >
            {strings.restartCeremony}
          </Button>
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          {strings.legalNote}
        </p>
      </div>

      {current && composer ? (
        <SignatureComposer
          open
          onClose={() => setComposer(null)}
          strings={strings}
          variant={composer === "initials" ? "initials" : "signature"}
          title={
            composer === "initials"
              ? strings.composerInitialsFor(currentDisplayName)
              : strings.composerFor(currentDisplayName)
          }
          onSave={(draft) => saveDraft(composer, draft)}
        />
      ) : null}
    </section>
  );
}
