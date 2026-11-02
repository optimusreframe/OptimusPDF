"use client";

import { Fragment, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { GuardedLink as Link } from "@/components/layout/GuardedLink";
import { Badge } from "@/components/ui/Badge";
import { GlassCard } from "@/components/ui/GlassCard";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { LAME, npmTarballUrl, npmVersionUrl, sourceTreeUrl } from "@/app/licenses/lame";
import { LICENSE_TEXT_URLS, SERVER_SIDE, USED_UNDER, licenseIds } from "@/app/licenses/licenseTexts";
import { PACKAGES, type PackageEntry } from "@/app/licenses/packages";
import { STRINGS, fill, type LicensesStrings } from "@/app/licenses/strings";

/**
 * «Licencias y avisos de codigo abierto». Misma estructura que `/about` y `/privacy` (cabecera con insignia, secciones en
 * tarjetas de material, columna de 860 px), con las listas en tarjetas apiladas en vez de una tabla: a 320 px una tabla de
 * cuatro columnas obligaria a desplazar de lado. Los enlaces externos se abren en otra pestana y lo dicen (texto + icono).
 */

/** Enlace de texto, con objetivo de 44 px con tacto. Los externos llevan icono y aviso para lectores de pantalla. */
const LINK_CLASS =
  "inline-flex items-center gap-1 rounded-ios-sm py-1 text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal pointer-coarse:min-h-11";

function ExternalA({ href, children, newTab }: { href: string; children: ReactNode; newTab: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
      <span className="break-words">{children}</span>
      <ExternalLink aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="sr-only"> {newTab}</span>
    </a>
  );
}

function LicenseLinks({ expression, s }: { expression: string; s: LicensesStrings }) {
  return (
    <>
      {licenseIds(expression).map((id) => {
        const href = LICENSE_TEXT_URLS[id];
        return href ? (
          <ExternalA key={id} href={href} newTab={s.fields.openInNewTab}>
            {s.fields.licenseText}: {id}
          </ExternalA>
        ) : null;
      })}
    </>
  );
}

/** Chip de licencia: como la insignia neutra, pero PUEDE partirse en lineas (las licencias compuestas son largas a 320 px). */
function LicenseBadge({ children }: { children: ReactNode }) {
  return (
    <span className="material-thin inline-block max-w-full rounded-ios-sm px-2.5 py-1 text-caption-2 leading-snug font-medium text-muted-foreground forced-colors:border forced-colors:border-[CanvasText]">
      {children}
    </span>
  );
}

function PackageCard({ entry, s }: { entry: PackageEntry; s: LicensesStrings }) {
  const usedUnder = USED_UNDER[entry.name];
  return (
    <li data-package={entry.name} className="surface-card flex min-w-0 flex-col rounded-ios p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <h3 className="min-w-0 text-base font-semibold break-words text-foreground">{entry.name}</h3>
        <span className="text-footnote text-muted-foreground tabular-nums">
          <span className="sr-only">{s.fields.version} </span>v{entry.version}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <LicenseBadge>
          <span className="sr-only">{s.fields.license}: </span>
          {entry.license}
        </LicenseBadge>
        {usedUnder ? <span className="text-caption text-muted-foreground">{fill(s.fields.usedUnder, { license: usedUnder })}</span> : null}
        {SERVER_SIDE.has(entry.name) ? <Badge variant="signal">{s.fields.onServer}</Badge> : null}
      </div>
      <p className="mt-2 text-subheadline text-muted-foreground">{s.purposes[entry.name]}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        <ExternalA href={entry.repo} newTab={s.fields.openInNewTab}>
          {s.fields.repository}
        </ExternalA>
        <ExternalA href={npmVersionUrl(entry.name, entry.version)} newTab={s.fields.openInNewTab}>
          {s.fields.npm}
        </ExternalA>
        <LicenseLinks expression={usedUnder ?? entry.license} s={s} />
      </div>
    </li>
  );
}

/** Pone en tipografia de codigo (y partible en cualquier punto) los hashes que aparezcan en un texto. */
function withHashes(text: string, hashes: readonly string[]): ReactNode {
  const pattern = new RegExp(`(${hashes.join("|")})`);
  return text.split(pattern).map((part, index) =>
    hashes.includes(part) ? (
      <code key={index} className="font-mono text-[0.92em] break-all text-foreground">
        {part}
      </code>
    ) : (
      <Fragment key={index}>{part}</Fragment>
    ),
  );
}

function versionOf(name: string): string {
  return PACKAGES.find((entry) => entry.name === name)?.version ?? "";
}

function Mp3Section({ s }: { s: LicensesStrings }) {
  const m = s.mp3;
  const mediabunny = versionOf("mediabunny");
  const encoder = versionOf("@mediabunny/mp3-encoder");
  const values = { version: LAME.version, emscripten: LAME.emscripten, sha: LAME.wasmSha256 };
  const components = [
    { name: "mediabunny", version: mediabunny, license: "MPL-2.0", role: m.roles.mediabunny },
    { name: "@mediabunny/mp3-encoder", version: encoder, license: "MPL-2.0", role: m.roles.encoder },
    { name: "LAME", version: LAME.version, license: m.lameLicense, role: m.roles.lame },
  ];
  const newTab = s.fields.openInNewTab;
  return (
    <section id="mp3" aria-labelledby="mp3-title" className="mt-10 scroll-mt-24 lg:scroll-mt-8">
      <GlassCard className="p-5 md:p-7">
        <h2 id="mp3-title" className="text-headline text-foreground">
          {m.title}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">{m.intro}</p>

        <div data-lame-notice="" className="mt-5 rounded-ios border border-hairline bg-white/5 p-4">
          <p lang="en" className="text-title-3 font-semibold text-foreground">
            {LAME.noticeLead}
            <a href={LAME.site} target="_blank" rel="noopener noreferrer" className={cn(LINK_CLASS, "py-0")}>
              {LAME.noticeLink}
              <ExternalLink aria-hidden="true" className="size-4 shrink-0" />
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
          <p className="mt-1 text-footnote text-muted-foreground">{m.noticeCaption}</p>
        </div>

        <h3 className="ui-label mt-6 mb-3 text-muted-foreground">{m.componentsTitle}</h3>
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {components.map((component) => (
            <li key={component.name} data-mp3-component={component.name} className="surface-card flex min-w-0 flex-col rounded-ios p-4">
              <h4 className="text-base font-semibold break-words text-foreground">{component.name}</h4>
              <p className="mt-0.5 text-footnote text-muted-foreground tabular-nums">
                <span className="sr-only">{s.fields.version} </span>v{component.version}
              </p>
              <div className="mt-2">
                <LicenseBadge>
                  <span className="sr-only">{s.fields.license}: </span>
                  {component.license}
                </LicenseBadge>
              </div>
              <p className="mt-2 text-subheadline text-muted-foreground">{component.role}</p>
            </li>
          ))}
        </ul>

        <h3 className="mt-8 mb-3 text-base font-semibold text-foreground">{m.complianceTitle}</h3>
        <div className="space-y-3">
          {m.compliance.map((paragraph) => (
            <p key={paragraph.slice(0, 32)} className="text-sm leading-relaxed text-muted-foreground md:text-base">
              {withHashes(fill(paragraph, values), [LAME.wasmSha256])}
            </p>
          ))}
        </div>

        <h3 className="mt-8 mb-1 text-base font-semibold text-foreground">{m.sourceTitle}</h3>
        <p className="text-sm text-muted-foreground">{m.sourceIntro}</p>
        <ul data-mp3-sources="" className="mt-2 divide-y divide-hairline">
          <SourceRow title={`mediabunny ${mediabunny}`}>
            <ExternalA href={sourceTreeUrl(mediabunny)} newTab={newTab}>
              {m.labelRepo}
            </ExternalA>
            <ExternalA href={npmVersionUrl("mediabunny", mediabunny)} newTab={newTab}>
              {m.labelNpm}
            </ExternalA>
            <ExternalA href={npmTarballUrl("mediabunny", mediabunny)} newTab={newTab}>
              {m.labelTarball}
            </ExternalA>
          </SourceRow>
          <SourceRow title={`@mediabunny/mp3-encoder ${encoder}`}>
            <ExternalA href={sourceTreeUrl(encoder, "packages/mp3-encoder")} newTab={newTab}>
              {m.labelRepo}
            </ExternalA>
            <ExternalA href={npmVersionUrl("@mediabunny/mp3-encoder", encoder)} newTab={newTab}>
              {m.labelNpm}
            </ExternalA>
            <ExternalA href={npmTarballUrl("@mediabunny/mp3-encoder", encoder)} newTab={newTab}>
              {m.labelTarball}
            </ExternalA>
          </SourceRow>
          <SourceRow title={`LAME ${LAME.version}`}>
            <ExternalA href={LAME.site} newTab={newTab}>
              {m.labelLameSite}
            </ExternalA>
            <ExternalA href={LAME.sourceUrl} newTab={newTab}>
              {m.labelLameSource}
            </ExternalA>
            <p className="basis-full text-caption text-muted-foreground">{withHashes(fill(m.lameSourceNote, { sha: LAME.tarballSha256 }), [LAME.tarballSha256])}</p>
          </SourceRow>
        </ul>

        <h3 className="mt-8 mb-1 text-base font-semibold text-foreground">{m.textsTitle}</h3>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {["MPL-2.0", "LGPL-2.0-or-later", "LGPL-2.1-or-later"].map((id) => (
            <ExternalA key={id} href={LICENSE_TEXT_URLS[id]} newTab={newTab}>
              {id}
            </ExternalA>
          ))}
        </div>

        <h3 className="mt-8 mb-3 text-base font-semibold text-foreground">{m.replaceTitle}</h3>
        <div className="space-y-3">
          {m.replace.map((paragraph) => (
            <p key={paragraph.slice(0, 32)} className="text-sm leading-relaxed text-muted-foreground md:text-base">
              {fill(paragraph, values)}
            </p>
          ))}
        </div>
      </GlassCard>
    </section>
  );
}

function SourceRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="py-3">
      <p className="text-subheadline font-medium break-words text-foreground">{title}</p>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">{children}</div>
    </li>
  );
}

export function LicensesView() {
  const { t, language } = useI18n();
  const s = STRINGS[language];

  return (
    <div className="mx-auto max-w-[860px] px-4 pt-10 pb-16 [overflow-wrap:anywhere] md:px-6 md:pt-16">
      <header>
        <Badge variant="live" dot>
          {t.common.localAndZeroUploads}
        </Badge>
        <h1 className="mt-5 text-title-1 text-foreground">{s.title}</h1>
        <p className="mt-3 text-base text-muted-foreground md:text-lg">{s.subtitle}</p>
        <p className="mt-3 text-caption text-muted-foreground">{s.provenance}</p>
      </header>

      <Mp3Section s={s} />

      <section aria-labelledby="packages-title" className="mt-12">
        <h2 id="packages-title" className="text-headline text-foreground">
          {s.packagesTitle}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">{s.packagesIntro}</p>
        <ul data-packages="" className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
          {PACKAGES.map((entry) => (
            <PackageCard key={entry.name} entry={entry} s={s} />
          ))}
        </ul>
        <p className="mt-4 text-footnote text-muted-foreground">{s.packagesNote}</p>
      </section>

      <section aria-labelledby="assets-title" className="mt-12">
        <h2 id="assets-title" className="text-headline text-foreground">
          {s.assetsTitle}
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">{s.assetsIntro}</p>
        <ul data-assets="" className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
          {s.assets.map((asset) => (
            <li key={asset.name} className="surface-card flex min-w-0 flex-col rounded-ios p-4">
              <h3 className="text-base font-semibold break-words text-foreground">{asset.name}</h3>
              <div className="mt-2">
                <LicenseBadge>
                  <span className="sr-only">{s.fields.license}: </span>
                  {asset.license}
                </LicenseBadge>
              </div>
              <p className="mt-2 text-subheadline text-muted-foreground">{asset.purpose}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {asset.links.map((link) => (
                  <ExternalA key={link.href} href={link.href} newTab={s.fields.openInNewTab}>
                    {link.label}
                  </ExternalA>
                ))}
                <LicenseLinks expression={asset.license} s={s} />
              </div>
            </li>
          ))}
        </ul>
      </section>

      <GlassCard className="mt-12 p-5 md:p-7">
        <h2 className="text-headline text-foreground">{s.modelsTitle}</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">
          {s.modelsBody}{" "}
          <Link href="/privacy" className="text-foreground underline underline-offset-2 hover:text-muted-foreground">
            {s.modelsLinkLabel}
          </Link>
          .
        </p>
      </GlassCard>

      <GlassCard className="mt-6 p-5 md:p-7">
        <h2 className="text-headline text-foreground">{s.contactTitle}</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {s.contactBody}{" "}
          <Link href="/about" className="text-foreground underline underline-offset-2 hover:text-muted-foreground">
            {s.contactLinkLabel}
          </Link>
          .
        </p>
      </GlassCard>
    </div>
  );
}

/** Tarjeta que `/about` muestra para llegar a esta pagina. */
export function AboutLicensesCard() {
  const { language } = useI18n();
  const s = STRINGS[language];
  return (
    <div className="mx-auto max-w-[860px] px-4 pb-16 md:px-6">
      <GlassCard className="-mt-6 p-7" data-about-licenses="">
        <h2 className="text-headline text-foreground">{s.aboutTitle}</h2>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{s.aboutBody}</p>
        <p className="mt-3">
          <Link href="/licenses" className="inline-flex min-h-11 items-center rounded-ios-sm text-sm text-foreground underline underline-offset-2 hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
            {s.aboutLinkLabel}
          </Link>
        </p>
      </GlassCard>
    </div>
  );
}
