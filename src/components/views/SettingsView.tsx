"use client";

import { useState } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Checkbox } from "@/components/ui/Checkbox";
import { useI18n, type Language } from "@/lib/i18n";
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { clearRecentEntries } from "@/lib/recent";
import { clearValueHistory } from "@/lib/valueHistory";
import {
  clearLocalSignData,
  type ClearFailure,
} from "@/app/sign-pdf/clearLocalSignData";
import { clearAllTemplates } from "@/app/sign-pdf/signTemplates";
import { SIGN_STRINGS } from "@/app/sign-pdf/strings";
import { clearAllEditDrafts } from "@/app/edit-pdf/editDrafts";
import { clearLocalProData } from "@/app/pdf-pro/proDrafts";
import { clearHandoff } from "@/app/pdf-pro/proHandoff";
import {
  PRO_FEATURE_FLAGS,
  setProFeatureFlag,
  useProFeatureFlags,
} from "@/app/pdf-pro/proFeatureFlags";
import {
  EDIT_PDF_FEATURE_FLAGS,
  setEditPdfFeatureFlag,
  useEditPdfFeatureFlags,
} from "@/app/edit-pdf/editFeatureFlags";
import {
  SIGN_PDF_FEATURE_FLAGS,
  setSignPdfFeatureFlag,
  useSignPdfFeatureFlags,
} from "@/app/sign-pdf/signFeatureFlags";

export function SettingsView() {
  const { t, language, setLanguage } = useI18n();
  const { theme, setTheme } = useTheme();
  const [cleared, setCleared] = useState(false);
  /** Almacenes que no se pudieron vaciar en el ultimo intento (vacio = bien). */
  const [failed, setFailed] = useState<(ClearFailure | "editDrafts" | "proDrafts")[]>([]);
  const signPdfFlags = useSignPdfFeatureFlags();
  const editPdfFlags = useEditPdfFeatureFlags();
  const proFlags = useProFeatureFlags();

  return (
    <div className="mx-auto max-w-[800px] px-4 pt-10 pb-16 md:px-6 md:pt-16">
      <h1 className="text-title-1 text-foreground">
        {t.settings.title}
      </h1>

      <div className="mt-8 space-y-4">
        <GlassCard className="p-6">
          <h2 className="text-headline text-foreground">
            {t.settings.themeTitle}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.settings.themeBody}
          </p>
          <SegmentedControl<ThemeChoice>
            className="mt-5"
            value={theme}
            onChange={setTheme}
            options={[
              { value: "light", label: t.common.light },
              { value: "dark", label: t.common.dark },
              { value: "system", label: t.common.system },
            ]}
          />
        </GlassCard>

        <GlassCard className="p-6">
          <h2 className="text-headline text-foreground">
            {t.settings.languageTitle}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.settings.languageBody}
          </p>
          <SegmentedControl<Language>
            className="mt-5"
            value={language}
            onChange={setLanguage}
            options={[
              { value: "es", label: t.common.spanish },
              { value: "en", label: t.common.english },
            ]}
          />
        </GlassCard>

        <GlassCard className="p-6">
          <h2 className="text-headline text-foreground">
            {t.settings.signPdfFeaturesTitle}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.settings.signPdfFeaturesBody}
          </p>
          <div className="mt-5 space-y-4">
            {SIGN_PDF_FEATURE_FLAGS.map((flag) => (
              <Checkbox
                key={flag}
                label={t.settings.signPdfFeatures[flag].label}
                hint={t.settings.signPdfFeatures[flag].hint}
                checked={signPdfFlags[flag]}
                onChange={(enabled) => setSignPdfFeatureFlag(flag, enabled)}
              />
            ))}
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <h2 className="text-headline text-foreground">
            {t.settings.editPdfFeaturesTitle}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.settings.editPdfFeaturesBody}
          </p>
          <div className="mt-5 space-y-4">
            {EDIT_PDF_FEATURE_FLAGS.map((flag) => (
              <Checkbox
                key={flag}
                label={t.settings.editPdfFeatures[flag].label}
                hint={t.settings.editPdfFeatures[flag].hint}
                checked={editPdfFlags[flag]}
                onChange={(enabled) => setEditPdfFeatureFlag(flag, enabled)}
              />
            ))}
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <h2 className="text-headline text-foreground">
            {t.settings.proFeaturesTitle}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {t.settings.proFeaturesBody}
          </p>
          <div className="mt-5 space-y-4">
            {PRO_FEATURE_FLAGS.map((flag) => (
              <Checkbox
                key={flag}
                label={t.settings.proFeatures[flag].label}
                hint={t.settings.proFeatures[flag].hint}
                checked={proFlags[flag]}
                onChange={(enabled) => setProFeatureFlag(flag, enabled)}
              />
            ))}
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <h2 className="text-headline text-foreground">
            {t.settings.dataTitle}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t.settings.dataBody}
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                clearRecentEntries();
                clearValueHistory();
                clearAllTemplates();
                clearHandoff();
                // Async (IndexedDB): no se afirma "borrado" hasta que de verdad
                // terminaron BIEN los borradores y el baul de firmas (que se
                // borra aunque su flag este apagado). Si falla alguno se dice
                // cual y el boton sigue sirviendo para reintentar. Los borradores
                // del editor y de PDF Pro (otras bases de IndexedDB) se vacian a la vez.
                setCleared(false);
                setFailed([]);
                void Promise.all([
                  clearLocalSignData(),
                  clearAllEditDrafts(),
                  clearLocalProData(),
                ]).then(([failures, editDrafts, proFailures]) => {
                  const all: (ClearFailure | "editDrafts" | "proDrafts")[] = [
                    ...failures,
                    ...(editDrafts.ok ? [] : (["editDrafts"] as const)),
                    ...proFailures,
                  ];
                  setFailed(all);
                  setCleared(all.length === 0);
                });
              }}
            >
              {t.settings.clearData}
            </Button>
            {/* Region de estado siempre montada: solo cambia su contenido. */}
            <span role="status">
              {failed.length > 0 ? (
                <span className="text-footnote text-destructive-text">
                  {SIGN_STRINGS[language].vaultClearFailed(failed)}
                </span>
              ) : cleared ? (
                <Badge variant="success">{t.settings.cleared}</Badge>
              ) : null}
            </span>
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <h2 className="text-headline text-foreground">
            {t.settings.aboutTitle}
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t.footer.tagline}
          </p>
          <Badge variant="live" dot className="mt-4">
            {t.common.localAndZeroUploads}
          </Badge>
        </GlassCard>
      </div>
    </div>
  );
}
