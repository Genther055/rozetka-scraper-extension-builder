// Test recursive seller parser
function parseSellersFromAnyJson(obj, sellersMap = new Map()) {
    if (!obj || typeof obj !== 'object') return sellersMap;

    // 1. Build seller lookup table if present (e.g. obj.sellers = { "123": { "title": "Mini Shop" } })
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
    findSellerLookups(obj);

    // 2. Recursively find products
    function traverse(node) {
        if (!node || typeof node !== 'object') return;

        if (Array.isArray(node)) {
            for (const item of node) traverse(item);
            return;
        }

        const id = node.id || node.goods_id || node.goodsId || node.productId || node.sku;
        const prodId = id ? String(id) : '';
        const href = node.href || node.url || node.link || '';

        // Extract seller from direct object properties
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
            const cleaned = sellerName.trim();
            if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                if (prodId) sellersMap.set(prodId, cleaned);
                if (href) sellersMap.set(href.split('?')[0].replace(/\/+$/, ''), cleaned);
            }
        }

        for (const k of Object.keys(node)) {
            if (typeof node[k] === 'object') traverse(node[k]);
        }
    }

    traverse(obj);
    return sellersMap;
}

// Test with various Rozetka state structures
const testState1 = {
    goods: [
        { id: 617723771, title: "Sigma X-power", seller: { id: 45, title: "Mini Shop" } },
        { id: 517691374, title: "Sigma mobile", seller_id: 99 }
    ],
    sellers: {
        "99": { title: "Smart Hub" }
    }
};

const map = parseSellersFromAnyJson(testState1);
console.log('Parsed sellers:', Object.fromEntries(map));
