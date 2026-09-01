import type { Locale } from "../i18n/config";
import { getDictionary } from "../i18n";
import { localizedHref } from "../i18n/routes";
import PublicFooter from "./public-footer";
import PublicHeader from "./public-header";

type PublicNotFoundProps = {
  locale: Locale;
};

export default function PublicNotFound({ locale }: PublicNotFoundProps) {
  const dictionary = getDictionary(locale).notFound;

  return (
    <div className="localized-public localized-not-found-page">
      <PublicHeader locale={locale} />
      <main className="not-found-main">
        <section className="not-found-panel" aria-labelledby="not-found-title">
          <p className="not-found-status" aria-hidden="true">404</p>
          <h1 id="not-found-title" className="section-title">{dictionary.title}</h1>
          <p className="not-found-message">{dictionary.message}</p>
          <a className="not-found-home-link" href={localizedHref(locale, "home")}>{dictionary.returnHome}</a>
        </section>
      </main>
      <PublicFooter locale={locale} />
    </div>
  );
}
