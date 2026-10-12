"use client";

import { Slider } from "@/components/ui/Slider";
import {
  ChoiceGroup,
  ColorSwatches,
  NumberField,
  OptionSection,
  TextField,
  ToggleRow,
} from "@/components/tool/OptionControls";
import { useI18n } from "@/lib/i18n";
import {
  MAX_BATES_DIGITS,
  documentBaseName,
  expandHeaderFooterTokens,
  formatBatesLabel,
  type HeaderFooterOptions,
  type HeaderFooterSlots,
} from "@/lib/pdf/headerFooter";
import type { PageNumberMargin } from "@/lib/pdf/pageNumbers";
import { INK_COLORS, type PdfFontFamily } from "@/lib/pdf/watermark";
import { PAGE_NUMBERS_STRINGS } from "@/app/add-page-numbers/strings";
import type { DocPanelProps } from "@/app/pdf-pro/tabs/docToolTypes";
import { getProStrings } from "@/app/pdf-pro/proStrings";

const SLOT_KEYS = ["left", "center", "right"] as const;

/** Lo que se leeria en la primera pagina (una linea por zona con texto). */
export function previewHeaderFooterLines(options: HeaderFooterOptions, pageCount: number, locale: string): string[] {
  const start = Math.max(0, Math.floor(options.firstNumber));
  const from = Math.min(Math.max(1, Math.floor(options.fromPage) || 1), Math.max(1, pageCount));
  const rawTo = Math.floor(options.toPage) || pageCount;
  const to = Math.min(Math.max(from, rawTo), Math.max(1, pageCount));
  const total = start + (to - from + 1) - 1;
  const lines: string[] = [];
  const ctx = {
    current: start,
    total,
    name: documentBaseName(options.documentName),
    dateLabel: new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" }).format(options.date ?? new Date()),
    bates: options.bates ? formatBatesLabel(options.bates, options.bates.start) : "",
  };
  for (const group of [options.header, options.footer]) {
    const text = SLOT_KEYS.map((key) => expandHeaderFooterTokens(group[key], ctx).trim())
      .filter((part) => part.length > 0)
      .join("  ·  ");
    if (text) lines.push(text);
  }
  return lines;
}

function SlotFields({
  title,
  slots,
  labels,
  onChange,
}: {
  title: string;
  slots: HeaderFooterSlots;
  labels: Record<(typeof SLOT_KEYS)[number], string>;
  onChange: (slots: HeaderFooterSlots) => void;
}) {
  return (
    <OptionSection title={title}>
      {SLOT_KEYS.map((key) => (
        <TextField
          key={key}
          label={`${title} · ${labels[key]}`}
          value={slots[key]}
          onChange={(value) => onChange({ ...slots, [key]: value })}
        />
      ))}
    </OptionSection>
  );
}

/** Panel de «Encabezado, pie y Bates»: tres textos por zona con marcadores, numeracion Bates, rango y tinta. */
export function HeaderFooterPanel({ options, setOptions, ctx }: DocPanelProps<HeaderFooterOptions>) {
  const { language } = useI18n();
  const s = getProStrings(language).docTools.headerFooter;
  const n = PAGE_NUMBERS_STRINGS[language];
  const bates = options.bates ?? null;
  const labels = { left: s.left, center: s.center, right: s.right };
  const lines = previewHeaderFooterLines(options, ctx.pageCount, language === "es" ? "es-ES" : "en-US");

  return (
    <>
      <SlotFields title={s.headerTitle} slots={options.header} labels={labels} onChange={(header) => setOptions({ header })} />
      <SlotFields title={s.footerTitle} slots={options.footer} labels={labels} onChange={(footer) => setOptions({ footer })} />
      <p className="text-xs leading-relaxed text-muted-foreground">{s.tokensHint}</p>

      {lines.length > 0 ? (
        <div className="rounded-ios-sm border border-white/10 bg-white/5 px-3 py-2.5" data-header-footer-preview="">
          <span className="block text-caption text-muted-foreground">{s.previewLabel}</span>
          {lines.map((line, index) => (
            <span key={index} className="mt-1 block truncate text-sm text-foreground tabular-nums">
              {line}
            </span>
          ))}
        </div>
      ) : null}

      <OptionSection title={s.batesTitle}>
        <ToggleRow
          label={s.batesToggle}
          hint={s.batesHint}
          checked={bates !== null}
          onChange={(on) => setOptions({ bates: on ? { prefix: "", start: 1, digits: 6 } : null })}
        />
        {bates ? (
          <>
            <TextField
              label={s.batesPrefix}
              value={bates.prefix}
              maxLength={30}
              onChange={(prefix) => setOptions({ bates: { ...bates, prefix } })}
            />
            <div className="flex items-end gap-2">
              <NumberField label={s.batesStart} value={bates.start} min={0} onChange={(start) => setOptions({ bates: { ...bates, start } })} />
              <NumberField
                label={s.batesDigits}
                value={bates.digits}
                min={1}
                max={MAX_BATES_DIGITS}
                onChange={(digits) => setOptions({ bates: { ...bates, digits } })}
              />
            </div>
          </>
        ) : null}
      </OptionSection>

      <OptionSection>
        <div className="flex items-end gap-2">
          <NumberField label={s.firstNumber} value={options.firstNumber} min={0} onChange={(firstNumber) => setOptions({ firstNumber })} />
        </div>
        <span className="ui-label block text-muted-foreground">{n.pagesLabel}</span>
        <div className="flex items-end gap-2">
          <NumberField label={n.pagesFrom} value={options.fromPage} min={1} onChange={(fromPage) => setOptions({ fromPage })} />
          <NumberField label={n.pagesTo} value={options.toPage} min={0} onChange={(toPage) => setOptions({ toPage })} />
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{n.pagesHint}</p>
        <ChoiceGroup<PageNumberMargin>
          label={n.marginLabel}
          value={options.margin}
          columns={3}
          choices={[
            { value: "small", label: n.marginSmall },
            { value: "recommended", label: n.marginRecommended },
            { value: "large", label: n.marginLarge },
          ]}
          onChange={(margin) => setOptions({ margin })}
        />
      </OptionSection>

      <OptionSection>
        <ChoiceGroup<PdfFontFamily>
          label={n.fontLabel}
          value={options.fontFamily}
          columns={3}
          choices={[
            { value: "helvetica", label: n.fontHelvetica },
            { value: "times", label: n.fontTimes },
            { value: "courier", label: n.fontCourier },
          ]}
          onChange={(fontFamily) => setOptions({ fontFamily })}
        />
        <Slider label={n.sizeLabel} value={options.fontSize} min={6} max={48} step={1} suffix=" pt" onChange={(fontSize) => setOptions({ fontSize })} />
        <ColorSwatches label={n.colorLabel} value={options.color} colors={INK_COLORS} onChange={(color) => setOptions({ color })} />
      </OptionSection>
    </>
  );
}
