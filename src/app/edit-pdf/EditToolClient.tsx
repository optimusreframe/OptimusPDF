"use client";

import { useCallback, useState } from "react";
import { PenTool } from "lucide-react";
import { ToolShell, type ProcessResult } from "@/components/tool/ToolShell";
import { Slider } from "@/components/ui/Slider";
import {
  ChoiceGroup,
  ColorSwatches,
  OptionSection,
  ToggleRow,
} from "@/app/add-watermark/OptionControls";
import { EditCanvas } from "@/app/edit-pdf/EditCanvas";
import { EDIT_STRINGS } from "@/app/edit-pdf/strings";
import { useI18n } from "@/lib/i18n";
import {
  INK_COLORS,
  MAX_SAFE_FILE_SIZE,
  PdfError,
  withSuffix,
  type PdfFontFamily,
  type ProgressCallback,
} from "@/lib/pdf/core";
import {
  DEFAULT_EDIT_STYLE,
  FILL_OPACITIES,
  HIGHLIGHT_COLORS,
  MAX_FONT_SIZE,
  MAX_STROKE_WIDTH,
  MIN_FONT_SIZE,
  applyEdits,
  applyStyleToElement,
  groupElementsByPage,
  type CheckMark,
  type EditElement,
  type EditElementType,
  type EditStyle,
} from "@/lib/pdf/editPdf";
import { getTool } from "@/lib/tools-registry";

const TOOL = getTool("edit-pdf");

export type EditToolOptions = {
  elements: EditElement[];
  /** Pagina visible en el lienzo (indice 0). */
  pageIndex: number;
  /** Tipo que se creara con el proximo trazo. */
  activeType: EditElementType;
  style: EditStyle;
  selectedId: string | null;
};

const DEFAULT_OPTIONS: EditToolOptions = {
  elements: [],
  pageIndex: 0,
  activeType: "text",
  style: DEFAULT_EDIT_STYLE,
  selectedId: null,
};

export function EditToolClient() {
  const { language } = useI18n();
  const s = EDIT_STRINGS[language];
  const [missingElements, setMissingElements] = useState(false);

  const process = useCallback(
    async (
      files: File[],
      options: EditToolOptions,
      onProgress: ProgressCallback,
      signal: AbortSignal,
    ): Promise<ProcessResult> => {
      const grouped = groupElementsByPage(options.elements);
      if (grouped.size === 0) {
        setMissingElements(true);
        throw new PdfError("nothingSelected", "edit:noElements");
      }
      setMissingElements(false);

      const file = files[0];
      const blob = await applyEdits(file, grouped, onProgress, signal);
      return { blob, filename: withSuffix(file.name, s.filenameSuffix) };
    },
    [s.filenameSuffix],
  );

  return (
    <ToolShell<EditToolOptions>
      tool={TOOL}
      defaultOptions={DEFAULT_OPTIONS}
      process={process}
      progressMessage={s.progressMessage}
      canRun={(files, options) =>
        files.length > 0 && groupElementsByPage(options.elements).size > 0
      }
      renderMain={({ files, options, setOptions }) => (
        <div className="space-y-6">
          <EditCanvas
            file={files[0] ?? null}
            elements={options.elements}
            onElementsChange={(elements) => {
              if (elements.length > 0) setMissingElements(false);
              setOptions({ elements });
            }}
            pageIndex={options.pageIndex}
            onPageIndexChange={(pageIndex) => setOptions({ pageIndex })}
            activeType={options.activeType}
            onActiveTypeChange={(activeType) => setOptions({ activeType })}
            style={options.style}
            selectedId={options.selectedId}
            onSelectedIdChange={(selectedId) => setOptions({ selectedId })}
            strings={s}
          />

          {missingElements ? (
            <p role="alert" className="text-sm text-destructive">
              {s.noElements}
            </p>
          ) : null}

          <section className="glass rounded-ios p-5">
            <div className="flex items-start gap-3">
              <PenTool
                aria-hidden="true"
                className="mt-0.5 size-5 shrink-0 text-accent-edit"
              />
              <div className="min-w-0">
                <h3 className="text-headline text-foreground">
                  {s.howItWorksTitle}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {s.howItWorksBody}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {s.scopeWarning}
                </p>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                  {s.fontWarning}
                </p>
              </div>
            </div>
          </section>
        </div>
      )}
      renderOptions={({ files, options, setOptions }) => {
        /**
         * El estilo activo manda sobre lo proximo que se dibuje y, si
         * hay algo seleccionado, se le reaplica en el acto para que el
         * cambio se vea sin tener que rehacer el elemento.
         */
        const patchStyle = (patch: Partial<EditStyle>) => {
          const style = { ...options.style, ...patch };
          const elements = options.selectedId
            ? options.elements.map((element) =>
                element.id === options.selectedId
                  ? applyStyleToElement(element, style)
                  : element,
              )
            : options.elements;
          setOptions({ style, elements });
        };

        return (
          <>
            <OptionSection>
              <span className="ui-label block text-muted-foreground">
                {s.styleTitle}
              </span>
              <p className="text-sm text-foreground tabular-nums">
                {s.totalElements(options.elements.length)}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {s.styleAppliesTo}
              </p>
            </OptionSection>

            {options.activeType === "text" ? (
              <OptionSection>
                <ChoiceGroup<PdfFontFamily>
                  label={s.fontLabel}
                  value={options.style.fontFamily}
                  columns={3}
                  choices={[
                    { value: "helvetica", label: s.fontHelvetica },
                    { value: "times", label: s.fontTimes },
                    { value: "courier", label: s.fontCourier },
                  ]}
                  onChange={(fontFamily) => patchStyle({ fontFamily })}
                />
                <Slider
                  label={s.sizeLabel}
                  value={options.style.fontSize}
                  min={MIN_FONT_SIZE}
                  max={MAX_FONT_SIZE}
                  step={1}
                  suffix=" pt"
                  onChange={(fontSize) => patchStyle({ fontSize })}
                />
                <div className="grid grid-cols-2 gap-2">
                  <ToggleRow
                    label={s.bold}
                    checked={options.style.bold}
                    onChange={(bold) => patchStyle({ bold })}
                  />
                  <ToggleRow
                    label={s.italic}
                    checked={options.style.italic}
                    onChange={(italic) => patchStyle({ italic })}
                  />
                </div>
                <ColorSwatches
                  label={s.textColorLabel}
                  value={options.style.textColor}
                  colors={INK_COLORS}
                  onChange={(textColor) => patchStyle({ textColor })}
                />
              </OptionSection>
            ) : null}

            {options.activeType === "check" ? (
              <OptionSection>
                <ChoiceGroup<CheckMark>
                  label={s.checkMarkLabel}
                  value={options.style.checkMark}
                  columns={2}
                  choices={[
                    { value: "check", label: s.checkMarkCheck },
                    { value: "cross", label: s.checkMarkCross },
                  ]}
                  onChange={(checkMark) => patchStyle({ checkMark })}
                />
              </OptionSection>
            ) : null}

            {options.activeType === "rect" ||
            options.activeType === "ellipse" ||
            options.activeType === "line" ||
            options.activeType === "check" ? (
              <OptionSection>
                <ColorSwatches
                  label={s.strokeColorLabel}
                  value={options.style.strokeColor}
                  colors={INK_COLORS}
                  onChange={(strokeColor) => patchStyle({ strokeColor })}
                />
                <Slider
                  label={s.strokeWidthLabel}
                  value={options.style.strokeWidth}
                  min={0}
                  max={MAX_STROKE_WIDTH}
                  step={0.5}
                  suffix=" pt"
                  onChange={(strokeWidth) => patchStyle({ strokeWidth })}
                />
              </OptionSection>
            ) : null}

            {options.activeType === "rect" ||
            options.activeType === "ellipse" ? (
              <OptionSection>
                <ToggleRow
                  label={s.fillLabel}
                  checked={options.style.fill}
                  onChange={(fill) => patchStyle({ fill })}
                />
                {options.style.fill ? (
                  <>
                    <ColorSwatches
                      label={s.fillColorLabel}
                      value={options.style.fillColor}
                      colors={INK_COLORS}
                      onChange={(fillColor) => patchStyle({ fillColor })}
                    />
                    <ChoiceGroup<number>
                      label={s.fillOpacityLabel}
                      value={options.style.fillOpacity}
                      columns={3}
                      choices={FILL_OPACITIES.map((opacity) => ({
                        value: opacity,
                        label: `${Math.round(opacity * 100)} %`,
                      }))}
                      onChange={(fillOpacity) => patchStyle({ fillOpacity })}
                    />
                  </>
                ) : null}
              </OptionSection>
            ) : null}

            {options.activeType === "highlight" ? (
              <OptionSection>
                <ColorSwatches
                  label={s.highlightColorLabel}
                  value={options.style.highlightColor}
                  colors={HIGHLIGHT_COLORS}
                  onChange={(highlightColor) => patchStyle({ highlightColor })}
                />
                <ChoiceGroup<number>
                  label={s.highlightOpacityLabel}
                  value={options.style.highlightOpacity}
                  columns={3}
                  choices={FILL_OPACITIES.map((opacity) => ({
                    value: opacity,
                    label: `${Math.round(opacity * 100)} %`,
                  }))}
                  onChange={(highlightOpacity) =>
                    patchStyle({ highlightOpacity })
                  }
                />
              </OptionSection>
            ) : null}

            <OptionSection>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {s.typeHints[options.activeType]}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {s.scopeWarning}
              </p>
              {options.elements.length === 0 ? (
                <p className="text-xs leading-relaxed text-destructive">
                  {s.noElements}
                </p>
              ) : null}
              {files[0] && files[0].size > MAX_SAFE_FILE_SIZE ? (
                <p className="text-xs leading-relaxed text-destructive">
                  {s.largeFile}
                </p>
              ) : null}
            </OptionSection>
          </>
        );
      }}
    />
  );
}
