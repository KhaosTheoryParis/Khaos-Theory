import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "../../i18n";
import { isLocale } from "../../i18n/config";
import { localizedPublicMetadata } from "../../public/public-seo";
import PublicFooter from "../../public/public-footer";
import PublicHeader from "../../public/public-header";

type LocalizedAboutPageProps = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: LocalizedAboutPageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const metadata = getDictionary(locale).metadata;
  return localizedPublicMetadata({ locale, route: "about", title: metadata.aboutTitle, description: metadata.aboutDescription });
}

export default async function LocalizedAboutPage({ params }: LocalizedAboutPageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dictionary = getDictionary(locale);

  return (
    <div className="localized-public localized-about-page">
      <PublicHeader locale={locale} currentRoute="about" />
      <main>
        <section id="about" aria-labelledby="about-title">
          <h1 id="about-title" className="section-title">{dictionary.about.title}</h1>
          <div className="section-content">{dictionary.about.message}</div>
        </section>
      </main>
      <PublicFooter locale={locale} />
    </div>
  );
}
