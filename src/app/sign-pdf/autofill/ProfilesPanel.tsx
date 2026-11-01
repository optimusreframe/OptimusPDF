"use client";

import { forwardRef, useId, useRef, useState } from "react";
import { Lock, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { HIT_44 } from "@/components/ui/touchTarget";
import { cn } from "@/lib/cn";
import type { ClientProfile } from "@/lib/autofill/types";
import {
  clientProfilesAvailable,
  deleteClientProfile,
  removeClientProfileValue,
  renameClientProfile,
  setClientProfileValue,
  useClientProfiles,
} from "@/lib/clientProfile/store";
import { dataKeyLabel } from "@/app/sign-pdf/autofill/model";
import type { AutofillStrings } from "@/app/sign-pdf/autofill/strings";
import { AUTOFILL_INPUT_CLASS } from "@/app/sign-pdf/autofill/ui";

/**
 * Perfiles guardados: usar (salta la lectura y va directo a revisar), editar (renombrar, corregir o quitar un valor) y borrar.
 * Las acciones se aplican al instante en el almacen del dispositivo (`@/lib/clientProfile/store`); la lista es la del almacen
 * en vivo, asi que otra pestana, importar un respaldo o «Borrar datos» tambien la cambian.
 */

type Props = {
  strings: AutofillStrings;
  locale: "es" | "en";
  onUse: (profile: ClientProfile) => void;
  onBack: () => void;
  onAnnounce: (text: string) => void;
};

function ValueEditor({ profile, valueKey, strings, locale, onAnnounce, onRemoved }: { profile: ClientProfile; valueKey: string; strings: AutofillStrings; locale: "es" | "en"; onAnnounce: (text: string) => void; onRemoved: () => void }) {
  const stored = profile.values[valueKey].value;
  const [draft, setDraft] = useState(stored);
  const [error, setError] = useState(false);
  const id = useId();
  const label = dataKeyLabel(valueKey, locale);
  const changed = draft.trim() !== stored;
  return (
    <li className="space-y-1.5" data-autofill-profile-value={valueKey}>
      <label htmlFor={id} className="ui-label text-muted-foreground">
        {label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={id}
          type="text"
          value={draft}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(false);
          }}
          className={cn(AUTOFILL_INPUT_CLASS, "min-w-0 flex-1 basis-40", error && "border-destructive/60")}
        />
        {/* `aria-disabled` (no `disabled`): tras guardar el boton se apaga y el foco no puede irse a la nada. */}
        <Button
          variant="secondary"
          size="sm"
          aria-disabled={!changed}
          aria-label={strings.profileValueSave(label)}
          className={!changed ? "opacity-60" : undefined}
          onClick={() => {
            if (!changed) return;
            const result = setClientProfileValue(profile.id, valueKey, draft);
            if (result.ok) {
              setError(false);
              onAnnounce(strings.profileValueSaved);
            } else setError(true);
          }}
        >
          {strings.profileSaveShort}
        </Button>
        <button
          type="button"
          aria-label={strings.profileValueRemove(label)}
          onClick={() => {
            removeClientProfileValue(profile.id, valueKey);
            onAnnounce(strings.profileValueRemoved);
            onRemoved();
          }}
          className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal pointer-coarse:size-11", HIT_44)}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-footnote text-destructive-text">
          {strings.profileInvalid}
        </p>
      ) : null}
    </li>
  );
}

function ProfileEditor({ profile, strings, locale, onAnnounce, onClose }: { profile: ClientProfile; strings: AutofillStrings; locale: "es" | "en"; onAnnounce: (text: string) => void; onClose: () => void }) {
  const [name, setName] = useState(profile.name);
  const [nameError, setNameError] = useState(false);
  const nameId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const keys = Object.keys(profile.values);
  return (
    <div className="space-y-3 border-t border-white/10 pt-3" data-autofill-profile-editor="">
      <div className="space-y-1.5">
        <label htmlFor={nameId} className="ui-label text-muted-foreground">
          {strings.profileRenameLabel}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input
            id={nameId}
            ref={nameRef}
            type="text"
            value={name}
            maxLength={80}
            autoComplete="off"
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(false);
            }}
            className={cn(AUTOFILL_INPUT_CLASS, "min-w-0 flex-1 basis-40", nameError && "border-destructive/60")}
          />
          <Button
            variant="secondary"
            size="sm"
            aria-disabled={name.trim() === profile.name}
            className={name.trim() === profile.name ? "opacity-60" : undefined}
            onClick={() => {
              if (name.trim() === profile.name) return;
              const result = renameClientProfile(profile.id, name);
              if (result.ok) onAnnounce(strings.profileRenamed);
              else setNameError(true);
            }}
          >
            {strings.profileRename}
          </Button>
        </div>
        {nameError ? (
          <p role="alert" className="text-footnote text-destructive-text">
            {strings.profileNameRequired}
          </p>
        ) : null}
      </div>
      <ul className="space-y-3">
        {keys.map((key) => (
          <ValueEditor key={key} profile={profile} valueKey={key} strings={strings} locale={locale} onAnnounce={onAnnounce} onRemoved={() => nameRef.current?.focus({ preventScroll: true })} />
        ))}
      </ul>
      <Button variant="ghost" size="sm" onClick={onClose}>
        {strings.profileDone}
      </Button>
    </div>
  );
}

export const ProfilesPanel = forwardRef<HTMLHeadingElement, Props>(function ProfilesPanel({ strings, locale, onUse, onBack, onAnnounce }, forwardedRef) {
  const profiles = useClientProfiles();
  const headingEl = useRef<HTMLHeadingElement | null>(null);
  const headingRef = (element: HTMLHeadingElement | null) => {
    headingEl.current = element;
    if (typeof forwardedRef === "function") forwardedRef(element);
    else if (forwardedRef) forwardedRef.current = element;
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ClientProfile | null>(null);
  const available = clientProfilesAvailable();
  return (
    <div className="space-y-4 pb-2" data-autofill-profiles="">
      <h3 ref={headingRef} tabIndex={-1} className="text-headline text-foreground outline-none">
        {strings.profilesTitle}
      </h3>
      <p className="flex items-start gap-2 text-footnote leading-relaxed text-muted-foreground">
        <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {strings.profilesPrivacy}
      </p>
      {!available ? (
        <p className="text-footnote text-destructive-text">{strings.profileUnavailable}</p>
      ) : profiles.length === 0 ? (
        <p className="text-subheadline text-muted-foreground" data-autofill-profiles-empty="">
          {strings.profilesEmpty}
        </p>
      ) : (
        <ul className="space-y-2">
          {profiles.map((profile) => {
            const editing = editingId === profile.id;
            return (
              <li key={profile.id} className="surface-card rounded-ios-sm min-w-0 space-y-2 p-3" data-autofill-profile={profile.id}>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="text-callout font-semibold text-foreground [overflow-wrap:anywhere]">{profile.name}</p>
                    <p className="text-caption text-muted-foreground">{strings.profileValues(Object.keys(profile.values).length)}</p>
                  </div>
                  <Button size="sm" aria-label={strings.profileUse(profile.name)} onClick={() => onUse(profile)} data-autofill-profile-use="">
                    {strings.profileUseShort}
                  </Button>
                  <button
                    type="button"
                    aria-label={strings.profileEdit(profile.name)}
                    aria-expanded={editing}
                    onClick={() => setEditingId(editing ? null : profile.id)}
                    className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal pointer-coarse:size-11", HIT_44)}
                  >
                    <Pencil aria-hidden="true" className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={strings.profileDelete(profile.name)}
                    onClick={() => setDeleting(profile)}
                    className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-destructive-text focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal pointer-coarse:size-11", HIT_44)}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </button>
                </div>
                {editing ? <ProfileEditor profile={profile} strings={strings} locale={locale} onAnnounce={onAnnounce} onClose={() => setEditingId(null)} /> : null}
              </li>
            );
          })}
        </ul>
      )}
      <Button variant="secondary" size="md" fullWidth wrap onClick={onBack}>
        {strings.back}
      </Button>
      <ConfirmSheet
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) {
            deleteClientProfile(deleting.id);
            onAnnounce(strings.profileDeleted(deleting.name));
            if (editingId === deleting.id) setEditingId(null);
            // El boton que tenia el foco desaparece: el foco pasa al titulo de la lista.
            queueMicrotask(() => headingEl.current?.focus({ preventScroll: true }));
          }
        }}
        restoreFocusOnClose={() => false}
        title={strings.profileDeleteTitle}
        body={deleting ? strings.profileDeleteBody(deleting.name) : ""}
        confirmLabel={strings.profileDeleteConfirm}
        cancelLabel={strings.cancel}
        closeLabel={strings.close}
      />
    </div>
  );
});
