import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { isLocale } from "../../i18n/config";
import { termsDocuments } from "../../i18n/terms";
import PublicFooter from "../../public/public-footer";
import PublicHeader from "../../public/public-header";

type TermsPageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: TermsPageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const terms = termsDocuments[locale];
  return { title: terms.title, description: terms.title };
}

export default async function TermsPage({ params }: TermsPageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const terms = termsDocuments[locale];

  return (
    <div className="localized-public localized-legal-page">
      <PublicHeader locale={locale} currentRoute="terms" />
      <main>
        <section className="legal-page" aria-labelledby="terms-title">
          <h1 id="terms-title" className="section-title">{terms.title}</h1>
          <div className="legal-content">
            <p><strong>{terms.version}</strong></p>
            {terms.sections.map((section, sectionIndex) => (
              <div key={section.heading}>
                <h2 id={`terms-section-${sectionIndex + 1}`}>{section.heading}</h2>
                {section.paragraphs.map((paragraph) => <TermsParagraph key={paragraph} text={paragraph} />)}
              </div>
            ))}
            <div>
              <h2 id="terms-withdrawal-form">{terms.withdrawalForm.heading}</h2>
              {terms.withdrawalForm.paragraphs.map((paragraph) => <TermsParagraph key={paragraph} text={paragraph} />)}
            </div>
          </div>
        </section>
      </main>
      <PublicFooter locale={locale} />
    </div>
  );
}

function TermsParagraph({ text }: { text: string }) {
  return (
    <p>
      {text.split("\n").map((line, index) => (
        <Fragment key={`${line}-${index}`}>
          {line === "https://www.cm2c.net/" ? <a href={line}>{line}</a> : line}
          {index < text.split("\n").length - 1 ? <br /> : null}
        </Fragment>
      ))}
    </p>
  );
}
