import type { MetadataRoute } from "next";
import { supportedLocales } from "./i18n/config";
import { localizedHref } from "./i18n/routes";
import { homeCatalog } from "./public/home-catalog";
import { publicUrl } from "./public/public-seo";
import { publicCategories } from "./public/category-page";

export default function sitemap(): MetadataRoute.Sitemap {
  const staticRoutes = ["home", "about", "contact", "legal"] as const;

  return [
    ...supportedLocales.flatMap((locale) => staticRoutes.map((route) => ({
      url: publicUrl(localizedHref(locale, route)),
      changeFrequency: route === "home" ? "weekly" as const : "monthly" as const,
      priority: route === "home" ? 1 : 0.6,
    }))),
    ...supportedLocales.flatMap((locale) => publicCategories.map((category) => ({
      url: publicUrl(`/${locale}/${category}`),
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }))),
    ...supportedLocales.flatMap((locale) => homeCatalog.map((product) => ({
      url: publicUrl(localizedHref(locale, "product", { query: { item: product.id } })),
      changeFrequency: "weekly" as const,
      priority: 0.9,
    }))),
  ];
}
