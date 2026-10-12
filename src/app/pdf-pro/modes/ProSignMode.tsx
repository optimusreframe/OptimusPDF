"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { FillEmbedded } from "@/app/sign-pdf/FillEmbedded";
import { ModeHeaderSlotContext } from "@/app/sign-pdf/embeddedChrome";
import { SignEmbedded } from "@/app/sign-pdf/SignEmbedded";
import { SIGN_EMBEDDED_STRINGS } from "@/app/sign-pdf/signEmbeddedStrings";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import type { ProModeProps } from "@/app/pdf-pro/modes/modeTypes";
import { useProModeHost } from "@/app/pdf-pro/modes/modeContext";
import { useEntryFocus } from "@/app/pdf-pro/modes/modeFocus";
import { useOptionalProWorkingDocState } from "@/app/pdf-pro/useProWorkingDoc";

type SubMode = "sign" | "fill";

/** Lo que el documento de trabajo sabe del PDF (firmas digitales, copia descifrada), si hay proveedor. */
function useDocumentFacts() {
  const state = useOptionalProWorkingDocState();
  return state?.document
    ? { signatures: state.document.signatures, encrypted: state.document.wasEncrypted }
    : undefined;
}

/**
 * Modo de la pestana «Firmar» de PDF Pro (Wave 7 · U7): la herramienta Firmar (lienzo, paleta, baul, ceremonia)
 * sobre el snapshot vigente y, en el mismo sitio, «Rellenar formulario» (campos AcroForm reales, huecos
 * sugeridos y texto libre), como la herramienta «Rellenar y firmar» de los editores de escritorio. Un
 * conmutador arriba elige cual; cada uno tiene su sesion y su «Aplicar» (UN snapshot). Cambiar de uno a otro
 * con trabajo sin aplicar pide confirmacion: las dos sesiones nunca conviven.
 *
 * El anfitrion puede pedir una herramienta (`intent.tool` = `sign` o `fill`, p. ej. desde la paleta de comandos):
 * se abre esa, con la misma confirmacion si hay trabajo sin aplicar.
 */
export function ProSignMode({ file, bytes, lang, onApply, onCancel, onDirtyChange }: ProModeProps) {
  const facts = useDocumentFacts();
  const e = SIGN_EMBEDDED_STRINGS[lang];
  const [sub, setSub] = useState<SubMode>("sign");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<SubMode | null>(null);
  const host = useProModeHost();
  const intent = host?.intent ?? null;
  const reportName = host?.reportName;
  // La barra del anfitrion nombra la herramienta abierta («Firmando» / «Rellenando»).
  useEffect(() => {
    reportName?.(sub);
    return () => reportName?.(null);
  }, [reportName, sub]);
  // Entrar con S o F deja el foco en <body> al desmontarse el visor: pasa al conmutador de herramienta.
  const rootRef = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEntryFocus(rootRef, '[data-pro-mode-switch] [role="tab"][tabindex="0"]');
  const [seenIntent, setSeenIntent] = useState(0);
  if (intent && intent.nonce !== seenIntent) {
    setSeenIntent(intent.nonce);
    if ((intent.tool === "sign" || intent.tool === "fill") && intent.tool !== sub) {
      if (dirty) setPending(intent.tool);
      else setSub(intent.tool);
    }
  }

  const label = (mode: SubMode) => (mode === "sign" ? e.switchSign : e.switchFill);
  const reportDirty = useCallback(
    (next: boolean) => {
      setDirty(next);
      onDirtyChange(next);
    },
    [onDirtyChange],
  );
  const choose = (next: SubMode) => {
    if (next === sub) return;
    if (dirty) setPending(next);
    else setSub(next);
  };

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col" data-pro-mode-switch-host="">
      <div className="shrink-0 px-3 pt-1.5 md:px-4">
        <div className="mx-auto flex w-full max-w-[1100px] flex-wrap items-center gap-x-3 gap-y-1">
          <div className="w-full max-w-sm min-w-[16rem] flex-1" data-pro-mode-switch="">
            <SegmentedControl<SubMode>
              label={e.switchLabel}
              hideLabel
              value={sub}
              onChange={choose}
              options={[
                { value: "sign", label: e.switchSign },
                { value: "fill", label: e.switchFill },
              ]}
            />
          </div>
          {/* Aqui pinta su fila cada herramienta (modo de firma, estado, notas): una sola fila en total. */}
          <div ref={setSlot} className="contents" data-pro-mode-header-slot="" />
        </div>
      </div>
      <ModeHeaderSlotContext.Provider value={slot}>
      {sub === "sign" ? (
        <SignEmbedded
          key="sign"
          file={file}
          bytes={bytes}
          lang={lang}
          onApply={onApply}
          onCancel={onCancel}
          onDirtyChange={reportDirty}
          facts={facts}
        />
      ) : (
        <FillEmbedded
          key="fill"
          file={file}
          bytes={bytes}
          lang={lang}
          onApply={onApply}
          onCancel={onCancel}
          onDirtyChange={reportDirty}
          facts={facts}
        />
      )}
      </ModeHeaderSlotContext.Provider>
      <ConfirmSheet
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) {
            setSub(pending);
            setDirty(false);
          }
          setPending(null);
        }}
        title={e.switchConfirmTitle}
        body={e.switchConfirmBody(label(sub))}
        confirmLabel={e.switchConfirm}
        cancelLabel={e.switchStay}
        closeLabel={SIGN_STRINGS[lang].confirmClose}
      />
    </div>
  );
}
