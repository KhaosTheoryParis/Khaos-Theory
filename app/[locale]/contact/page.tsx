import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "../../i18n";
import { isLocale } from "../../i18n/config";
import PublicFooter from "../../public/public-footer";
import PublicHeader from "../../public/public-header";

const contactEmail = "contact@khaostheoryparis.com";

type LocalizedContactPageProps = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: LocalizedContactPageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: getDictionary(locale).metadata.contactTitle };
}

export default async function LocalizedContactPage({ params }: LocalizedContactPageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dictionary = getDictionary(locale);

  return (
    <div className="localized-public localized-contact-page">
      <PublicHeader locale={locale} currentRoute="contact" />
      <main>
        <section id="contact" className="contact" aria-labelledby="contact-title">
          <h1 id="contact-title" className="section-title">{dictionary.contact.title}</h1>
          <a href={`mailto:${contactEmail}`} className="contact-email">{contactEmail}</a>
        </section>
      </main>
      <PublicFooter locale={locale} />
    </div>
  );
}
