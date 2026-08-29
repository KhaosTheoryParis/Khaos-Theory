import type { Locale } from "../i18n/config";
import { localizedHref } from "../i18n/routes";
import type { HomeProductId } from "../i18n/types";

export type PublicProduct = {
  id: HomeProductId;
  price: number;
  images: readonly string[];
  available: true;
};

export type RingSize = readonly [fr: number, us: string];

export const ringSizes: readonly RingSize[] = [
  [48, "4.5"], [49, "5"], [50, "5.25"], [51, "5.5"], [52, "6"], [53, "6.5"], [54, "7"], [55, "7.25"],
  [56, "7.5"], [57, "8"], [58, "8.5"], [59, "8.75"], [60, "9"], [61, "9.5"], [62, "10"], [63, "10.25"],
  [64, "10.5"], [65, "11"], [66, "11.5"], [67, "12"], [68, "12.25"], [69, "12.5"], [70, "13"],
];

export const publicProductCatalog: readonly PublicProduct[] = [
  { id: "geometry", price: 250, images: ["/Photos/Rings/KTR-GEOMETRY-001.jpg"], available: true },
  { id: "carved-cross", price: 200, images: ["/Photos/Rings/KTR-KARVED%20KROSS-001.jpg"], available: true },
  { id: "hollow-cross", price: 200, images: ["/Photos/Rings/KTR-HOLLOW%20KROSS-001.jpg"], available: true },
  { id: "signet-corner", price: 200, images: ["/Photos/Rings/KTR-SIGNET%20KORNER-001.jpg", "/Photos/Rings/KTR-SIGNET%20KORNER-002.jpg"], available: true },
  { id: "damaged-ring-i", price: 150, images: ["/Photos/Rings/KTR-DAMAGED%20RING-001.jpg"], available: true },
  { id: "damaged-ring-ii", price: 150, images: ["/Photos/Rings/KTR-DAMAGED%20RING-002.jpg"], available: true },
];

export const homeCatalog = publicProductCatalog.map(({ id, price, images }) => ({ id, price, image: images[0] }));

export function isPublicProductId(value: string): value is HomeProductId {
  return publicProductCatalog.some((product) => product.id === value);
}

export function getPublicProduct(productId: string): PublicProduct | null {
  return publicProductCatalog.find((product) => product.id === productId) ?? null;
}

export function historicProductHref(productId: HomeProductId): string {
  return `/product.html?item=${encodeURIComponent(productId)}`;
}

export function localizedProductHref(locale: Locale, productId: HomeProductId): string {
  return localizedHref(locale, "product", { query: { item: productId } });
}
