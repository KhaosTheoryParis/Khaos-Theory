import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "../../i18n";
import { isLocale } from "../../i18n/config";
import { localizedHref } from "../../i18n/routes";
import PublicFooter from "../../public/public-footer";
import PublicHeader from "../../public/public-header";

type LocalizedSuccessPageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ session_id?: string | string[] }>;
};

function safeSessionId(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return /^[A-Za-z0-9_]{1,255}$/.test(value) ? value : undefined;
}

export async function generateMetadata({ params }: LocalizedSuccessPageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: getDictionary(locale).metadata.successTitle };
}

export default async function LocalizedSuccessPage({ params, searchParams }: LocalizedSuccessPageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  const dictionary = getDictionary(locale);
  const sessionId = safeSessionId((await searchParams).session_id);
  const currentRouteOptions = sessionId ? { query: { session_id: sessionId } } : undefined;

  return (
    <div className="localized-public localized-success-page">
      <PublicHeader locale={locale} currentRoute="success" currentRouteOptions={currentRouteOptions} />
      <main>
        <section className="checkout-summary" aria-labelledby="success-title">
          <h1 id="success-title" className="section-title">{dictionary.success.title}</h1>
          <p className="checkout-empty">{dictionary.success.message}</p>
          <a className="continue-shopping" href={localizedHref(locale, "home")}>{dictionary.success.returnHome}</a>
        </section>
      </main>
      <PublicFooter locale={locale} />
    </div>
  );
}
