"use client";

import { forwardRef, useId } from "react";
import { AlertTriangle, ScanSearch } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/cn";
import type { AutofillFlow } from "@/app/sign-pdf/autofill/useAutofillFlow";
import { dataKeyLabel, effectiveValue, overwritesText, type PlannedRow, type ReviewGroup, type ReviewItem } from "@/app/sign-pdf/autofill/model";
import { readingStrings } from "@/app/sign-pdf/autofill/readingStrings";
import { AUTOFILL_INPUT_CLASS, RadioRow } from "@/app/sign-pdf/autofill/ui";

/**
 * Paso REVISAR: lo que se encontro, agrupado por tipo de dato, con casilla, valor editable, confianza (en texto, no solo color),
 * evidencia y por que; debajo, a que CAMPO del documento va cada valor y la advertencia de los que pisarian texto ya escrito.
 * Nada viene marcado salvo lo de confianza alta sin contradiccion; los campos con texto escrito vienen SIN marcar.
 */

function Evidence({ item, strings, id, locale, label }: { item: ReviewItem; strings: AutofillFlow["strings"]; id: string; locale: "es" | "en"; label: string }) {
  if (item.fromProfile) {
    return (
      <p id={id} className="text-caption text-muted-foreground [overflow-wrap:anywhere]">
        {strings.fromProfile(item.fromProfile.name)}
      </p>
    );
  }
  const reading = readingStrings(locale);
  const fromImage = item.evidence.origin === "ocr";
  return (
    <div id={id} className="space-y-1">
      {item.source ? (
        <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]" data-autofill-source="">
          {reading.from(item.source.name, item.source.kind, item.source.scanned, item.evidence.pageIndex + 1)}
        </p>
      ) : null}
      {item.evidence.crop ? (
        <figure className="m-0 space-y-1" data-autofill-crop="">
          {/* La imagen es un recorte JPEG hecho en este dispositivo (URL `data:`); nunca sale de el. Se ve entera sin desbordar a 320 px. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.evidence.crop} alt={reading.cropAlt(label)} className="block h-auto max-h-28 w-auto max-w-full rounded-ios-sm border border-white/14 bg-white object-contain" />
          <figcaption className="text-caption text-muted-foreground">{reading.cropLabel}</figcaption>
        </figure>
      ) : null}
      {item.evidence.snippet ? (
        <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]" data-autofill-evidence="">
          {strings.evidence(item.evidence.pageIndex + 1, item.evidence.snippet)}
        </p>
      ) : null}
      {fromImage ? (
        <p className="flex items-start gap-1.5 text-caption text-muted-foreground" data-autofill-ocr-note={item.evidence.verified === false ? "unconfirmed" : item.evidence.verified === true ? "confirmed" : "read"}>
          <ScanSearch aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span>{item.evidence.verified === false ? reading.notConfirmed : item.evidence.verified === true ? `${reading.ocrCheck} ${reading.confirmed}` : reading.ocrCheck}</span>
        </p>
      ) : null}
      {item.reason ? (
        <p className="text-caption text-muted-foreground [overflow-wrap:anywhere]" data-autofill-why="">
          {strings.why(item.reason)}
        </p>
      ) : null}
    </div>
  );
}

function ConfidenceBadge({ item, strings }: { item: ReviewItem; strings: AutofillFlow["strings"] }) {
  if (item.fromProfile) return null;
  const high = item.tier === "high";
  return (
    <Badge variant={high ? "success" : "neutral"} data-autofill-confidence={item.tier}>
      {high ? strings.confidenceHigh : strings.confidenceReview}
    </Badge>
  );
}

function ValueInput({ item, label, flow, disabled }: { item: ReviewItem; label: string; flow: AutofillFlow; disabled?: boolean }) {
  const id = useId();
  const value = Object.prototype.hasOwnProperty.call(flow.edits, item.id) ? flow.edits[item.id] : item.value;
  return (
    <div>
      <label htmlFor={id} className="sr-only">
        {flow.strings.valueLabel(label)}
      </label>
      <input
        id={id}
        type="text"
        value={value}
        disabled={disabled}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(event) => flow.edit(item.id, event.target.value)}
        className={AUTOFILL_INPUT_CLASS}
        data-autofill-value={item.id}
      />
    </div>
  );
}

function SingleGroup({ group, flow }: { group: ReviewGroup; flow: AutofillFlow }) {
  const item = group.items[0];
  const on = flow.selection[group.key] === item.id;
  const evId = useId();
  const edited = Object.prototype.hasOwnProperty.call(flow.edits, item.id) && effectiveValue(item, flow.edits) !== item.value;
  return (
    <fieldset className="surface-card rounded-ios-sm min-w-0 space-y-1 p-3" data-autofill-group={group.key}>
      <legend className="sr-only">{group.label}</legend>
      <Checkbox
        label={group.label}
        checked={on}
        onChange={(next) => flow.select(group.key, next ? item.id : null)}
        // El nombre accesible incluye el valor para que «Teléfono» no se lea sin saber que se va a usar.
        id={`autofill-use-${item.id}`}
      />
      <div className="space-y-1.5 pl-[34px]">
        <ValueInput item={item} label={group.label} flow={flow} />
        <div className="flex flex-wrap items-center gap-1.5">
          <ConfidenceBadge item={item} strings={flow.strings} />
          {edited ? <Badge variant="signal">{flow.strings.edited}</Badge> : null}
        </div>
        <Evidence item={item} strings={flow.strings} id={evId} locale={flow.locale} label={group.label} />
      </div>
    </fieldset>
  );
}

function ChoiceGroup({ group, flow }: { group: ReviewGroup; flow: AutofillFlow }) {
  const name = useId();
  const chosen = flow.selection[group.key] ?? null;
  return (
    <fieldset className="surface-card rounded-ios-sm min-w-0 space-y-1 p-3" data-autofill-group={group.key} data-autofill-multiple="">
      {/* `float-left w-full`: la leyenda queda DENTRO de la tarjeta (no a caballo sobre su borde). */}
      <legend className="ui-label float-left mb-1 w-full px-0 text-foreground">{group.label}</legend>
      <p className="clear-both flex items-start gap-2 text-footnote leading-relaxed text-muted-foreground">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {flow.strings.groupConflict}
      </p>
      {group.items.map((item) => {
        const selected = chosen === item.id;
        const evId = `${name}-${item.id}-ev`;
        const edited = Object.prototype.hasOwnProperty.call(flow.edits, item.id) && effectiveValue(item, flow.edits) !== item.value;
        return (
          <RadioRow key={item.id} name={name} label={effectiveValue(item, flow.edits) || item.value} checked={selected} onChange={() => flow.select(group.key, item.id)} describedBy={evId}>
            <div className="space-y-1.5 pb-2">
              {selected ? <ValueInput item={item} label={group.label} flow={flow} /> : null}
              <div className="flex flex-wrap items-center gap-1.5">
                <ConfidenceBadge item={item} strings={flow.strings} />
                {edited ? <Badge variant="signal">{flow.strings.edited}</Badge> : null}
              </div>
              <Evidence item={item} strings={flow.strings} id={evId} locale={flow.locale} label={group.label} />
            </div>
          </RadioRow>
        );
      })}
      <RadioRow name={name} label={flow.strings.noneOption} checked={chosen === null} onChange={() => flow.select(group.key, null)} />
    </fieldset>
  );
}

function MapRow({ row, flow }: { row: PlannedRow; flow: AutofillFlow }) {
  const label = row.field.label?.trim() || "";
  const on = flow.checked[row.field.id] === true;
  const warn = overwritesText(row);
  const noteId = useId();
  const name = label || flow.strings.mapRowNoLabel(row.page);
  return (
    <li className="surface-card rounded-ios-sm min-w-0 space-y-1 p-3" data-autofill-row={row.field.id} data-overwrites={warn ? "" : undefined}>
      <Checkbox
        label={label ? flow.strings.mapRow(label, row.page) : flow.strings.mapRowNoLabel(row.page)}
        checked={on && !row.invalidDate}
        disabled={row.invalidDate}
        onChange={(next) => flow.setRowChecked(row, next)}
        id={`autofill-row-${row.field.id}`}
      />
      <div className="space-y-1 pl-[34px]" id={noteId}>
        <p className="text-subheadline font-medium text-foreground [overflow-wrap:anywhere]" data-autofill-row-value="">
          {row.proposal.value}
          {row.suggested ? <span className="ml-2 text-caption font-normal text-muted-foreground">({flow.strings.mapSuggested})</span> : null}
        </p>
        {row.invalidDate ? (
          <p className="flex items-start gap-2 text-footnote leading-relaxed text-destructive-text">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {flow.strings.notDate(name)}
          </p>
        ) : null}
        {warn ? (
          <p className="flex items-start gap-2 text-footnote leading-relaxed text-foreground" data-autofill-overwrite-warning="">
            <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-edit" />
            <span className="[overflow-wrap:anywhere]">{flow.strings.overwrites(row.current)}</span>
          </p>
        ) : null}
      </div>
    </li>
  );
}

export const ReviewStep = forwardRef<HTMLHeadingElement, { flow: AutofillFlow }>(function ReviewStep({ flow }, headingRef) {
  const { strings } = flow;
  const empty = flow.groups.length === 0;
  const keysLabel = flow.missingKeys.map((key) => dataKeyLabel(key, flow.locale)).join(", ");
  const saveNameId = useId();
  const canFill = flow.count > 0 || flow.canSaveOnly;
  return (
    <div className="space-y-4 pb-2" data-autofill-review="">
      <h3 ref={headingRef} tabIndex={-1} className="text-headline text-foreground outline-none">
        {strings.reviewTitle}
      </h3>

      {flow.warnings.length > 0 || flow.skippedPhotos > 0 ? (
        <ul className="space-y-1.5" data-autofill-warnings="">
          {flow.skippedPhotos > 0 ? (
            <li className="flex items-start gap-2 text-footnote leading-relaxed text-foreground" data-autofill-skipped-photos="">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-edit" />
              <span className="[overflow-wrap:anywhere]">{strings.skippedPhotos(flow.skippedPhotos)}</span>
            </li>
          ) : null}
          {flow.warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`} className="flex items-start gap-2 text-footnote leading-relaxed text-foreground" data-autofill-warning={warning.code}>
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-accent-edit" />
              <span className="[overflow-wrap:anywhere]">{strings.warning(warning.code, flow.warningNames[index] || null)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {flow.offerModel ? (
        <Button variant="secondary" size="md" fullWidth wrap onClick={() => void flow.downloadModel()} data-autofill-model-retry="">
          {strings.modelRetry}
        </Button>
      ) : null}

      {empty ? (
        <div className="space-y-3" data-autofill-empty="">
          <p className="text-subheadline text-foreground">{strings.nothingFound}</p>
          <p className="text-footnote leading-relaxed text-muted-foreground">{strings.nothingFoundHint}</p>
          <Button variant="secondary" size="md" fullWidth wrap onClick={flow.backToChoose}>
            {strings.back}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-footnote leading-relaxed text-muted-foreground">{strings.reviewIntro}</p>

          <div className="space-y-2">
            {flow.groups.map((group) => (group.multiple ? <ChoiceGroup key={group.key} group={group} flow={flow} /> : <SingleGroup key={group.key} group={group} flow={flow} />))}
          </div>

          <section className="space-y-2" aria-labelledby={`${saveNameId}-map`}>
            <h4 id={`${saveNameId}-map`} className="text-callout font-semibold text-foreground">
              {strings.mapTitle}
            </h4>
            <p className="text-footnote leading-relaxed text-muted-foreground">{strings.mapIntro}</p>
            {flow.planFailed || flow.engineFailed ? (
              <p className="text-footnote text-destructive-text">{strings.readFailed}</p>
            ) : flow.rows.length > 0 ? (
              <ul className="space-y-2">
                {flow.rows.map((row) => (
                  <MapRow key={row.field.id} row={row} flow={flow} />
                ))}
              </ul>
            ) : flow.accepted.length > 0 ? (
              <p className="text-footnote leading-relaxed text-muted-foreground" data-autofill-no-matches="">
                {strings.noMatches}
              </p>
            ) : (
              <p className="text-footnote leading-relaxed text-muted-foreground">{strings.fillNothing}</p>
            )}
            {flow.missingKeys.length > 0 && flow.rows.length > 0 ? (
              <p className="text-footnote leading-relaxed text-muted-foreground" data-autofill-unmatched="">
                {strings.noFieldFor(keysLabel)}
              </p>
            ) : null}
          </section>

          {!flow.fromProfile && flow.accepted.length > 0 ? (
            <section className="surface-card rounded-ios-sm space-y-2 p-3" data-autofill-save-profile="">
              <Checkbox label={strings.saveProfile} hint={strings.saveProfileHint} checked={flow.saveOn} onChange={flow.setSaveOn} />
              {flow.saveOn ? (
                <div className="space-y-1.5 pl-[34px]">
                  <label htmlFor={saveNameId} className="ui-label text-muted-foreground">
                    {strings.profileName}
                  </label>
                  <input
                    id={saveNameId}
                    type="text"
                    value={flow.profileName}
                    autoComplete="off"
                    maxLength={80}
                    aria-invalid={flow.profileError ? true : undefined}
                    aria-describedby={flow.profileError ? `${saveNameId}-err` : undefined}
                    onChange={(event) => flow.setProfileName(event.target.value)}
                    className={cn(AUTOFILL_INPUT_CLASS, flow.profileError && "border-destructive/60")}
                    data-autofill-profile-name=""
                  />
                </div>
              ) : null}
            </section>
          ) : null}

          {flow.profileError ? (
            <p id={`${saveNameId}-err`} role="alert" className="flex items-start gap-2 text-footnote leading-relaxed text-destructive-text" data-autofill-profile-error="">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              {flow.profileError}
            </p>
          ) : null}

          <div className="flex flex-col gap-2">
            <Button size="md" fullWidth wrap disabled={!canFill} onClick={flow.fill} data-autofill-fill="">
              {flow.count > 0 ? strings.fillButton(flow.count) : flow.canSaveOnly ? strings.saveProfile : strings.fillNothing}
            </Button>
            <Button variant="secondary" size="md" fullWidth wrap onClick={flow.fromProfile ? flow.showProfiles : flow.backToChoose}>
              {strings.back}
            </Button>
          </div>
        </>
      )}
    </div>
  );
});
