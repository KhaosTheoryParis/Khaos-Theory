import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "../../i18n";
import { isLocale } from "../../i18n/config";
import PublicFooter from "../../public/public-footer";
import PublicHeader from "../../public/public-header";

const legalIdentity = {
  publisher: "EI - Vincent GÉRARD",
  tradeName: "Khaos Theory",
  address: ["231 Rue Saint-Honoré", "75001 Paris", "France"],
  siren: "928 374 297",
  siret: "928 374 297 00028",
  email: "contact@khaostheoryparis.com",
  publicationDirector: "Vincent GÉRARD",
} as const;

const hostingProvider = {
  name: "Cloudflare, Inc.",
  address: ["101 Townsend St", "San Francisco, CA 94107", "United States"],
} as const;

type LocalizedLegalPageProps = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: LocalizedLegalPageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: getDictionary(locale).metadata.legalTitle };
}

export default async function LocalizedLegalPage({ params }: LocalizedLegalPageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dictionary = getDictionary(locale);

  return (
    <div className="localized-public localized-legal-page">
      <PublicHeader locale={locale} currentRoute="legal" />
      <main>
        <section className="legal-page" aria-labelledby="legal-title">
          <h1 id="legal-title" className="section-title">{dictionary.legal.title}</h1>
          <div className="legal-content">
            <p>{dictionary.legal.introduction}</p>

            <h2>{dictionary.legal.publisherHeading}</h2>
            <p>
              <strong>{dictionary.legal.publisherLabel} :</strong> {legalIdentity.publisher}<br />
              <strong>{dictionary.legal.tradeNameLabel} :</strong> {legalIdentity.tradeName}<br />
              <strong>{dictionary.legal.addressLabel} :</strong><br />
              {legalIdentity.address.map((line) => <span key={line}>{line}<br /></span>)}
              <strong>{dictionary.legal.sirenLabel} :</strong> {legalIdentity.siren}<br />
              <strong>{dictionary.legal.siretLabel} :</strong> {legalIdentity.siret}<br />
              <strong>{dictionary.legal.emailLabel} :</strong>{" "}
              <a href={`mailto:${legalIdentity.email}`}>{legalIdentity.email}</a><br />
              <strong>{dictionary.legal.publicationDirectorLabel} :</strong> {legalIdentity.publicationDirector}
            </p>
            {/* TODO(legal): Add a verified professional telephone number before final commercial launch if legally required. */}

            <h2>{dictionary.legal.vatHeading}</h2>
            <p>{dictionary.legal.vatStatus}</p>

            <h2>{dictionary.legal.hostingHeading}</h2>
            <p>
              {dictionary.legal.hostingIntroduction}<br />
              {hostingProvider.name}<br />
              {hostingProvider.address.map((line) => <span key={line}>{line}<br /></span>)}
            </p>

            <h2>{dictionary.legal.intellectualPropertyHeading}</h2>
            <p>{dictionary.legal.intellectualPropertyText}</p>

            <h2>{dictionary.legal.languageHeading}</h2>
            <p>{dictionary.legal.languageText}</p>
          </div>
        </section>
      </main>
      <PublicFooter locale={locale} />
    </div>
  );
}
