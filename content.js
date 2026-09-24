// TradeScout Content Script v3.5 Pro (Multi-Tab Background Worker & Live Telemetry)
(function() {
    if (window.self !== window.top) return; // Skip iframes
    if (window.__tradeScoutInjected) return; // Prevent duplicate injection
    window.__tradeScoutInjected = true;

    console.log('TradeScout Content Script v3.5 Pro loaded on:', window.location.href);

    const SESSION_STORAGE_KEY = '__tradeScout_active_session';

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
        } catch (_) {}
    }

    // Persist session to tab's sessionStorage across page transitions
    function persistSessionState(pageNum) {
        try {
            const state = {
                isRunning: isTabScrapingActive && window.__tradeScoutIsScrapingActive,
                tabId: currentTabId,
                sessionId: currentSessionId,
                sentLinks: Array.from(sentLinks),
                currentPage: pageNum || currentPage,
                estimatedTotal: currentEstimatedTotal,
                sessionTitle: getPageMetadata().title,
                category: getPageMetadata().category,
                startTime: sessionStartTime,
                webhookUrl: webhookEndpoint,
                savedAt: Date.now()
            };
            sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(state));
        } catch (_) {}
    }

    function clearPersistedSession() {
        try {
            sessionStorage.removeItem(SESSION_STORAGE_KEY);
        } catch (_) {}
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
        
        const m1 = cleaned.match(/(?:знайдено|найдено|показано)?\s*([\d\s\u00A0\u202F.,]+)\s*(?:товар\w*|тов\w*)/i);
        if (m1 && m1[1]) {
            const num = parseInt(m1[1].replace(/[\s\u00A0\u202F.,]/g, ''), 10);
            if (!isNaN(num) && num > 0 && num < 10000000) return num;
        }

        const m2 = cleaned.match(/([\d\s\u00A0\u202F.,]+)\s*(?:товарів|товари|товаров|товара|товар)/i);
        if (m2 && m2[1]) {
            const num = parseInt(m2[1].replace(/[\s\u00A0\u202F.,]/g, ''), 10);
            if (!isNaN(num) && num > 0 && num < 10000000) return num;
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
                    if (el.closest('aside, .sidebar, rz-filter-stack, .sidebar-block')) continue;
                    const txt = el.textContent || el.innerText || '';
                    const count = parseCountFromText(txt);
                    if (count > 0) return count;
                }
            } catch (_) {}
        }

        try {
            const pTags = document.querySelectorAll('p, span, div, h1, h2');
            for (const el of pTags) {
                if (el.children.length > 3) continue;
                if (el.closest('aside, .sidebar, rz-filter-stack, .sidebar-block')) continue;
                const txt = el.textContent || el.innerText || '';
                if (txt.includes('товар') || txt.includes('Знайдено') || txt.includes('знайдено') || txt.includes('найдено')) {
                    const count = parseCountFromText(txt);
                    if (count > 0 && count < 10000000) return count;
                }
            }
        } catch (_) {}

        try {
            const pageLinks = document.querySelectorAll('a.pagination__link, [class*="pagination"] a, rz-paginator a');
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
        } catch (_) {}

        const currentDomTiles = document.querySelectorAll('rz-product-tile, .goods-tile, rz-catalog-tile, [data-goods-id], app-goods-tile-default').length;
        return currentDomTiles > 0 ? currentDomTiles : 60;
    }

    function isSponsoredTile(item) {
        if (!item || !(item instanceof Element)) return true;
        if (item.closest('aside, .sidebar, header, footer, rz-viewed-goods, .recently-viewed, rz-similar-goods, rz-recommended-goods, rz-accessories, .catalog-banner, .advertising-slot, .main-goods__cell--advertising')) {
            return true;
        }
        const tileClasses = (item.className || '').toLowerCase();
        if (tileClasses.includes('catalog-banner') || tileClasses.includes('banner-tile') || tileClasses.includes('advertising-slot')) {
            return true;
        }
        const hasProductLink = !!item.querySelector('a[href*="/p"], a.goods-tile__heading, a.tile-title, [class*="heading"] a');
        const hasPrice = !!item.querySelector('.goods-tile__price, .price, [class*="price"]');
        if (!hasProductLink && !hasPrice) return true;
        return false;
    }

    // Fast, gentle 2-step silent background scroll (takes 500ms total, triggers all lazy loads smoothly)
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

    function extractReviews(item) {
        try {
            const revEl = item.querySelector('.goods-tile__reviews-link, [class*="reviews-link"], [class*="comments"], [class*="rating-count"], [data-testid*="reviews"]');
            if (revEl) {
                const text = revEl.innerText || revEl.textContent || '';
                const m = text.match(/(\d+)/);
                if (m && m[1]) return parseInt(m[1], 10);
            }
            const allText = item.innerText || '';
            const m2 = allText.match(/(\d+)\s*(?:відгук|отзыв)/i);
            if (m2 && m2[1]) return parseInt(m2[1], 10);
        } catch (_) {}
        return 0;
    }

    function extractRating(item) {
        try {
            const starsEl = item.querySelector('.stars_rating, [data-testid="stars-rating"], .goods-tile__stars svg, [class*="stars"] svg, [class*="rating-stars"]');
            if (starsEl) {
                const style = starsEl.getAttribute('style') || '';
                const matchCalc = style.match(/calc\(([\d.]+)%/i);
                if (matchCalc) return parseFloat(((parseFloat(matchCalc[1]) || 100) / 20).toFixed(1));
                const matchWidth = style.match(/width:\s*([\d.]+)%/i);
                if (matchWidth) return parseFloat(((parseFloat(matchWidth[1]) || 100) / 20).toFixed(1));
            }
            const ratingEl = item.querySelector('[data-rating], [aria-label*="рейтинг"], [aria-label*="rating"]');
            if (ratingEl) {
                const attr = ratingEl.getAttribute('data-rating') || ratingEl.getAttribute('aria-label') || '';
                const m = attr.match(/([\d.]+)/);
                if (m && m[1]) {
                    const val = parseFloat(m[1]);
                    if (val > 0 && val <= 5) return val;
                }
            }
        } catch (_) {}
        return 4.8;
    }

    function extractSeller(item) {
        try {
            const merchantEl = item.querySelector('.goods-tile__merchant, [class*="merchant"], .seller-title, [class*="seller"], .goods-tile__seller');
            if (merchantEl) {
                const txt = merchantEl.innerText || merchantEl.textContent || '';
                const clean = txt.replace(/Продавець:|Продавец:|Seller:/gi, '').trim();
                if (clean.length > 1) return clean;
            }
        } catch (_) {}
        return 'Rozetka';
    }

    function extractSpecs(name) {
        if (!name) return 'Стандартні';
        const capacityMatch = name.match(/(\d+)\s*(?:mah|мАг|мАч)/i);
        const powerMatch = name.match(/(\d+(?:\.\d+)?)\s*W/i);
        const parts = [];
        if (capacityMatch) parts.push(`${capacityMatch[1]} mAh`);
        if (powerMatch) parts.push(`${powerMatch[1]}W`);
        return parts.join(', ') || 'Стандартні';
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
            } catch (_) {}
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
            } catch (_) {}
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
            } catch (_) {}
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
            } catch (_) {}
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

    function buildNextPageUrl(currentUrl, nextPg) {
        try {
            const u = new URL(currentUrl);
            const path = u.pathname;
            if (path.includes(';page=')) {
                u.pathname = path.replace(/;page=\d+/, `;page=${nextPg}`);
            } else if (path.match(/page=\d+/)) {
                u.pathname = path.replace(/page=\d+/, `page=${nextPg}`);
            } else {
                if (path.includes('=')) {
                    u.pathname = path.endsWith('/') ? `${path.slice(0, -1)};page=${nextPg}/` : `${path};page=${nextPg}/`;
                } else {
                    u.pathname = path.endsWith('/') ? `${path}page=${nextPg}/` : `${path}/page=${nextPg}/`;
                }
            }
            return u.toString();
        } catch (_) {
            return currentUrl;
        }
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

                const priceEl = item.querySelector('.goods-tile__price-value, .price, [class*="price-value"], [class*="price__current"], [class*="current-price"]');
                const priceText = priceEl && priceEl.innerText ? priceEl.innerText : '';
                const price = priceText ? parseInt(priceText.replace(/\D/g, ''), 10) || 0 : 0;

                const oldPriceEl = item.querySelector('.goods-tile__price.type_old, .goods-tile__price--old, .price--old, [class*="price--old"], [class*="old-price"]');
                const oldPriceText = oldPriceEl && oldPriceEl.innerText ? oldPriceEl.innerText : '';
                const oldPrice = oldPriceText ? parseInt(oldPriceText.replace(/\D/g, ''), 10) || 0 : 0;
                const discount = (oldPrice && oldPrice > price) ? Math.round(((oldPrice - price) / oldPrice) * 100) : 0;

                const reviews = extractReviews(item);
                const rating = extractRating(item);
                const seller = extractSeller(item);
                const specs = extractSpecs(name);

                const itemText = item.innerText || '';
                const inStock = !(item.classList.contains('tile-disabled') || itemText.includes('Немає в наявності') || itemText.includes('Нет в наличии'));

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

            // 1. Silent scroll to trigger lazy mounting (500ms fast)
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

                persistSessionState(currentPage);
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

                    // If it's a page navigation link and action has href
                    if (actionObj.type === 'nextPage' || actionObj.type === 'pageNum') {
                        persistSessionState(currentPage + 1);
                    }

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
                        persistSessionState(currentPage);
                        break;
                    }

                    // If click did not expand in DOM and we have a target href or pageNum, navigate directly
                    if (!pageTransitionSuccess && (actionObj.type === 'nextPage' || actionObj.type === 'pageNum')) {
                        const targetUrl = actionObj.href && actionObj.href.startsWith('http') ? actionObj.href : buildNextPageUrl(window.location.href, currentPage + 1);
                        if (targetUrl && targetUrl !== window.location.href) {
                            persistSessionState(currentPage + 1);
                            window.location.href = targetUrl;
                            return; // Navigation will reload content script and resume seamlessly
                        }
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
            clearPersistedSession();
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

        persistSessionState(1);

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
        clearPersistedSession();
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

    // Check if resuming from an active session after page navigation
    try {
        const rawState = sessionStorage.getItem(SESSION_STORAGE_KEY);
        if (rawState) {
            const state = JSON.parse(rawState);
            if (state && state.isRunning && (Date.now() - (state.savedAt || 0) < 600000)) {
                console.log('TradeScout Content Script: Resuming session across page navigation on page', state.currentPage);
                isTabScrapingActive = true;
                window.__tradeScoutIsScrapingActive = true;
                currentTabId = state.tabId;
                currentSessionId = state.sessionId;
                webhookEndpoint = state.webhookUrl || webhookEndpoint;
                sessionStartTime = state.startTime || Date.now();
                currentPage = state.currentPage || 1;
                currentEstimatedTotal = state.estimatedTotal || getEstimatedTotalFromPage();
                
                if (Array.isArray(state.sentLinks)) {
                    state.sentLinks.forEach(l => sentLinks.add(l));
                }

                const meta = getPageMetadata();
                currentStatusMsg = `Збір: ${meta.title} (${sentLinks.size}/${currentEstimatedTotal})...`;
                
                sendTabMessage({
                    action: 'tabProgress',
                    total: sentLinks.size,
                    page: currentPage,
                    percent: Math.min(100, Math.round((sentLinks.size / Math.max(1, currentEstimatedTotal)) * 100)),
                    statusMsg: currentStatusMsg,
                    sessionTitle: meta.title,
                    category: meta.category,
                    sessionId: currentSessionId,
                    estimatedTotal: currentEstimatedTotal,
                    startTime: sessionStartTime
                });

                setTimeout(() => {
                    runTabScraper(currentPage);
                }, 400);
            }
        }
    } catch (_) {}

    // Default 100% idle on page load if not resuming
    if (!isTabScrapingActive) {
        const initialMeta = getPageMetadata();
        sendTabMessage({ action: 'tabIdle', sessionTitle: initialMeta.title, category: initialMeta.category });
    }

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
