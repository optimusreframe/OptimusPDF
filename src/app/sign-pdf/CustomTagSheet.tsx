"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { MAX_CUSTOM_TAGS, MAX_CUSTOM_TAG_NAME } from "@/lib/fieldTags";
import { addCustomTag, customTagRoom } from "@/lib/valueHistory";
import { useTagStrings } from "@/app/sign-pdf/tagStrings";

export type CustomTagSheetProps = {
  open: boolean;
  onClose: () => void;
  /** Se creo (o ya existia) la etiqueta propia con esta clave. */
  onCreated: (tag: string) => void;
  closeLabel: string;
};

/**
 * «Otra…»: crea una etiqueta propia con el nombre que la persona escriba («Código de zona»). Es una hoja y no un campo dentro
 * de la barra de sugerencias porque escribir en otro input le quitaria el foco al campo del documento y cerraria su edicion.
 * El nombre se guarda aparte de la clave (`custom.codigo_de_zona`), que no admite espacios ni tildes.
 */
export function CustomTagSheet({ open, onClose, onCreated, closeLabel }: CustomTagSheetProps) {
  const strings = useTagStrings();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setName("");
    setError(null);
    onClose();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") {
      setError(strings.customEmpty);
      return;
    }
    const tag = addCustomTag(name);
    if (!tag) {
      setError(customTagRoom() === 0 ? strings.customFull(MAX_CUSTOM_TAGS) : strings.customEmpty);
      return;
    }
    setName("");
    setError(null);
    onCreated(tag);
    onClose();
  };

  return (
    <Sheet open={open} onClose={close} title={strings.customTitle} closeLabel={closeLabel} initialFocus="[data-custom-tag-input]">
      <form onSubmit={submit} className="space-y-3 pb-2" noValidate>
        <p className="text-sm leading-relaxed text-muted-foreground">{strings.customBody}</p>
        <div>
          <label htmlFor="custom-tag-name" className="block pb-1 text-xs font-medium text-foreground">
            {strings.customNameLabel}
          </label>
          <input
            id="custom-tag-name"
            data-custom-tag-input=""
            type="text"
            value={name}
            maxLength={MAX_CUSTOM_TAG_NAME}
            autoComplete="off"
            autoCapitalize="sentences"
            placeholder={strings.customNamePlaceholder}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "custom-tag-error" : undefined}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError(null);
            }}
            className="rounded-ios-sm min-h-11 w-full border border-white/14 bg-white/6 px-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          />
          <p id="custom-tag-error" role="alert" className="min-h-5 pt-1 text-xs text-destructive-text">
            {error}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Button type="submit" size="md" fullWidth>
            {strings.customCreate}
          </Button>
          <Button type="button" variant="ghost" size="md" fullWidth onClick={close}>
            {strings.customCancel}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
