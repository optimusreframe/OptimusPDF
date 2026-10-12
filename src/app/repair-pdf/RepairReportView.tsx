"use client";

import { AlertTriangle, CheckCircle2, FileWarning, Info, Wrench } from "lucide-react";
import { formatFileSize } from "@/lib/pdf/core";
import type { RepairOutcome } from "@/lib/pdf/repair";
import type { RepairStrings } from "@/app/repair-pdf/strings";

export function Row({
  icon: Icon,
  tone,
  children,
}: {
  icon: typeof Info;
  tone: "neutral" | "good" | "warn";
  children: React.ReactNode;
}) {
  const color =
    tone === "warn"
      ? "text-destructive"
      : tone === "good"
        ? "text-success"
        : "text-muted-foreground";
  return (
    <div className="flex items-start gap-3">
      <Icon aria-hidden="true" className={`mt-0.5 size-4 shrink-0 ${color}`} />
      <p className="text-sm leading-relaxed text-foreground">{children}</p>
    </div>
  );
}

/** Informe medido sobre el documento que se va a descargar. */
export function RepairReportView({
  s,
  outcome,
  language,
}: {
  s: RepairStrings;
  /** Solo se lee `report`: PDF Pro pasa el informe sin el archivo. */
  outcome: Pick<RepairOutcome, "report">;
  language: string;
}) {
  const { report } = outcome;
  const { pagesRecovered, pagesDeclared } = report;
  // Solo se afirma una perdida cuando hay un denominador real y es mayor.
  const lost =
    pagesDeclared !== null && pagesDeclared > pagesRecovered
      ? pagesDeclared - pagesRecovered
      : 0;

  return (
    <div className="space-y-6">
      {/* Diagnostico */}
      <section>
        <h3 className="text-headline text-foreground">
          {s.damageTitle}
        </h3>
        <div className="mt-3 space-y-2">
          {report.damage.length === 0 ? (
            <Row icon={CheckCircle2} tone="good">
              {s.damageNone}
            </Row>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{s.damageIntro}</p>
              <ul className="space-y-2">
                {report.damage.map((signal) => (
                  <li key={signal}>
                    <Row icon={FileWarning} tone="warn">
                      {s.damage[signal]}
                    </Row>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>

      {/* Que se hizo */}
      <section>
        <h3 className="text-headline text-foreground">{s.planTitle}</h3>
        {report.actions.length === 0 ? (
          <div className="mt-3">
            <Row icon={CheckCircle2} tone="good">
              {s.actionsNone}
            </Row>
          </div>
        ) : (
          <ul className="mt-3 space-y-2">
            {report.actions.map((action) => (
              <li key={action}>
                <Row icon={Wrench} tone="neutral">
                  {s.actions[action]}
                </Row>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Resultado medido */}
      <section>
        <h3 className="text-headline text-foreground">
          {s.resultTitle}
        </h3>
        <div className="mt-3 space-y-2">
          <Row icon={lost > 0 ? AlertTriangle : CheckCircle2} tone={lost > 0 ? "warn" : "good"}>
            {pagesDeclared !== null
              ? s.pagesRecoveredOf(pagesRecovered, pagesDeclared)
              : s.pagesRecovered(pagesRecovered)}
          </Row>

          {lost > 0 ? (
            <Row icon={AlertTriangle} tone="warn">
              {s.pagesLost(lost)}
            </Row>
          ) : pagesDeclared !== null ? (
            <Row icon={CheckCircle2} tone="good">
              {s.pagesComplete}
            </Row>
          ) : null}

          {report.failedPages.length > 0 ? (
            <Row icon={AlertTriangle} tone="warn">
              {s.failedPages(report.failedPages.join(", "))}
            </Row>
          ) : null}

          {report.bytesDiscarded > 0 ? (
            <Row icon={FileWarning} tone="warn">
              {s.bytesDiscarded(
                formatFileSize(report.bytesDiscarded, language),
              )}
            </Row>
          ) : null}

          <Row
            icon={report.textPreserved ? CheckCircle2 : AlertTriangle}
            tone={report.textPreserved ? "good" : "warn"}
          >
            {report.textPreserved ? s.textPreserved : s.textLost}
          </Row>
        </div>
      </section>
    </div>
  );
}

