import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, supportedLocales } from "../i18n/config";
import { getDictionary } from "../i18n";
import { localizedHref } from "../i18n/routes";
import { localizedPublicMetadata } from "../public/public-seo";
import { homeCatalog, localizedProductHref } from "../public/home-catalog";
import PublicFooter from "../public/public-footer";
import PublicHeader from "../public/public-header";

type LocalePageProps = {
  params: Promise<{ locale: string }>;
};

export function generateStaticParams() {
  return supportedLocales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: LocalePageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};

  const metadata = getDictionary(locale).metadata;
  return localizedPublicMetadata({ locale, route: "home", title: metadata.homeTitle, description: metadata.homeDescription });
}

export default async function LocalizedHomePage({ params }: LocalePageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const dictionary = getDictionary(locale);

  return (
    <div className="localized-public localized-home">
      <PublicHeader locale={locale} />
      <main>
        <section id="home" className="hero" aria-labelledby="localized-home-title">
          <h1 id="localized-home-title" className="localized-home-title">{dictionary.brand}</h1>
          <div className="construction-notice">
            <span className="construction-notice-title">{dictionary.home.constructionTitle}</span>
            <span className="construction-notice-message">
              {dictionary.home.constructionMessage}{" "}
              <a href={localizedHref(locale, "contact")}>{dictionary.home.constructionContact}</a>
            </span>
          </div>
          <img src="/logo.jpeg" alt={dictionary.brand} className="logo" />
          <div className="tagline">{dictionary.home.tagline}</div>
          <div className="scroll">{dictionary.home.scrollCue}</div>
        </section>
        <section id="collection" aria-labelledby="collection-title">
          <h2 id="collection-title" className="section-title">{dictionary.home.collectionTitle}</h2>
          <div className="shop-grid product-grid">
            {homeCatalog.map((product) => {
              const copy = dictionary.home.products[product.id];
              return (
                <a className="product-card" href={localizedProductHref(locale, product.id)} key={product.id}>
                  <img src={product.image} alt={copy.imageAlt} />
                  <span className="product-overlay">
                    <span>{copy.name}</span>
                    <strong>{product.price} €</strong>
                  </span>
                </a>
              );
            })}
          </div>
        </section>
      </main>
      <PublicFooter locale={locale} />
    </div>
  );
}
