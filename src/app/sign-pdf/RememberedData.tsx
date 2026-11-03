"use client";

import { useId, useState } from "react";
import { ChevronDown, ChevronRight, Database, Pencil, Pin, PinOff, Search, Tag, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmSheet } from "@/components/ui/ConfirmSheet";
import { GlassCard } from "@/components/ui/GlassCard";
import { Sheet } from "@/components/ui/Sheet";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { foldText, isCustomTag, isTagKey, tagLabel } from "@/lib/fieldTags";
import {
  MAX_PINNED_PER_KEY,
  MAX_VALUE_LENGTH,
  clearValueHistory,
  customTagNames,
  editValue,
  forgetKey,
  forgetValue,
  listRemembered,
  renameCustomTag,
  setPinned,
  useValueHistoryVersion,
  type RememberedGroup,
  type ValueHistoryEntry,
} from "@/lib/valueHistory";
import { useTagStrings } from "@/app/sign-pdf/tagStrings";

/**
 * «Datos recordados»: la hoja donde la persona ve, corrige y borra lo que la memoria de valores guarda (`lib/valueHistory.ts`),
 * agrupado por ETIQUETA. Por cada valor: fijar arriba, editar el texto y borrarlo; por etiqueta: borrarla entera (y, si es
 * propia, cambiarle el nombre); y «Borrar todo». Con buscador. Todo es local: nada de esto sale del dispositivo.
 *
 * Tiene tres puntos de entrada (`RememberedDataButton`): la fila de privacidad de Firmar, el panel de «Solo yo» y Ajustes.
 */

const ICON_BUTTON =
  "inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground pointer-coarse:size-11 " +
  "transition-[background-color,color,scale] duration-[var(--duration-fast)] active:scale-[0.94] motion-reduce:active:scale-100 hover:bg-white/10 hover:text-foreground " +
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal disabled:opacity-40 forced-colors:border forced-colors:border-[ButtonText]";

type Confirm = { kind: "tag"; key: string; count: number } | { kind: "all" } | null;

export function RememberedDataSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, language } = useI18n();
  const strings = useTagStrings();
  useValueHistoryVersion();
  const custom = customTagNames();
  const groups = listRemembered();
  const [query, setQuery] = useState("");
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [status, setStatus] = useState("");
  const searchId = useId();

  const needle = foldText(query.trim());
  const nameOf = (group: RememberedGroup): string => (isTagKey(group.key) ? tagLabel(group.key, language, custom) : group.key);
  const visible = groups
    .map((group) => {
      if (needle === "") return { group, entries: group.entries };
      const nameMatches = foldText(nameOf(group)).includes(needle);
      const entries = nameMatches ? group.entries : group.entries.filter((entry) => foldText(entry.value).includes(needle));
      return { group, entries, hidden: !nameMatches && entries.length === 0 };
    })
    .filter((item) => !("hidden" in item && item.hidden));
  const expandedByDefault = groups.length <= 4 || needle !== "";

  const confirmTitle = confirm?.kind === "all" ? strings.rememberedClearTitle : confirm?.kind === "tag" ? strings.rememberedDeleteTag(tagLabel(confirm.key, language, custom)) : "";
  const confirmBody =
    confirm?.kind === "all"
      ? strings.rememberedClearBody
      : confirm?.kind === "tag"
        ? strings.rememberedDeleteTagConfirm(tagLabel(confirm.key, language, custom), confirm.count)
        : "";

  return (
    <>
      <Sheet open={open} onClose={onClose} title={strings.rememberedTitle} closeLabel={t.common.close}>
        <div className="space-y-4 pb-2" data-remembered-data="">
          <p className="text-sm leading-relaxed text-muted-foreground">{strings.rememberedIntro}</p>
          <p className="text-footnote text-muted-foreground">{strings.rememberedPrivacy}</p>

          {groups.length > 0 ? (
            <div>
              <label htmlFor={searchId} className="sr-only">
                {strings.rememberedSearchLabel}
              </label>
              <div className="relative">
                <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  id={searchId}
                  type="search"
                  value={query}
                  autoComplete="off"
                  placeholder={strings.rememberedSearch}
                  onChange={(event) => setQuery(event.target.value)}
                  className="rounded-ios-sm min-h-11 w-full border border-white/14 bg-white/6 pr-3 pl-9 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                />
              </div>
            </div>
          ) : null}

          {/* Region de estado siempre montada: solo cambia su contenido. */}
          <p role="status" aria-live="polite" className="min-h-5 text-footnote text-success-text">
            {status}
          </p>

          {groups.length === 0 ? (
            <p className="rounded-ios-sm border border-dashed border-white/16 p-4 text-sm leading-relaxed text-muted-foreground">{strings.rememberedEmpty}</p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">{strings.rememberedNoMatch}</p>
          ) : (
            <ul className="space-y-3">
              {visible.map(({ group, entries }) => {
                const name = nameOf(group);
                const isOpen = openGroups[group.key] ?? expandedByDefault;
                const listId = `remembered-${group.key.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
                const customTag = isCustomTag(group.key);
                return (
                  <li key={group.key} className="surface-card rounded-ios overflow-hidden" data-remembered-group={group.key}>
                    <div className="flex items-center gap-1 pr-1">
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        aria-controls={listId}
                        onClick={() => setOpenGroups((current) => ({ ...current, [group.key]: !isOpen }))}
                        className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-3 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal"
                      >
                        {isOpen ? <ChevronDown aria-hidden="true" className="size-4 shrink-0" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0" />}
                        <Tag aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate text-callout font-semibold text-foreground">{name}</span>
                        <span className="shrink-0 text-footnote text-muted-foreground tabular-nums">{strings.rememberedCount(group.entries.length)}</span>
                        {!isTagKey(group.key) ? <span className="shrink-0 rounded-full bg-white/8 px-2 py-0.5 text-caption-2 text-muted-foreground">{strings.rememberedLegacy}</span> : null}
                      </button>
                      {customTag && Object.prototype.hasOwnProperty.call(custom, group.key) ? (
                        <GroupRename tag={group.key} name={name} onDone={setStatus} />
                      ) : null}
                      <button
                        type="button"
                        aria-label={strings.rememberedDeleteTag(name)}
                        title={strings.rememberedDeleteTag(name)}
                        onClick={() => setConfirm({ kind: "tag", key: group.key, count: group.entries.length })}
                        className={cn(ICON_BUTTON, "hover:text-destructive-text")}
                      >
                        <Trash2 aria-hidden="true" className="size-4" />
                      </button>
                    </div>
                    {isOpen ? (
                      <ul id={listId} className="divide-y divide-white/8 border-t border-white/10">
                        {entries.map((entry) => (
                          <EntryRow key={entry.value} groupKey={group.key} entry={entry} onStatus={setStatus} />
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {groups.length > 0 ? (
            <Button variant="destructive" size="md" fullWidth onClick={() => setConfirm({ kind: "all" })}>
              <Trash2 aria-hidden="true" className="size-4" />
              {strings.rememberedClearAll}
            </Button>
          ) : null}
        </div>
      </Sheet>

      <ConfirmSheet
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (confirm?.kind === "all") {
            clearValueHistory();
            setStatus(strings.rememberedStatusCleared);
          } else if (confirm?.kind === "tag") {
            forgetKey(confirm.key);
            setStatus(strings.rememberedStatusDeleted);
          }
        }}
        title={confirmTitle}
        body={confirmBody}
        confirmLabel={confirm?.kind === "all" ? strings.rememberedClearConfirm : strings.rememberedDeleteAction}
        cancelLabel={strings.rememberedCancel}
        closeLabel={t.common.close}
      />
    </>
  );
}

/** Un valor guardado con sus tres acciones: fijar, editar y borrar. */
function EntryRow({ groupKey, entry, onStatus }: { groupKey: string; entry: ValueHistoryEntry; onStatus: (text: string) => void }) {
  const strings = useTagStrings();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.value);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();

  if (editing) {
    const save = () => {
      if (draft.trim() === entry.value) {
        setEditing(false);
        return;
      }
      if (editValue(groupKey, entry.value, draft)) {
        onStatus(strings.rememberedSaved);
        setEditing(false);
      } else {
        setError(strings.rememberedInvalidValue);
      }
    };
    return (
      <li className="space-y-2 p-3">
        <label htmlFor={inputId} className="block text-footnote font-medium text-foreground">
          {strings.rememberedEditLabel}
        </label>
        <input
          id={inputId}
          type="text"
          value={draft}
          maxLength={MAX_VALUE_LENGTH}
          autoFocus
          aria-invalid={error ? true : undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              save();
            } else if (event.key === "Escape") {
              event.stopPropagation();
              setEditing(false);
            }
          }}
          className="rounded-ios-sm min-h-11 w-full border border-white/14 bg-white/6 px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
        />
        {error ? (
          <p role="alert" className="text-xs text-destructive-text">
            {error}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button size="sm" onClick={save}>
            {strings.rememberedSave}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {strings.rememberedCancel}
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-1 py-1 pr-1 pl-3">
      <span className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-callout text-foreground">
        {entry.pinned ? (
          <>
            <Pin aria-hidden="true" className="size-3.5 shrink-0 text-signal-text" />
            <span className="sr-only">{strings.suggestionPinned}</span>
          </>
        ) : null}
        <span className="min-w-0 break-words">{entry.value}</span>
      </span>
      <button
        type="button"
        aria-label={entry.pinned ? strings.unpinNamed(entry.value) : strings.pinNamed(entry.value)}
        title={entry.pinned ? strings.unpin : strings.pin}
        aria-pressed={entry.pinned === true}
        onClick={() => {
          if (setPinned(groupKey, entry.value, !entry.pinned)) {
            onStatus(entry.pinned ? strings.unpinnedNotice(entry.value) : strings.pinnedNotice(entry.value));
          } else if (!entry.pinned) {
            onStatus(strings.pinFull(MAX_PINNED_PER_KEY));
          }
        }}
        className={ICON_BUTTON}
      >
        {entry.pinned ? <PinOff aria-hidden="true" className="size-4" /> : <Pin aria-hidden="true" className="size-4" />}
      </button>
      <button
        type="button"
        aria-label={strings.rememberedEdit(entry.value)}
        title={strings.rememberedEditLabel}
        onClick={() => {
          setDraft(entry.value);
          setError(null);
          setEditing(true);
        }}
        className={ICON_BUTTON}
      >
        <Pencil aria-hidden="true" className="size-4" />
      </button>
      <button
        type="button"
        aria-label={strings.rememberedDelete(entry.value)}
        title={strings.forget}
        onClick={() => {
          forgetValue(groupKey, entry.value);
          onStatus(strings.forgotten(entry.value));
        }}
        className={cn(ICON_BUTTON, "hover:text-destructive-text")}
      >
        <Trash2 aria-hidden="true" className="size-4" />
      </button>
    </li>
  );
}

/** Cambiar el nombre de una etiqueta propia (la clave no cambia: los campos que ya la llevan siguen igual). */
function GroupRename({ tag, name, onDone }: { tag: string; name: string; onDone: (text: string) => void }) {
  const strings = useTagStrings();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();
  const inputId = useId();
  return (
    <>
      <button
        type="button"
        aria-label={strings.rememberedRenameTag(name)}
        title={strings.rememberedRenameTag(name)}
        onClick={() => {
          setDraft(name);
          setError(null);
          setOpen(true);
        }}
        className={ICON_BUTTON}
      >
        <Pencil aria-hidden="true" className="size-4" />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title={strings.rememberedRenameTag(name)} closeLabel={t.common.close} initialFocus={`#${CSS.escape(inputId)}`}>
        <form
          noValidate
          className="space-y-3 pb-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (renameCustomTag(tag, draft)) {
              onDone(strings.rememberedSaved);
              setOpen(false);
            } else {
              setError(strings.customEmpty);
            }
          }}
        >
          <label htmlFor={inputId} className="block text-xs font-medium text-foreground">
            {strings.rememberedRenameLabel}
          </label>
          <input
            id={inputId}
            type="text"
            value={draft}
            maxLength={40}
            onChange={(event) => {
              setDraft(event.target.value);
              if (error) setError(null);
            }}
            className="rounded-ios-sm min-h-11 w-full border border-white/14 bg-white/6 px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive-text">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Button type="submit" size="md" fullWidth>
              {strings.rememberedSave}
            </Button>
            <Button type="button" variant="ghost" size="md" fullWidth onClick={() => setOpen(false)}>
              {strings.rememberedCancel}
            </Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}

/** Boton que abre la hoja «Datos recordados» (y la lleva consigo). */
export function RememberedDataButton({
  variant = "ghost",
  size = "sm",
  fullWidth = false,
  className,
}: {
  variant?: "ghost" | "secondary";
  size?: "sm" | "md";
  fullWidth?: boolean;
  className?: string;
}) {
  const strings = useTagStrings();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} fullWidth={fullWidth} className={className} onClick={() => setOpen(true)} data-remembered-open="">
        <Database aria-hidden="true" className="size-4" />
        {strings.rememberedButton}
      </Button>
      <RememberedDataSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** Tarjeta de Ajustes: explica que se recuerda y abre la hoja «Datos recordados». */
export function RememberedDataSettingsCard() {
  const strings = useTagStrings();
  return (
    <GlassCard className="p-6">
      <h2 className="text-headline text-foreground">{strings.settingsTitle}</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{strings.settingsBody}</p>
      <div className="mt-5">
        <RememberedDataButton variant="secondary" size="md" className="h-auto min-h-11 max-w-full py-2 text-center whitespace-normal" />
      </div>
    </GlassCard>
  );
}
