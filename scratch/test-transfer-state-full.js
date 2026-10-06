function cleanSellerName(raw) {
    if (!raw) return '';
    let text = String(raw).trim();
    text = text.replace(/^(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|магазин|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
    const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0 && !/^(?:продавець(?:\s+товару)?|продавец|seller|магазин|merchant|від\s+продавця|от\s+продавца)\s*:?$/i.test(l));
    if (lines.length === 0) return '';
    let name = lines[0];
    name = name.replace(/\s*\([^)]*\).*$/, '');
    name = name.replace(/\s*\b\d+(?:[.,]\d+)?\s*(?:★|\%|\bтовар\w*|\bтов\w*).*$/, '');
    name = name.replace(/\s+\d+\s*$/, '');
    name = name.replace(/^(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|магазин|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
    name = name.replace(/^[>›»\s]+|[>›»\s]+$/, '').trim();

    if (name.length > 3 && name === name.toUpperCase() && !/^\d+$/.test(name)) {
        name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    }

    if (name.length >= 2 && name.length <= 80 && !/^\d+$/.test(name) && !/^(?:відгук|отзыв|купити|купить|додати|в кошик|немає|в наявності|новинка|акція|топ|скидка|знижка|уточнюйте|офіційний|официальный|інші продавці|другие продавцы)/i.test(name)) {
        return name;
    }
    return '';
}

function unescapeAngularState(str) {
    if (!str) return '';
    return str
        .replace(/&q;/g, '"')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&a;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&l;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&g;/g, '>')
        .replace(/&s;/g, "'");
}

function parseSellersFromAnyJson(obj, sellersMap = new Map(), sellersCountMap = new Map()) {
    if (!obj || typeof obj !== 'object') return;

    // 1. Build seller lookup table
    const sellerLookup = new Map();
    function findSellerLookups(node) {
        if (!node || typeof node !== 'object') return;
        if (node.sellers && typeof node.sellers === 'object') {
            for (const [sId, sObj] of Object.entries(node.sellers)) {
                if (sObj && typeof sObj === 'object') {
                    const sName = sObj.title || sObj.name || sObj.seller_title || sObj.seller_name;
                    if (sName) sellerLookup.set(String(sId), String(sName).trim());
                } else if (typeof sObj === 'string') {
                    sellerLookup.set(String(sId), sObj.trim());
                }
            }
        }
        for (const k of Object.keys(node)) {
            if (typeof node[k] === 'object') findSellerLookups(node[k]);
        }
    }
    try { findSellerLookups(obj); } catch (_) {}

    // 2. Traverse tree
    function traverse(node) {
        if (!node || typeof node !== 'object') return;

        if (Array.isArray(node)) {
            for (const item of node) traverse(item);
            return;
        }

        const id = node.id || node.goods_id || node.goodsId || node.productId || node.sku;
        const prodId = id ? String(id) : '';
        const href = node.href || node.url || node.link || '';

        let sellerName = '';
        if (node.seller) {
            if (typeof node.seller === 'string') sellerName = node.seller;
            else if (typeof node.seller === 'object') {
                sellerName = node.seller.title || node.seller.name || node.seller.title_translit || node.seller.seller_name || '';
            }
        }
        if (!sellerName) {
            sellerName = node.seller_title || node.sellerName || node.seller_name || node.merchant_name || node.merchant || node.shop_name || node.shopName || '';
        }
        if (!sellerName && node.seller_id && sellerLookup.has(String(node.seller_id))) {
            sellerName = sellerLookup.get(String(node.seller_id));
        }

        if (sellerName && typeof sellerName === 'string') {
            const cleaned = cleanSellerName(sellerName);
            if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                if (prodId) sellersMap.set(prodId, cleaned);
                if (href) sellersMap.set(href.split('?')[0].replace(/\/+$/, ''), cleaned);
            }
        }

        const sCount = node.sellers_count || node.sellersCount || node.other_sellers_count;
        if (typeof sCount === 'number' && sCount > 0 && prodId) {
            sellersCountMap.set(prodId, sCount);
        }

        for (const k of Object.keys(node)) {
            if (typeof node[k] === 'object') traverse(node[k]);
        }
    }

    try { traverse(obj); } catch (_) {}
}

// Full test with mock TransferState
const mockTransferState = `
{
  &q;G.https://common-api.rozetka.com.ua/v1/api/catalog/search?category_id=387969&q;: {
    &q;data&q;: {
      &q;goods&q;: [
        { &q;id&q;: 611141153, &q;seller&q;: { &q;id&q;: 45, &q;title&q;: &q;Мій компʼютер&q; }, &q;sellers_count&q;: 4 },
        { &q;id&q;: 620223395, &q;seller_id&q;: 88, &q;sellers_count&q;: 2 },
        { &q;id&q;: 623552327, &q;seller&q;: &q;THANOS&q; }
      ],
      &q;sellers&q;: {
        &q;88&q;: { &q;title&q;: &q;TutTehno&q; }
      }
    }
  }
}
`;

const sellersMap = new Map();
const countMap = new Map();

const unescaped = unescapeAngularState(mockTransferState);
const data = JSON.parse(unescaped);
parseSellersFromAnyJson(data, sellersMap, countMap);

console.log('Sellers parsed:', Object.fromEntries(sellersMap));
console.log('Sellers counts parsed:', Object.fromEntries(countMap));
