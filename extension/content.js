// TradeScout Content Script v4.1 Pro (Proven Fast In-Place Harvester & Accurate Data Extractor)
(function() {
    if (window.self !== window.top) return; // Skip iframes
    if (window.__tradeScoutInjected) return; // Prevent duplicate injection
    window.__tradeScoutInjected = true;

    console.log('TradeScout Content Script v4.1 Pro loaded on:', window.location.href);

    const SESSION_STORAGE_KEY = '__tradeScout_active_session';
    const STOPPED_FLAG_KEY = '__tradeScout_stopped';

    let isTabScrapingActive = false;
    window.__tradeScoutIsScrapingActive = false;
    let isScraperLoopRunning = false;
    let currentSessionEpoch = 0;
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
            return;
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
            sessionStorage.removeItem(STOPPED_FLAG_KEY);
        } catch (_) {}
    }

    function clearPersistedSession() {
        try {
            sessionStorage.removeItem(SESSION_STORAGE_KEY);
            sessionStorage.setItem(STOPPED_FLAG_KEY, 'true');
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
                const m = href.match(/[?&]page=(\d+)/i) || href.match(/page[=-](\d+)/i) || href.match(/\/(\d+)\/?$/);
                if (m && m[1]) {
                    const hNum = parseInt(m[1], 10);
                    if (!isNaN(hNum) && hNum > maxPage && hNum < 500) {
                        maxPage = hNum;
                    }
                }
            }
        } catch (_) {}

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
        
        if (item.closest('aside, .sidebar, header, footer, rz-viewed-goods, .recently-viewed, rz-similar-goods, rz-recommended-goods, rz-accessories, .catalog-banner, .advertising-slot, .main-goods__cell--advertising, rz-goods-sections, app-slider-goods, app-goods-carousel, rz-carousel')) {
            return true;
        }
        
        const tileClasses = (item.className || '').toLowerCase();
        if (tileClasses.includes('catalog-banner') || tileClasses.includes('banner-tile') || tileClasses.includes('advertising-slot')) {
            return true;
        }

        const linkTag = item.tagName === 'A' ? item : (item.querySelector('a.goods-tile__heading, a.tile-title, [class*="heading"] a, a[href*="/p/"], a[href*="/p-"], a[href*="/p"]') || item.querySelector('a[href]'));
        if (!linkTag) return true;

        const href = linkTag.getAttribute('href') || '';
        if (!href || href === '#' || href.startsWith('javascript:')) return true;

        return false;
    }

    // Fast, gentle background scroll to mount all lazy-loaded rows
    async function silentBackgroundScroll() {
        try {
            const docH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 1500);
            
            // 1. Scroll to middle
            const midY = Math.round(docH / 2);
            window.scrollTo(0, midY);
            window.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise(r => setTimeout(r, 150));

            // 2. Scroll to bottom of catalog
            const targetY = Math.max(0, docH - window.innerHeight);
            window.scrollTo(0, targetY);
            window.dispatchEvent(new Event('scroll', { bubbles: true }));

            // 3. Trigger last tile view to ensure Angular loads bottom items
            const allTiles = document.querySelectorAll('rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, app-goods-tile-default, rz-catalog-tiles-observer');
            if (allTiles.length > 0) {
                const lastTile = allTiles[allTiles.length - 1];
                lastTile.scrollIntoView({ behavior: 'auto', block: 'nearest' });
            }

            await new Promise(r => setTimeout(r, 200));
        } catch (_) {}
    }

    function parseReviewNumber(text) {
        if (!text || typeof text !== 'string') return 0;
        const clean = text.replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' ').replace(/\u202F/g, ' ').trim();
        
        const m1 = clean.match(/(\d+)\s*(?:відгук\w*|отзыв\w*|reviews?|відг\w*)/i);
        if (m1 && m1[1]) {
            const n = parseInt(m1[1], 10);
            if (!isNaN(n) && n > 0 && n < 100000) return n;
        }

        const m2 = clean.match(/[\(\[]\s*(\d+)\s*[\)\]]/);
        if (m2 && m2[1]) {
            const n = parseInt(m2[1], 10);
            if (!isNaN(n) && n > 0 && n < 100000) return n;
        }

        const digitsOnly = clean.replace(/\D/g, '');
        if (digitsOnly && digitsOnly.length > 0 && digitsOnly.length <= 6) {
            const n = parseInt(digitsOnly, 10);
            if (!isNaN(n) && n > 0 && n < 100000) return n;
        }

        return 0;
    }

    function extractReviews(item) {
        if (!item || !(item instanceof Element)) return 0;

        const reviewSelectors = [
            'a.goods-tile__reviews-link',
            'a[class*="reviews-link"]',
            'a[class*="comments-link"]',
            'a[href*="#comments"]',
            'a[href*="comments"]',
            'a[href*="reviews"]',
            '.goods-tile__reviews-link',
            'rz-rating a',
            'rz-rating-block a',
            '[class*="reviews-link"]',
            '[class*="comments-link"]',
            '[class*="reviews-count"]',
            '[class*="comments-count"]',
            '[class*="goods-tile__comments"]',
            '[class*="goods-tile__reviews"]',
            'a.rating-block-rating'
        ];

        for (const sel of reviewSelectors) {
            try {
                const el = item.querySelector(sel);
                if (el) {
                    const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
                    const count = parseReviewNumber(text);
                    if (count > 0) return count;
                }
            } catch (_) {}
        }

        try {
            const fullText = item.innerText || '';
            const match = fullText.match(/(\d+)\s*(?:відгук\w*|отзыв\w*|reviews?|відг\w*)/i);
            if (match && match[1]) {
                const n = parseInt(match[1], 10);
                if (!isNaN(n) && n > 0 && n < 100000) return n;
            }
        } catch (_) {}

        return 0;
    }

    function extractRating(item) {
        if (!item || !(item instanceof Element)) return 5.0;

        const starsEl = item.querySelector('.stars_rating, [data-testid="stars-rating"], .goods-tile__stars svg, [class*="stars"] svg, [class*="star"] [style*="width"], [class*="rating-stars"]');
        if (starsEl) {
            const style = starsEl.getAttribute('style') || '';
            const match = style.match(/width:\s*(?:calc\()?([\d.]+)%?/i);
            if (match && match[1]) {
                const pct = parseFloat(match[1]);
                if (!isNaN(pct) && pct > 0 && pct <= 100) {
                    return parseFloat((pct / 20).toFixed(1));
                }
            }
        }

        const ratingContainer = item.querySelector('rz-rating, .goods-tile__rating, [class*="goods-tile__rating"], [class*="rating-block"]');
        if (ratingContainer) {
            const label = (ratingContainer.getAttribute('aria-label') || ratingContainer.getAttribute('title') || '').trim();
            const m = label.match(/([\d][.,]\d)/);
            if (m && m[1]) {
                const score = parseFloat(m[1].replace(',', '.'));
                if (!isNaN(score) && score >= 1 && score <= 5) return score;
            }
        }

        const scoreEl = item.querySelector('.goods-tile__rating-score, .rating-score, [class*="rating-score"], [class*="rating-value"]');
        if (scoreEl && scoreEl.innerText) {
            const m = scoreEl.innerText.trim().match(/([\d][.,]\d)/);
            if (m && m[1]) {
                const score = parseFloat(m[1].replace(',', '.'));
                if (!isNaN(score) && score >= 1 && score <= 5) return score;
            }
        }

        return 5.0;
    }

    function extractSeller(item) {
        if (!item || !(item instanceof Element)) return 'Rozetka';

        const sellerSelectors = [
            '.goods-tile__seller b',
            '.goods-tile__seller a',
            '.goods-tile__seller-name',
            '.goods-tile__seller',
            'rz-goods-seller b',
            'rz-goods-seller a',
            'rz-goods-seller',
            'rz-seller b',
            'rz-seller a',
            'rz-seller',
            '[class*="goods-tile__seller"] b',
            '[class*="goods-tile__seller"] a',
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
                if (el) {
                    let s = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                    s = s.replace(/^продавець:?\s*/i, '')
                         .replace(/^продавец:?\s*/i, '')
                         .replace(/^seller:?\s*/i, '')
                         .replace(/^магазин:?\s*/i, '')
                         .trim();
                    if (s && s.length > 1 && s.length < 60) {
                        if (/^rozetka$/i.test(s) || s === 'Rozetka' || s === 'Розетка') {
                            return 'Rozetka';
                        }
                        return s;
                    }
                }
            } catch (_) {}
        }

        try {
            const attrSeller = item.getAttribute('data-seller') || item.getAttribute('data-merchant');
            if (attrSeller && attrSeller.trim().length > 1) {
                let s = attrSeller.trim();
                if (/^rozetka$/i.test(s) || s === 'Rozetka' || s === 'Розетка') return 'Rozetka';
                return s;
            }
        } catch (_) {}

        try {
            const itemText = (item.innerText || '').replace(/\s+/g, ' ');
            const match = itemText.match(/(?:продавець|продавец|seller)\s*:\s*([A-Za-zА-Яа-яІіЇїЄє0-9\s_\-\.]{2,40})/i);
            if (match && match[1]) {
                let s = match[1].trim();
                if (s && s.length > 1 && s.length < 60) {
                    if (/^rozetka$/i.test(s) || s === 'Rozetka' || s === 'Розетка') return 'Rozetka';
                    return s;
                }
            }
        } catch (_) {}

        return 'Rozetka';
    }

    function extractSmartSpecs(name, item) {
        if (!name) return 'Стандартні';
        const specsList = [];

        const capMatch = name.match(/(\d[\d\s]*\d|\d+)\s*(?:mah|мАг|маг|мА\*г)/i);
        if (capMatch) specsList.push(`${capMatch[1].replace(/\s/g, '')} mAh`);

        const powerMatch = name.match(/(\d+(?:\.\d+)?)\s*(?:W|Вт|вт|w)\b/);
        if (powerMatch) specsList.push(`${powerMatch[1]}W`);

        const storageMatch = name.match(/\b(\d+)\s*(?:GB|ГБ|TB|ТБ)\b/i);
        if (storageMatch) specsList.push(`${storageMatch[1].toUpperCase()}`);

        const screenMatch = name.match(/(\d{1,2}(?:[.,]\d)?)\s*(?:["”″]|дюйм|\bd\b)/i);
        if (screenMatch) specsList.push(`${screenMatch[1].replace(',', '.')}"`);

        if (/QC\s*3\.0|Quick\s*Charge|PD\s*\d*W?|Power\s*Delivery|MagSafe|GaN/i.test(name)) {
            const protoMatch = name.match(/(?:QC\s*3\.0|Quick\s*Charge|PD\s*\d*W?|Power\s*Delivery|MagSafe|GaN)/i);
            if (protoMatch) specsList.push(protoMatch[0]);
        }

        if (/Type-C|USB-C|Lightning|Micro-USB/i.test(name)) {
            const connMatch = name.match(/(?:Type-C|USB-C|Lightning|Micro-USB)/i);
            if (connMatch) specsList.push(connMatch[0]);
        }

        if (item && item instanceof Element) {
            const charElements = item.querySelectorAll('.goods-tile__short-desc, .goods-tile__characteristic, [class*="characteristic"], [class*="param"]');
            for (const cel of charElements) {
                const txt = (cel.innerText || '').replace(/\s+/g, ' ').trim();
                if (txt && txt.length > 2 && txt.length < 80 && !specsList.includes(txt)) {
                    specsList.push(txt);
                }
            }
        }

        return specsList.length > 0 ? specsList.slice(0, 5).join(', ') : 'Стандартні';
    }

    function buildNextPageUrl(currentUrl, targetPageNum) {
        if (!currentUrl) return '';
        let url = currentUrl.split('#')[0];
        
        if (url.includes('?')) {
            const [base, query] = url.split('?');
            const params = new URLSearchParams(query);
            params.set('page', String(targetPageNum));
            return `${base}?${params.toString()}`;
        }

        if (/\/page=\d+\/?/i.test(url)) {
            return url.replace(/\/page=\d+\/?/i, `/page=${targetPageNum}/`);
        }
        if (/;page=\d+\/?/i.test(url)) {
            return url.replace(/;page=\d+\/?/i, `;page=${targetPageNum}/`);
        }
        if (/\/page-\d+\/?/i.test(url)) {
            return url.replace(/\/page-\d+\/?/i, `/page-${targetPageNum}/`);
        }

        const clean = url.replace(/\/+$/, '');
        return `${clean}/page=${targetPageNum}/`;
    }

    function findPaginationActionElements(pageIndex) {
        const nextPageNum = pageIndex + 1;

        // Priority 1: "Show More" / "Показати ще" button
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
            } catch (_) {}
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
            } catch (_) {}
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
            } catch (_) {}
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

    async function scrapeCurrentDomItems(meta, pageIndex) {
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

        // Batch query Rozetka's official details API to enrich sellers, ratings, reviews, and precise pricing
        const apiProductMap = new Map();
        try {
            const productIds = [];
            for (const { link } of distinctTiles) {
                const m = link.match(/\/p(\d+)/i) || link.match(/p-(\d+)/i) || link.match(/\/(\d{5,})\//);
                if (m && m[1]) productIds.push(m[1]);
            }
            if (productIds.length > 0) {
                const apiUrl = `https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=${productIds.join(',')}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3000);
                const res = await fetch(apiUrl, { signal: controller.signal }).catch(() => null);
                clearTimeout(timeoutId);
                if (res && res.ok) {
                    const json = await res.json().catch(() => null);
                    if (json && Array.isArray(json.data)) {
                        for (const apiProd of json.data) {
                            if (apiProd && apiProd.id) {
                                apiProductMap.set(String(apiProd.id), apiProd);
                            }
                        }
                    }
                }
            }
        } catch (_) {}

        const newItems = [];

        for (const { item, linkTag, link } of distinctTiles) {
            try {
                const titleEl = item.querySelector('a.tile-title, a.goods-tile__heading, .goods-tile__heading, .tile-title, [class*="heading"], [class*="title"]') || linkTag;
                const name = titleEl && titleEl.innerText ? titleEl.innerText.trim() : (linkTag.innerText ? linkTag.innerText.trim() : '');
                if (!name || name.length < 3) continue;

                const idMatch = link.match(/\/p(\d+)/i) || link.match(/p-(\d+)/i) || link.match(/\/(\d{5,})\//);
                const prodId = idMatch ? String(idMatch[1]) : '';
                const apiProd = prodId ? apiProductMap.get(prodId) : null;

                // 1. Current Price
                let price = 0;
                const priceEl = item.querySelector(
                    '.goods-tile__price-value, .goods-tile__price--current, .goods-tile__price_color_red, ' +
                    '.price--red, .price, [class*="price-value"], [class*="price__current"], [class*="price_color_red"], ' +
                    '.product-price__big, [class*="price__main"], [class*="price-current"], .goods-tile__price'
                );
                const priceText = priceEl && priceEl.innerText ? priceEl.innerText : '';
                if (priceText) {
                    price = parseInt(priceText.replace(/\D/g, ''), 10) || 0;
                }
                if (!price && apiProd && apiProd.price) {
                    price = parseInt(String(apiProd.price).replace(/\D/g, ''), 10) || 0;
                }

                // 2. Old Price & Discount
                let oldPrice = 0;
                let discount = 0;

                if (apiProd) {
                    if (apiProd.old_price && Number(apiProd.old_price) > 0) {
                        const parsedOld = parseInt(String(apiProd.old_price).replace(/\D/g, ''), 10) || 0;
                        if (parsedOld > price) oldPrice = parsedOld;
                    } else if (apiProd.oldPrice && Number(apiProd.oldPrice) > 0) {
                        const parsedOld = parseInt(String(apiProd.oldPrice).replace(/\D/g, ''), 10) || 0;
                        if (parsedOld > price) oldPrice = parsedOld;
                    }

                    if (apiProd.discount) {
                        if (typeof apiProd.discount === 'number' && apiProd.discount > 0) {
                            discount = apiProd.discount;
                        } else if (typeof apiProd.discount === 'object' && apiProd.discount.value) {
                            discount = parseInt(apiProd.discount.value, 10) || 0;
                        }
                    }
                }

                if (!oldPrice) {
                    const oldPriceEl = item.querySelector(
                        '.goods-tile__price--old, .goods-tile__price_type_old, .goods-tile__price.type_old, ' +
                        '.goods-tile__price_color_gray, .goods-tile__price-old, [class*="price_color_gray"], ' +
                        '[class*="price--old"], [class*="price_type_old"], [class*="price-old"], [class*="old-price"], ' +
                        '[class*="price__old"], [class*="old_price"], [class*="price-discount"], [class*="product-price__small"], ' +
                        'del, s, strike, [style*="line-through"]'
                    );
                    if (oldPriceEl && oldPriceEl.innerText) {
                        const parsed = parseInt(oldPriceEl.innerText.replace(/\D/g, ''), 10) || 0;
                        if (parsed > price) oldPrice = parsed;
                    }
                }

                if (!discount) {
                    const badgeEl = item.querySelector(
                        'rz-badge, .goods-tile__badge, [class*="goods-tile__badge"], [class*="goods-tile__label"], ' +
                        '[class*="badge"], [class*="promo"], [class*="discount"], [class*="sticker"], [class*="tag"]'
                    );
                    const badgeText = badgeEl && badgeEl.innerText ? badgeEl.innerText : '';
                    const badgeMatch = badgeText.match(/(?:-|−|знижка\s*|скидка\s*)(\d{1,2})\s*%/i) || badgeText.match(/-(\d{1,2})%/);
                    if (badgeMatch && badgeMatch[1]) {
                        discount = parseInt(badgeMatch[1], 10) || 0;
                    }
                }

                if (oldPrice > price && !discount && price > 0) {
                    discount = Math.round(((oldPrice - price) / oldPrice) * 100);
                } else if (discount > 0 && (!oldPrice || oldPrice <= price) && price > 0) {
                    oldPrice = Math.round(price / (1 - (discount / 100)));
                }

                if (!oldPrice || oldPrice < price) {
                    oldPrice = price;
                }

                // 3. Reviews & Rating (API preferred, DOM fallback)
                let reviews = 0;
                let rating = 5.0;

                if (apiProd) {
                    if (typeof apiProd.comments_amount === 'number') reviews = apiProd.comments_amount;
                    else if (typeof apiProd.reviews_amount === 'number') reviews = apiProd.reviews_amount;
                    else if (typeof apiProd.comments_count === 'number') reviews = apiProd.comments_count;

                    if (typeof apiProd.comments_mark === 'number' && apiProd.comments_mark > 0) rating = apiProd.comments_mark;
                    else if (typeof apiProd.rating === 'number' && apiProd.rating > 0) rating = apiProd.rating;
                }

                if (!reviews) reviews = extractReviews(item);
                if (!rating || rating === 5.0) rating = extractRating(item);

                // 4. In-Stock
                let inStock = true;
                if (apiProd && typeof apiProd.sell_status === 'string') {
                    inStock = apiProd.sell_status !== 'unavailable' && apiProd.sell_status !== 'out_of_stock';
                } else {
                    const itemText = item.innerText || '';
                    inStock = !(item.classList.contains('tile-disabled') || itemText.includes('Немає в наявності'));
                }

                // 5. Smart Specifications
                const specs = extractSmartSpecs(name, item);

                // 6. Seller
                let seller = 'Rozetka';
                if (apiProd && apiProd.seller && apiProd.seller.title) {
                    seller = apiProd.seller.title.trim() || 'Rozetka';
                } else {
                    seller = extractSeller(item) || 'Rozetka';
                }

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

        persistSessionState(pageIndex);

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

    // Main multi-page traversal controller
    async function runTabScraper(initialPage) {
        currentSessionEpoch++;
        const myEpoch = currentSessionEpoch;
        isScraperLoopRunning = true;

        try {
            const meta = getPageMetadata();
            if (currentEstimatedTotal <= 0) {
                currentEstimatedTotal = getEstimatedTotalFromPage();
            }
            currentPage = initialPage || 1;
            console.log(`TradeScout Tab ${currentTabId}: Started scraping "${meta.title}" (Page ${currentPage})... Estimated total: ${currentEstimatedTotal}`);

            currentPercent = Math.min(100, Math.round((sentLinks.size / Math.max(1, currentEstimatedTotal)) * 100)) || 1;
            currentStatusMsg = `Збір: ${meta.title} (${sentLinks.size}/${currentEstimatedTotal})...`;

            let consecutiveNoGrowth = 0;
            let lastHarvestCount = sentLinks.size;
            const tileSelectors = 'ul.catalog-grid, rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], app-goods-tile-default';

            while (isTabScrapingActive && window.__tradeScoutIsScrapingActive && myEpoch === currentSessionEpoch) {
                if (currentEstimatedTotal <= 0) {
                    const latestEstimated = getEstimatedTotalFromPage();
                    if (latestEstimated > 0) {
                        currentEstimatedTotal = latestEstimated;
                    }
                }

                // 1. Background fast scroll to mount all lazy rows
                await silentBackgroundScroll();
                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive || myEpoch !== currentSessionEpoch) break;

                // 2. Scrape all new items in current DOM
                let batch = await scrapeCurrentDomItems(meta, currentPage);
                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive || myEpoch !== currentSessionEpoch) break;

                if (batch.length === 0) {
                    await new Promise(r => setTimeout(r, 350));
                    if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive || myEpoch !== currentSessionEpoch) break;
                    const extra = await scrapeCurrentDomItems(meta, currentPage);
                    if (extra.length > 0) {
                        batch = batch.concat(extra);
                    }
                }

                if (batch.length > 0 && isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
                    processAndReportHarvest(batch, meta, currentPage);
                }

                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive || myEpoch !== currentSessionEpoch) break;

                if (sentLinks.size > lastHarvestCount) {
                    consecutiveNoGrowth = 0;
                    lastHarvestCount = sentLinks.size;
                } else {
                    consecutiveNoGrowth++;
                }

                const latestEstimated = getEstimatedTotalFromPage();
                if (latestEstimated > currentEstimatedTotal) {
                    currentEstimatedTotal = latestEstimated;
                }

                // 3. Find next page action (Show More vs Next Page Link)
                const actionObj = findPaginationActionElements(currentPage);
                const hasNextPage = !!actionObj;

                if (!hasNextPage) {
                    const maxPossiblePages = Math.ceil(currentEstimatedTotal / 60);
                    if (currentPage < maxPossiblePages && consecutiveNoGrowth < 2) {
                        const fallbackNextPage = currentPage + 1;
                        const fallbackUrl = buildNextPageUrl(window.location.href, fallbackNextPage);
                        if (fallbackUrl && fallbackUrl !== window.location.href) {
                            console.log(`TradeScout Tab ${currentTabId}: Direct navigation to page ${fallbackNextPage} -> ${fallbackUrl}`);
                            persistSessionState(fallbackNextPage);
                            sendTabMessage({
                                action: 'tabProgress',
                                total: sentLinks.size,
                                page: fallbackNextPage,
                                percent: currentPercent,
                                statusMsg: `Завантаження стор. ${fallbackNextPage}...`,
                                syncedCount: sentLinks.size,
                                estimatedTotal: currentEstimatedTotal,
                                sessionTitle: meta.title,
                                category: meta.category,
                                sessionId: currentSessionId,
                                startTime: sessionStartTime,
                                sentLinks: Array.from(sentLinks),
                                webhookUrl: webhookEndpoint
                            });
                            window.location.href = fallbackUrl;
                            return;
                        }
                    }

                    if (consecutiveNoGrowth >= 2) {
                        console.log(`TradeScout Tab ${currentTabId}: Catalog finished with ${sentLinks.size} items.`);
                        break;
                    }
                }

                // 4. Trigger Page Transition via Click or Fallback
                let pageTransitionSuccess = false;
                const prevDomCount = document.querySelectorAll(tileSelectors).length;
                const prevHref = window.location.href;

                if (actionObj) {
                    currentStatusMsg = `Завантаження стор. ${currentPage + 1}...`;
                    persistSessionState(currentPage + 1);

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

                    dispatchSafeClick(actionObj.element);

                    for (let w = 0; w < 12; w++) {
                        if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive || myEpoch !== currentSessionEpoch) break;
                        await new Promise(r => setTimeout(r, 250));

                        // A. URL changed
                        if (window.location.href !== prevHref) {
                            pageTransitionSuccess = true;
                            break;
                        }

                        // B. DOM expanded (Show More in-place)
                        if (document.querySelectorAll(tileSelectors).length > prevDomCount) {
                            pageTransitionSuccess = true;
                            break;
                        }

                        // C. New unscraped tiles present in DOM
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
                        consecutiveNoGrowth = 0;
                        persistSessionState(currentPage);
                        continue;
                    }
                }

                // Direct URL fallback navigation if click did not navigate
                const targetPageNum = currentPage + 1;
                const directUrl = (actionObj && actionObj.href && actionObj.href.includes('page=')) ? (actionObj.href.startsWith('http') ? actionObj.href : `https://rozetka.com.ua${actionObj.href}`) : buildNextPageUrl(window.location.href, targetPageNum);
                if (directUrl && directUrl !== window.location.href) {
                    console.log(`TradeScout Tab ${currentTabId}: Direct navigation fallback to page ${targetPageNum} -> ${directUrl}`);
                    persistSessionState(targetPageNum);
                    window.location.href = directUrl;
                    return;
                }

                consecutiveNoGrowth++;
                if (consecutiveNoGrowth >= 2) {
                    break;
                }
            }

            // Scraping finished
            isTabScrapingActive = false;
            window.__tradeScoutIsScrapingActive = false;
            clearPersistedSession();
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
            if (myEpoch === currentSessionEpoch) {
                isScraperLoopRunning = false;
            }
        }
    }

    function startScrapingOnThisTab(tabId, customUrl) {
        isTabScrapingActive = true;
        window.__tradeScoutIsScrapingActive = true;
        currentSessionEpoch++;
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
        currentSessionEpoch++;
        currentTabId = session.tabId || currentTabId || Date.now();
        currentSessionId = session.sessionId || `session_${currentTabId}_${Date.now()}`;
        if (session.webhookUrl) webhookEndpoint = session.webhookUrl;

        sentLinks.clear();
        if (Array.isArray(session.sentLinks)) {
            session.sentLinks.forEach(link => sentLinks.add(link));
        }

        let urlPage = 1;
        const pageMatch = window.location.href.match(/[?&]page=(\d+)/i) || window.location.href.match(/page[=-](\d+)/i);
        if (pageMatch && pageMatch[1]) {
            urlPage = parseInt(pageMatch[1], 10) || 1;
        }
        currentPage = urlPage > 1 ? urlPage : (session.currentPage || 1);

        sessionStartTime = session.startTime || Date.now();
        currentEstimatedTotal = session.estimatedTotal || getEstimatedTotalFromPage();
        currentPercent = Math.min(100, Math.round((sentLinks.size / Math.max(1, currentEstimatedTotal)) * 100)) || 1;
        currentStatusMsg = `Збір (стор. ${currentPage}): ${sentLinks.size}/${currentEstimatedTotal}...`;

        persistSessionState(currentPage);

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
        currentSessionEpoch++;
        isScraperLoopRunning = false;
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

    function resetTabState() {
        isTabScrapingActive = false;
        window.__tradeScoutIsScrapingActive = false;
        currentSessionEpoch++;
        isScraperLoopRunning = false;
        clearPersistedSession();
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
            // First check immediate tab-level sessionStorage
            const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
            const isStopped = sessionStorage.getItem(STOPPED_FLAG_KEY) === 'true';

            if (raw && !isStopped) {
                try {
                    const parsed = JSON.parse(raw);
                    if (parsed && parsed.isRunning && Date.now() - (parsed.savedAt || 0) < 120000) {
                        console.log('TradeScout Content Script: Resuming session from tab sessionStorage on page load...', parsed);
                        setTimeout(() => {
                            resumeScrapingSession(parsed);
                        }, 250);
                        return;
                    }
                } catch (_) {}
            }

            // Fallback: Query background service worker
            chrome.runtime.sendMessage({ action: 'GET_TAB_SESSION_ON_LOAD' }, (res) => {
                if (chrome.runtime.lastError) {
                    const meta = getPageMetadata();
                    sendTabMessage({ action: 'tabIdle', sessionTitle: meta.title, category: meta.category });
                    return;
                }
                if (res && res.isRunning && res.session) {
                    console.log('TradeScout Content Script: Resuming session from background on page load...', res.session);
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
