// Test Main World Bridge integration with Content Script message handler
const pageSellerMap = new Map();
const pageSellersCountMap = new Map();

function cleanSellerName(raw) {
    if (!raw) return '';
    let text = String(raw).trim();
    text = text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#34;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\u00A0/g, ' ')
        .replace(/\u202F/g, ' ');

    text = text.replace(/^(?:інтернет-магазин|магазин|продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
    const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0 && !/^(?:інтернет-магазин|магазин|продавець(?:\s+товару)?|продавец|seller|merchant|від\s+продавця|от\s+продавца)\s*:?$/i.test(l));
    if (lines.length === 0) return '';
    let name = lines[0];

    name = name.replace(/\s*\([^)]*\).*$/, '');
    name = name.replace(/\s*\b\d+(?:[.,]\d+)?\s*(?:★|\%|\bтовар\w*|\bтов\w*).*$/, '');
    name = name.replace(/\s+\d+\s*$/, '');
    name = name.replace(/^(?:інтернет-магазин|магазин|продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
    name = name.replace(/^[>›»\s—–:-]+|[>›»\s—–:-]+$/, '').trim();

    if (name.length > 3 && name === name.toUpperCase() && /^[A-Z0-9\s_-]+$/.test(name)) {
        name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    }

    if (/^rozetka\b/i.test(name) || /^розетка\b/i.test(name)) {
        return 'Rozetka';
    }

    if (name.length >= 2 && name.length <= 80 && !/^\d+$/.test(name) && !/^(?:відгук|отзыв|купити|купить|додати|в кошик|немає|в наявності|новинка|акція|топ|скидка|знижка|уточнюйте|офіційний|официальный|інші продавці|другие продавцы|всі продавці|все продавцы)/i.test(name)) {
        return name;
    }
    return '';
}

// Simulate receiving message from Main World Bridge
function handleMainWorldMessage(eventData) {
    if (eventData.type === 'TRADESCOUT_MAIN_GOODS_UPDATE' && eventData.goods) {
        for (const [id, item] of Object.entries(eventData.goods)) {
            if (item && item.seller) {
                const cleaned = cleanSellerName(item.seller);
                if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                    pageSellerMap.set(String(id), cleaned);
                }
            }
            if (item && typeof item.sellersCount === 'number' && item.sellersCount > 0) {
                pageSellersCountMap.set(String(id), item.sellersCount);
            }
        }
    }
}

// Mock test
handleMainWorldMessage({
    type: 'TRADESCOUT_MAIN_GOODS_UPDATE',
    goods: {
        '459482989': { id: '459482989', seller: 'Berem&Store', sellersCount: 5 },
        '611141153': { id: '611141153', seller: 'Мій компʼютер', sellersCount: 3 },
        '620223395': { id: '620223395', seller: 'TutTehno', sellersCount: 2 },
        '623552327': { id: '623552327', seller: 'THANOS', sellersCount: 1 }
    }
});

console.log('pageSellerMap:', Object.fromEntries(pageSellerMap));
console.log('pageSellersCountMap:', Object.fromEntries(pageSellersCountMap));
