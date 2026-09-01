import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDictionary } from "../../i18n";
import { isLocale } from "../../i18n/config";
import { getPublicProduct } from "../../public/home-catalog";
import ProductDetail from "../../public/product-detail";
import PublicFooter from "../../public/public-footer";
import PublicHeader from "../../public/public-header";
import { localizedPublicMetadata } from "../../public/public-seo";

type LocalizedProductPageProps = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ item?: string | string[] }>;
};

async function getLocalizedProduct({ params, searchParams }: LocalizedProductPageProps) {
  const [{ locale }, { item }] = await Promise.all([params, searchParams]);
  if (!isLocale(locale) || typeof item !== "string") notFound();

  const product = getPublicProduct(item);
  if (!product || !product.available) notFound();

  return { locale, product, dictionary: getDictionary(locale) };
}

export async function generateMetadata(props: LocalizedProductPageProps): Promise<Metadata> {
  const { locale, dictionary, product } = await getLocalizedProduct(props);
  const productName = dictionary.home.products[product.id].name;
  return localizedPublicMetadata({
    locale,
    route: "product",
    options: { query: { item: product.id } },
    title: dictionary.metadata.productTitle.replace("{product}", productName),
    description: dictionary.metadata.productDescription.replace("{product}", productName),
  });
}

export default async function LocalizedProductPage(props: LocalizedProductPageProps) {
  const { locale, product, dictionary } = await getLocalizedProduct(props);

  return (
    <div className="localized-public localized-product-page">
      <PublicHeader locale={locale} currentRoute="product" currentRouteOptions={{ query: { item: product.id } }} />
      <main><ProductDetail product={product} dictionary={dictionary} /></main>
      <PublicFooter locale={locale} />
    </div>
  );
}
