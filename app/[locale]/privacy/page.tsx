import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { isLocale } from "../../i18n/config";
import { privacyDocuments } from "../../i18n/privacy";
import PublicFooter from "../../public/public-footer";
import PublicHeader from "../../public/public-header";

type PrivacyPageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: PrivacyPageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const privacy = privacyDocuments[locale];
  return { title: privacy.title, description: privacy.title };
}

export default async function PrivacyPage({ params }: PrivacyPageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const privacy = privacyDocuments[locale];

  return (
    <div className="localized-public localized-legal-page">
      <PublicHeader locale={locale} currentRoute="privacy" />
      <main>
        <section className="legal-page" aria-labelledby="privacy-title">
          <h1 id="privacy-title" className="section-title">{privacy.title}</h1>
          <div className="legal-content">
            <p><strong>{privacy.version}</strong></p>
            {privacy.sections.map((section, index) => (
              <div key={section.heading}>
                <h2 id={`privacy-section-${index + 1}`}>{section.heading}</h2>
                {section.paragraphs.map((paragraph) => <PrivacyParagraph key={paragraph} text={paragraph} />)}
              </div>
            ))}
          </div>
        </section>
      </main>
      <PublicFooter locale={locale} />
    </div>
  );
}

function PrivacyParagraph({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <p>
      {lines.map((line, index) => (
        <Fragment key={`${line}-${index}`}>
          {line}
          {index < lines.length - 1 ? <br /> : null}
        </Fragment>
      ))}
    </p>
  );
}
