// TradeScout Content Script v3.8 Pro (Silky Smooth Linear Downward Scroll & Full Multi-Page Catalog Harvester)
(function() {
    if (window.self !== window.top) return; // Skip iframes
    if (window.__tradeScoutInjected) return; // Prevent duplicate injection
    window.__tradeScoutInjected = true;

    console.log('TradeScout Content Script v3.8 Pro loaded on:', window.location.href);

    let isTabScrapingActive = false;
    window.__tradeScoutIsScrapingActive = false;
    let isScraperLoopRunning = false;
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
        
        // Match: "Знайдено 531 товар" or "Знайдено 508 товарів" or "Найдено 355 товаров"
        const m1 = cleaned.match(/(?:знайдено|найдено|показано)\s*([\d\s\u00A0\u202F.,]+)\s*(?:товар\w*|тов\w*)?/i);
        if (m1 && m1[1]) {
            const num = parseInt(m1[1].replace(/[\s\u00A0\u202F.,]/g, ''), 10);
            if (!isNaN(num) && num > 0 && num < 1000000) return num;
        }

        // Match: "531 товар", "508 товарів", "73 товари", "24 товари", "100 товаров", "350 товаров"
        const m2 = cleaned.match(/\b([\d\s\u00A0\u202F.,]+)\s*(?:товарів|товари|товаров|товара|товар)\b/i);
        if (m2 && m2[1]) {
            const num = parseInt(m2[1].replace(/[\s\u00A0\u202F.,]/g, ''), 10);
            if (!isNaN(num) && num > 0 && num < 1000000) return num;
        }

        // Match: "Знайдено 508"
        const m3 = cleaned.match(/(?:знайдено|найдено)\s*([\d\s\u00A0\u202F.,]+)/i);
        if (m3 && m3[1]) {
            const num = parseInt(m3[1].replace(/[\s\u00A0\u202F.,]/g, ''), 10);
            if (!isNaN(num) && num > 0 && num < 1000000) return num;
        }

        return 0;
    }

    function getEstimatedTotalFromPage() {
        let maxPage = 1;
        try {
            const pageLinks = document.querySelectorAll('a.pagination__link, [class*="pagination"] a, li.pagination__item a, rz-paginator a');
            for (const link of pageLinks) {
                if (link.closest('aside, .sidebar, header, footer, rz-recommended-goods, .recently-viewed')) continue;
                const txt = (link.textContent || '').trim();
                const num = parseInt(txt, 10);
                if (!isNaN(num) && num > maxPage && num < 500) {
                    maxPage = num;
                }
                const href = link.getAttribute('href') || '';
                const m = href.match(/page=(\d+)/i) || href.match(/\/(\d+)\/?$/) || href.match(/page-(\d+)/i);
                if (m && m[1]) {
                    const hNum = parseInt(m[1], 10);
                    if (!isNaN(hNum) && hNum > maxPage && hNum < 500) {
                        maxPage = hNum;
                    }
                }
            }
        } catch (e) {}

        // Check top catalog counter text (strictly exclude sidebars, chips, and filters)
        let parsedTopCount = 0;
        const topElements = document.querySelectorAll('rz-catalog-settings, .catalog-settings, .catalog-heading, .catalog-selection__label, [class*="heading__goods"], [class*="found-goods"], [class*="goods-count"], h1');
        for (const el of topElements) {
            if (el.closest('aside, .sidebar, rz-filter-stack, .sidebar-block, [class*="filter"], rz-catalog-selection, .catalog-selection, [class*="chip"]')) continue;
            const txt = (el.textContent || el.innerText || '').trim();
            if (txt.toLowerCase().includes('знайдено') || txt.toLowerCase().includes('найдено') || txt.toLowerCase().includes('товар')) {
                const count = parseCountFromText(txt);
                if (count > 0 && count < 1000000) {
                    parsedTopCount = count;
                    break;
                }
            }
        }

        if (parsedTopCount > 0) {
            return parsedTopCount;
        }

        if (maxPage > 1) {
            return maxPage * 60;
        }

        const currentDomTiles = document.querySelectorAll('rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], app-goods-tile-default').length;
        return currentDomTiles > 0 ? currentDomTiles : 60;
    }

    // Filter: strictly eliminate non-catalog containers (sidebar, recommendations, recently viewed, carousels, banners)
    function isUnwantedTile(item) {
        if (!item || !(item instanceof Element)) return true;
        
        // 1. Exclude all recommendation blocks, carousels, sidebar, recently viewed, and banners
        if (item.closest('aside, .sidebar, header, footer, rz-viewed-goods, .recently-viewed, rz-similar-goods, rz-recommended-goods, rz-accessories, .catalog-banner, .advertising-slot, .main-goods__cell--advertising, rz-goods-sections, app-slider-goods, app-goods-carousel, rz-carousel')) {
            return true;
        }
        
        // 2. Check if tile itself is an ad banner or placeholder
        const tileClasses = (item.className || '').toLowerCase();
        if (tileClasses.includes('catalog-banner') || tileClasses.includes('banner-tile') || tileClasses.includes('advertising-slot')) {
            return true;
        }

        // 3. Must have a valid product link
        const linkTag = item.tagName === 'A' ? item : (item.querySelector('a.goods-tile__heading, a.tile-title, [class*="heading"] a, a[href*="/p/"], a[href*="/p-"], a[href*="/p"]') || item.querySelector('a[href]'));
        if (!linkTag) return true;

        const href = linkTag.getAttribute('href') || '';
        if (!href || href === '#' || href.startsWith('javascript:')) return true;

        return false;
    }

    function findPaginationActionElements(pageIndex) {
        const nextPageNum = pageIndex + 1;

        // Priority 1: "Show More" / "Показати ще" button (expands catalog on same page instantly)
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
            'button[data-testid*="show-more"]',
            'button[data-testid*="more"]'
        ];
        for (const sel of moreSelectors) {
            try {
                const btn = document.querySelector(sel);
                if (btn && !btn.disabled && !btn.classList.contains('button--loading') && !btn.classList.contains('disabled')) {
                    if (btn.closest('aside, .sidebar, .filter, .recently-viewed, header, rz-recommended-goods')) continue;
                    return { type: 'showMore', element: btn };
                }
            } catch (e) {}
        }

        const allButtons = document.querySelectorAll('button, a, div[role="button"]');
        for (const el of allButtons) {
            const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
            if (txt === 'показати ще' || txt === 'показать еще' || txt.includes('показати ще') || txt.includes('показать еще') || txt === 'show more') {
                if (el.closest('aside, .sidebar, .filter, .recently-viewed, header, rz-recommended-goods')) continue;
                if (el.disabled || el.classList.contains('button--loading') || el.classList.contains('disabled')) continue;
                return { type: 'showMore', element: el };
            }
        }

        // Priority 2: Numbered next page link (e.g. page=2, page=3...)
        const pageNumSelectors = [
            `a.pagination__link[href*="page=${nextPageNum}"]`,
            `a.pagination__link[href*=";page=${nextPageNum}"]`,
            `a.pagination__link[href*="page-${nextPageNum}"]`,
            `a.pagination__link`,
            `[class*="pagination__item"] a`,
            `rz-paginator a`
        ];
        for (const sel of pageNumSelectors) {
            try {
                const links = document.querySelectorAll(sel);
                for (const link of links) {
                    if (link.closest('aside, .sidebar, header, footer, rz-recommended-goods')) continue;
                    const txt = (link.innerText || link.textContent || '').trim();
                    const href = link.getAttribute('href') || '';
                    if (txt === String(nextPageNum) || href.includes(`page=${nextPageNum}`) || href.includes(`;page=${nextPageNum}`) || href.includes(`page-${nextPageNum}`)) {
                        return { type: 'pageNum', element: link, pageNum: nextPageNum, href };
                    }
                }
            } catch (e) {}
        }

        // Priority 3: Forward arrow / next button
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
                    if (btn.closest('aside, .sidebar, header, footer, rz-recommended-goods')) continue;
                    const href = btn.getAttribute('href') || '';
                    return { type: 'nextPage', element: btn, href };
                }
            } catch (e) {}
        }

        return null;
    }

    function dispatchSafeClick(element) {
        if (!element) return;
        try {
            element.focus();
            element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            element.click();
            element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } catch (_) {}
    }

    function sendWebhookPayload(payload) {
        try {
            chrome.runtime.sendMessage({
                action: 'sendWebhook',
                webhookUrl: webhookEndpoint,
                tabId: currentTabId,
                payload: payload
            }, () => {
                if (chrome.runtime.lastError) {}
            });
        } catch (_) {}
    }

    function extractSeller(item) {
        if (!item || !(item instanceof Element)) return 'Rozetka';
        
        const sellerSelectors = [
            '.goods-tile__seller',
            '.goods-tile__seller-name',
            'rz-goods-seller',
            'rz-seller',
            '[class*="goods-tile__seller"]',
            '[class*="seller-name"]',
            '[class*="seller-title"]',
            '.seller-title',
            '.seller-name',
            '.shop-name',
            '.goods-tile__shop',
            '[data-testid*="seller"]',
            '[data-testid*="merchant"]',
            '.goods-tile__merchant',
            '[class*="merchant"]'
        ];
        
        for (const sel of sellerSelectors) {
            try {
                const el = item.querySelector(sel);
                if (el && el.innerText && el.innerText.trim().length > 1) {
                    let s = el.innerText.trim();
                    s = s.replace(/^продавець:?\s*/i, '')
                         .replace(/^продавец:?\s*/i, '')
                         .replace(/^seller:?\s*/i, '')
                         .replace(/^магазин:?\s*/i, '')
                         .trim();
                    if (s && s.length > 1 && !s.includes('\n') && s.length < 60) {
                        return s;
                    }
                }
            } catch (_) {}
        }
        
        try {
            const itemText = item.innerText || '';
            const match = itemText.match(/(?:продавець|продавец|seller)\s*:\s*([^\n\r\t,;]+)/i);
            if (match && match[1]) {
                let s = match[1].trim();
                if (s && s.length > 1 && s.length < 60) {
                    return s;
                }
            }
        } catch (_) {}
        
        return 'Rozetka';
    }

    function scrapeCurrentDomItems(meta, pageIndex) {
        const catalogContainer = document.querySelector('rz-grid, ul.catalog-grid, .catalog-grid, rz-catalog-grid, rz-catalog-tiles, .catalog-selection__goods, section.catalog-grid') || document.querySelector('main') || document.body;
        
        let rawTiles = Array.from(catalogContainer.querySelectorAll('li.catalog-grid__cell, rz-catalog-tile, rz-product-tile, [data-goods-id], .goods-tile, app-goods-tile-default'));
        if (rawTiles.length === 0) {
            rawTiles = Array.from(document.querySelectorAll('rz-catalog-tile, rz-product-tile, [data-goods-id], .goods-tile, li.catalog-grid__cell, app-goods-tile-default'));
        }

        const distinctTiles = [];
        const seenElements = new Set();

        for (const item of rawTiles) {
            if (isUnwantedTile(item)) continue;
            
            const linkTag = item.tagName === 'A' ? item : (item.querySelector('a.goods-tile__heading, a.tile-title, [class*="heading"] a, a[href*="/p/"], a[href*="/p-"], a[href*="/p"]') || item.querySelector('a[href]'));
            if (!linkTag) continue;

            const rawHref = linkTag.getAttribute('href');
            if (!rawHref) continue;

            let link = rawHref.split('?')[0].split('#')[0].replace(/\/+$/, '');
            if (!link.startsWith('http')) {
                link = link.startsWith('/') ? `https://rozetka.com.ua${link}` : `https://rozetka.com.ua/${link}`;
            }

            if (sentLinks.has(link) || seenElements.has(link)) continue;
            seenElements.add(link);
            distinctTiles.push({ item, linkTag, link });
        }

        if (distinctTiles.length === 0) return [];

        const newItems = [];

        for (const { item, linkTag, link } of distinctTiles) {
            try {
                const titleEl = item.querySelector('a.tile-title, a.goods-tile__heading, .goods-tile__heading, .tile-title, [class*="heading"], [class*="title"]') || linkTag;
                const name = titleEl && titleEl.innerText ? titleEl.innerText.trim() : (linkTag.innerText ? linkTag.innerText.trim() : '');
                if (!name || name.length < 3) continue;

                // --- 1. CURRENT PRICE EXTRACTION ---
                let price = 0;
                const priceEl = item.querySelector(
                    '.goods-tile__price-value, .goods-tile__price--current, .goods-tile__price_color_red, ' +
                    '.price--red, .price, [class*="price-value"], [class*="price__current"], [class*="price_color_red"], ' +
                    '.product-price__big, [class*="price__main"]'
                );
                const priceText = priceEl && priceEl.innerText ? priceEl.innerText : '';
                if (priceText) {
                    price = parseInt(priceText.replace(/\D/g, ''), 10) || 0;
                }

                // --- 2. OLD (PRE-DISCOUNT) PRICE & DISCOUNT EXTRACTION ---
                let oldPrice = 0;
                let discount = 0;

                const oldPriceEl = item.querySelector(
                    '.goods-tile__price--old, .goods-tile__price_type_old, .goods-tile__price.type_old, ' +
                    '.goods-tile__price_color_gray, .goods-tile__price-old, [class*="price_color_gray"], ' +
                    '[class*="price--old"], [class*="price_type_old"], [class*="price-old"], [class*="old-price"], ' +
                    '[class*="price__old"], [class*="old_price"], [class*="price-discount"], [class*="product-price__small"], ' +
                    'del, s, strike, [style*="line-through"]'
                );
                if (oldPriceEl && oldPriceEl.innerText) {
                    const parsed = parseInt(oldPriceEl.innerText.replace(/\D/g, ''), 10) || 0;
                    if (parsed > price) {
                        oldPrice = parsed;
                    }
                }

                const badgeEl = item.querySelector(
                    'rz-badge, .goods-tile__badge, [class*="goods-tile__badge"], [class*="goods-tile__label"], ' +
                    '[class*="badge"], [class*="promo"], [class*="discount"], [class*="sticker"], [class*="tag"]'
                );
                const badgeText = badgeEl && badgeEl.innerText ? badgeEl.innerText : '';
                const badgeMatch = badgeText.match(/(?:-|−|знижка\s*|скидка\s*)(\d{1,2})\s*%/i) || badgeText.match(/-(\d{1,2})%/);
                if (badgeMatch && badgeMatch[1]) {
                    discount = parseInt(badgeMatch[1], 10) || 0;
                } else {
                    const fullTileText = item.innerText || '';
                    const tileMatch = fullTileText.match(/(?:-|−)(\d{1,2})%/);
                    if (tileMatch && tileMatch[1]) {
                        const pct = parseInt(tileMatch[1], 10) || 0;
                        if (pct > 0 && pct < 90) {
                            discount = pct;
                        }
                    }
                }

                // Harmonize oldPrice & discount
                if (oldPrice > price && !discount && price > 0) {
                    discount = Math.round(((oldPrice - price) / oldPrice) * 100);
                } else if (discount > 0 && (!oldPrice || oldPrice <= price) && price > 0) {
                    oldPrice = Math.round(price / (1 - (discount / 100)));
                }

                if (!oldPrice || oldPrice < price) {
                    oldPrice = price;
                }

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

                const seller = extractSeller(item) || 'Rozetka';

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
        }

        return newItems;
    }

    function processAndReportHarvest(items, meta, pageIndex) {
        if (!items || items.length === 0) return;
        const estimated = currentEstimatedTotal > 0 ? currentEstimatedTotal : Math.max(sentLinks.size, 60);
        currentPercent = Math.min(100, Math.round((sentLinks.size / estimated) * 100));
        currentStatusMsg = `Зібрано ${sentLinks.size} з ${estimated} товарів (стор. ${pageIndex})...`;

        sendTabMessage({
            action: 'tabProgress',
            total: sentLinks.size,
            page: pageIndex,
            percent: currentPercent,
            statusMsg: currentStatusMsg,
            syncedCount: sentLinks.size,
            estimatedTotal: estimated,
            sessionTitle: meta.title,
            category: meta.category,
            sessionId: currentSessionId,
            startTime: sessionStartTime,
            sentLinks: Array.from(sentLinks),
            webhookUrl: webhookEndpoint
        });

        // Fast non-blocking background dispatch
        sendWebhookPayload({
            products: items,
            page: pageIndex,
            sessionId: currentSessionId,
            sessionTitle: meta.title,
            category: meta.category,
            tabId: currentTabId
        });
    }

    // Silky Smooth Linear Progressive Downward Scroll Engine (100% human-like, zero jumping)
    async function progressivePageHarvest(meta, pageIndex) {
        let harvestedThisPage = 0;
        let consecutiveNoGrowthSteps = 0;

        // 1. Initial harvest at current top position
        const initialBatch = scrapeCurrentDomItems(meta, pageIndex);
        if (initialBatch.length > 0) {
            harvestedThisPage += initialBatch.length;
            processAndReportHarvest(initialBatch, meta, pageIndex);
        }

        // 2. Smooth downward stepping
        const stepPx = 300;
        const stepDelay = 120; // 120ms per step = smooth, fast and reliable

        while (isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
            const currentScrollY = window.scrollY || window.pageYOffset || document.documentElement.scrollTop || 0;
            const docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 1000);
            const maxScrollY = Math.max(0, docHeight - window.innerHeight);

            // If we have room to scroll down smoothly:
            if (currentScrollY < maxScrollY - 20) {
                const targetY = Math.min(currentScrollY + stepPx, maxScrollY);
                window.scrollTo({ top: targetY, behavior: 'smooth' });
                document.documentElement.scrollTop = targetY;
                document.body.scrollTop = targetY;
                window.dispatchEvent(new Event('scroll', { bubbles: true }));
                window.dispatchEvent(new WheelEvent('wheel', { deltaY: stepPx, bubbles: true }));

                const batch = scrapeCurrentDomItems(meta, pageIndex);
                if (batch.length > 0) {
                    harvestedThisPage += batch.length;
                    consecutiveNoGrowthSteps = 0;
                    processAndReportHarvest(batch, meta, pageIndex);
                }

                await new Promise(r => setTimeout(r, stepDelay));
            } else {
                // We reached the bottom of current rendered height!
                // Wait briefly for Angular lazy loading to render new rows:
                await new Promise(r => setTimeout(r, 350));
                window.dispatchEvent(new Event('scroll', { bubbles: true }));
                window.dispatchEvent(new Event('resize', { bubbles: true }));

                const batch = scrapeCurrentDomItems(meta, pageIndex);
                if (batch.length > 0) {
                    harvestedThisPage += batch.length;
                    consecutiveNoGrowthSteps = 0;
                    processAndReportHarvest(batch, meta, pageIndex);
                }

                const newDocHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 1000);
                if (newDocHeight > docHeight + 50) {
                    // New rows mounted! Reset counter and continue scrolling down
                    consecutiveNoGrowthSteps = 0;
                } else {
                    consecutiveNoGrowthSteps++;
                    if (consecutiveNoGrowthSteps >= 3) {
                        // Truly reached bottom of page
                        break;
                    }
                }
            }
        }

        // 3. Final sweep at bottom
        const finalBatch = scrapeCurrentDomItems(meta, pageIndex);
        if (finalBatch.length > 0) {
            harvestedThisPage += finalBatch.length;
            processAndReportHarvest(finalBatch, meta, pageIndex);
        }

        return harvestedThisPage;
    }

    // Main scraping runner
    async function runTabScraper(initialPage) {
        if (isScraperLoopRunning) {
            console.log(`TradeScout Tab ${currentTabId}: Scraper loop is already running, resetting and starting cleanly.`);
        }
        isScraperLoopRunning = true;

        try {
            const meta = getPageMetadata();
            if (currentEstimatedTotal <= 0) {
                currentEstimatedTotal = getEstimatedTotalFromPage();
            }
            currentPage = initialPage || 1;
            console.log(`TradeScout Tab ${currentTabId}: Started scraping "${meta.title}"... Estimated total: ${currentEstimatedTotal}`);

            currentPercent = Math.min(100, Math.round((sentLinks.size / Math.max(1, currentEstimatedTotal)) * 100)) || 1;
            currentStatusMsg = `Збір: ${meta.title} (${sentLinks.size}/${currentEstimatedTotal})...`;

            let consecutiveNoNew = 0;
            let lastCount = sentLinks.size;
            const tileSelectors = 'ul.catalog-grid, rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], app-goods-tile-default';

            while (isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
                const latestEstimated = getEstimatedTotalFromPage();
                if (latestEstimated > currentEstimatedTotal) {
                    currentEstimatedTotal = latestEstimated;
                }

                // 1. Progressive smooth downward scroll
                await progressivePageHarvest(meta, currentPage);
                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;

                if (sentLinks.size > lastCount) {
                    consecutiveNoNew = 0;
                    lastCount = sentLinks.size;
                } else {
                    consecutiveNoNew++;
                }

                // 2. Check for next page
                const actionObj = findPaginationActionElements(currentPage);
                const hasNextPage = !!actionObj;

                if (!hasNextPage && consecutiveNoNew >= 2) {
                    console.log(`TradeScout Tab ${currentTabId}: No next page button found and no new products. Catalog complete.`);
                    break;
                }

                if (!hasNextPage) {
                    console.log(`TradeScout Tab ${currentTabId}: Reached final page of catalog.`);
                    break;
                }

                // 3. Trigger next page via DOM click on Show More (in-place) or next page button
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
                            page: currentPage + 1,
                            percent: currentPercent,
                            statusMsg: currentStatusMsg,
                            syncedCount: sentLinks.size,
                            estimatedTotal: currentEstimatedTotal,
                            sessionTitle: meta.title,
                            category: meta.category,
                            sessionId: currentSessionId,
                            startTime: sessionStartTime,
                            sentLinks: Array.from(sentLinks),
                            webhookUrl: webhookEndpoint
                        });

                        const prevHref = window.location.href;
                        dispatchSafeClick(actionObj.element);

                        for (let w = 0; w < 12; w++) {
                            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;
                            await new Promise(r => setTimeout(r, 250));
                            
                            // A. Check if URL changed
                            if (window.location.href !== prevHref) {
                                pageTransitionSuccess = true;
                                break;
                            }

                            // B. Check if DOM expanded (Show More in-place)
                            const currentDomCount = document.querySelectorAll(tileSelectors).length;
                            if (currentDomCount > prevDomCount) {
                                pageTransitionSuccess = true;
                                break;
                            }

                            // C. Check if new tiles loaded in DOM with unscraped links
                            const freshItems = Array.from(document.querySelectorAll(tileSelectors));
                            const hasUnscrapedLink = freshItems.some(tile => {
                                if (isUnwantedTile(tile)) return false;
                                const linkTag = tile.querySelector('a.goods-tile__heading, a.tile-title, a[href*="/p/"], a[href*="/p-"], a[href*="/p"]');
                                if (!linkTag) return false;
                                let href = (linkTag.getAttribute('href') || '').split('?')[0].split('#')[0].replace(/\/+$/, '');
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

            // Scraping completed
            isTabScrapingActive = false;
            window.__tradeScoutIsScrapingActive = false;
            currentPercent = 100;
            currentStatusMsg = `Збір завершено! (${sentLinks.size} товарів)`;
            console.log(`TradeScout Tab ${currentTabId}: Scrape finished! Total: ${sentLinks.size} items.`);

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
                sessionId: currentSessionId,
                startTime: sessionStartTime,
                sentLinks: Array.from(sentLinks),
                webhookUrl: webhookEndpoint
            });
        } finally {
            isScraperLoopRunning = false;
        }
    }

    function startScrapingOnThisTab(tabId, customUrl) {
        isTabScrapingActive = true;
        window.__tradeScoutIsScrapingActive = true;
        isScraperLoopRunning = false;
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
            startTime: sessionStartTime,
            sentLinks: [],
            webhookUrl: webhookEndpoint
        });

        runTabScraper(1);
    }

    function resumeScrapingSession(session) {
        if (!session) return;
        isTabScrapingActive = true;
        window.__tradeScoutIsScrapingActive = true;
        isScraperLoopRunning = false;
        currentTabId = session.tabId || currentTabId || Date.now();
        currentSessionId = session.sessionId || `session_${currentTabId}_${Date.now()}`;
        if (session.webhookUrl) webhookEndpoint = session.webhookUrl;

        sentLinks.clear();
        if (Array.isArray(session.sentLinks)) {
            session.sentLinks.forEach(link => sentLinks.add(link));
        }

        let urlPage = 1;
        const pageMatch = window.location.href.match(/page=(\d+)/i) || window.location.href.match(/\/page-(\d+)/i);
        if (pageMatch && pageMatch[1]) {
            urlPage = parseInt(pageMatch[1], 10) || 1;
        }
        currentPage = urlPage > 1 ? urlPage : (session.currentPage || 1);

        sessionStartTime = session.startTime || Date.now();
        currentEstimatedTotal = session.estimatedTotal || getEstimatedTotalFromPage();
        currentPercent = Math.min(100, Math.round((sentLinks.size / Math.max(1, currentEstimatedTotal)) * 100)) || 1;
        currentStatusMsg = `Збір (стор. ${currentPage}): ${sentLinks.size}/${currentEstimatedTotal}...`;

        sendTabMessage({
            action: 'tabProgress',
            total: sentLinks.size,
            page: currentPage,
            percent: currentPercent,
            statusMsg: currentStatusMsg,
            sessionTitle: session.sessionTitle || getPageMetadata().title,
            category: session.category || getPageMetadata().category,
            sessionId: currentSessionId,
            estimatedTotal: currentEstimatedTotal,
            startTime: sessionStartTime,
            sentLinks: Array.from(sentLinks),
            webhookUrl: webhookEndpoint
        });

        runTabScraper(currentPage);
    }

    function stopScrapingOnThisTab() {
        isTabScrapingActive = false;
        window.__tradeScoutIsScrapingActive = false;
        isScraperLoopRunning = false;
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

    function resetTabState() {
        isTabScrapingActive = false;
        window.__tradeScoutIsScrapingActive = false;
        isScraperLoopRunning = false;
        sentLinks.clear();
        currentPercent = 0;
        currentEstimatedTotal = 0;
        currentStatusMsg = 'Готова до запуску';
        currentPage = 1;
        const meta = getPageMetadata();
        sendTabMessage({ action: 'tabIdle', sessionTitle: meta.title, category: meta.category });
    }

    // Check on page load if this tab was in an active scraping session
    function checkAndResumeSessionOnLoad() {
        try {
            chrome.runtime.sendMessage({ action: 'GET_TAB_SESSION_ON_LOAD' }, (res) => {
                if (chrome.runtime.lastError) {
                    const meta = getPageMetadata();
                    sendTabMessage({ action: 'tabIdle', sessionTitle: meta.title, category: meta.category });
                    return;
                }
                if (res && res.isRunning && res.session) {
                    console.log('TradeScout Content Script: Resuming existing scrape session on page load...', res.session);
                    setTimeout(() => {
                        resumeScrapingSession(res.session);
                    }, 350);
                } else {
                    const meta = getPageMetadata();
                    sendTabMessage({ action: 'tabIdle', sessionTitle: meta.title, category: meta.category });
                }
            });
        } catch (_) {
            const meta = getPageMetadata();
            sendTabMessage({ action: 'tabIdle', sessionTitle: meta.title, category: meta.category });
        }
    }

    checkAndResumeSessionOnLoad();

    // Expose direct window handlers for fail-safe invocation
    window.__tradeScoutStartScrape = startScrapingOnThisTab;
    window.__tradeScoutResumeScrape = resumeScrapingSession;
    window.__tradeScoutStopScrape = stopScrapingOnThisTab;
    window.__tradeScoutResetState = resetTabState;

    // Listen for clear events from dashboard window
    window.addEventListener('tradescout_reset_extension_sessions', resetTabState);
    window.addEventListener('message', (event) => {
        if (event.data && (event.data.type === 'TRADESCOUT_CLEAR_ALL' || event.data.action === 'RESET_ALL_SESSIONS')) {
            resetTabState();
        }
    });

    // Message listener for popup / background commands
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'START_TAB_SCRAPE') {
            startScrapingOnThisTab(message.tabId, message.webhookUrl);
            const meta = getPageMetadata();
            sendResponse({ success: true, sessionTitle: meta.title });
            return true;
        }

        if (message.action === 'RESUME_TAB_SCRAPE') {
            resumeScrapingSession(message.session);
            sendResponse({ success: true });
            return true;
        }

        if (message.action === 'STOP_TAB_SCRAPE') {
            stopScrapingOnThisTab();
            sendResponse({ success: true });
            return true;
        }

        if (message.action === 'RESET_TAB_STATE') {
            resetTabState();
            sendResponse({ success: true });
            return true;
        }

        if (message.action === 'PING_TAB_STATUS') {
            const meta = getPageMetadata();
            const est = getEstimatedTotalFromPage();
            const isRunning = isTabScrapingActive && window.__tradeScoutIsScrapingActive;
            const isFinished = !isRunning && currentPercent === 100 && sentLinks.size > 0;
            const finalEst = isFinished ? sentLinks.size : (currentEstimatedTotal > 0 ? currentEstimatedTotal : est);

            sendResponse({
                isRunning: isRunning,
                totalScraped: sentLinks.size,
                estimatedTotal: finalEst,
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
