"use client";

import { useState } from "react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { GlassCard } from "@/components/ui/GlassCard";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useI18n, type Language } from "@/lib/i18n";
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { clearRecentEntries } from "@/lib/recent";
import { clearValueHistory } from "@/lib/valueHistory";
import { clearAllDrafts } from "@/app/sign-pdf/signDrafts";

export function SettingsView() {
  const { t, language, setLanguage } = useI18n();
  const { theme, setTheme } = useTheme();
  const [cleared, setCleared] = useState(false);

  return (
    <div className="mx-auto max-w-[800px] px-4 pt-10 pb-16 md:px-6 md:pt-16">
      <h1 className="text-4xl font-black tracking-[-0.025em] text-foreground md:text-5xl">
        {t.settings.title}
      </h1>

      <div className="mt-8 space-y-4">
        <GlassCard className="p-6">
          <h2 className="hud-label text-[11px] text-foreground">
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
          <h2 className="hud-label text-[11px] text-foreground">
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
          <h2 className="hud-label text-[11px] text-foreground">
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
                // Async (IndexedDB): no se afirma "borrado" hasta que
                // de verdad termino.
                void clearAllDrafts().then(() => setCleared(true));
              }}
            >
              {t.settings.clearData}
            </Button>
            {cleared ? (
              <Badge variant="success">{t.settings.cleared}</Badge>
            ) : null}
          </div>
        </GlassCard>

        <GlassCard className="p-6">
          <h2 className="hud-label text-[11px] text-foreground">
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
