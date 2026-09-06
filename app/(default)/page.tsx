import { permanentRedirect } from "next/navigation";

type RootSearchParams = Record<string, string | string[] | undefined>;

export function buildLocalizedRootRedirect(searchParams: RootSearchParams = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const entry of value) query.append(key, entry);
    } else if (value !== undefined) {
      query.set(key, value);
    }
  }
  const serializedQuery = query.toString();
  return serializedQuery ? `/fr?${serializedQuery}` : "/fr";
}

export default async function Home({ searchParams }: { searchParams?: Promise<RootSearchParams> }) {
  permanentRedirect(buildLocalizedRootRedirect(await searchParams));
}
