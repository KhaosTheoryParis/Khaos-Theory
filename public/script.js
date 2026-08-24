const collectionMenu = document.querySelector(".collection-menu");
const collectionToggle = document.querySelector(".collection-toggle");
const cartMenu = document.querySelector(".cart-menu");
const cartToggle = document.querySelector(".cart-toggle");
const cartSubmenu = document.querySelector(".cart-submenu");

const products = {
    geometry: { name: "Geometry", price: 275, description: "A Khaos Theory ring with a graphic, geometric profile.", images: ["Photos/Rings/KTR-GEOMETRY-001.jpg"] },
    "carved-cross": { name: "Karved Kross", price: 200, description: "A Khaos Theory ring defined by a carved cross motif.", images: ["Photos/Rings/KTR-KARVED%20KROSS-001.jpg"] },
    "hollow-cross": { name: "Hollow Kross", price: 200, description: "A Khaos Theory ring with a hollow cross detail.", images: ["Photos/Rings/KTR-HOLLOW%20KROSS-001.jpg"] },
    "signet-corner": { name: "Signet Korner", price: 200, description: "A Khaos Theory signet ring with an angular corner profile.", images: ["Photos/Rings/KTR-SIGNET%20KORNER-001.jpg", "Photos/Rings/KTR-SIGNET%20KORNER-002.jpg"] },
    "damaged-ring-i": { name: "Damaged Ring I", price: 150, description: "A Khaos Theory ring with a deliberately textured profile.", images: ["Photos/Rings/KTR-DAMAGED%20RING-001.jpg"] },
    "damaged-ring-ii": { name: "Damaged Ring II", price: 150, description: "A second Khaos Theory Damaged Ring model with its own sculptural profile.", images: ["Photos/Rings/KTR-DAMAGED%20RING-002.jpg"] }
};

const ringSizes = [[48, "4.5"], [49, "5"], [50, "5.25"], [51, "5.5"], [52, "6"], [53, "6.5"], [54, "7"], [55, "7.25"], [56, "7.5"], [57, "8"], [58, "8.5"], [59, "8.75"], [60, "9"], [61, "9.5"], [62, "10"], [63, "10.25"], [64, "10.5"], [65, "11"], [66, "11.5"], [67, "12"], [68, "12.25"], [69, "12.5"], [70, "13"]];
const craftsmanshipNote = "Every items are made from .925 silver. Because every finish is completed by hand, details may vary, making each piece unique.";
const formatPrice = (price) => `${price} €`;
const readCart = () => { try { return JSON.parse(localStorage.getItem("khaosTheoryCart")) || []; } catch { return []; } };
const saveCart = (cart) => localStorage.setItem("khaosTheoryCart", JSON.stringify(cart));

const renderCart = () => {
    if (!cartSubmenu) return;
    const cart = readCart();
    const cartEmpty = cartSubmenu.querySelector(".cart-empty");
    const itemCount = cart.reduce((total, item) => total + item.quantity, 0);
    const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    let cartLines = cartSubmenu.querySelector(".cart-lines");

    if (!cartLines) {
        cartLines = document.createElement("div");
        cartLines.className = "cart-lines";
        cartEmpty.before(cartLines);
    }

    document.querySelectorAll(".cart-item-count").forEach((element) => element.textContent = `${itemCount} ${itemCount === 1 ? "ITEM" : "ITEMS"}`);

    if (!cart.length) {
        cartLines.innerHTML = "";
        cartEmpty.hidden = false;
        return;
    }

    cartEmpty.hidden = true;
    cartLines.innerHTML = `${cart.map((item) => `<div class="cart-line"><div><strong>${item.name}</strong><span>FR ${item.size} / US ${item.usSize} · ×${item.quantity}</span></div><div><span>${formatPrice(item.price * item.quantity)}</span><button type="button" class="cart-remove" data-cart-key="${item.key}" aria-label="Remove ${item.name}">×</button></div></div>`).join("")}<div class="cart-total"><span>TOTAL</span><strong>${formatPrice(total)}</strong></div><a class="cart-checkout-link" href="checkout.html">REVIEW AND CHECKOUT</a>`;
};

const closeMenus = () => {
    collectionMenu?.classList.remove("is-open");
    collectionToggle?.setAttribute("aria-expanded", "false");
    cartMenu?.classList.remove("is-open");
    cartToggle?.setAttribute("aria-expanded", "false");
};

collectionToggle?.addEventListener("click", () => {
    const isOpen = collectionMenu.classList.toggle("is-open");
    collectionToggle.setAttribute("aria-expanded", isOpen);
    cartMenu?.classList.remove("is-open");
    cartToggle?.setAttribute("aria-expanded", "false");
});

cartToggle?.addEventListener("click", () => {
    const isOpen = cartMenu.classList.toggle("is-open");
    cartToggle.setAttribute("aria-expanded", isOpen);
    collectionMenu?.classList.remove("is-open");
    collectionToggle?.setAttribute("aria-expanded", "false");
});

document.addEventListener("click", (event) => {
    if (collectionMenu?.contains(event.target) || cartMenu?.contains(event.target)) return;
    closeMenus();
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeMenus();
    collectionToggle?.focus();
});

document.addEventListener("click", (event) => {
    const removeButton = event.target.closest(".cart-remove");
    if (!removeButton) return;
    saveCart(readCart().filter((item) => item.key !== removeButton.dataset.cartKey));
    renderCart();
});

const productDetail = document.querySelector("#product-detail");

if (productDetail) {
    const productId = new URLSearchParams(window.location.search).get("item");
    const product = products[productId];

    if (!product) {
        productDetail.innerHTML = "<div class=\"section-title\">Product unavailable</div>";
    } else {
        document.title = `${product.name} — Khaos Theory`;
        productDetail.innerHTML = `<div class="product-gallery"><div class="product-image-frame"><img class="product-main-image is-visible" src="${product.images[0]}" alt="Khaos Theory ${product.name} ring"><button class="gallery-arrow gallery-arrow-previous" type="button" aria-label="Previous photo">←</button><button class="gallery-arrow gallery-arrow-next" type="button" aria-label="Next photo">→</button><span class="gallery-counter">1 / ${product.images.length}</span></div></div><div class="product-information"><p class="product-name">${product.name}</p><p class="product-price">${formatPrice(product.price)}</p><p class="product-description">${product.description}</p><p class="product-craftsmanship">${craftsmanshipNote}</p><form class="add-to-cart-form" data-product-id="${productId}"><label for="ring-size">Size</label><select id="ring-size" name="size" required>${ringSizes.map(([fr, us]) => `<option value="${fr}" data-us-size="${us}">FR ${fr} — US ${us}</option>`).join("")}</select><label for="ring-quantity">Quantity</label><select id="ring-quantity" name="quantity" required>${[1, 2, 3, 4, 5].map((quantity) => `<option value="${quantity}">${quantity}</option>`).join("")}</select><button class="add-to-cart-button" type="submit">ADD TO KART</button><p class="add-to-cart-confirmation" aria-live="polite"></p></form><p class="size-note">French and US size equivalents are indicative.</p></div>`;

        let activeImage = 0;
        const mainImage = productDetail.querySelector(".product-main-image");
        const galleryCounter = productDetail.querySelector(".gallery-counter");
        const galleryArrows = productDetail.querySelectorAll(".gallery-arrow");

        const updateGallery = () => {
            mainImage.classList.remove("is-visible");
            window.setTimeout(() => {
                mainImage.src = product.images[activeImage];
                mainImage.alt = `Khaos Theory ${product.name} ring — photo ${activeImage + 1}`;
                mainImage.classList.add("is-visible");
                galleryCounter.textContent = `${activeImage + 1} / ${product.images.length}`;
            }, 140);
        };

        galleryArrows.forEach((arrow) => {
            if (product.images.length === 1) arrow.hidden = true;
            arrow.addEventListener("click", () => {
                activeImage = (activeImage + (arrow.classList.contains("gallery-arrow-next") ? 1 : -1) + product.images.length) % product.images.length;
                updateGallery();
            });
        });
    }
}

document.addEventListener("submit", (event) => {
    const form = event.target.closest(".add-to-cart-form");
    if (!form) return;
    event.preventDefault();
    const product = products[form.dataset.productId];
    const size = form.elements.size.value;
    const usSize = form.elements.size.selectedOptions[0].dataset.usSize;
    const quantity = Number(form.elements.quantity.value);
    const key = `${form.dataset.productId}-${size}`;
    const cart = readCart();
    const existingItem = cart.find((item) => item.key === key);

    if (existingItem) existingItem.quantity += quantity;
    else cart.push({ key, name: product.name, price: product.price, size, usSize, quantity });

    saveCart(cart);
    renderCart();
    cartMenu?.classList.add("is-open");
    cartToggle?.setAttribute("aria-expanded", "true");
    form.querySelector(".add-to-cart-confirmation").textContent = "Added to your kart.";
});

renderCart();

const checkoutSummary = document.querySelector("#checkout-summary");

if (checkoutSummary) {
    const cart = readCart();
    const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

    if (!cart.length) {
        checkoutSummary.innerHTML = `<div class="section-title">My Kart</div><p class="checkout-empty">Your kart is empty.</p><a class="continue-shopping" href="rings.html">CONTINUE SHOPPING</a>`;
    } else {
        checkoutSummary.innerHTML = `<div class="section-title">Order summary</div><div class="checkout-lines">${cart.map((item) => `<div class="checkout-line"><div><strong>${item.name}</strong><span>FR ${item.size} / US ${item.usSize} · Quantity ${item.quantity}</span></div><span>${formatPrice(item.price * item.quantity)}</span></div>`).join("")}</div><div class="checkout-total"><span>TOTAL</span><strong>${formatPrice(total)}</strong></div><button class="stripe-checkout-button" type="button">PAY WITH STRIPE</button><p class="checkout-status" aria-live="polite"></p>`;

        checkoutSummary.querySelector(".stripe-checkout-button").addEventListener("click", async (event) => {
            const button = event.currentTarget;
            const status = checkoutSummary.querySelector(".checkout-status");
            button.disabled = true;
            status.textContent = "Redirecting to secure payment…";

            try {
                const response = await fetch("/api/create-checkout-session", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ items: cart.map((item) => ({ id: item.key.split("-").slice(0, -1).join("-"), size: item.size, quantity: item.quantity })) })
                });
                const session = await response.json();

                if (!response.ok || !session.url) throw new Error(session.error || "Unable to start payment.");
                window.location.href = session.url;
            } catch (error) {
                button.disabled = false;
                status.textContent = error.message;
            }
        });
    }
}
