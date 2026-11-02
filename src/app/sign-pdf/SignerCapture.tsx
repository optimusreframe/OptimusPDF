"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, Circle, PenLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { StatusRegion } from "@/components/tool/liveRouting";
import { cn } from "@/lib/cn";
import { SignatureComposer, type SignatureDraft } from "@/app/sign-pdf/SignatureComposer";
import { SignatureVaultSheet } from "@/app/sign-pdf/SignatureVaultSheet";
import { StaleSignatureNotice } from "@/app/sign-pdf/StaleSignatureNotice";
import { VaultNoticeLine } from "@/app/sign-pdf/VaultNoticeLine";
import { CaptureRow } from "@/app/sign-pdf/SigningCeremony";
import { hasCollected, type EarlyGroup, type EarlyStatus } from "@/app/sign-pdf/earlyCapture";
import type { SavedDrafts } from "@/app/sign-pdf/blockModel";
import { useSignPdfFeatureFlag } from "@/app/sign-pdf/signFeatureFlags";
import { touchVaultEntry, vaultImageToDataUrl } from "@/app/sign-pdf/signVault";
import { rememberDrafts, type VaultNotice } from "@/app/sign-pdf/vaultMessages";
import type { SignStrings } from "@/app/sign-pdf/strings";
import type { SignatureFieldType, Signer } from "@/lib/pdf/sign";

/*
 * Recoger la firma y las iniciales de un firmante en el paso «Firmantes» (antes o despues de poner sus campos). La linea de
 * estado va dentro de la tarjeta del firmante (`SignerManager`) y el panel se abre EN LINEA, no en una hoja: el compositor
 * ya es un dialogo, y dos dialogos apilados confunden a los lectores de pantalla. Todo el estado vive fuera
 * (`useEarlyCapture`); aqui solo hay lo que es de pantalla: panel abierto, compositor y baul abiertos.
 */

/** Lo que `SignerManager` necesita para pintar y editar lo recogido de cada firmante. */
export type SignerCaptureApi = {
  /** `false` mientras se calcula la huella del documento: no se recoge nada hasta tenerla. */
  ready: boolean;
  statusOf: (signerId: string) => EarlyStatus;
  /** Un grupo por bloque del firmante (uno solo con un documento). */
  groupsOf: (signerId: string) => EarlyGroup[];
  onSave: (signerId: string, groupId: string, type: SignatureFieldType, draft: SignatureDraft) => void;
  /** Aplica una firma guardada del baul (con `applyToAll`, a los demas grupos VACIOS del firmante). */
  onUseSaved: (
    signerId: string,
    groupId: string,
    saved: SavedDrafts,
    applyToAll: boolean,
  ) => { missing: SignatureFieldType[]; filledOthers: number };
  onClear: (signerId: string) => void;
  /** Documento al que se dice que pertenece lo guardado en el baul («Recordar»). */
  sourceOf: (groupId: string) => string;
  /** Frase para la region viva (siempre montada en `SignerManager`). */
  liveMessage: string;
  /** Una frase por firmante cuya firma YA recogida dejo de valer. */
  staleNotes: readonly { signerId: string; text: string }[];
};

/** El estado en palabras: lo que lee la persona y un lector de pantalla (el icono y el color solo acompanan). */
export function earlyStatusText(status: EarlyStatus, strings: SignStrings): string {
  const early = strings.early;
  switch (status.kind) {
    case "complete":
      return early.statusComplete;
    case "signature":
      return early.statusSignature;
    case "initials":
      return early.statusInitials;
    case "partial":
      return early.statusPartial;
    case "stale":
      return `${strings.statusStale} · ${strings.staleReasonShort(status.reason ?? "document")}`;
    default:
      return early.statusNone;
  }
}

function StatusIcon({ kind }: { kind: EarlyStatus["kind"] }) {
  const common = "size-4 shrink-0";
  if (kind === "complete") return <Check aria-hidden="true" className={cn(common, "text-success-text")} />;
  if (kind === "stale") return <AlertTriangle aria-hidden="true" className={cn(common, "text-destructive-text")} />;
  if (kind === "none") return <Circle aria-hidden="true" className={cn(common, "text-muted-foreground")} />;
  return <PenLine aria-hidden="true" className={cn(common, "text-foreground")} />;
}

/** Region viva unica + aviso de firmas caducadas: se pintan una vez, sobre la lista de firmantes. */
export function SignerCaptureNotices({ api }: { api: SignerCaptureApi }) {
  return (
    <>
      {/* Region viva siempre montada: lo recogido o quitado se anuncia aqui (una sola para todas las tarjetas). */}
      <StatusRegion as="p" text={api.liveMessage} className="sr-only">
        {api.liveMessage}
      </StatusRegion>
      <StaleSignatureNotice items={api.staleNotes} />
    </>
  );
}

export type SignerCaptureSectionProps = {
  signer: Signer;
  /** Nombre a mostrar (con el respaldo numerado de `SignerManager`). */
  name: string;
  /** Huecos del firmante en todos los documentos. */
  fieldCount: number;
  api: SignerCaptureApi;
  strings: SignStrings;
};

/**
 * Estado + acciones + panel de UN firmante: «Recoger firma e iniciales» (o «Cambiar» y «Quitar» si ya hay algo), el aviso de
 * que aun no tiene campos y, abierto, una fila de Firma y otra de Iniciales por grupo. Se puede dejar una de las dos y usar una
 * guardada del baul.
 */
export function SignerCaptureSection({ signer, name, fieldCount, api, strings }: SignerCaptureSectionProps) {
  const early = strings.early;
  const status = api.statusOf(signer.id);
  const groups = api.groupsOf(signer.id);
  const collected = hasCollected(status);
  const vaultEnabled = useSignPdfFeatureFlag("signatureVault");
  const [open, setOpen] = useState(false);
  const [composer, setComposer] = useState<{ groupId: string; type: SignatureFieldType } | null>(null);
  const [vaultFor, setVaultFor] = useState<{ groupId: string; type: SignatureFieldType } | null>(null);
  const [vaultShown, setVaultShown] = useState(false);
  const [notice, setNotice] = useState<VaultNotice | null>(null);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  /** El foco entra al panel al abrirlo y vuelve al boton al cerrarlo (no al montar). */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (open) panelRef.current?.focus({ preventScroll: false });
    else toggleRef.current?.focus({ preventScroll: true });
  }, [open]);

  const statusText = api.ready ? earlyStatusText(status, strings) : strings.checkingDocument;
  const canEdit = api.ready && groups.length > 0;
  const showRemove = collected || status.kind === "stale";
  const group = (id: string) => groups.find((candidate) => candidate.id === id) ?? null;
  const composerGroup = composer ? group(composer.groupId) : null;
  const vaultGroup = vaultFor ? group(vaultFor.groupId) : null;

  return (
    <div className="space-y-2" data-early-capture={signer.id}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p
          data-early-status={api.ready ? status.kind : "checking"}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-footnote font-medium text-foreground [overflow-wrap:anywhere]"
        >
          <StatusIcon kind={api.ready ? status.kind : "none"} />
          <span>{statusText}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            ref={toggleRef}
            variant={collected ? "ghost" : "secondary"}
            size="sm"
            wrap
            disabled={!canEdit}
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            aria-label={collected ? early.changeFor(name) : early.collectFor(name)}
            onClick={() => setOpen((value) => !value)}
          >
            {collected ? early.change : early.collect}
          </Button>
          {showRemove ? (
            <Button
              variant="ghost"
              size="sm"
              wrap
              disabled={!api.ready}
              aria-label={early.removeFor(name)}
              onClick={() => {
                setNotice(null);
                api.onClear(signer.id);
                // El boton «Quitar» desaparece: el foco pasa a «Recoger» de la misma tarjeta, no a <body>.
                queueMicrotask(() => toggleRef.current?.focus({ preventScroll: true }));
              }}
            >
              {early.remove}
            </Button>
          ) : null}
        </div>
      </div>

      {/* Hay trazo vigente y ninguno de sus campos todavia: no se estampa nada y se dice en una linea. */}
      {collected && fieldCount === 0 ? (
        <p data-early-no-fields="" className="text-footnote leading-relaxed text-muted-foreground">
          {early.noFieldsYet}
        </p>
      ) : null}

      {open && canEdit ? (
        <div
          id={panelId}
          ref={panelRef}
          role="group"
          tabIndex={-1}
          aria-label={early.panelLabel(name)}
          className="rounded-ios-sm space-y-3 border border-white/10 p-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        >
          <p className="text-footnote leading-relaxed text-muted-foreground">{early.panelHint}</p>
          {groups.map((item) => (
            <div key={item.id} className="space-y-2">
              {item.label ? (
                <p className="text-footnote font-semibold text-foreground [overflow-wrap:anywhere]">{item.label}</p>
              ) : null}
              <ul className="space-y-3">
                {(["signature", "initials"] as const).map((type) => (
                  <CaptureRow
                    key={type}
                    type={type}
                    draft={item[type]}
                    strings={strings}
                    context={item.title ?? undefined}
                    onCompose={() => setComposer({ groupId: item.id, type })}
                    onOpenVault={
                      vaultEnabled
                        ? () => {
                            setNotice(null);
                            setVaultFor({ groupId: item.id, type });
                            setVaultShown(true);
                          }
                        : undefined
                    }
                    vaultDisabled={!api.ready}
                  />
                ))}
              </ul>
            </div>
          ))}
          {status.kind === "partial" ? (
            <p className="text-footnote leading-relaxed text-foreground">{early.panelPartialHint}</p>
          ) : null}
          <VaultNoticeLine notice={notice} />
          <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
            {early.done}
          </Button>
        </div>
      ) : null}

      {composer && composerGroup ? (
        <SignatureComposer
          open
          onClose={() => setComposer(null)}
          strings={strings}
          variant={composer.type === "initials" ? "initials" : "signature"}
          title={composer.type === "initials" ? strings.composerInitialsFor(name) : strings.composerFor(name)}
          onSave={(draft) => api.onSave(signer.id, composer.groupId, composer.type, draft)}
          signerName={signer.name}
          onRemember={
            vaultEnabled
              ? (draft, who) => {
                  // La firma y las iniciales de una misma persona van en UNA entrada del baul: lo recien creado + el otro trazo ya recogido.
                  const other = composer.type === "signature" ? composerGroup.initials : composerGroup.signature;
                  void rememberDrafts(strings, {
                    signerName: who.signerName,
                    sourceDocument: api.sourceOf(composer.groupId),
                    signature: composer.type === "signature" ? draft : other,
                    initials: composer.type === "initials" ? draft : other,
                    created: composer.type,
                  }).then(setNotice);
                }
              : undefined
          }
        />
      ) : null}

      {/* Se monta al abrirla por primera vez y se queda: asi la salida se anima. */}
      {vaultEnabled && vaultFor ? (
        <SignatureVaultSheet
          open={vaultShown && vaultGroup !== null}
          onClose={() => setVaultShown(false)}
          strings={strings}
          need={vaultFor.type}
          preferSignerName={signer.name}
          offerApplyAll={groups.length > 1}
          onUse={(entry, options) => {
            const applyToAll = options?.applyToAll === true;
            const saved: SavedDrafts = {
              signature: entry.signature
                ? { dataUrl: vaultImageToDataUrl(entry.signature), ratio: entry.signature.ratio }
                : null,
              initials: entry.initials
                ? { dataUrl: vaultImageToDataUrl(entry.initials), ratio: entry.initials.ratio }
                : null,
            };
            const result = api.onUseSaved(signer.id, vaultFor.groupId, saved, applyToAll);
            void touchVaultEntry(entry.id);
            setVaultShown(false);
            setNotice({
              text:
                result.missing.length > 0
                  ? strings.vaultAppliedPartial(entry.signerName, result.missing)
                  : applyToAll
                    ? strings.vaultAppliedAll(entry.signerName, result.filledOthers)
                    : strings.vaultApplied(entry.signerName),
              // Una captura parcial no es un error: se explica, sin alarma.
              tone: result.missing.length > 0 ? "info" : "success",
            });
          }}
        />
      ) : null}
    </div>
  );
}
