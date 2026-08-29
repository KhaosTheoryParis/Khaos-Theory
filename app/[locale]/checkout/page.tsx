import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "../../i18n";
import { isLocale } from "../../i18n/config";
import CheckoutClient from "../../public/checkout-client";
import PublicFooter from "../../public/public-footer";
import PublicHeader from "../../public/public-header";

type LocalizedCheckoutPageProps = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: LocalizedCheckoutPageProps): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  return { title: getDictionary(locale).metadata.checkoutTitle };
}

export default async function LocalizedCheckoutPage({ params }: LocalizedCheckoutPageProps) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const dictionary = getDictionary(locale);

  return (
    <div className="localized-public localized-checkout-page">
      <PublicHeader locale={locale} currentRoute="checkout" />
      <main><CheckoutClient locale={locale} dictionary={dictionary} /></main>
      <PublicFooter locale={locale} />
    </div>
  );
}
