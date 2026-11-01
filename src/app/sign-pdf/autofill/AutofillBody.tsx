"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { AlertTriangle, Camera, ClipboardPaste, Download, FileText, Image as ImageIcon, Lock, ScanLine, Type, Upload, UserRound, X } from "lucide-react";
import { StatusRegion } from "@/components/tool/liveRouting";
import { Button } from "@/components/ui/Button";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { Spinner } from "@/components/ui/Spinner";
import { HIT_44 } from "@/components/ui/touchTarget";
import { cn } from "@/lib/cn";
import { formatFileSize } from "@/lib/pdf/core";
import { useClientProfiles } from "@/lib/clientProfile/store";
import { ProfilesPanel } from "@/app/sign-pdf/autofill/ProfilesPanel";
import { ReviewStep } from "@/app/sign-pdf/autofill/ReviewStep";
import { AUTOFILL_TEXTAREA_CLASS } from "@/app/sign-pdf/autofill/ui";
import { useAutofillFlow, MAX_SOURCES, type AutofillFlowParams, type SourceEntry } from "@/app/sign-pdf/autofill/useAutofillFlow";

/**
 * Contenido de la hoja «Rellenar con datos del cliente»: elegir fuentes -> leyendo (con cancelar) -> revisar, y los perfiles
 * guardados. Vive DENTRO de la hoja: se monta al abrirla y se desmonta al cerrarla, asi que cerrar cancela la lectura y olvida
 * los archivos elegidos (no se quedan en memoria).
 *
 * Foco: al abrir lo recibe el primer control (`data-autofill-initial`, via `initialFocus` de la hoja); al cambiar de paso, el
 * titulo del paso nuevo (o «Cancelar» mientras lee); al cerrar, la hoja lo devuelve al boton que la abrio.
 */

const KIND_ICON = { pdf: FileText, image: ImageIcon, text: Type } as const;

function EntryRow({ entry, flow }: { entry: SourceEntry; flow: ReturnType<typeof useAutofillFlow> }) {
  const { strings } = flow;
  const Icon = KIND_ICON[entry.kind];
  const kind = entry.kind === "pdf" ? strings.kindPdf : entry.kind === "image" ? strings.kindImage : strings.kindText;
  return (
    <li className="surface-card rounded-ios-sm flex items-center gap-3 p-3" data-autofill-source={entry.id}>
      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-ios-sm bg-white/6">
        <Icon className="size-4 text-signal" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground" title={entry.name}>
          {entry.name}
        </p>
        <p className="text-caption text-muted-foreground">
          {strings.originName[entry.origin]} · {kind}
          {entry.kind === "text" ? "" : ` · ${formatFileSize(entry.size)}`}
        </p>
      </div>
      <button
        type="button"
        aria-label={strings.remove(entry.name)}
        onClick={() => flow.removeEntry(entry.id)}
        className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal pointer-coarse:size-11", HIT_44)}
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </li>
  );
}

export function AutofillBody(props: AutofillFlowParams) {
  const [announce, setAnnounce] = useState("");
  const flow = useAutofillFlow({ ...props, onAnnounce: (text) => setAnnounce(text) });
  const { strings, phase } = flow;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const introRef = useRef<HTMLParagraphElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const scanRef = useRef<HTMLInputElement>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const profiles = useClientProfiles();
  const firstPhase = useRef(true);

  // El motor se carga al abrir la hoja (no con la pagina de Firmar).
  const { loadEngine } = flow;
  useEffect(() => {
    loadEngine();
  }, [loadEngine]);

  // Cambio de paso: el foco va al titulo del paso nuevo (o a «Cancelar» mientras lee). El primer pintado lo decide la hoja.
  useEffect(() => {
    if (firstPhase.current) {
      firstPhase.current = false;
      return;
    }
    const target = phase === "reading" || phase === "downloading" ? cancelRef.current : phase === "choose" ? introRef.current : headingRef.current;
    target?.focus({ preventScroll: true });
  }, [phase]);

  useEffect(() => {
    if (pasting) pasteRef.current?.focus();
  }, [pasting]);

  const submitPaste = (event: FormEvent) => {
    event.preventDefault();
    if (flow.addText(pasted)) {
      setPasted("");
      setPasting(false);
    }
  };

  return (
    <div className="space-y-4 pb-2" data-autofill-body="" data-phase={phase}>
      <StatusRegion text={announce} className="sr-only">
        {announce}
      </StatusRegion>

      {phase === "choose" ? (
        <div className="space-y-4" data-autofill-choose="">
          <div className="space-y-2">
            <p ref={introRef} tabIndex={-1} className="text-subheadline text-foreground outline-none">
              {strings.chooseIntro}
            </p>
            <p className="flex items-start gap-2 text-footnote leading-relaxed text-muted-foreground">
              <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {strings.privacyLine}
            </p>
          </div>

          <input ref={uploadRef} type="file" multiple accept="application/pdf,image/*,.pdf" className="sr-only" tabIndex={-1} aria-hidden="true" data-autofill-input="file" onChange={(event) => { flow.addFiles(event.target.files, "file"); event.target.value = ""; }} />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" data-autofill-input="camera" onChange={(event) => { flow.addFiles(event.target.files, "camera"); event.target.value = ""; }} />
          <input ref={scanRef} type="file" multiple accept="application/pdf,image/*,.pdf" className="sr-only" tabIndex={-1} aria-hidden="true" data-autofill-input="scan" onChange={(event) => { flow.addFiles(event.target.files, "scan"); event.target.value = ""; }} />

          <div role="group" aria-label={strings.sourcesLegend} className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
            <Button variant="secondary" size="md" wrap fullWidth onClick={() => uploadRef.current?.click()} data-autofill-initial="">
              <Upload aria-hidden="true" className="size-4 shrink-0" />
              {strings.upload}
            </Button>
            <Button variant="secondary" size="md" wrap fullWidth onClick={() => cameraRef.current?.click()}>
              <Camera aria-hidden="true" className="size-4 shrink-0" />
              {strings.camera}
            </Button>
            <Button variant="secondary" size="md" wrap fullWidth onClick={() => scanRef.current?.click()}>
              <ScanLine aria-hidden="true" className="size-4 shrink-0" />
              {strings.scanned}
            </Button>
            <Button variant="secondary" size="md" wrap fullWidth aria-expanded={pasting} onClick={() => setPasting((on) => !on)}>
              <ClipboardPaste aria-hidden="true" className="size-4 shrink-0" />
              {strings.paste}
            </Button>
          </div>

          <Link
            href="/scan-to-pdf"
            target="_blank"
            rel="noopener"
            className="inline-flex min-h-6 items-center text-footnote font-medium text-signal-text underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal pointer-coarse:min-h-11"
            data-autofill-scan-link=""
          >
            {strings.scanLink}
          </Link>

          {pasting ? (
            <form onSubmit={submitPaste} className="space-y-2" data-autofill-paste="">
              <label htmlFor="autofill-paste-text" className="ui-label text-muted-foreground">
                {strings.pasteLabel}
              </label>
              <textarea id="autofill-paste-text" ref={pasteRef} value={pasted} onChange={(event) => setPasted(event.target.value)} rows={5} spellCheck={false} aria-describedby="autofill-paste-hint" className={AUTOFILL_TEXTAREA_CLASS} />
              <p id="autofill-paste-hint" className="text-footnote text-muted-foreground">
                {strings.pasteHint}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" size="md" disabled={pasted.trim() === "" || flow.entries.length >= MAX_SOURCES}>
                  {strings.pasteAdd}
                </Button>
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => {
                    setPasting(false);
                    setPasted("");
                  }}
                >
                  {strings.pasteCancel}
                </Button>
              </div>
            </form>
          ) : null}

          {flow.entries.length > 0 ? (
            <section className="space-y-2" aria-label={strings.chosenTitle(flow.entries.length)}>
              <h3 className="text-callout font-semibold text-foreground">{strings.chosenTitle(flow.entries.length)}</h3>
              <ul className="space-y-2">
                {flow.entries.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} flow={flow} />
                ))}
              </ul>
            </section>
          ) : null}

          {flow.notices.length > 0 ? (
            <ul className="space-y-1" data-autofill-notices="">
              {flow.notices.map((notice) => (
                <li key={notice} className="flex items-start gap-2 text-footnote leading-relaxed text-foreground">
                  <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-edit" />
                  <span className="[overflow-wrap:anywhere]">{notice}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {flow.failure ? (
            <p role="alert" className="flex items-start gap-2 text-footnote leading-relaxed text-destructive-text" data-autofill-failure="">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {strings.readFailed}
            </p>
          ) : null}

          <div className="space-y-2">
            <Button size="md" fullWidth wrap disabled={flow.entries.length === 0 || flow.checking} aria-describedby={flow.entries.length === 0 ? "autofill-no-sources" : undefined} onClick={() => void flow.start()} data-autofill-read="">
              {strings.read}
            </Button>
            {flow.entries.length === 0 ? (
              <p id="autofill-no-sources" className="text-footnote text-muted-foreground">
                {strings.noSources}
              </p>
            ) : null}
          </div>

          <div className="border-t border-white/10 pt-3">
            <Button variant="ghost" size="md" fullWidth wrap onClick={flow.showProfiles} data-autofill-profiles-button="">
              <UserRound aria-hidden="true" className="size-4 shrink-0" />
              {strings.profilesButton}
              {profiles.length > 0 ? ` (${profiles.length})` : ""}
            </Button>
          </div>
        </div>
      ) : null}

      {phase === "model" ? (
        <div className="space-y-4" data-autofill-model="">
          <h3 ref={headingRef} tabIndex={-1} className="text-headline text-foreground outline-none">
            {strings.modelTitle}
          </h3>
          <p className="text-subheadline text-foreground" data-autofill-model-body="">
            {strings.modelBody}
          </p>
          <p className="text-footnote leading-relaxed text-muted-foreground">{strings.modelNote}</p>
          {flow.modelFailure ? (
            <p role="alert" className="flex items-start gap-2 text-footnote leading-relaxed text-destructive-text" data-autofill-model-failure="">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {strings.modelFailed(flow.modelFailure)}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Button size="md" fullWidth wrap onClick={() => void flow.downloadModel()} data-autofill-model-download="">
              <Download aria-hidden="true" className="size-4 shrink-0" />
              {flow.modelFailure ? strings.modelRetryDownload : strings.modelDownload}
            </Button>
            {flow.entries.some((entry) => entry.kind !== "image") ? (
              <Button variant="secondary" size="md" fullWidth wrap onClick={() => void flow.start({ skipPhotos: true })} data-autofill-model-skip="">
                {strings.modelSkipPhotos}
              </Button>
            ) : null}
            <Button variant="ghost" size="md" fullWidth wrap onClick={flow.backToChoose}>
              {strings.back}
            </Button>
          </div>
        </div>
      ) : null}

      {phase === "downloading" ? (
        <div className="space-y-4" data-autofill-downloading="">
          <div className="flex items-center gap-3">
            <Spinner />
            <p className="text-subheadline text-foreground">{strings.modelDownloading}</p>
          </div>
          <p className="text-footnote leading-relaxed text-muted-foreground">{strings.modelDownloadingNote}</p>
          <Button ref={cancelRef} variant="secondary" size="md" fullWidth wrap onClick={flow.cancel} data-autofill-cancel="">
            {strings.cancel}
          </Button>
        </div>
      ) : null}

      {phase === "reading" ? (
        <div className="space-y-4" data-autofill-reading="">
          <div className="flex items-center gap-3">
            <Spinner />
            <p className="text-subheadline text-foreground">{strings.reading}</p>
          </div>
          <ProgressBar value={flow.progress * 100} label={strings.readingLabel} />
          <p className="text-footnote leading-relaxed text-muted-foreground">{strings.readingNote}</p>
          <Button ref={cancelRef} variant="secondary" size="md" fullWidth wrap onClick={flow.cancel} data-autofill-cancel="">
            {strings.cancel}
          </Button>
        </div>
      ) : null}

      {phase === "review" ? <ReviewStep ref={headingRef} flow={flow} /> : null}

      {phase === "profiles" ? <ProfilesPanel ref={headingRef} strings={strings} locale={flow.locale} onUse={flow.useProfile} onBack={flow.backToChoose} onAnnounce={setAnnounce} /> : null}
    </div>
  );
}
