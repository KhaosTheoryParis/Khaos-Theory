import type { Locale } from "../i18n/config";
import { getDictionary } from "../i18n";
import type { PublicCategory } from "../i18n/types";
import { homeCatalog, localizedProductHref } from "./home-catalog";
import PublicFooter from "./public-footer";
import PublicHeader from "./public-header";

export const publicCategories = ["rings", "bracelets", "earrings", "pendants"] as const satisfies readonly PublicCategory[];

export function isPublicCategory(value: string): value is PublicCategory {
  return (publicCategories as readonly string[]).includes(value);
}

type CategoryPageProps = {
  locale: Locale;
  category: PublicCategory;
};

export default function CategoryPage({ locale, category }: CategoryPageProps) {
  const dictionary = getDictionary(locale);
  const title = dictionary.categories[category];
  const rings = category === "rings";

  return (
    <div className="localized-public localized-category-page">
      <PublicHeader locale={locale} currentRoute={category} />
      <main>
        <section id={category} className={rings ? undefined : "category-page"} aria-labelledby={`${category}-title`}>
          <h1 id={`${category}-title`} className="section-title">{title}</h1>
          {rings ? (
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
          ) : <p className="category-note">{dictionary.categories.comingSoon}</p>}
        </section>
      </main>
      <PublicFooter locale={locale} />
    </div>
  );
}
