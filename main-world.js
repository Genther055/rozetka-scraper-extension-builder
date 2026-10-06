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
        s = s.replace(/\b(?:запитати\s+про\s+товар|спросить\s+о\s+товаре|усі\s+товари\s+продавця|все\s+товары\s+продавца|товари\s+продавця|товары\s+продавца|написати\s+продавцю|написать\s+продавцу|повідомити|сообщить|немає\s+в\s+наявності|нет\s+в\s+наличии|в\s+наявності|в\s+наличии|код:\s*\d+|арт(?:икул)?:\s*\d+)\b.*$/i, '');

        const lines = s.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0 && !/^(?:інтернет-магазин|магазин|продавець(?:\s+товару)?|продавец|seller|merchant|від\s+продавця|от\s+продавца)\s*:?$/i.test(l));
        if (lines.length === 0) return '';
        s = lines[0];

        s = s.replace(/\s*\b\d+(?:[.,]\d+)?\s*(?:\/\s*5|\s*★|\%|\bоцін\w*|\bоцен\w*|\bвідгук\w*|\bотзыв\w*|\bтовар\w*|\bтов\w*).*$/i, '');
        s = s.replace(/\s*\([^)]*\).*$/, '');
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

        // 3. Scan DOM on-page seller carriage & anchors
        try {
            const sellerAnchors = document.querySelectorAll(`
                rz-marketplace-link a, .seller-market-link a, [class*="seller-market-link"] a,
                rz-seller-carriage a[href*="/seller/"], .product-seller a[href*="/seller/"], rz-seller-title a, rz-seller-title-feedback a,
                rz-goods-seller a, [class*="product-seller"] a, a[href*="/seller/"], a[apprzroute][href*="/seller/"]
            `);
            for (const a of sellerAnchors) {
                let sName = cleanSeller(a.querySelector('.text-inline, span')?.innerText || a.innerText || a.textContent || '');
                if (!sName || sName.toLowerCase() === 'rozetka') {
                    const href = a.getAttribute('href') || '';
                    const m = href.match(/\/(?:seller|merchant)\/([^\/?#]+)/i);
                    if (m && m[1] && !/^\d+$/.test(m[1])) {
                        const slug = decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
                        if (slug.length >= 2) sName = cleanSeller(slug);
                    }
                }
                if (sName && sName.toLowerCase() !== 'rozetka') {
                    const pContainer = a.closest('rz-product, .product-about, rz-catalog-tile, rz-product-tile, .goods-tile, main, body');
                    const gIdEl = pContainer ? pContainer.querySelector('.g-id, [data-goods-id], [class*="goods-id"]') : null;
                    const rawGId = gIdEl?.getAttribute('data-goods-id') || gIdEl?.innerText?.trim();
                    const urlGId = window.location.href.match(/\/p(\d+)/i)?.[1];
                    const targetId = rawGId || urlGId;
                    if (targetId) {
                        if (!goodsMap[targetId]) goodsMap[targetId] = { id: targetId, seller: '', sellersCount: 1 };
                        goodsMap[targetId].seller = sName;
                    }
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

    // Direct Batch Fetch in Main World (100% same context as DevTools Console)
    async function handleBatchFetch(ids, reqId) {
        if (!Array.isArray(ids) || ids.length === 0) {
            window.postMessage({ type: 'TRADESCOUT_BATCH_SELLERS_RESULT', requestId: reqId, data: [] }, '*');
            document.dispatchEvent(new CustomEvent('tradescout_batch_sellers_done', { detail: { requestId: reqId, results: [] } }));
            return;
        }
        const collectedResults = [];
        try {
            for (let i = 0; i < ids.length; i += 50) {
                const chunk = ids.slice(i, i + 50);
                const idsChunk = chunk.join(',');
                try {
                    const res = await fetch(`https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=${idsChunk}`, {
                        credentials: 'include'
                    });
                    if (res.ok) {
                        const json = await res.json();
                        if (Array.isArray(json?.data)) {
                            for (const item of json.data) {
                                if (item && item.id) {
                                    collectedResults.push(item);
                                    const sTitle = item.seller?.title || item.seller?.name || item.seller_title || (typeof item.seller === 'string' ? item.seller : '');
                                    const cleaned = cleanSeller(sTitle);
                                    const finalSeller = cleaned || (item.seller?.id === 5 ? 'Rozetka' : (sTitle || 'Rozetka'));
                                    const sCount = item.sellers_count || (item.same_offers?.count ? item.same_offers.count + 1 : 1);
                                    goodsMap[String(item.id)] = {
                                        id: String(item.id),
                                        seller: finalSeller,
                                        sellersCount: sCount
                                    };
                                }
                            }
                        }
                    }
                } catch (_) {}
            }
            if (collectedResults.length > 0) {
                dispatchUpdate();
            }
            window.postMessage({
                type: 'TRADESCOUT_BATCH_SELLERS_RESULT',
                requestId: reqId,
                data: collectedResults
            }, '*');
            document.dispatchEvent(new CustomEvent('tradescout_batch_sellers_done', {
                detail: { requestId: reqId, results: collectedResults }
            }));
        } catch (_) {
            window.postMessage({
                type: 'TRADESCOUT_BATCH_SELLERS_RESULT',
                requestId: reqId,
                data: collectedResults
            }, '*');
            document.dispatchEvent(new CustomEvent('tradescout_batch_sellers_done', {
                detail: { requestId: reqId, results: collectedResults }
            }));
        }
    }

    // Multi-channel listeners to ensure 100% reception across isolated and main worlds
    window.addEventListener('message', (event) => {
        if (event.data?.type === 'TRADESCOUT_REQUEST_BATCH_SELLERS') {
            handleBatchFetch(event.data.productIds, event.data.requestId);
        }
    });

    document.addEventListener('tradescout_request_batch_sellers', (e) => {
        handleBatchFetch(e.detail?.productIds, e.detail?.requestId);
    });

    window.addEventListener('tradescout_batch_fetch_sellers', (e) => {
        handleBatchFetch(e.detail?.productIds, e.detail?.requestId);
    });

    setInterval(harvestAll, 1000);

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', harvestAll);
    } else {
        harvestAll();
    }
})();
