import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { isLocale, supportedLocales } from "../../i18n/config";
import { getDictionary } from "../../i18n";
import CategoryPage, { isPublicCategory, publicCategories } from "../../public/category-page";

type LocalizedCategoryPageProps = {
  params: Promise<{ locale: string; category: string }>;
};

export function generateStaticParams() {
  return supportedLocales.flatMap((locale) => publicCategories.map((category) => ({ locale, category })));
}

export async function generateMetadata({ params }: LocalizedCategoryPageProps): Promise<Metadata> {
  const { locale, category } = await params;
  if (!isLocale(locale) || !isPublicCategory(category)) return {};

  const dictionary = getDictionary(locale);
  return { title: dictionary.metadata.categoryTitle.replace("{category}", dictionary.categories[category]) };
}

export default async function LocalizedCategoryPage({ params }: LocalizedCategoryPageProps) {
  const { locale, category } = await params;
  if (!isLocale(locale) || !isPublicCategory(category)) notFound();

  return <CategoryPage locale={locale} category={category} />;
}
