// TradeScout Main World Bridge (Runs directly in page execution context with 100% access to Angular Ivy memory, dataLayer & network responses)
(function() {
    if (window.__tradeScoutMainWorldInitialized) return;
    window.__tradeScoutMainWorldInitialized = true;

    console.log('[TradeScout MainWorld] Bridge initialized in page execution context.');

    const goodsMap = {};
    const sellerLookup = new Map();

    function cleanSeller(raw) {
        if (!raw) return '';
        let s = String(raw).trim();
        s = s.replace(/^(?:інтернет-магазин|магазин|продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
        s = s.replace(/\s*\([^)]*\).*$/, '');
        s = s.replace(/\s*\b\d+(?:[.,]\d+)?\s*(?:★|\%|\bтовар\w*|\bтов\w*).*$/, '');
        s = s.replace(/\s+\d+\s*$/, '');
        s = s.replace(/^[>›»\s—–:-]+|[>›»\s—–:-]+$/, '').trim();

        if (s.length > 3 && s === s.toUpperCase() && /^[A-Z0-9\s_-]+$/.test(s)) {
            s = s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
        }

        if (/^rozetka\b/i.test(s) || /^розетка\b/i.test(s)) {
            return 'Rozetka';
        }

        if (s.length >= 2 && s.length <= 80 && !/^\d+$/.test(s) && !/^(?:відгук|отзыв|купити|купить|додати|в кошик|немає|в наявності|новинка|акція|топ|скидка|знижка|уточнюйте|офіційний|официальный|інші продавці|другие продавцы|всі продавці|все продавцы)/i.test(s)) {
            return s;
        }
        return '';
    }

    function dispatchUpdate() {
        if (Object.keys(goodsMap).length > 0) {
            window.postMessage({
                type: 'TRADESCOUT_MAIN_GOODS_UPDATE',
                goods: { ...goodsMap }
            }, '*');
        }
    }

    function scanObject(node, depth = 0, visited = new Set()) {
        if (!node || typeof node !== 'object' || visited.has(node) || depth > 5) return;
        visited.add(node);

        // Build seller lookup table if node has sellers dictionary
        if (node.sellers && typeof node.sellers === 'object') {
            for (const [sId, sObj] of Object.entries(node.sellers)) {
                if (sObj && typeof sObj === 'object') {
                    const sName = sObj.title || sObj.name || sObj.seller_title || sObj.seller_name;
                    if (sName) sellerLookup.set(String(sId), cleanSeller(sName));
                } else if (typeof sObj === 'string') {
                    sellerLookup.set(String(sId), cleanSeller(sObj));
                }
            }
        }
        if (Array.isArray(node.filter_sellers)) {
            for (const sItem of node.filter_sellers) {
                if (sItem && sItem.id && sItem.title) {
                    sellerLookup.set(String(sItem.id), cleanSeller(sItem.title));
                }
            }
        }

        // Check if node is a genuine goods item
        const id = node.id || node.goods_id || node.goodsId || node.productId || node.sku;
        const hasGoodsSignature = id && (node.title || node.price || node.seller || node.seller_id || node.seller_title || node.sellers_count || node.href || node.url);
        
        if (hasGoodsSignature) {
            const prodId = String(id).trim();
            let sellerName = '';
            if (node.seller) {
                sellerName = typeof node.seller === 'string' ? node.seller : (node.seller.title || node.seller.name || node.seller.title_translit || node.seller.seller_name || node.seller.shop_name || '');
            }
            if (!sellerName) {
                sellerName = node.seller_title || node.sellerName || node.seller_name || node.merchant_name || node.merchant || node.shop_name || node.shopName || '';
            }
            if (!sellerName && node.seller_id && sellerLookup.has(String(node.seller_id))) {
                sellerName = sellerLookup.get(String(node.seller_id));
            }
            
            let sCount = node.sellers_count || node.sellersCount || node.sellers_amount || node.all_sellers_count;
            if (typeof sCount !== 'number' && (node.other_sellers_count || node.otherSellersCount)) {
                const oCount = node.other_sellers_count || node.otherSellersCount;
                if (typeof oCount === 'number') sCount = oCount + 1;
            }

            if (prodId) {
                const cleaned = cleanSeller(sellerName);
                if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                    if (!goodsMap[prodId]) goodsMap[prodId] = { id: prodId, seller: '', sellersCount: 1 };
                    goodsMap[prodId].seller = cleaned;
                }
                if (typeof sCount === 'number' && sCount > 0) {
                    if (!goodsMap[prodId]) goodsMap[prodId] = { id: prodId, seller: '', sellersCount: 1 };
                    goodsMap[prodId].sellersCount = sCount;
                }
            }
        }

        if (Array.isArray(node)) {
            for (const item of node) scanObject(item, depth + 1, visited);
        } else {
            for (const k of Object.keys(node)) {
                if (typeof node[k] === 'object' && node[k] !== null) {
                    scanObject(node[k], depth + 1, visited);
                }
            }
        }
    }

    function harvestAll() {
        // 1. Scan window.dataLayer
        try {
            if (Array.isArray(window.dataLayer)) {
                for (const entry of window.dataLayer) {
                    if (!entry) continue;
                    const items = entry.ecommerce?.impressions || entry.ecommerce?.items || (entry.ecommerce?.detail?.products) || [];
                    for (const it of items) {
                        if (it && (it.id || it.goods_id)) {
                            const id = String(it.id || it.goods_id).trim();
                            const seller = it.seller || it.affiliation || it.seller_title || it.brand || '';
                            const cleaned = cleanSeller(seller);
                            if (id && cleaned && cleaned.toLowerCase() !== 'rozetka') {
                                if (!goodsMap[id]) goodsMap[id] = { id, seller: '', sellersCount: 1 };
                                goodsMap[id].seller = cleaned;
                            }
                        }
                    }
                }
            }
        } catch (_) {}

        // 2. Scan DOM elements for __ngContext__ and Angular component instances
        try {
            const tiles = document.querySelectorAll(`
                rz-catalog-tile, rz-product-tile, app-goods-tile-default, .goods-tile, 
                li.catalog-grid__cell, [data-goods-id], rz-goods-seller, rz-product, 
                article, rz-grid > *, ul.catalog-grid > li, .catalog-grid > div
            `);

            for (const tile of tiles) {
                const directObjs = [tile.goods, tile.item, tile.product, tile.data, tile.dataGoods, tile.__goods];
                for (const obj of directObjs) {
                    if (obj) scanObject(obj, 0);
                }

                if (tile.__ngContext__) {
                    const ctx = Array.isArray(tile.__ngContext__) ? tile.__ngContext__ : [tile.__ngContext__];
                    for (const entry of ctx) {
                        if (entry) scanObject(entry, 0);
                    }
                }

                if (window.ng && window.ng.getComponent) {
                    try {
                        const comp = window.ng.getComponent(tile);
                        if (comp) scanObject(comp, 0);
                    } catch (_) {}
                }
            }
        } catch (_) {}

        dispatchUpdate();
    }

    // Intercept network requests (fetch & XHR) in main world to capture all live Rozetka JSON responses
    try {
        const origFetch = window.fetch;
        if (origFetch) {
            window.fetch = async function(...args) {
                const response = await origFetch.apply(this, args);
                try {
                    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                    if (url && (url.includes('rozetka.com.ua') || url.includes('/api/')) && 
                        (url.includes('goods') || url.includes('catalog') || url.includes('search') || url.includes('details') || url.includes('get-price'))) {
                        const clone = response.clone();
                        clone.json().then(data => {
                            if (data) {
                                scanObject(data, 0);
                                dispatchUpdate();
                                window.postMessage({
                                    type: 'TRADESCOUT_NETWORK_DATA',
                                    data: data
                                }, '*');
                            }
                        }).catch(() => {});
                    }
                } catch (_) {}
                return response;
            };
        }

        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this.__tradescout_url = url;
            return origOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function(...args) {
            this.addEventListener('load', function() {
                try {
                    const url = this.__tradescout_url || '';
                    if (url && (url.includes('rozetka.com.ua') || url.includes('/api/')) && 
                        (url.includes('goods') || url.includes('catalog') || url.includes('search') || url.includes('details') || url.includes('get-price'))) {
                        const text = this.responseText;
                        if (text && (text.startsWith('{') || text.startsWith('['))) {
                            const data = JSON.parse(text);
                            scanObject(data, 0);
                            dispatchUpdate();
                            window.postMessage({
                                type: 'TRADESCOUT_NETWORK_DATA',
                                data: data
                            }, '*');
                        }
                    }
                } catch (_) {}
            });
            return origSend.apply(this, args);
        };
    } catch (_) {}

    // Event-driven & periodic harvesting
    window.addEventListener('tradescout_request_main_harvest', harvestAll);
    setInterval(harvestAll, 1000);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', harvestAll);
    } else {
        harvestAll();
    }
})();
