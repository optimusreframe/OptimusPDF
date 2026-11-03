"use client";

import type { ReactNode } from "react";
import {
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  CalendarDays,
  CaseUpper,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Equal,
  PenLine,
  Repeat,
  Signature,
  SquareCheck,
  Trash2,
  Type,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { DetectedFieldType } from "@/lib/pdf/detectFields";
import type { SignatureFieldType } from "@/lib/pdf/sign";
import type { NormalizedRect } from "@/lib/pdf/core";
import type { TaggableType } from "@/lib/fieldTags";
import type { SignStrings } from "@/app/sign-pdf/strings";
import { FieldTagPicker } from "@/app/sign-pdf/FieldTagPicker";
import type { EditModeStrings } from "@/app/sign-pdf/editMode/editModeStrings";
import { ChoiceRow, IconButton, PillButton, SectionTitle, SwitchRow, type Choice } from "@/app/sign-pdf/editMode/editUi";
import { InspectorSlider } from "@/app/sign-pdf/editMode/InspectorSlider";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  fromPercent,
  toPercent,
  type AlignMode,
} from "@/app/sign-pdf/editMode/editGeometry";

/*
 * Inspector contextual del elemento seleccionado (W3-B1): lo que antes estaba repartido entre la barra flotante y los
 * tiradores, con valores que se pueden ajustar a ojo (deslizadores) y al decimal (numero y pasos de 44 px). Es solo
 * presentacion: cada accion llega ya resuelta desde el lienzo, que es quien conoce la sesion.
 */

export type InspectorProps = {
  strings: SignStrings;
  edit: EditModeStrings;
  /** Nombre visible del elemento («Firma de Ana», «Campo 3»). */
  name: string;
  /** Tipo en palabras («Firma», «Texto», «Casilla»...). */
  typeName: string;
  color: string;
  kind: "slot" | "text";
  rect: NormalizedRect;
  /** Varios firmantes: quien firma este hueco. */
  signer: { value: string; choices: readonly Choice<string>[] } | null;
  slotType: SignatureFieldType | null;
  textType: DetectedFieldType | null;
  /** El ajuste de tipos ricos (casilla, fecha, iniciales) esta activo. */
  richTypes: boolean;
  /** Etiqueta del dato (solo texto y fecha, con las etiquetas activadas). */
  tag: { type: TaggableType; current: string | null; suggested: string | null } | null;
  optional: boolean;
  fontSize: number | undefined;
  /** Tamano de letra (pt) con el que se ve hoy el texto cuando es automatico. */
  autoFontSize: number;
  hasNeighbor: boolean;
  canPaste: boolean;
  canRepeat: boolean;
  /** «Solo yo»: la firma propia es una sola y no se duplica ni se copia. */
  canDuplicate: boolean;
  canCopy: boolean;
  onSize: (size: { width?: number; height?: number }) => void;
  onSigner: (signerId: string) => void;
  onSlotType: (type: SignatureFieldType) => void;
  onTextType: (type: DetectedFieldType) => void;
  onTag: (tag: string | null) => void;
  onOtherTag: () => void;
  onOptional: (optional: boolean) => void;
  onFontSize: (size: number | undefined) => void;
  onAlign: (mode: AlignMode) => void;
  onMatchSize: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onRepeat: () => void;
  onDelete: () => void;
};

export function EditInspector(props: InspectorProps) {
  const {
    strings,
    edit,
    kind,
    rect,
    optional,
    fontSize,
    autoFontSize,
    hasNeighbor,
  } = props;
  const supportsFont = kind === "text" && props.textType !== "checkbox";
  const fontValue = fontSize ?? autoFontSize;

  const typeChoices: Choice<DetectedFieldType>[] = [
    { value: "text", label: strings.fieldTypeText, icon: <Type aria-hidden="true" className="size-4" /> },
    { value: "checkbox", label: strings.fieldTypeCheckbox, icon: <SquareCheck aria-hidden="true" className="size-4" /> },
    { value: "date", label: strings.fieldTypeDate, icon: <CalendarDays aria-hidden="true" className="size-4" /> },
    { value: "initials", label: strings.fieldTypeInitials, icon: <CaseUpper aria-hidden="true" className="size-4" /> },
  ];
  const slotChoices: Choice<SignatureFieldType>[] = [
    { value: "signature", label: strings.fieldSignature, icon: <PenLine aria-hidden="true" className="size-4" /> },
    { value: "initials", label: strings.fieldInitials, icon: <Signature aria-hidden="true" className="size-4" /> },
  ];

  return (
    <div className="space-y-5" data-edit-inspector="">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="size-3.5 shrink-0 rounded-full"
          /* Color del firmante o del campo: dato del documento, no un token del tema. */
          style={{ backgroundColor: props.color }}
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-headline text-foreground">{props.name}</h3>
          <p className="text-caption text-muted-foreground">{props.typeName}</p>
        </div>
      </div>

      {/* Acciones de siempre a la vista: en el panel bajo (detente medio) estan a un toque. */}
      <div role="group" aria-label={edit.actionsSection} className="flex flex-wrap items-center gap-1">
        {props.canDuplicate ? (
          <IconButton label={edit.duplicate} onClick={props.onDuplicate}>
            <CopyPlus aria-hidden="true" className="size-5" />
          </IconButton>
        ) : null}
        {props.canCopy ? (
          <IconButton label={edit.copy} onClick={props.onCopy}>
            <Copy aria-hidden="true" className="size-5" />
          </IconButton>
        ) : null}
        {props.canCopy ? (
          <IconButton label={edit.paste} inactive={!props.canPaste} onClick={props.onPaste}>
            <ClipboardPaste aria-hidden="true" className="size-5" />
          </IconButton>
        ) : null}
        <span className="flex-1" />
        <IconButton label={edit.remove} className="text-destructive-text hover:bg-destructive/12" onClick={props.onDelete}>
          <Trash2 aria-hidden="true" className="size-5" />
        </IconButton>
      </div>

      {props.signer ? (
        <section>
          <SectionTitle>{edit.signerLabel}</SectionTitle>
          <ChoiceRow label={edit.signerLabel} value={props.signer.value} choices={props.signer.choices} onChange={props.onSigner} />
        </section>
      ) : null}

      {kind === "slot" && props.slotType ? (
        <section>
          <SectionTitle>{edit.typeLabel}</SectionTitle>
          <ChoiceRow label={edit.typeLabel} value={props.slotType} choices={slotChoices} onChange={props.onSlotType} />
        </section>
      ) : null}

      {kind === "text" && props.textType && props.richTypes ? (
        <section>
          <SectionTitle>{edit.typeLabel}</SectionTitle>
          <ChoiceRow label={edit.typeLabel} value={props.textType} choices={typeChoices} onChange={props.onTextType} />
        </section>
      ) : null}

      {props.tag ? (
        <section>
          <SectionTitle>{edit.tagSection}</SectionTitle>
          <FieldTagPicker
            type={props.tag.type}
            current={props.tag.current}
            suggested={props.tag.suggested}
            onPick={props.onTag}
            onNone={() => props.onTag(null)}
            onOther={props.onOtherTag}
            className="flex-wrap"
          />
        </section>
      ) : null}

      {kind === "text" ? (
        <SwitchRow
          label={edit.requiredLabel}
          hint={optional ? edit.requiredOff : edit.requiredOn}
          checked={!optional}
          onChange={(required) => props.onOptional(!required)}
        />
      ) : null}

      <section aria-label={edit.sizeSection}>
        <SectionTitle>{edit.sizeSection}</SectionTitle>
        <div className="space-y-3">
          <InspectorSlider
            label={edit.widthLabel}
            value={toPercent(rect.width)}
            min={2}
            max={100}
            step={0.5}
            unit="%"
            decreaseLabel={edit.stepDown(edit.widthLabel)}
            increaseLabel={edit.stepUp(edit.widthLabel)}
            valueLabel={edit.valueOf(edit.widthLabel)}
            onChange={(value) => props.onSize({ width: fromPercent(value) })}
          />
          <InspectorSlider
            label={edit.heightLabel}
            value={toPercent(rect.height)}
            min={2}
            max={100}
            step={0.5}
            unit="%"
            decreaseLabel={edit.stepDown(edit.heightLabel)}
            increaseLabel={edit.stepUp(edit.heightLabel)}
            valueLabel={edit.valueOf(edit.heightLabel)}
            onChange={(value) => props.onSize({ height: fromPercent(value) })}
          />
          {supportsFont ? (
            <div className="space-y-1">
              <InspectorSlider
                label={edit.fontSizeLabel}
                value={fontValue}
                min={FONT_SIZE_MIN}
                max={FONT_SIZE_MAX}
                step={0.5}
                unit="pt"
                decreaseLabel={edit.stepDown(edit.fontSizeLabel)}
                increaseLabel={edit.stepUp(edit.fontSizeLabel)}
                valueLabel={edit.valueOf(edit.fontSizeLabel)}
                onChange={(value) => props.onFontSize(value)}
              />
              <SwitchRow
                label={edit.fontSizeUseAuto}
                hint={fontSize === undefined ? edit.fontSizeAutoHint : undefined}
                checked={fontSize === undefined}
                onChange={(auto) => props.onFontSize(auto ? undefined : autoFontSize)}
              />
            </div>
          ) : null}
        </div>
      </section>

      <section aria-label={edit.alignSection}>
        <SectionTitle>{edit.alignSection}</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <AlignButton label={edit.alignLeft} disabled={!hasNeighbor} onClick={() => props.onAlign("left")}>
            <AlignHorizontalJustifyStart aria-hidden="true" className="size-5" />
          </AlignButton>
          <AlignButton label={edit.alignCenter} disabled={!hasNeighbor} onClick={() => props.onAlign("center")}>
            <AlignHorizontalJustifyCenter aria-hidden="true" className="size-5" />
          </AlignButton>
          <AlignButton label={edit.alignRight} disabled={!hasNeighbor} onClick={() => props.onAlign("right")}>
            <AlignHorizontalJustifyEnd aria-hidden="true" className="size-5" />
          </AlignButton>
          <PillButton aria-disabled={!hasNeighbor} onClick={hasNeighbor ? props.onMatchSize : undefined}>
            <Equal aria-hidden="true" className="size-4" />
            {edit.matchSize}
          </PillButton>
        </div>
        {!hasNeighbor ? <p className="mt-1.5 text-caption text-muted-foreground">{edit.alignNoNeighbor}</p> : null}
      </section>

      {props.canRepeat ? (
        <PillButton className="w-full" onClick={props.onRepeat}>
          <Repeat aria-hidden="true" className="size-4" />
          {edit.repeatAll}
        </PillButton>
      ) : null}
    </div>
  );
}

function AlignButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-disabled={disabled ? true : undefined}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "inline-flex size-11 items-center justify-center rounded-ios-sm bg-white/8 text-foreground hover:bg-white/14",
        "transition-[background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] active:scale-[0.95] motion-reduce:active:scale-100",
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal forced-colors:border forced-colors:border-[ButtonText]",
        disabled && "opacity-40",
      )}
    >
      {children}
    </button>
  );
}
