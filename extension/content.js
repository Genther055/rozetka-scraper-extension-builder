// TradeScout Content Script v3.5 Pro (Multi-Tab Background Worker & Live Telemetry)
(function() {
    if (window.self !== window.top) return; // Skip iframes
    if (window.__tradeScoutInjected) return; // Prevent duplicate injection
    window.__tradeScoutInjected = true;

    console.log('TradeScout Content Script v3.5 Pro loaded on:', window.location.href);

    let isTabScrapingActive = false;
    window.__tradeScoutIsScrapingActive = false;
    let currentSessionId = null;
    let currentTabId = null;
    let webhookEndpoint = 'https://rozetka-scraper-extension-builder.onrender.com/api/products';
    const sentLinks = new Set();
    let sessionStartTime = null;
    let currentPercent = 0;
    let currentEstimatedTotal = 0;
    let currentStatusMsg = 'Готова до запуску';
    let currentPage = 1;

    // Helper to send messages safely to background service worker
    function sendTabMessage(msg) {
        if (msg.action === 'tabProgress' && (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive)) {
            return; // Block progress messages if scraping has stopped
        }
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

    function parseCountFromText(text) {
        if (!text || typeof text !== 'string') return 0;
        const cleaned = text.replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' ').replace(/\u202F/g, ' ').trim();
        
        const m1 = cleaned.match(/(?:знайдено|найдено)?\s*([\d\s\u00A0\u202F.,]+)\s*(?:товар|тов)/i);
        if (m1 && m1[1]) {
            const num = parseInt(m1[1].replace(/[\s\u00A0\u202F.,]/g, ''), 10);
            if (!isNaN(num) && num > 0) return num;
        }

        const m2 = cleaned.match(/([\d\s\u00A0\u202F.,]+)\s*(?:товарів|товари|товаров|товара)/i);
        if (m2 && m2[1]) {
            const num = parseInt(m2[1].replace(/[\s\u00A0\u202F.,]/g, ''), 10);
            if (!isNaN(num) && num > 0) return num;
        }

        const digitsOnly = cleaned.replace(/[^\d]/g, '');
        if (digitsOnly.length > 0) {
            const num = parseInt(digitsOnly, 10);
            if (!isNaN(num) && num > 0 && num < 10000000) return num;
        }

        return 0;
    }

    function getEstimatedTotalFromPage() {
        const selectors = [
            '[data-testid="filters-found-goods"]',
            'p[data-testid="filters-found-goods"]',
            '[data-testid*="found-goods"]',
            '[data-testid*="filters-found"]',
            '[data-testid="goods-counter"]',
            '[data-testid*="counter"]',
            '.catalog-heading__goods', 
            '.catalog-selection__label',
            '.goods-count',
            '[class*="heading__goods"]',
            '[class*="selection__label"]',
            '[class*="found-goods"]',
            '[class*="filters-found"]',
            '[class*="goods-count"]',
            'rz-catalog-settings [class*="found"]',
            'rz-catalog-settings p',
            'rz-catalog-counter',
            'rz-goods-counter',
            '.catalog-settings__goods-count'
        ];
        
        for (const sel of selectors) {
            try {
                const elements = document.querySelectorAll(sel);
                for (const el of elements) {
                    const txt = el.textContent || el.innerText || '';
                    const count = parseCountFromText(txt);
                    if (count > 0) return count;
                }
            } catch (e) {}
        }

        try {
            const pTags = document.querySelectorAll('p, span, div, h1, h2');
            for (const el of pTags) {
                if (el.children.length > 3) continue;
                const txt = el.textContent || el.innerText || '';
                if (txt.includes('товар') || txt.includes('Знайдено') || txt.includes('знайдено') || txt.includes('найдено')) {
                    const count = parseCountFromText(txt);
                    if (count > 0 && count < 10000000) return count;
                }
            }
        } catch (e) {}

        try {
            const pageLinks = document.querySelectorAll('a.pagination__link, [class*="pagination"] a');
            let maxPage = 1;
            pageLinks.forEach(link => {
                const txt = (link.textContent || '').trim();
                const num = parseInt(txt, 10);
                if (!isNaN(num) && num > maxPage && num < 1000) {
                    maxPage = num;
                }
            });
            if (maxPage > 1) {
                return maxPage * 60;
            }
        } catch (e) {}

        const currentDomTiles = document.querySelectorAll('rz-product-tile, .goods-tile, rz-catalog-tile, [data-goods-id]').length;
        return currentDomTiles > 0 ? currentDomTiles : 60;
    }

    function isSponsoredTile(item) {
        if (item.classList.contains('catalog-banner') || item.classList.contains('rz-banner') || item.classList.contains('banner-tile') || item.classList.contains('advertising-slot')) {
            return true;
        }
        const hasProductLink = !!item.querySelector('a[href*="/p"], a.goods-tile__heading, a.tile-title, [class*="heading"] a');
        const hasPrice = !!item.querySelector('.goods-tile__price, .price, [class*="price"]');
        if (!hasProductLink && !hasPrice) return true;
        return false;
    }

    async function silentBackgroundScroll() {
        try {
            const midY = Math.round(document.body.scrollHeight / 2);
            window.scrollTo({ top: midY, behavior: 'auto' });
            await new Promise(r => setTimeout(r, 200));
            const targetY = Math.max(0, document.body.scrollHeight - window.innerHeight);
            window.scrollTo({ top: targetY, behavior: 'auto' });
            await new Promise(r => setTimeout(r, 300));
        } catch (_) {}
    }

    function findPaginationActionElements(pageIndex) {
        const retrySelectors = [
            'button.retry',
            'button[class*="retry"]',
            'a[class*="retry"]',
            'rz-empty-state button',
            '.error-state button',
            '[class*="error"] button'
        ];
        for (const sel of retrySelectors) {
            try {
                const btn = document.querySelector(sel);
                if (btn) return { type: 'retry', element: btn };
            } catch (e) {}
        }

        const moreSelectors = [
            'rz-catalog-more button', 
            '.catalog-more button', 
            '.catalog-more__btn', 
            'button.show-more', 
            '.show-more', 
            'a.show-more', 
            '[class*="catalog-more"] button',
            '[class*="catalog-more"] a',
            '[class*="show-more"]',
            'button[data-testid="show-more"]'
        ];
        for (const sel of moreSelectors) {
            try {
                const btn = document.querySelector(sel);
                if (btn && !btn.disabled && !btn.classList.contains('button--loading') && !btn.classList.contains('disabled')) {
                    return { type: 'showMore', element: btn };
                }
            } catch (e) {}
        }

        const nextSelectors = [
            'a.pagination__direction--forward',
            'a.pagination__direction_type_forward',
            '[class*="pagination__direction--forward"]',
            '[class*="pagination__direction_type_forward"]',
            'a[title*="Наступна"]',
            'a[title*="Следующая"]',
            'a[aria-label*="Next"]',
            'rz-paginator a.pagination__direction:last-child',
            'a.pagination__direction:last-child'
        ];
        for (const sel of nextSelectors) {
            try {
                const btn = document.querySelector(sel);
                if (btn && !btn.disabled && !btn.classList.contains('disabled') && !btn.classList.contains('pagination__direction--disabled')) {
                    const href = btn.getAttribute('href') || '';
                    return { type: 'nextPage', element: btn, href };
                }
            } catch (e) {}
        }

        const nextPageNum = pageIndex + 1;
        const pageNumSelectors = [
            `a.pagination__link[href*="page=${nextPageNum}"]`,
            `a.pagination__link[href*="page=${nextPageNum}/"]`,
            `a.pagination__link[href*=";page=${nextPageNum}"]`,
            `a.pagination__link`,
            `[class*="pagination__item"] a`
        ];
        for (const sel of pageNumSelectors) {
            try {
                const links = document.querySelectorAll(sel);
                for (const link of links) {
                    const txt = (link.innerText || link.textContent || '').trim();
                    const href = link.getAttribute('href') || '';
                    if (txt === String(nextPageNum) || href.includes(`page=${nextPageNum}`)) {
                        return { type: 'pageNum', element: link, pageNum: nextPageNum, href };
                    }
                }
            } catch (e) {}
        }

        const allElements = document.querySelectorAll('button, a, div[role="button"], span');
        for (const el of allElements) {
            const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
            if (txt === 'показати ще' || txt === 'показать еще' || txt.includes('показати ще') || txt.includes('показать еще') || txt === 'show more') {
                if (el.closest('.sidebar') || el.closest('.filter') || el.closest('.recently-viewed')) continue;
                if (el.disabled || el.classList.contains('button--loading') || el.classList.contains('disabled')) continue;
                return { type: 'showMore', element: el };
            }
            if (txt === 'спробувати ще' || txt === 'повторити' || txt.includes('спробувати знову') || txt.includes('повторити спробу')) {
                return { type: 'retry', element: el };
            }
        }

        return null;
    }

    function dispatchSafeClick(element) {
        if (!element) return;
        try {
            element.click();
            element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}
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
        const tileSelectors = 'rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], div[class*="goods-tile"], article[class*="tile"], [data-testid="goods-tile"], app-goods-tile-default, .catalog-grid__cell, .goods-tile__inner';
        let items = Array.from(document.querySelectorAll(tileSelectors)).filter(item => !item.closest('.recently-viewed'));
        
        if (items.length === 0) {
            const links = document.querySelectorAll('a[href*="/p/"], a[href*="/p-"], a[href*="/p"]');
            items = Array.from(links).map(l => l.closest('li, div, rz-catalog-tile, article, section, app-goods-tile-default') || l).filter(Boolean);
        }

        if (items.length === 0) return [];

        const newItems = [];

        items.forEach((item) => {
            try {
                if (isSponsoredTile(item)) return;

                const linkTag = item.tagName === 'A' ? item : (item.querySelector('a.goods-tile__heading, a.tile-title, [class*="heading"] a, a[href*="/p/"], a[href*="/p-"], a[href*="/p"]') || item.querySelector('a[href]'));
                if (!linkTag) return;
                
                const linkEl = linkTag.getAttribute('href');
                if (!linkEl) return;

                const titleEl = item.querySelector('a.tile-title, a.goods-tile__heading, .goods-tile__heading, .tile-title, [class*="heading"], [class*="title"]') || linkTag;
                const name = titleEl && titleEl.innerText ? titleEl.innerText.trim() : (linkTag.innerText ? linkTag.innerText.trim() : '');
                if (!name || name.length < 3) return;

                let link = linkEl.startsWith('http') ? linkEl : (linkEl.startsWith('/') ? `https://rozetka.com.ua${linkEl}` : `https://rozetka.com.ua/${linkEl}`);
                link = link.split('?')[0].split('#')[0];

                if (sentLinks.has(link)) return;

                const priceEl = item.querySelector('.goods-tile__price-value, .price, [class*="price-value"], [class*="price__current"]');
                const priceText = priceEl && priceEl.innerText ? priceEl.innerText : '';
                const price = priceText ? parseInt(priceText.replace(/\D/g, ''), 10) || 0 : 0;

                const oldPriceEl = item.querySelector('.goods-tile__price.type_old, .goods-tile__price--old, .price--old, [class*="price--old"]');
                const oldPriceText = oldPriceEl && oldPriceEl.innerText ? oldPriceEl.innerText : '';
                const oldPrice = oldPriceText ? parseInt(oldPriceText.replace(/\D/g, ''), 10) || 0 : 0;
                const discount = (oldPrice && oldPrice > price) ? Math.round(((oldPrice - price) / oldPrice) * 100) : 0;

                const reviewsEl = item.querySelector('.rating-block-rating, [class*="rating"], [class*="comments"], .goods-tile__reviews-link, [class*="reviews"]');
                const reviewsText = reviewsEl && reviewsEl.innerText ? reviewsEl.innerText : '';
                const reviews = reviewsText ? parseInt(reviewsText.replace(/\D/g, ''), 10) || 0 : 0;

                const starsEl = item.querySelector('.stars_rating, [data-testid="stars-rating"], .goods-tile__stars svg, [class*="stars"] svg');
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

                const merchantEl = item.querySelector('.goods-tile__merchant, [class*="merchant"], .seller-title');
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

    // Main scraping runner
    async function runTabScraper(initialPage) {
        const meta = getPageMetadata();
        currentEstimatedTotal = getEstimatedTotalFromPage();
        currentPage = initialPage || 1;
        console.log(`TradeScout Tab ${currentTabId}: Started scraping "${meta.title}"...`);

        currentPercent = Math.min(100, Math.round((sentLinks.size / Math.max(1, currentEstimatedTotal)) * 100)) || 1;
        currentStatusMsg = `Збір: ${meta.title} (${sentLinks.size}/${currentEstimatedTotal})...`;

        let consecutiveNoNew = 0;
        let lastCount = sentLinks.size;
        const tileSelectors = 'rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], div[class*="goods-tile"], article[class*="tile"], [data-testid="goods-tile"]';

        while (isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
            const latestEstimated = getEstimatedTotalFromPage();
            if (latestEstimated > currentEstimatedTotal) {
                currentEstimatedTotal = latestEstimated;
            }

            // 1. Silent scroll to trigger lazy mounting
            await silentBackgroundScroll();
            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;

            // 2. Scrape all items on current page
            let newProducts = await scrapeCurrentDomItems(meta, currentPage);
            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;
            
            if (newProducts.length === 0) {
                await new Promise(r => setTimeout(r, 350));
                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;
                const extraSweep = await scrapeCurrentDomItems(meta, currentPage);
                if (extraSweep.length > 0) {
                    newProducts = newProducts.concat(extraSweep);
                }
            }
            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;
            
            if (newProducts.length > 0 && isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
                currentPercent = Math.min(100, Math.round((sentLinks.size / Math.max(1, currentEstimatedTotal)) * 100));
                currentStatusMsg = `Зібрано ${sentLinks.size} з ${currentEstimatedTotal} товарів (стор. ${currentPage})...`;

                sendTabMessage({
                    action: 'tabProgress',
                    total: sentLinks.size,
                    page: currentPage,
                    percent: currentPercent,
                    statusMsg: currentStatusMsg,
                    syncedCount: sentLinks.size,
                    estimatedTotal: currentEstimatedTotal,
                    sessionTitle: meta.title,
                    category: meta.category,
                    sessionId: currentSessionId,
                    startTime: sessionStartTime
                });

                await sendWebhookPayload({
                    products: newProducts,
                    page: currentPage,
                    sessionId: currentSessionId,
                    sessionTitle: meta.title,
                    category: meta.category,
                    tabId: currentTabId
                });
            }

            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;

            if (sentLinks.size > lastCount) {
                consecutiveNoNew = 0;
                lastCount = sentLinks.size;
            } else {
                consecutiveNoNew++;
            }

            // 3. Check if all items in catalog are collected
            if (currentEstimatedTotal > 0 && sentLinks.size >= currentEstimatedTotal) {
                console.log(`TradeScout Tab ${currentTabId}: All ${sentLinks.size}/${currentEstimatedTotal} items collected!`);
                break;
            }

            if (consecutiveNoNew >= 3) {
                console.log(`TradeScout Tab ${currentTabId}: Catalog ended (no new products). Total: ${sentLinks.size}`);
                break;
            }

            // 4. Trigger next page via DOM click or Show More
            let pageTransitionSuccess = false;
            const maxTransitionAttempts = 3;

            for (let attempt = 1; attempt <= maxTransitionAttempts; attempt++) {
                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;

                const prevDomCount = document.querySelectorAll(tileSelectors).length;
                const actionObj = findPaginationActionElements(currentPage);

                if (actionObj) {
                    if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;

                    currentStatusMsg = `Завантаження стор. ${currentPage + 1}...`;
                    sendTabMessage({
                        action: 'tabProgress',
                        total: sentLinks.size,
                        page: currentPage,
                        percent: currentPercent,
                        statusMsg: currentStatusMsg,
                        syncedCount: sentLinks.size,
                        estimatedTotal: currentEstimatedTotal,
                        sessionTitle: meta.title,
                        category: meta.category,
                        sessionId: currentSessionId,
                        startTime: sessionStartTime
                    });

                    dispatchSafeClick(actionObj.element);

                    for (let w = 0; w < 12; w++) {
                        if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;
                        await new Promise(r => setTimeout(r, 250));
                        
                        const currentDomCount = document.querySelectorAll(tileSelectors).length;
                        // Check if DOM expanded (Show More)
                        if (currentDomCount > prevDomCount) {
                            pageTransitionSuccess = true;
                            break;
                        }
                        // Check if new tiles loaded in DOM with unscraped links (Numbered Pagination)
                        const freshItems = Array.from(document.querySelectorAll(tileSelectors));
                        const hasUnscrapedLink = freshItems.some(tile => {
                            const linkTag = tile.querySelector('a.goods-tile__heading, a.tile-title, a[href*="/p/"], a[href*="/p-"], a[href*="/p"]');
                            if (!linkTag) return false;
                            let href = linkTag.getAttribute('href') || '';
                            href = href.split('?')[0].split('#')[0];
                            return href && !sentLinks.has(href) && !sentLinks.has(`https://rozetka.com.ua${href}`);
                        });
                        if (hasUnscrapedLink) {
                            pageTransitionSuccess = true;
                            break;
                        }
                    }

                    if (pageTransitionSuccess) {
                        currentPage++;
                        consecutiveNoNew = 0;
                        break;
                    }
                }

                if (attempt < maxTransitionAttempts) {
                    await silentBackgroundScroll();
                    await new Promise(r => setTimeout(r, 400));
                }
            }

            if (!pageTransitionSuccess) {
                consecutiveNoNew++;
                if (consecutiveNoNew >= 2) {
                    console.log(`TradeScout Tab ${currentTabId}: Catalog finished with ${sentLinks.size} items.`);
                    break;
                }
                await new Promise(r => setTimeout(r, 500));
            }
        }

        if (isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
            isTabScrapingActive = false;
            window.__tradeScoutIsScrapingActive = false;
            currentPercent = 100;
            currentStatusMsg = `Збір завершено! Всього ${sentLinks.size} товарів.`;
            console.log(`TradeScout Tab ${currentTabId}: Scrape completed with ${sentLinks.size} items.`);

            sendTabMessage({
                action: 'tabFinished',
                total: sentLinks.size,
                page: currentPage,
                percent: 100,
                statusMsg: currentStatusMsg,
                syncedCount: sentLinks.size,
                estimatedTotal: sentLinks.size,
                sessionTitle: meta.title,
                category: meta.category,
                sessionId: currentSessionId
            });
        }
    }

    function startScrapingOnThisTab(tabId, customUrl) {
        isTabScrapingActive = true;
        window.__tradeScoutIsScrapingActive = true;
        currentTabId = tabId || currentTabId || Date.now();
        currentSessionId = `session_${currentTabId}_${Date.now()}`;
        if (customUrl) webhookEndpoint = customUrl;
        sentLinks.clear();
        sessionStartTime = Date.now();
        currentPage = 1;

        const meta = getPageMetadata();
        currentEstimatedTotal = getEstimatedTotalFromPage();
        currentPercent = 1;
        currentStatusMsg = `Запуск скрейпінгу: ${meta.title}...`;

        sendTabMessage({
            action: 'tabProgress',
            total: 0,
            page: 1,
            percent: 1,
            statusMsg: currentStatusMsg,
            sessionTitle: meta.title,
            category: meta.category,
            sessionId: currentSessionId,
            estimatedTotal: currentEstimatedTotal,
            startTime: sessionStartTime
        });

        runTabScraper(1);
    }

    function stopScrapingOnThisTab() {
        isTabScrapingActive = false;
        window.__tradeScoutIsScrapingActive = false;
        const meta = getPageMetadata();
        currentPercent = 0;
        currentStatusMsg = 'Скрейпінг зупинено.';

        sendTabMessage({
            action: 'tabStopped',
            total: sentLinks.size,
            page: currentPage,
            percent: 0,
            statusMsg: 'Скрейпінг зупинено.',
            sessionTitle: meta.title,
            category: meta.category,
            sessionId: currentSessionId
        });
    }

    // Default 100% idle on page load
    const initialMeta = getPageMetadata();
    sendTabMessage({ action: 'tabIdle', sessionTitle: initialMeta.title, category: initialMeta.category });

    // Expose direct window handlers for fail-safe invocation
    window.__tradeScoutStartScrape = startScrapingOnThisTab;
    window.__tradeScoutStopScrape = stopScrapingOnThisTab;

    // Message listener for popup / background commands
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'START_TAB_SCRAPE') {
            startScrapingOnThisTab(message.tabId, message.webhookUrl);
            const meta = getPageMetadata();
            sendResponse({ success: true, sessionTitle: meta.title });
            return true;
        }

        if (message.action === 'STOP_TAB_SCRAPE') {
            stopScrapingOnThisTab();
            sendResponse({ success: true });
            return true;
        }

        if (message.action === 'PING_TAB_STATUS') {
            const meta = getPageMetadata();
            const est = getEstimatedTotalFromPage();
            sendResponse({
                isRunning: isTabScrapingActive && window.__tradeScoutIsScrapingActive,
                totalScraped: sentLinks.size,
                estimatedTotal: currentEstimatedTotal > 0 ? currentEstimatedTotal : est,
                percent: currentPercent,
                statusMsg: currentStatusMsg,
                page: currentPage,
                startTime: sessionStartTime,
                sessionTitle: meta.title,
                category: meta.category,
                sessionId: currentSessionId
            });
            return true;
        }
    });

})();
