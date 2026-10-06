// Scratch test showing Main World bridge mechanism
const mainWorldScriptCode = `
(function() {
    if (window.__tradeScoutMainBridge) return;
    window.__tradeScoutMainBridge = true;

    function harvestAllAngularGoods() {
        const goodsMap = {};
        
        // 1. Traverse all DOM elements with __ngContext__
        const allElements = document.querySelectorAll('rz-catalog-tile, rz-product-tile, app-goods-tile-default, .goods-tile, [data-goods-id], rz-product, body *');
        for (const el of allElements) {
            try {
                if (el.__ngContext__) {
                    const ctx = Array.isArray(el.__ngContext__) ? el.__ngContext__ : [el.__ngContext__];
                    for (const item of ctx) {
                        if (!item || typeof item !== 'object') continue;
                        
                        // Check direct properties or item.goods / item.product / item.tile
                        const candidates = [item, item.goods, item.product, item.tile, item.item, item.data];
                        for (const c of candidates) {
                            if (c && typeof c === 'object' && (c.id || c.goods_id || c.goodsId)) {
                                const id = String(c.id || c.goods_id || c.goodsId);
                                let sellerName = '';
                                if (c.seller) {
                                    sellerName = typeof c.seller === 'string' ? c.seller : (c.seller.title || c.seller.name || c.seller.title_translit || c.seller.seller_name || '');
                                }
                                if (!sellerName) {
                                    sellerName = c.seller_title || c.sellerName || c.seller_name || c.merchant_name || '';
                                }
                                const sCount = c.sellers_count || c.sellersCount || (c.other_sellers_count ? c.other_sellers_count + 1 : 1);
                                if (id && (sellerName || sCount)) {
                                    goodsMap[id] = {
                                        id,
                                        seller: sellerName,
                                        sellersCount: sCount || 1,
                                        price: c.price,
                                        oldPrice: c.old_price,
                                        rating: c.rating || c.comments_mark,
                                        reviews: c.comments_amount
                                    };
                                }
                            }
                        }
                    }
                }
            } catch (_) {}
        }

        // 2. Also check dataLayer
        if (Array.isArray(window.dataLayer)) {
            for (const entry of window.dataLayer) {
                if (entry && entry.ecommerce) {
                    const items = entry.ecommerce.impressions || entry.ecommerce.items || (entry.ecommerce.detail ? [entry.ecommerce.detail] : []);
                    for (const it of items) {
                        if (it && it.id) {
                            const id = String(it.id);
                            if (it.seller || it.brand || it.affiliation) {
                                if (!goodsMap[id]) goodsMap[id] = { id };
                                goodsMap[id].seller = goodsMap[id].seller || it.seller || it.affiliation || '';
                            }
                        }
                    }
                }
            }
        }

        // Send to content script
        window.postMessage({
            type: 'TRADESCOUT_MAIN_GOODS_UPDATE',
            goods: goodsMap
        }, '*');
    }

    // Intercept fetch/XHR to capture Rozetka catalog responses
    const origFetch = window.fetch;
    window.fetch = async function(...args) {
        const res = await origFetch.apply(this, args);
        try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (url.includes('rozetka.com.ua') && (url.includes('goods') || url.includes('catalog') || url.includes('search'))) {
                const clone = res.clone();
                clone.json().then(data => {
                    if (data) {
                        window.postMessage({
                            type: 'TRADESCOUT_NETWORK_DATA',
                            data: data
                        }, '*');
                    }
                }).catch(() => {});
            }
        } catch (_) {}
        return res;
    };

    // Run harvest on DOM mutations or requests
    setInterval(harvestAllAngularGoods, 1000);
    window.addEventListener('tradescout_request_main_harvest', harvestAllAngularGoods);
    harvestAllAngularGoods();
})();
`;

console.log("Main world injection script length:", mainWorldScriptCode.length);
