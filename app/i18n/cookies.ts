import type { Locale } from "./config";

export type CookiesSection = { heading: string; paragraphs: readonly string[] };
export type CookiesDocument = { title: string; version: string; sections: readonly CookiesSection[] };

const fr: CookiesDocument = {
  title: "COOKIES ET TECHNOLOGIES SIMILAIRES — KHAOS THEORY",
  version: "Version : septembre 2026",
  sections: [
    { heading: "1. Objet", paragraphs: ["La présente page décrit les technologies de stockage et les services susceptibles d’être utilisés lors de la navigation sur khaostheoryparis.com."] },
    { heading: "2. Panier", paragraphs: ["Khaos Theory utilise le stockage local du navigateur (localStorage) afin de conserver le contenu du panier et d’assurer son fonctionnement entre les différentes pages du site.", "La clé utilisée par l’application est khaosTheoryCart.", "Ce stockage contient uniquement les informations nécessaires au fonctionnement du panier, telles que les produits sélectionnés, leurs tailles, quantités et informations associées."] },
    { heading: "3. Paiement", paragraphs: ["Lorsque l’utilisateur accède au processus de paiement, le site utilise Stripe.js et Stripe Elements afin de fournir les fonctionnalités nécessaires au paiement sécurisé.", "Stripe peut utiliser les technologies techniques nécessaires au fonctionnement, à la sécurité et à la prévention de la fraude de son service conformément à ses propres conditions et politiques.", "Khaos Theory ne stocke pas les données de carte bancaire dans ses bases de données applicatives."] },
    { heading: "4. Police de caractères", paragraphs: ["Le site utilise actuellement Google Fonts afin de charger la police Alumni Sans.", "Le navigateur peut ainsi établir une connexion avec l’infrastructure de Google lors du chargement de cette ressource."] },
    { heading: "5. Mesure d’audience et publicité", paragraphs: ["À la date de la présente version, Khaos Theory n’utilise aucun outil de mesure d’audience ou de publicité comportementale tel que Google Analytics, Meta Pixel, TikTok Pixel ou Hotjar.", "Aucun traceur publicitaire n’est actuellement intégré par Khaos Theory au site."] },
    { heading: "6. Préférence de langue", paragraphs: ["La préférence de langue n’est actuellement pas enregistrée dans un cookie ou dans le stockage local du navigateur.", "La version française ou anglaise du site est déterminée par l’URL consultée."] },
    { heading: "7. Consentement", paragraphs: ["Les technologies actuellement utilisées par Khaos Theory sont limitées aux fonctionnalités nécessaires ou directement liées aux services demandés par l’utilisateur, notamment le fonctionnement du panier et du processus de paiement.", "Khaos Theory n’affiche donc pas actuellement de bannière destinée au consentement à des traceurs publicitaires ou de mesure d’audience qu’il n’utilise pas.", "Si des technologies non essentielles nécessitant un consentement préalable sont ajoutées ultérieurement, Khaos Theory mettra en place le mécanisme d’information et de consentement approprié avant leur activation."] },
    { heading: "8. Gestion du stockage local", paragraphs: ["L’utilisateur peut supprimer les données enregistrées localement par son navigateur au moyen des paramètres de celui-ci.", "La suppression des données du panier peut entraîner la perte du contenu du panier enregistré sur l’appareil."] },
    { heading: "9. Informations complémentaires", paragraphs: ["Pour plus d’informations sur le traitement des données personnelles, l’utilisateur peut consulter la Politique de confidentialité de Khaos Theory :\n/fr/privacy", "Pour toute question :\ncontact@khaostheoryparis.com"] },
    { heading: "10. Modification", paragraphs: ["Khaos Theory peut modifier la présente page afin de tenir compte de l’évolution du site, des technologies utilisées ou de la réglementation applicable.", "La version publiée sur le site est la version applicable au moment de sa consultation."] },
  ],
};

const en: CookiesDocument = {
  title: "COOKIES AND SIMILAR TECHNOLOGIES — KHAOS THEORY",
  version: "Version: September 2026",
  sections: [
    { heading: "1. Purpose", paragraphs: ["This page describes the storage technologies and services that may be used when browsing khaostheoryparis.com."] },
    { heading: "2. Cart", paragraphs: ["Khaos Theory uses local browser storage (localStorage) to retain the cart contents and allow the cart to operate across the site’s pages.", "The key used by the application is khaosTheoryCart.", "This storage contains only the information needed for cart operation, such as selected products, sizes, quantities and associated information."] },
    { heading: "3. Payment", paragraphs: ["When the user enters the payment process, the site uses Stripe.js and Stripe Elements to provide the functionality needed for secure payment.", "Stripe may use technical technologies necessary for the operation, security and fraud prevention of its service in accordance with its own terms and policies.", "Khaos Theory does not store card data in its application databases."] },
    { heading: "4. Font", paragraphs: ["The site currently uses Google Fonts to load the Alumni Sans font.", "The browser may therefore connect to Google infrastructure when this resource is loaded."] },
    { heading: "5. Audience measurement and advertising", paragraphs: ["As of this version, Khaos Theory does not use any audience measurement or behavioural advertising tool such as Google Analytics, Meta Pixel, TikTok Pixel or Hotjar.", "No advertising tracker is currently integrated by Khaos Theory into the site."] },
    { heading: "6. Language preference", paragraphs: ["The language preference is not currently stored in a cookie or in local browser storage.", "The French or English version of the site is determined by the URL being viewed."] },
    { heading: "7. Consent", paragraphs: ["The technologies currently used by Khaos Theory are limited to features necessary for, or directly related to, services requested by the user, including cart operation and the payment process.", "Khaos Theory therefore does not currently display a banner for consent to advertising or audience measurement trackers that it does not use.", "If non-essential technologies requiring prior consent are added in the future, Khaos Theory will put in place the appropriate information and consent mechanism before activating them."] },
    { heading: "8. Managing local storage", paragraphs: ["The user can delete data stored locally by the browser through the browser’s settings.", "Deleting cart data may result in losing the cart contents saved on the device."] },
    { heading: "9. Further information", paragraphs: ["For more information about the processing of personal data, users may consult Khaos Theory’s Privacy Policy:\n/en/privacy", "For any question:\ncontact@khaostheoryparis.com"] },
    { heading: "10. Changes", paragraphs: ["Khaos Theory may amend this page to reflect changes to the site, the technologies used or applicable regulations.", "The version published on the site is the version applicable when it is consulted."] },
  ],
};

export const cookiesDocuments: Record<Locale, CookiesDocument> = { fr, en };
