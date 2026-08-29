import { isLocale, type Locale } from "./config";

export const localizedRoutes = [
  "home",
  "rings",
  "bracelets",
  "earrings",
  "pendants",
  "product",
  "about",
  "contact",
  "cart",
  "checkout",
  "success",
  "legal",
] as const;

export type LocalizedRoute = (typeof localizedRoutes)[number];

const routeSegments: Record<LocalizedRoute, string> = {
  home: "",
  rings: "rings",
  bracelets: "bracelets",
  earrings: "earrings",
  pendants: "pendants",
  product: "product",
  about: "about",
  contact: "contact",
  cart: "cart",
  checkout: "checkout",
  success: "success",
  legal: "legal",
};

type QueryValue = string | number | boolean | null | undefined;
export type LocalizedRouteOptions = {
  query?: URLSearchParams | Record<string, QueryValue>;
  hash?: string;
};

export type ParsedLocalizedRoute = {
  locale: Locale;
  route: LocalizedRoute;
  query: URLSearchParams;
  hash: string;
};

const internalOrigin = "https://khaos-theory.invalid";

function isLocalizedRoute(value: string): value is LocalizedRoute {
  return (localizedRoutes as readonly string[]).includes(value);
}

function toSearchParams(query: LocalizedRouteOptions["query"]): URLSearchParams {
  if (query instanceof URLSearchParams) return new URLSearchParams(query);

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== null && value !== undefined) params.set(key, String(value));
  }
  return params;
}

function normalizeHash(hash: string | undefined): string {
  if (!hash) return "";
  return `#${hash.replace(/^#/, "")}`;
}

export function localizedPath(locale: Locale, route: LocalizedRoute): string {
  const segment = routeSegments[route];
  return segment ? `/${locale}/${segment}` : `/${locale}`;
}

export function localizedHref(
  locale: Locale,
  route: LocalizedRoute,
  options: LocalizedRouteOptions = {},
): string {
  const params = toSearchParams(options.query);
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const hash = normalizeHash(options.hash);
  const base = route === "home" && hash ? `/${locale}/` : localizedPath(locale, route);
  return `${base}${query}${hash}`;
}

export function parseLocalizedRoute(input: string): ParsedLocalizedRoute | null {
  if (!input.startsWith("/")) return null;

  let url: URL;
  try {
    url = new URL(input, internalOrigin);
  } catch {
    return null;
  }

  if (url.origin !== internalOrigin) return null;

  const normalizedPath = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length < 1 || segments.length > 2) return null;

  const [candidateLocale, candidateSegment] = segments;
  if (!isLocale(candidateLocale)) return null;

  const route = (Object.entries(routeSegments) as Array<[LocalizedRoute, string]>).find(
    ([, segment]) => segment === (candidateSegment ?? ""),
  )?.[0];
  if (!route || !isLocalizedRoute(route)) return null;

  return {
    locale: candidateLocale,
    route,
    query: new URLSearchParams(url.searchParams),
    hash: url.hash.slice(1),
  };
}

export function switchLocalizedRoute(input: string, targetLocale: Locale): string | null {
  if (!isLocale(targetLocale)) return null;

  const parsed = parseLocalizedRoute(input);
  if (!parsed) return null;

  return localizedHref(targetLocale, parsed.route, {
    query: parsed.query,
    hash: parsed.hash,
  });
}
