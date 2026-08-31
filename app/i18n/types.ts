export type TranslationDictionary = {
  brand: string;
  navigation: {
    collection: string;
    rings: string;
    bracelets: string;
    earrings: string;
    pendants: string;
    about: string;
    contact: string;
    cart: string;
  };
  language: {
    french: string;
    english: string;
    switcherLabel: string;
  };
  common: {
    home: string;
    legalNotice: string;
  };
  home: {
    constructionTitle: string;
    constructionMessage: string;
    constructionContact: string;
    tagline: string;
    scrollCue: string;
    collectionTitle: string;
    products: Record<HomeProductId, {
      name: string;
      imageAlt: string;
    }>;
  };
  categories: {
    rings: string;
    bracelets: string;
    earrings: string;
    pendants: string;
    comingSoon: string;
  };
  product: {
    size: string;
    quantity: string;
    addToKart: string;
    addedToKart: string;
    cartUnavailable: string;
    sizeNote: string;
    craftsmanshipFirstParagraph: string;
    craftsmanshipSecondParagraph: string;
    previousImage: string;
    nextImage: string;
    photo: string;
  };
  checkout: {
    yourKart: string;
    orderSummary: string;
    empty: string;
    continueShopping: string;
    size: string;
    quantity: string;
    total: string;
    remove: string;
    removeOne: string;
    addOne: string;
    quantityFor: string;
    confirmAndPay: string;
    redirecting: string;
    paymentError: string;
    invalidCart: string;
    unavailableItem: string;
    loading: string;
  };
  success: {
    title: string;
    message: string;
    returnHome: string;
  };
  about: {
    title: string;
    message: string;
  };
  contact: {
    title: string;
  };
  legal: {
    title: string;
    introduction: string;
    publisherHeading: string;
    publisherLabel: string;
    tradeNameLabel: string;
    addressLabel: string;
    sirenLabel: string;
    siretLabel: string;
    emailLabel: string;
    phoneLabel: string;
    publicationDirectorLabel: string;
    vatHeading: string;
    vatStatus: string;
    hostingHeading: string;
    hostingIntroduction: string;
    mediationHeading: string;
    mediationIntroduction: string;
    intellectualPropertyHeading: string;
    intellectualPropertyText: string;
    languageHeading: string;
    languageText: string;
  };
  metadata: {
    homeTitle: string;
    categoryTitle: string;
    productTitle: string;
    checkoutTitle: string;
    successTitle: string;
    aboutTitle: string;
    contactTitle: string;
    legalTitle: string;
  };
  footer: {
    city: string;
  };
};

export type PublicCategory = "rings" | "bracelets" | "earrings" | "pendants";

export type HomeProductId =
  | "geometry"
  | "carved-cross"
  | "hollow-cross"
  | "signet-corner"
  | "damaged-ring-i"
  | "damaged-ring-ii";
