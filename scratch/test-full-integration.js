const { JSDOM } = require('jsdom');

function cleanSellerName(raw) {
    if (!raw) return '';
    let text = String(raw).trim();
    text = text.replace(/^(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|магазин|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
    const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0 && !/^(?:продавець(?:\s+товару)?|продавец|seller|магазин|merchant|від\s+продавця|от\s+продавца)\s*:?$/i.test(l));
    if (lines.length === 0) return '';
    let name = lines[0];
    // Strip any parentheses content e.g. " (24)", " (24 товари)", " (95%)", " (офіційний дистриб'ютор)"
    name = name.replace(/\s*\([^)]*\).*$/, '');
    name = name.replace(/\s*\b\d+(?:[.,]\d+)?\s*(?:★|\%|\bтовар\w*|\bтов\w*).*$/, '');
    name = name.replace(/\s+\d+\s*$/, '');
    name = name.replace(/^(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|магазин|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
    name = name.replace(/^[>›»\s]+|[>›»\s]+$/, '').trim();

    // Normalize all-caps names e.g. "QINETIQ" -> "Qinetiq", "THANOS" -> "Thanos"
    if (name.length > 3 && name === name.toUpperCase() && !/^\d+$/.test(name)) {
        name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    }

    if (name.length >= 2 && name.length <= 80 && !/^\d+$/.test(name) && !/^(?:відгук|отзыв|купити|купить|додати|в кошик|немає|в наявності|новинка|акція|топ|скидка|знижка|уточнюйте|офіційний|официальный|інші продавці|другие продавцы)/i.test(name)) {
        return name;
    }
    return '';
}

function extractSellerFromDom(domRoot) {
    const scopes = [domRoot];
    const sellerLinkSelectors = [
        'a[href*="/seller/"]',
        'a[href*="/merchant/"]',
        'a[href*="seller="]',
        'a[href*="seller_id="]',
        'a[href*="merchant="]',
        'a[apprzroute][href*="/seller/"]',
        'a.goods-tile__seller-link',
        'a.goods-tile__seller-name',
        'a.product-seller__title',
        'a.product-seller__link',
        'a.product-seller__name',
        'rz-goods-seller a',
        'rz-product-seller a',
        'rz-seller a',
        'rz-seller-title a',
        'rz-seller-title-feedback a',
        'rz-seller-carriage a',
        '.product-seller a',
        '.goods-tile__seller a',
        '[data-testid*="seller"] a',
        '[data-testid*="merchant"] a'
    ];

    for (const scope of scopes) {
        for (const sel of sellerLinkSelectors) {
            const links = scope.querySelectorAll(sel);
            for (const a of links) {
                const innerSpan = a.querySelector('.text-inline, [class*="title"], [class*="name"], span, p, b, strong');
                const txt = (innerSpan ? innerSpan.textContent : '') || a.textContent || a.getAttribute('title') || '';
                const s = cleanSellerName(txt);
                if (s && s.toLowerCase() !== 'rozetka') return s;

                const img = a.querySelector('img[alt], img[title]');
                if (img) {
                    const imgName = cleanSellerName(img.getAttribute('alt') || img.getAttribute('title'));
                    if (imgName && imgName.toLowerCase() !== 'rozetka') return imgName;
                }

                const href = a.getAttribute('href') || '';
                const m = href.match(/\/(?:seller|merchant)\/([^\/?#]+)/i) || href.match(/[?&](?:seller|merchant|seller_id)=([^&#]+)/i);
                if (m && m[1] && m[1].toLowerCase() !== 'rozetka' && !/^\d+$/.test(m[1])) {
                    const slugName = decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
                    if (slugName.length >= 2) return cleanSellerName(slugName);
                }
            }
        }
    }

    const sellerContainerSelectors = [
        'rz-seller-carriage',
        'rz-seller-title',
        'rz-seller-title-feedback',
        'rz-goods-seller',
        'rz-product-seller',
        'rz-seller',
        '.product-seller',
        '.product-seller__title',
        '.product-seller__name',
        '.product-seller__shop',
        '.goods-tile__seller',
        '.goods-tile__seller-name',
        '.goods-tile__seller-title',
        '.goods-tile__seller-link',
        '.goods-tile__shop',
        '.goods-tile__merchant',
        '.goods-tile__availability',
        '.goods-tile__delivery',
        '[class*="goods-tile__seller"]',
        '[class*="product-seller"]',
        '[class*="product__seller"]',
        '[class*="seller-name"]',
        '[class*="seller-title"]',
        '[class*="shop-name"]',
        '.seller-title',
        '.seller-name',
        '.shop-name',
        '[data-testid*="seller"]',
        '[data-testid*="merchant"]',
        '[class*="merchant"]'
    ];

    for (const scope of scopes) {
        for (const sel of sellerContainerSelectors) {
            const elements = scope.querySelectorAll(sel);
            for (const el of elements) {
                const s = cleanSellerName(el.textContent || el.getAttribute('title') || '');
                if (s && s.toLowerCase() !== 'rozetka') return s;

                const img = el.querySelector('img[alt], img[title]');
                if (img) {
                    const imgName = cleanSellerName(img.getAttribute('alt') || img.getAttribute('title'));
                    if (imgName && imgName.toLowerCase() !== 'rozetka') return imgName;
                }
            }
        }
    }

    // Deep text scan
    for (const scope of scopes) {
        const fullText = scope.textContent || '';
        const m1 = fullText.match(/(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|магазин|від\s+продавця|от\s+продавца|доставка\s+від|доставка\s+от|відправник|отправитель)\s*:?\s*([^\n\r\t,;]+)/i);
        if (m1 && m1[1]) {
            const s = cleanSellerName(m1[1]);
            if (s && s.toLowerCase() !== 'rozetka') return s;
        }
    }

    return 'Rozetka';
}

// Test cases
const tests = [
    {
        name: "User provided link - Мій компʼютер",
        html: `<div class="product-seller">
            <a apprzroute="" class="color-black hover:color-green d-flex justify-between" href="https://rozetka.com.ua/ua/seller/mj-kompyuter/" rel="noopener nofollow">
                <span _ngcontent-rz-client-c3820496882="" class="text-inline d-block">Мій компʼютер</span>
                <svg width="24" height="24" class="-rotate-90 fill-black-60 shrink-0"><use rzIconName="icon-chevron-down" href="/h-a9485b90/assets/sprite/sprite.svg#icon-chevron-down"></use></svg>
            </a>
        </div>`,
        expected: "Мій компʼютер"
    },
    {
        name: "Rozetka vendor",
        html: `<div class="product-seller">
            <div class="d-flex text-base">
                <span class="pe-1 color-black-60">Продавець:</span>
                <span class="shrink-0"><img alt="Rozetka" src="..."></span>
            </div>
        </div>`,
        expected: "Rozetka"
    },
    {
        name: "Other seller - TutTehno",
        html: `<li class="border-1"><a href="https://rozetka.com.ua/ua/620223395/p620223395/"><span class="color-black-60">Продавець:</span> TutTehno</a></li>`,
        expected: "TutTehno"
    },
    {
        name: "Other seller - THANOS (all-caps)",
        html: `<li class="border-1"><a href="https://rozetka.com.ua/ua/623552327/p623552327/"><span class="color-black-60">Продавець:</span> THANOS</a></li>`,
        expected: "Thanos"
    },
    {
        name: "Other seller - Ю_Мобі",
        html: `<li class="border-1"><a href="https://rozetka.com.ua/ua/623675150/p623675150/"><span class="color-black-60">Продавець:</span> Ю_Мобі</a></li>`,
        expected: "Ю_Мобі"
    }
];

tests.forEach(t => {
    const dom = new JSDOM(t.html);
    const result = extractSellerFromDom(dom.window.document.body);
    const pass = result === t.expected;
    console.log(`${pass ? '✅' : '❌'} ${t.name}: result = "${result}" (expected "${t.expected}")`);
});
