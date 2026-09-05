// TradeScout Content Script v3.0 (Multi-Tab & Silent Background Scraper)
(function() {
    if (window.self !== window.top) return; // Skip iframes

    console.log('TradeScout Content Script v3.0 loaded in page:', window.location.href);

    let isTabScrapingActive = false;
    let currentSessionId = null;
    let currentTabId = null;
    let webhookEndpoint = 'https://rozetka-scraper-extension-builder.onrender.com/api/products';
    const sentLinks = new Set();

    // Helper to send messages safely to background service worker
    function sendTabMessage(msg) {
        try {
            chrome.runtime.sendMessage({ ...msg, tabId: currentTabId }, () => {
                if (chrome.runtime.lastError) {}
            });
        } catch (e) {}
    }

    // Extract human-readable category & session title from page
    function getPageMetadata() {
        let title = '';
        const h1 = document.querySelector('h1');
        if (h1 && h1.innerText && h1.innerText.trim().length > 2) {
            title = h1.innerText.trim();
        } else {
            const rawTitle = document.title || '';
            title = rawTitle.split(/[-–—|]/)[0].replace(/купити|в києві|україна|ціни|rozetka/gi, '').trim() || 'Каталог товарів';
        }

        let category = 'Загальна';
        const breadcrumbs = document.querySelectorAll('.breadcrumbs__link, .breadcrumbs__last, [class*="breadcrumbs"] a');
        if (breadcrumbs.length > 0) {
            const lastBc = breadcrumbs[breadcrumbs.length - 1];
            if (lastBc && lastBc.innerText) category = lastBc.innerText.trim();
        } else if (title) {
            category = title;
        }

        return { title, category };
    }

    function getEstimatedTotalFromPage() {
        const selectors = [
            '.catalog-heading__goods', 
            '.catalog-selection__label',
            '.goods-count',
            '[class*="heading__goods"]',
            '[class*="selection__label"]'
        ];
        for (const sel of selectors) {
            try {
                const el = document.querySelector(sel);
                if (el) {
                    const txt = el.textContent || '';
                    const match = txt.replace(/\s/g, '').match(/\d+/);
                    if (match) return parseInt(match[0], 10);
                }
            } catch (e) {}
        }
        return 120;
    }

    function isSponsoredTile(item) {
        const itemText = item.innerText || '';
        if (itemText.includes('Реклама') || itemText.includes('Спонсор') || itemText.includes('Рекламний')) {
            return true;
        }
        const spans = item.querySelectorAll('span, rz-tile-info, [class*="tile-info"], [class*="badge"]');
        for (const s of spans) {
            const txt = (s.innerText || '').trim().toLowerCase();
            if (txt === 'реклама' || txt.startsWith('реклама') || txt === 'спонсор') return true;
        }
        if (item.querySelector('.goods-tile__badge_type_promo, [class*="sponsored"], [class*="advertising"], .promo-tile')) {
            return true;
        }
        return false;
    }

    // Detail fetcher for specs and description
    async function fetchDetailForProduct(product) {
        if (!product.link) return;
        try {
            const charUrl = product.link.endsWith('/') ? `${product.link}characteristics/` : `${product.link}/characteristics/`;
            const res = await fetch(charUrl);
            if (!res.ok) return;
            const htmlText = await res.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlText, 'text/html');

            const descEl = doc.querySelector('.product-about__description, [class*="description-content"], .rz-product-description, [data-testid="description"]');
            if (descEl) {
                const cleanDesc = descEl.innerText.trim();
                if (cleanDesc && cleanDesc.length > 15) {
                    product.description = cleanDesc;
                }
            }

            const specsList = [];
            const specsMap = {};
            const dts = Array.from(doc.querySelectorAll('dt, .characteristics-full__label, [class*="characteristics"] [class*="label"], [class*="characteristics"] [class*="name"]'));
            dts.forEach(dt => {
                const dd = dt.nextElementSibling || dt.parentElement.querySelector('dd, .characteristics-full__value, [class*="characteristics"] [class*="value"]');
                const k = dt.innerText ? dt.innerText.trim() : '';
                const v = dd && dd.innerText ? dd.innerText.trim() : '';
                if (k && v && k.length > 1 && v.length > 0) {
                    specsMap[k] = v;
                    specsList.push(`${k}: ${v}`);
                }
            });

            if (specsList.length > 0) {
                product.specs = specsList.join('; ');
                product.detailedSpecsMap = specsMap;
            }

            const productIdMatch = product.link.match(/p(\d+)/);
            const productId = productIdMatch ? productIdMatch[1] : null;
            if (productId) {
                try {
                    const apiUrl = `https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=${productId}`;
                    const apiRes = await fetch(apiUrl);
                    if (apiRes.ok) {
                        const apiData = await apiRes.json();
                        const apiProduct = apiData.data?.[0];
                        if (apiProduct) {
                            if (apiProduct.seller && apiProduct.seller.title) {
                                product.seller = apiProduct.seller.title.trim();
                            }
                            if (apiProduct.old_price && apiProduct.old_price > 0) {
                                product.oldPrice = parseInt(apiProduct.old_price, 10) || product.oldPrice;
                                const actualPrice = apiProduct.price || product.price;
                                if (product.oldPrice > actualPrice) {
                                    product.discount = Math.round(((product.oldPrice - actualPrice) / product.oldPrice) * 100);
                                }
                            }
                            if (apiProduct.price && apiProduct.price > 0) {
                                product.price = parseInt(apiProduct.price, 10) || product.price;
                            }
                        }
                    }
                } catch (_) {}
            }
        } catch (_) {}
    }

    // Silent headless background scroll (Does not rely on requestAnimationFrame)
    async function silentBackgroundScroll() {
        try {
            const targetY = Math.max(0, document.body.scrollHeight - window.innerHeight);
            window.scrollTo({ top: targetY, behavior: 'auto' });
        } catch (_) {}
        await new Promise(r => setTimeout(r, 600));
    }

    function findShowMoreButton() {
        const selectors = [
            'rz-catalog-more button', 
            '.catalog-more button', 
            '.catalog-more__btn', 
            'button.show-more', 
            '.show-more', 
            'a.show-more', 
            '[class*="catalog-more"] button',
            '[class*="catalog-more"] a'
        ];
        for (const sel of selectors) {
            try {
                const btn = document.querySelector(sel);
                if (btn && !btn.disabled && !btn.classList.contains('button--loading')) {
                    return btn;
                }
            } catch (e) {}
        }

        const allElements = document.querySelectorAll('button, a, div[role="button"], span');
        for (const el of allElements) {
            const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
            if (txt === 'показати ще' || txt === 'показать еще' || txt.includes('показати ще') || txt.includes('показать еще') || txt === 'show more') {
                if (el.closest('.sidebar') || el.closest('.filter') || el.closest('.recently-viewed')) continue;
                if (el.disabled || el.classList.contains('button--loading')) continue;
                return el;
            }
        }
        return null;
    }

    async function sendWebhookPayload(payload) {
        return new Promise(resolve => {
            chrome.runtime.sendMessage({
                action: 'sendWebhook',
                webhookUrl: webhookEndpoint,
                tabId: currentTabId,
                payload: payload
            }, (res) => {
                resolve(res?.serverInfo || null);
            });
        });
    }

    async function scrapeCurrentDomItems(meta, pageIndex) {
        const tileSelectors = 'rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], div[class*="goods-tile"], article[class*="tile"]';
        let items = Array.from(document.querySelectorAll(tileSelectors)).filter(item => !item.closest('.recently-viewed'));
        
        if (items.length === 0) {
            const links = document.querySelectorAll('a[href*="/p/"], a[href*="/p-"]');
            items = Array.from(links).map(l => l.closest('li, div, rz-catalog-tile, article, section') || l).filter(Boolean);
        }

        if (items.length === 0) return [];

        const newItems = [];

        items.forEach((item) => {
            try {
                if (isSponsoredTile(item)) return;

                const linkTag = item.tagName === 'A' ? item : item.querySelector('a[href*="/p"], a[href]');
                if (!linkTag) return;
                
                const linkEl = linkTag.getAttribute('href');
                if (!linkEl) return;

                const titleEl = item.querySelector('a.tile-title, a.goods-tile__heading, .goods-tile__heading, .tile-title, [class*="heading"], [class*="title"]') || linkTag;
                const name = titleEl && titleEl.innerText ? titleEl.innerText.trim() : linkTag.innerText.trim();
                if (!name || name.length < 3) return;

                let link = linkEl.startsWith('http') ? linkEl : (linkEl.startsWith('/') ? `https://rozetka.com.ua${linkEl}` : `https://rozetka.com.ua/${linkEl}`);
                link = link.split('?')[0].split('#')[0];

                if (sentLinks.has(link)) return;

                const priceEl = item.querySelector('.goods-tile__price-value, .price');
                const priceText = priceEl && priceEl.innerText ? priceEl.innerText : '';
                const price = priceText ? parseInt(priceText.replace(/\D/g, ''), 10) || 0 : 0;

                const oldPriceEl = item.querySelector('.goods-tile__price.type_old, .goods-tile__price--old, .price--old');
                const oldPriceText = oldPriceEl && oldPriceEl.innerText ? oldPriceEl.innerText : '';
                const oldPrice = oldPriceText ? parseInt(oldPriceText.replace(/\D/g, ''), 10) || 0 : 0;
                const discount = (oldPrice && oldPrice > price) ? Math.round(((oldPrice - price) / oldPrice) * 100) : 0;

                const reviewsEl = item.querySelector('.rating-block-rating, [class*="rating"], [class*="comments"], .goods-tile__reviews-link');
                const reviewsText = reviewsEl && reviewsEl.innerText ? reviewsEl.innerText : '';
                const reviews = reviewsText ? parseInt(reviewsText.replace(/\D/g, ''), 10) || 0 : 0;

                const starsEl = item.querySelector('.stars_rating, [data-testid="stars-rating"], .goods-tile__stars svg');
                let rating = 5.0;
                if (starsEl) {
                    const style = starsEl.getAttribute('style') || '';
                    const match = style.match(/width:\s*calc\(([\d.]+)%/);
                    if (match) rating = parseFloat(((parseFloat(match[1]) || 100) / 20).toFixed(1));
                }

                const itemText = item.innerText || '';
                const inStock = !(item.classList.contains('tile-disabled') || itemText.includes('Немає в наявності'));

                const capacityMatch = name.match(/(\d+)\s*(?:mah|мАг)/i);
                const capacity = capacityMatch ? `${capacityMatch[1]} mAh` : '';
                const powerMatch = name.match(/(\d+(?:\.\d+)?)\s*W/i);
                const power = powerMatch ? `${powerMatch[1]}W` : '';
                const specs = [capacity, power].filter(Boolean).join(', ') || 'Стандартні';

                const merchantEl = item.querySelector('.goods-tile__merchant, [class*="merchant"]');
                const seller = merchantEl && merchantEl.innerText ? merchantEl.innerText.trim() : 'Rozetka';

                newItems.push({
                    name,
                    price,
                    oldPrice: oldPrice || price,
                    discount,
                    rating,
                    reviews,
                    inStock,
                    category: meta.category,
                    sessionTitle: meta.title,
                    sessionId: currentSessionId,
                    specs,
                    description: '',
                    seller,
                    sellersCount: 1,
                    priceChange: 0,
                    reviewsGrowth: 0,
                    link
                });

                sentLinks.add(link);
            } catch (_) {}
        });

        return newItems;
    }

    // Main multi-tab isolated scraping runner
    async function runTabScraper() {
        const meta = getPageMetadata();
        const estimatedTotal = getEstimatedTotalFromPage();
        console.log(`TradeScout Tab ${currentTabId}: Starting isolated scrape for "${meta.title}"...`);

        let pageCount = 1;
        let consecutiveNoNew = 0;
        let lastCount = 0;
        const tileSelectors = 'rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], div[class*="goods-tile"], article[class*="tile"]';

        while (isTabScrapingActive) {
            // 1. Scrape items visible now
            const newProducts = await scrapeCurrentDomItems(meta, pageCount);
            
            if (newProducts.length > 0) {
                // Background enrich details in small batches of 4
                const enrichBatch = async (batch) => {
                    await Promise.all(batch.map(p => fetchDetailForProduct(p)));
                };

                for (let i = 0; i < newProducts.length; i += 4) {
                    if (!isTabScrapingActive) break;
                    await enrichBatch(newProducts.slice(i, i + 4));
                    await new Promise(r => setTimeout(r, 150));
                }

                // Send payload tagged with session title and category
                const serverInfo = await sendWebhookPayload({
                    products: newProducts,
                    page: pageCount,
                    sessionId: currentSessionId,
                    sessionTitle: meta.title,
                    category: meta.category,
                    tabId: currentTabId
                });

                const syncedCount = serverInfo?.categoryCount || sentLinks.size;
                const percent = Math.min(98, Math.round((sentLinks.size / Math.max(1, estimatedTotal)) * 100));
                const statusMsg = `Зібрано ${sentLinks.size} товарів («${meta.title}»)...`;

                sendTabMessage({
                    action: 'tabProgress',
                    total: sentLinks.size,
                    page: pageCount,
                    percent,
                    statusMsg,
                    syncedCount,
                    sessionTitle: meta.title,
                    category: meta.category,
                    sessionId: currentSessionId
                });
            }

            if (!isTabScrapingActive) break;

            // 2. Silent background scroll
            await silentBackgroundScroll();

            // Check if new items loaded
            if (sentLinks.size > lastCount) {
                consecutiveNoNew = 0;
                lastCount = sentLinks.size;
            } else {
                consecutiveNoNew++;
            }

            // 3. Show More button or Pagination
            const showMoreBtn = findShowMoreButton();
            if (showMoreBtn) {
                const prevDomCount = document.querySelectorAll(tileSelectors).length;
                try {
                    showMoreBtn.click();
                } catch (_) {}
                pageCount++;

                // Wait up to 10s for new elements to appear
                let loaded = false;
                for (let w = 0; w < 20; w++) {
                    if (!isTabScrapingActive) break;
                    await new Promise(r => setTimeout(r, 500));
                    const currentDomCount = document.querySelectorAll(tileSelectors).length;
                    if (currentDomCount > prevDomCount) {
                        loaded = true;
                        break;
                    }
                }
                if (!loaded && consecutiveNoNew >= 2) {
                    console.log(`TradeScout Tab ${currentTabId}: No more new items loading. Finishing.`);
                    break;
                }
            } else {
                if (consecutiveNoNew >= 2) {
                    console.log(`TradeScout Tab ${currentTabId}: End of catalog reached.`);
                    break;
                }
                await new Promise(r => setTimeout(r, 1200));
            }
        }

        if (isTabScrapingActive) {
            isTabScrapingActive = false;
            console.log(`TradeScout Tab ${currentTabId}: Scrape finished successfully with ${sentLinks.size} items.`);
            sendTabMessage({
                action: 'tabFinished',
                total: sentLinks.size,
                sessionTitle: meta.title,
                category: meta.category,
                sessionId: currentSessionId
            });
        }
    }

    // Message listener for popup commands
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'START_TAB_SCRAPE') {
            if (isTabScrapingActive) {
                sendResponse({ success: true, alreadyRunning: true });
                return true;
            }
            isTabScrapingActive = true;
            currentTabId = message.tabId;
            currentSessionId = message.sessionId || `session_${currentTabId}_${Date.now()}`;
            webhookEndpoint = message.webhookUrl || webhookEndpoint;
            sentLinks.clear();

            const meta = getPageMetadata();
            sendTabMessage({
                action: 'tabProgress',
                total: 0,
                page: 1,
                percent: 5,
                statusMsg: `Запуск скрейпінгу: ${meta.title}...`,
                sessionTitle: meta.title,
                category: meta.category,
                sessionId: currentSessionId
            });

            runTabScraper();
            sendResponse({ success: true, sessionTitle: meta.title });
            return true;
        }

        if (message.action === 'STOP_TAB_SCRAPE') {
            isTabScrapingActive = false;
            const meta = getPageMetadata();
            sendTabMessage({
                action: 'tabProgress',
                total: sentLinks.size,
                page: 1,
                percent: 0,
                statusMsg: 'Скрейпінг зупинено.',
                sessionTitle: meta.title,
                category: meta.category,
                sessionId: currentSessionId
            });
            sendResponse({ success: true });
            return true;
        }

        if (message.action === 'PING_TAB_STATUS') {
            const meta = getPageMetadata();
            sendResponse({
                isRunning: isTabScrapingActive,
                totalScraped: sentLinks.size,
                sessionTitle: meta.title,
                category: meta.category,
                sessionId: currentSessionId
            });
            return true;
        }
    });

})();
