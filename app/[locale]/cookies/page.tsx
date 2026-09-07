import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Fragment } from "react";
import { isLocale } from "../../i18n/config";
import { cookiesDocuments } from "../../i18n/cookies";
import PublicFooter from "../../public/public-footer";
import PublicHeader from "../../public/public-header";

type CookiesPageProps = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: CookiesPageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const cookies = cookiesDocuments[locale];
  return { title: cookies.title, description: cookies.title };
}

export default async function CookiesPage({ params }: CookiesPageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const cookies = cookiesDocuments[locale];

  return (
    <div className="localized-public localized-legal-page">
      <PublicHeader locale={locale} currentRoute="cookies" />
      <main>
        <section className="legal-page" aria-labelledby="cookies-title">
          <h1 id="cookies-title" className="section-title">{cookies.title}</h1>
          <div className="legal-content">
            <p><strong>{cookies.version}</strong></p>
            {cookies.sections.map((section, index) => (
              <div key={section.heading}>
                <h2 id={`cookies-section-${index + 1}`}>{section.heading}</h2>
                {section.paragraphs.map((paragraph) => <CookiesParagraph key={paragraph} text={paragraph} locale={locale} />)}
              </div>
            ))}
          </div>
        </section>
      </main>
      <PublicFooter locale={locale} />
    </div>
  );
}

function CookiesParagraph({ text, locale }: { text: string; locale: "fr" | "en" }) {
  const lines = text.split("\n");
  return (
    <p>
      {lines.map((line, index) => (
        <Fragment key={`${line}-${index}`}>
          {line === `/${locale}/privacy` ? <a href={line}>{line}</a> : line}
          {index < lines.length - 1 ? <br /> : null}
        </Fragment>
      ))}
    </p>
  );
}
