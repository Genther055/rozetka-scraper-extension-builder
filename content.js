// TradeScout Content Script v3.5 Pro (Direct URL Traverser & Full-Catalog Harvester)
(function() {
    if (window.self !== window.top) return; // Skip iframes
    if (window.__tradeScoutInjected) return; // Prevent duplicate injection
    window.__tradeScoutInjected = true;

    console.log('TradeScout Content Script v3.5 Pro loaded on:', window.location.href);

    const SESSION_STORAGE_KEY = '__tradeScout_active_session';
    const TILE_SELECTORS = 'rz-product-tile, rz-catalog-tile, .goods-tile, li.catalog-grid__cell, [data-goods-id], app-goods-tile-default, article.goods-tile, div.goods-tile, article.content, rz-product-tile article, .catalog-grid__cell, rz-grid > *, ul.catalog-grid > li, .catalog-grid > div';

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
        
        // Match: "Знайдено 508 товарів" or "Знайдено 531 товар"
        const m1 = cleaned.match(/(?:знайдено|найдено|показано)?\s*([\d\s\u00A0\u202F.,]+)\s*(?:товар\w*|тов\w*)/i);
        if (m1 && m1[1]) {
            const num = parseInt(m1[1].replace(/[\s\u00A0\u202F.,]/g, ''), 10);
            if (!isNaN(num) && num > 0 && num < 1000000) return num;
        }

        // Match: "531 товар" or "508 товарів"
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

        const digitsOnly = cleaned.replace(/[^\d]/g, '');
        if (digitsOnly.length > 0) {
            const num = parseInt(digitsOnly, 10);
            if (!isNaN(num) && num > 0 && num < 1000000) return num;
        }

        return 0;
    }

    function getEstimatedTotalFromPage() {
        // Priority 1: Search top heading, counter, and settings elements
        const topElements = document.querySelectorAll(`
            rz-catalog-settings, .catalog-settings, .catalog-heading, .catalog-selection,
            [data-testid*="found"], [data-testid*="counter"], [data-testid*="total"],
            [class*="found-goods"], [class*="goods-count"], [class*="heading__goods"], [class*="total-goods"],
            .catalog-selection__label, [class*="selection__label"],
            h1, h2, rz-selected-filters, [class*="filters-tags"]
        `);
        for (const el of topElements) {
            if (el.closest('aside, .sidebar, rz-filter-stack, .sidebar-block, rz-section-slider, rz-viewed-goods, [class*="viewed"], .recently-viewed')) continue;
            const txt = (el.textContent || el.innerText || '').trim();
            if (txt.toLowerCase().includes('знайдено') || txt.toLowerCase().includes('найдено') || txt.toLowerCase().includes('товар')) {
                const count = parseCountFromText(txt);
                if (count > 0 && count < 1000000) return count;
            }
        }

        // Priority 2: Broad body scan for "Знайдено X товарів" or "X товарів" in header area
        try {
            const headerSection = document.querySelector('rz-category-page, rz-catalog, main, body');
            if (headerSection) {
                const fullText = (headerSection.innerText || '').slice(0, 3000);
                const count = parseCountFromText(fullText);
                if (count > 0 && count < 1000000) return count;
            }
        } catch (_) {}

        // Priority 3: Check pagination links (max page * 60)
        try {
            const pageLinks = document.querySelectorAll('a.pagination__link, [class*="pagination"] a, li.pagination__item a, rz-paginator a, [class*="paginator"] a');
            let maxPage = 1;
            pageLinks.forEach(link => {
                const txt = (link.textContent || '').trim();
                const num = parseInt(txt, 10);
                if (!isNaN(num) && num > maxPage && num < 500) {
                    maxPage = num;
                }
                const href = link.getAttribute('href') || '';
                const m = href.match(/page=(\d+)/i) || href.match(/\/(\d+)\/?$/);
                if (m && m[1]) {
                    const hNum = parseInt(m[1], 10);
                    if (!isNaN(hNum) && hNum > maxPage && hNum < 500) {
                        maxPage = hNum;
                    }
                }
            });
            if (maxPage > 1) {
                return maxPage * 60;
            }
        } catch (_) {}

        // Check if forward pagination button exists
        const hasForward = !!document.querySelector('a.pagination__direction--forward, a[rel="next"], [class*="pagination__direction_type_forward"], [class*="pagination__direction--forward"]');
        if (hasForward) {
            return 120;
        }

        return 60;
    }

    // Precise filter: eliminate only non-catalog containers (recently viewed sliders, recommendation carousels, sidebars, footers)
    function isUnwantedTile(item) {
        if (!item || !(item instanceof Element)) return true;
        
        // 1. Strictly exclude non-catalog containers (rz-section-slider, recently viewed, recommendations, sidebars, footers)
        const unwantedContainer = item.closest(`
            rz-section-slider, rz-goods-section-slider, rz-viewed-goods, .recently-viewed, .goods-viewed, rz-recent-goods, [data-testid="viewed-goods"],
            aside, .sidebar, rz-sidebar, 
            rz-goods-carousel, rz-carousel, rz-goods-slider, rz-slider, app-goods-carousel, app-slider, .goods-carousel,
            rz-similar-goods, rz-recommended-goods, rz-accessories,
            footer, header
        `);
        if (unwantedContainer) return true;

        // 2. Must have a valid product link
        const link = extractLink(item);
        if (!link) return true;

        return false;
    }

    // Comprehensive Title Extractor: finds title across all possible tags/attributes without dropping items
    function extractTitle(item, link) {
        if (!item || !(item instanceof Element)) return 'Товар Rozetka';
        
        // 1. Direct heading selectors (New Angular & Classic)
        const headingSelectors = [
            'a.tile-title', 'a[rztiletitle]', '.tile-title', 'a.goods-tile__heading', '.goods-tile__heading',
            'span.goods-tile__title', '.goods-tile__title', '[data-testid*="title"]', '[data-testid*="heading"]',
            '[class*="goods-tile__title"]', '[class*="goods-tile__heading"]', '[class*="heading"] a', '[class*="title"] a',
            'a[class*="heading"]', 'a[class*="title"]', 'rz-tile-title', 'a.goods-tile__title', 'h2', 'h3', 'h4'
        ];
        for (const sel of headingSelectors) {
            const el = item.querySelector(sel);
            if (el) {
                const txt = (el.innerText || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim();
                if (txt.length >= 3 && !txt.includes('₴')) return txt;
            }
        }

        // 2. Image host link
        const imgHost = item.querySelector('a.tile-image-host, [data-testid*="image-host"], a[title]');
        if (imgHost && imgHost.getAttribute('title') && imgHost.getAttribute('title').trim().length >= 3) {
            return imgHost.getAttribute('title').trim();
        }

        // 3. Image alt attribute
        const img = item.querySelector('img[alt], img.tile-image, [class*="image"] img');
        if (img && img.alt && img.alt.trim().length >= 3) {
            return img.alt.trim();
        }

        // 4. Any product link with text content
        const allLinks = item.querySelectorAll('a[href*="/p/"], a[href*="/p-"], a[href*="/p"], a[href]');
        for (const a of allLinks) {
            const txt = (a.innerText || a.getAttribute('title') || a.getAttribute('aria-label') || '').trim();
            if (txt.length >= 3 && !txt.includes('₴') && !txt.startsWith('http')) {
                return txt;
            }
        }

        // 5. Derive human-readable name from URL slug if present
        if (link) {
            const slugMatch = link.match(/rozetka\.com\.ua\/(?:ua\/)?([^\/]+)\/p\d+/i);
            if (slugMatch && slugMatch[1] && slugMatch[1].length >= 3) {
                const decoded = decodeURIComponent(slugMatch[1]).replace(/[-_]+/g, ' ').trim();
                if (decoded.length >= 3) return decoded;
            }
        }

        // 6. First valid text line in tile
        const lines = (item.innerText || '').split('\n').map(l => l.trim()).filter(l => l.length >= 3 && !l.includes('₴') && !l.includes('відгук') && !l.includes('наявності'));
        if (lines.length > 0) return lines[0];

        return 'Товар Rozetka';
    }

    // Extract product link with normalization
    function extractLink(item) {
        if (!item || !(item instanceof Element)) return '';
        const allLinks = Array.from(item.querySelectorAll('a[href]'));
        if (item.matches('a[href]')) allLinks.unshift(item);

        for (const a of allLinks) {
            const href = a.getAttribute('href');
            if (href && href.length > 2 && !href.startsWith('javascript:') && !href.startsWith('#')) {
                let link = href.split('?')[0].split('#')[0].replace(/\/+$/, '');
                if (!link.startsWith('http')) {
                    link = link.startsWith('/') ? `https://rozetka.com.ua${link}` : `https://rozetka.com.ua/${link}`;
                }
                link = link.replace('rozetka.com.ua/ua/', 'rozetka.com.ua/');
                if (link.includes('/p') || link.match(/\/\d{5,}/)) return link;
            }
        }
        return '';
    }

    // Paced Visual Inspector Scrolling through full page height
    async function silentBackgroundScroll() {
        try {
            let lastHeight = 0;
            let currentScroll = 0;
            const stepPx = 380; // steady, paced human-like steps
            const maxSteps = 30;

            for (let i = 0; i < maxSteps; i++) {
                const maxH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 2500);
                currentScroll = Math.min(maxH, currentScroll + stepPx);
                window.scrollTo({ top: currentScroll, behavior: 'smooth' });
                window.dispatchEvent(new Event('scroll'));
                document.dispatchEvent(new Event('scroll'));
                
                // Allow browser & Angular time to render components in the viewport
                await new Promise(r => setTimeout(r, 240));
                
                // Live computer vision / DOM geometry inspection of star fill in viewport
                captureVisualRatingsInViewport();

                if (currentScroll >= maxH && maxH === lastHeight) break;
                lastHeight = maxH;
            }

            window.scrollTo({ top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), behavior: 'smooth' });
            window.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 350));
            captureVisualRatingsInViewport();
        } catch (_) {}
    }

    // Trigger Rozetka's "Показати ще" button if present to mount remaining products on the current page
    async function triggerShowMoreAndWait() {
        try {
            const candidates = [];
            const showMoreSelectors = [
                'a.show-more',
                'button.show-more',
                'rz-button-show-more button',
                'rz-button-show-more a',
                'rz-button-show-more',
                '[data-testid="show-more-goods"]',
                '[data-testid*="show-more"]',
                '.show-more-button',
                '[class*="catalog-selection__btn"]',
                '[class*="catalog-grid__more"]',
                '[class*="show-more"]',
                '[class*="show_more"]'
            ];
            
            for (const sel of showMoreSelectors) {
                document.querySelectorAll(sel).forEach(el => candidates.push(el));
            }

            // Also search all buttons and links in main catalog area with matching text
            document.querySelectorAll('main a, main button, rz-catalog a, rz-catalog button, .catalog-grid a, .catalog-grid button, rz-paginator a, rz-paginator button, [class*="paginator"] a, [class*="paginator"] button, button, a').forEach(el => {
                if (el.classList.contains('pagination__link') || el.classList.contains('pagination__direction')) return;
                if (el.closest('header, footer, aside, rz-filter-stack, .sidebar, rz-sidebar')) return;
                const txt = (el.textContent || el.innerText || '').toLowerCase();
                if (/показати\s+ще|показать\s+еще|ще\s+\d+\s+товар|показати\s+більше|показать\s+больше/i.test(txt)) {
                    candidates.push(el);
                }
            });

            let clicked = false;
            for (const btn of candidates) {
                if (btn.classList.contains('pagination__link') || btn.classList.contains('pagination__direction')) continue;
                if (btn.closest('header, footer, aside, rz-filter-stack')) continue;

                btn.scrollIntoView({ behavior: 'auto', block: 'center' });
                window.dispatchEvent(new Event('scroll'));
                
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(evtType => {
                    try {
                        btn.dispatchEvent(new MouseEvent(evtType, { bubbles: true, cancelable: true, view: window }));
                    } catch (_) {}
                });
                try { btn.click(); } catch (_) {}
                clicked = true;
            }

            if (clicked) {
                await new Promise(r => setTimeout(r, 800));
                return true;
            }
        } catch (_) {}
        return false;
    }

    // Generate Rozetka-compliant Next Page URL
    function getRozetkaNextPageUrl(currentUrl, nextPg) {
        try {
            const u = new URL(currentUrl);
            // Search query parameters
            if (u.searchParams && (u.searchParams.has('text') || u.pathname.includes('/search'))) {
                u.searchParams.set('page', nextPg);
                return u.toString();
            }
            
            let path = u.pathname;
            // If page= already exists in pathname
            if (path.includes('page=')) {
                u.pathname = path.replace(/page=\d+/, `page=${nextPg}`);
                return u.toString();
            }
            
            // If category ID /c12345/ exists in path
            const catMatch = path.match(/\/(c\d+)\/(.*)/);
            if (catMatch) {
                const catId = catMatch[1];
                const rest = catMatch[2];
                if (rest && rest.length > 0) {
                    // Filtered catalog: /c387969/page=2;producer=xiaomi/
                    u.pathname = path.replace(`/${catId}/`, `/${catId}/page=${nextPg};`);
                } else {
                    // Simple catalog: /c387969/page=2/
                    u.pathname = path.replace(`/${catId}/`, `/${catId}/page=${nextPg}/`);
                }
                return u.toString();
            }

            // Fallback: append page=
            if (path.endsWith('/')) {
                u.pathname = `${path}page=${nextPg}/`;
            } else {
                u.pathname = `${path}/page=${nextPg}/`;
            }
            return u.toString();
        } catch (_) {
            return currentUrl;
        }
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

    // Directly extracts visual review count from DOM tile during page scrolling
    function extractReviewsFromDomTile(tileEl) {
        if (!tileEl || !(tileEl instanceof Element)) return 0;
        try {
            const tileRawText = (tileEl.innerText || tileEl.textContent || '');
            if (tileRawText.includes('Залишити відгук') || tileRawText.includes('Оставить отзыв')) {
                return 0;
            }

            // 1. Check inside rz-tile-rating or .goods-tile__rating
            const ratingEl = tileEl.querySelector('rz-tile-rating, .goods-tile__rating, app-rating, [class*="tile-rating"]');
            if (ratingEl) {
                const rzRevLink = ratingEl.querySelector('a.goods-tile__reviews-link, a[href*="comments"], [data-testid*="reviews"], [class*="reviews-link"], [class*="reviews-count"], button.reset-btn > span, button > span.text-sm, span.text-sm, a, button, span');
                if (rzRevLink && !rzRevLink.closest('rz-stars-rating-progress, [data-testid="stars-rating"]')) {
                    const linkText = (rzRevLink.textContent || rzRevLink.innerText || '').trim();
                    if (!linkText.includes('Залишити') && !linkText.includes('Оставить') && !linkText.includes('₴')) {
                        const countMatch = linkText.match(/(\d[\d\s\u00A0]*)/);
                        if (countMatch && countMatch[1]) {
                            const revVal = parseInt(countMatch[1].replace(/\D/g, ''), 10);
                            if (revVal > 0 && revVal < 500000) {
                                return revVal;
                            }
                        }
                    }
                }
            }

            // 2. Dedicated review link selectors anywhere on the tile
            const reviewElements = tileEl.querySelectorAll('a.goods-tile__reviews-link, a[href*="#comments"], a[href*="comments"], [class*="reviews-link"], [class*="reviews-count"], [data-testid*="reviews"]');
            for (const el of reviewElements) {
                if (el.closest('[class*="price"], del, s, strike, rz-promo-label, rz-tile-price, rz-stars-rating-progress, [class*="stars-rating"]')) continue;
                const t = (el.innerText || el.textContent || '').trim();
                if (t.includes('Залишити') || t.includes('Оставить') || t.includes('₴')) continue;
                const countMatch = t.match(/(\d[\d\s\u00A0]*)/);
                if (countMatch && countMatch[1]) {
                    const num = parseInt(countMatch[1].replace(/\D/g, ''), 10);
                    if (num > 0 && num < 500000) {
                        return num;
                    }
                }
            }
        } catch (_) {}
        return 0;
    }

    // Helper to resolve genuine rating from Rozetka Comments API and Schema.org
    async function fetchProductSchemaRating(productUrl, prodId) {
        if (!prodId && productUrl) {
            const m = productUrl.match(/\/p(\d+)/i) || productUrl.match(/p(\d+)/i) || productUrl.match(/\/(\d{5,})\//);
            if (m && m[1]) prodId = m[1];
        }

        // 1. Direct in-tab Comments API (Marks breakdown & stats e.g. 5★:5, 4★:1, 3★:1, 1★:1 -> 4.1)
        if (prodId) {
            const exactRating = await fetchExactProductRating(prodId);
            if (exactRating > 0 && exactRating <= 5) {
                return exactRating;
            }
        }

        // 2. Direct fetch of product HTML or comments HTML inside tab session
        if (productUrl || prodId) {
            const candidateUrls = [
                productUrl,
                prodId ? `https://rozetka.com.ua/p${prodId}/` : '',
                prodId ? `https://rozetka.com.ua/p${prodId}/comments/` : '',
                prodId ? `https://rozetka.com.ua/ua/p${prodId}/comments/` : ''
            ].filter(Boolean);

            for (const targetUrl of candidateUrls) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 3500);
                    const res = await fetch(targetUrl, { 
                        headers: { 'Accept': 'text/html,application/xhtml+xml' },
                        credentials: 'include',
                        signal: controller.signal 
                    }).catch(() => null);
                    clearTimeout(timeoutId);
                    if (res && res.ok) {
                        const text = await res.text().catch(() => '');
                        // 1. Strict Schema.org aggregateRating JSON-LD
                        const m = text.match(/aggregateRating["'\s]*:\s*\{[^}]*["']ratingValue["'\s]*:\s*"?([1-5](?:\.\d+)?)"?/i) ||
                                  text.match(/["']ratingValue["'\s]*:\s*"?([1-5](?:\.\d+)?)"?[^}]*aggregateRating/i);
                        if (m && m[1]) {
                            const val = parseFloat(m[1].replace(',', '.'));
                            if (val > 0 && val <= 5) return parseFloat(val.toFixed(1));
                        }
                        // 2. CSS width calculation in HTML
                        const wMatch = text.match(/<rz-stars-rating-progress[^>]*>[\s\S]*?style="[^"]*width:\s*(?:calc\(\s*)?([\d.]+)%[^"]*"[\s\S]*?<\/rz-stars-rating-progress>/i) ||
                                       text.match(/stars-rating-progress[^>]*style="[^"]*width:\s*(?:calc\(\s*)?([\d.]+)%/i);
                        if (wMatch && wMatch[1]) {
                            const percent = parseFloat(wMatch[1]);
                            if (percent > 0 && percent <= 100) {
                                return parseFloat(((percent / 100) * 5).toFixed(1));
                            }
                        }
                    }
                } catch (_) {}
            }
        }

        // 3. Request from background service worker
        try {
            const bgResponse = await new Promise(resolve => {
                chrome.runtime.sendMessage({
                    action: 'FETCH_SCHEMA_RATING',
                    url: productUrl,
                    prodId: prodId
                }, res => {
                    if (chrome.runtime.lastError || !res) resolve(null);
                    else resolve(res);
                });
            });
            if (bgResponse && bgResponse.rating > 0 && bgResponse.rating <= 5) {
                return bgResponse.rating;
            }
        } catch (_) {}

        return 0;
    }

    // Helper to fetch exact mathematical rating from Rozetka Comments API
    async function fetchExactProductRating(prodId) {
        if (!prodId) return 0;
        const endpoints = [
            `/api/goods-comments/v2/goods/${prodId}/marks`,
            `https://rozetka.com.ua/api/goods-comments/v2/goods/${prodId}/marks`,
            `/api/goods-comments/v2/goods/${prodId}/comments/stats`,
            `https://rozetka.com.ua/api/goods-comments/v2/goods/${prodId}/comments/stats`,
            `/api/goods-comments/v2/stats?goods_id=${prodId}`,
            `https://rozetka.com.ua/api/goods-comments/v2/stats?goods_id=${prodId}`
        ];

        for (const url of endpoints) {
            try {
                const res = await fetch(url, { 
                    headers: { 'Accept': 'application/json' },
                    credentials: 'include'
                }).catch(() => null);
                if (res && res.ok) {
                    const json = await res.json().catch(() => null);
                    if (json) {
                        const data = json.data || json;
                        const marks = data.marks || (Array.isArray(data) ? data : null);
                        if (marks) {
                            let totalMarks = 0;
                            let weightedSum = 0;
                            if (Array.isArray(marks)) {
                                for (const item of marks) {
                                    const star = Number(item.mark || item.star || item.rating || item.score) || 0;
                                    const cnt = Number(item.count || item.amount || item.total) || 0;
                                    if (star >= 1 && star <= 5 && cnt > 0) {
                                        totalMarks += cnt;
                                        weightedSum += cnt * star;
                                    }
                                }
                            } else if (typeof marks === 'object') {
                                for (let star = 1; star <= 5; star++) {
                                    const cnt = Number(marks[String(star)] ?? marks[star] ?? 0) || 0;
                                    if (cnt > 0) {
                                        totalMarks += cnt;
                                        weightedSum += cnt * star;
                                    }
                                }
                            }
                            if (totalMarks > 0) {
                                return parseFloat((weightedSum / totalMarks).toFixed(1));
                            }
                        }

                        if (typeof data.average_rating === 'number' && data.average_rating > 0 && data.average_rating <= 5) {
                            return parseFloat(data.average_rating.toFixed(1));
                        }

                        if (typeof data.rating === 'number' && data.rating > 0 && data.rating <= 5) {
                            return parseFloat(data.rating.toFixed(1));
                        }
                    }
                }
            } catch (_) {}
        }
        return 0;
    }

    // Global storage for visual ratings detected live during paced scroll
    const liveVisualRatingMap = new Map();

    // Live visual star-fill geometry inspector (Computer Vision & DOM Pixel Geometry)
    function measureVisualStarFill(tileEl) {
        if (!tileEl) return 0;
        try {
            // 1. Target progress star components
            const progressElements = tileEl.querySelectorAll('rz-stars-rating-progress, [class*="stars-rating-progress"], .goods-tile__stars, .goods-tile__rating, .stars-rating, app-rating');
            for (const container of progressElements) {
                if (container.closest('rz-product-seller, .product-seller, [class*="seller"], [class*="merchant"], [class*="shop"], [class*="store"], .seller-info')) continue;
                
                // Look for inner fill element (the golden active overlay)
                const fillEl = container.querySelector('.stars-rating-progress__fill, [class*="progress__fill"], [class*="fill"], div[style*="width"], span[style*="width"], svg[style*="width"]') || container;
                
                // Method A: Exact visual bounding box measurement in rendered pixels (Canvas / Geometry Vision)
                const trackRect = container.getBoundingClientRect();
                const fillRect = fillEl.getBoundingClientRect();
                if (trackRect.width > 20 && fillRect.width > 0) {
                    const ratio = Math.min(1, Math.max(0, fillRect.width / trackRect.width));
                    const visualScore = parseFloat((ratio * 5).toFixed(1));
                    if (visualScore >= 1.0 && visualScore <= 5.0) {
                        return visualScore;
                    }
                }

                // Method B: CSS style percentage width (e.g. style="width: calc(91.75% - 2px);" or style="width: 91.75%;")
                const styleAttr = fillEl.getAttribute('style') || container.getAttribute('style') || '';
                const m = styleAttr.match(/width:\s*(?:calc\(\s*)?([\d.]+)%/i);
                if (m && m[1]) {
                    const percent = parseFloat(m[1]);
                    if (percent > 0 && percent <= 100) {
                        const calculatedRating = parseFloat(((percent / 100) * 5).toFixed(1));
                        if (calculatedRating >= 1.0 && calculatedRating <= 5.0) {
                            return calculatedRating;
                        }
                    }
                }
            }
        } catch (_) {}
        return 0;
    }

    // Capture visual ratings of all products currently visible in the browser viewport
    function captureVisualRatingsInViewport() {
        try {
            const rawTiles = Array.from(document.querySelectorAll(TILE_SELECTORS));
            for (const tile of rawTiles) {
                if (isUnwantedTile(tile)) continue;
                const link = extractLink(tile);
                if (!link) continue;
                const m = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})\//);
                const prodId = m ? m[1] : link;

                const visualScore = measureVisualStarFill(tile);
                if (visualScore > 0 && visualScore <= 5) {
                    liveVisualRatingMap.set(prodId, visualScore);
                }
            }
        } catch (_) {}
    }

    // Directly extracts visual rating from discrete star elements or text attributes
    function extractStarsFromDomTile(tileEl) {
        if (!tileEl) return 0;

        try {
            // 0. Method: Real-time visual star fill measurement
            const visualFill = measureVisualStarFill(tileEl);
            if (visualFill > 0 && visualFill <= 5) {
                return visualFill;
            }

            // 1. Check explicit text rating or aria-label attributes (strictly excluding seller badge)
            const ratingContainers = tileEl.querySelectorAll('rz-tile-rating, rz-stars-rating-progress, rz-rating, app-rating, .goods-tile__rating, .goods-tile__stars, [class*="tile-rating"], [class*="stars-rating"], rz-product-comments-stats, .product-comments__rating, .comments-stats');
            for (const container of ratingContainers) {
                if (container.closest('rz-product-seller, .product-seller, [class*="seller"], [class*="merchant"], .seller-info')) continue;
                const labelText = container.getAttribute('aria-label') || container.getAttribute('title') || container.innerText || '';
                if (labelText && !/продавец|продавець|seller/i.test(labelText)) {
                    const m = labelText.match(/(?:оцінка(?:\s+користувачів)?|рейтинг|rating|score)?\s*([1-5](?:[.,]\d+)?)\s*(?:\/|з|\/5|з 5)\s*5?/i) || 
                              labelText.match(/\b([1-5](?:[.,]\d+)?)\s*(?:з|из|\/)\s*5\b/i) ||
                              labelText.match(/^([1-5]\.\d)$/);
                    if (m && m[1]) {
                        const num = parseFloat(m[1].replace(',', '.'));
                        if (!isNaN(num) && num >= 1.0 && num <= 5.0) {
                            return parseFloat(num.toFixed(1));
                        }
                    }
                }
            }

            // 2. Check discrete star elements (filled vs empty count)
            const starBlock = tileEl.querySelector('rz-stars-rating-progress, rz-tile-rating, [class*="stars-rating"], [class*="rating-block"], app-rating');
            if (starBlock && !starBlock.closest('rz-product-seller, .product-seller, [class*="seller"], [class*="merchant"]')) {
                const filledStars = starBlock.querySelectorAll('.star--filled, .star-filled, [class*="star-filled"], [class*="star_filled"], [class*="fill-yellow"], svg.text-yellow-400');
                const emptyStars = starBlock.querySelectorAll('.star--empty, .star-empty, [class*="star-empty"], [class*="star_empty"], [class*="fill-gray"], svg.text-gray-300, svg.text-gray-400');
                if (filledStars.length > 0 && emptyStars.length > 0 && (filledStars.length + emptyStars.length <= 6)) {
                    return filledStars.length;
                }
            }
        } catch (_) {}

        return 0;
    }

    // Extract raw Rozetka goods state from Angular SSR TransferState & JSON-LD
    function extractPageGoodsState() {
        const goodsMap = new Map();
        try {
            // 1. Angular Universal TransferState script <script id="serverApp-state">
            const serverStateEl = document.getElementById('serverApp-state');
            if (serverStateEl && serverStateEl.textContent) {
                let raw = serverStateEl.textContent;
                raw = raw.replace(/&q;/g, '"').replace(/&a;/g, '&').replace(/&s;/g, "'").replace(/&l;/g, '<').replace(/&g;/g, '>');
                try {
                    const stateObj = JSON.parse(raw);
                    const traverse = (obj) => {
                        if (!obj || typeof obj !== 'object') return;
                        if (Array.isArray(obj)) {
                            for (const item of obj) {
                                if (item && item.id) {
                                    const prev = goodsMap.get(String(item.id)) || {};
                                    let itemRating = 0;
                                    if (item.marks && typeof item.marks === 'object') {
                                        let totalMarks = 0, weightedSum = 0;
                                        if (Array.isArray(item.marks)) {
                                            for (const mItem of item.marks) {
                                                const star = Number(mItem.mark || mItem.star) || 0;
                                                const cnt = Number(mItem.count || mItem.amount) || 0;
                                                if (star >= 1 && star <= 5 && cnt > 0) {
                                                    totalMarks += cnt;
                                                    weightedSum += cnt * star;
                                                }
                                            }
                                        } else {
                                            for (let star = 1; star <= 5; star++) {
                                                const count = Number(item.marks[String(star)]) || Number(item.marks[star]) || 0;
                                                totalMarks += count;
                                                weightedSum += count * star;
                                            }
                                        }
                                        if (totalMarks > 0) {
                                            itemRating = parseFloat((weightedSum / totalMarks).toFixed(1));
                                        }
                                    }
                                    goodsMap.set(String(item.id), {
                                        ...prev,
                                        id: String(item.id),
                                        comments_amount: item.comments_amount || prev.comments_amount,
                                        rating: itemRating > 0 ? itemRating : prev.rating,
                                        stars_rating: itemRating > 0 ? itemRating : prev.stars_rating
                                    });
                                }
                                traverse(item);
                            }
                        } else {
                            if (obj.id) {
                                const prev = goodsMap.get(String(obj.id)) || {};
                                let itemRating = 0;
                                if (obj.marks && typeof obj.marks === 'object') {
                                    let totalMarks = 0, weightedSum = 0;
                                    if (Array.isArray(obj.marks)) {
                                        for (const mItem of obj.marks) {
                                            const star = Number(mItem.mark || mItem.star) || 0;
                                            const cnt = Number(mItem.count || mItem.amount) || 0;
                                            if (star >= 1 && star <= 5 && cnt > 0) {
                                                totalMarks += cnt;
                                                weightedSum += cnt * star;
                                            }
                                        }
                                    } else {
                                        for (let star = 1; star <= 5; star++) {
                                            const count = Number(obj.marks[String(star)]) || Number(obj.marks[star]) || 0;
                                            totalMarks += count;
                                            weightedSum += count * star;
                                        }
                                    }
                                    if (totalMarks > 0) itemRating = parseFloat((weightedSum / totalMarks).toFixed(1));
                                }
                                goodsMap.set(String(obj.id), {
                                    ...prev,
                                    id: String(obj.id),
                                    comments_amount: obj.comments_amount || prev.comments_amount,
                                    rating: itemRating > 0 ? itemRating : prev.rating,
                                    stars_rating: itemRating > 0 ? itemRating : prev.stars_rating
                                });
                            }
                            for (const key of Object.keys(obj)) {
                                traverse(obj[key]);
                            }
                        }
                    };
                    traverse(stateObj);
                } catch (_) {}
            }

            // 2. JSON-LD scripts
            const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of ldScripts) {
                try {
                    const ld = JSON.parse(script.textContent || '{}');
                    const processLd = (node) => {
                        if (!node || typeof node !== 'object') return;
                        if (Array.isArray(node)) {
                            for (const n of node) processLd(n);
                            return;
                        }
                        if (node['@graph']) processLd(node['@graph']);
                        if (node.itemListElement) processLd(node.itemListElement);
                        if (node.item) processLd(node.item);
                        
                        if (node.aggregateRating) {
                            const rawId = node.sku || node.productID || node.mpn || node.identifier || '';
                            const m = String(rawId).match(/^(\d{5,})$/) || (node.url || node.name || script.textContent).match(/\/p(\d+)/i) || (node.url || '').match(/\/(\d{5,})\//) || window.location.href.match(/\/p(\d+)/i) || window.location.href.match(/\/(\d{5,})\//);
                            const ratingVal = typeof node.aggregateRating.ratingValue === 'number' 
                                ? node.aggregateRating.ratingValue 
                                : parseFloat(String(node.aggregateRating.ratingValue || '').replace(',', '.'));
                            const revCount = parseInt(String(node.aggregateRating.reviewCount || node.aggregateRating.ratingCount || 0), 10);
                            const pId = m ? String(m[1]) : (rawId ? String(rawId) : '');
                            if (pId && ratingVal > 0 && ratingVal <= 5) {
                                const prev = goodsMap.get(pId) || {};
                                goodsMap.set(pId, {
                                    ...prev,
                                    id: pId,
                                    stars_rating: ratingVal,
                                    rating: ratingVal,
                                    comments_amount: revCount || prev.comments_amount
                                });
                            }
                        }
                    };
                    processLd(ld);
                } catch (_) {}
            }

            // 3. Direct DOM User Comments Marks & Rating on Product Page (e.g. "Оцінка користувачів 4.6/5 ★" or seller "4.6/5 ★ 84 оцінок")
            try {
                const pageIdMatch = window.location.href.match(/\/p(\d+)/i) || window.location.href.match(/\/(\d{5,})\//);
                if (pageIdMatch && pageIdMatch[1]) {
                    const pageProdId = pageIdMatch[1];
                    const prev = goodsMap.get(pageProdId) || {};

                    // Look for exact "Оцінка користувачів X.X/5" element ONLY inside product comments stats
                    const userRatingNodes = document.querySelectorAll('rz-product-comments-stats, .product-comments__rating, .comments-stats, .product-comments-marks, [class*="comments-stats"], [class*="comments-marks"], [class*="product-comments"], [class*="rating-score"]');
                    let foundDomRating = 0;
                    for (const uNode of userRatingNodes) {
                        if (uNode.closest('rz-product-seller, .product-seller, [class*="seller"], [class*="merchant"]')) continue;
                        
                        // Check CSS width in stars progress inside comments
                        const widthEls = uNode.querySelectorAll('[style*="width"]');
                        for (const wEl of widthEls) {
                            const mWidth = (wEl.getAttribute('style') || '').match(/width:\s*(?:calc\(\s*)?([\d.]+)%/i);
                            if (mWidth && mWidth[1]) {
                                const percent = parseFloat(mWidth[1]);
                                if (percent > 0 && percent <= 100) {
                                    foundDomRating = parseFloat(((percent / 100) * 5).toFixed(1));
                                    break;
                                }
                            }
                        }
                        if (foundDomRating > 0) break;

                        const txt = (uNode.innerText || uNode.textContent || '').trim();
                        if (/продавец|продавець|seller/i.test(txt)) continue;
                        const m = txt.match(/оцінка(?:\s+користувачів)?\s*([1-5](?:[.,]\d+)?)\s*(?:\/|з|\/5|з 5)\s*5?/i);
                        if (m && m[1]) {
                            const val = parseFloat(m[1].replace(',', '.'));
                            if (val > 0 && val <= 5) {
                                foundDomRating = val;
                                break;
                            }
                        }
                    }
                    if (foundDomRating > 0) {
                        goodsMap.set(pageProdId, {
                            ...prev,
                            id: pageProdId,
                            stars_rating: foundDomRating,
                            rating: foundDomRating
                        });
                    }
                }
            } catch (_) {}
        } catch (_) {}
        return goodsMap;
    }

    async function scrapeCurrentDomItems(meta, pageIndex) {
        // Query tiles across entire main content area (filtering non-catalog via isUnwantedTile)
        let rawTiles = Array.from(document.querySelectorAll(TILE_SELECTORS));

        // Filter out unwanted slider/carousel/banner/viewed elements and avoid duplicates
        const distinctTiles = [];
        const seenElements = new Set();

        for (const item of rawTiles) {
            if (isUnwantedTile(item)) continue;
            
            const link = extractLink(item);
            if (!link) continue;

            const name = extractTitle(item, link);
            if (!name || name.length < 2) continue;

            if (sentLinks.has(link) || seenElements.has(link)) continue;
            seenElements.add(link);
            distinctTiles.push({ item, link, name });
        }

        // Product page fallback (when user triggers scraper on a single product page e.g. /p470077279/)
        if (distinctTiles.length === 0) {
            const isProductPage = !!document.querySelector('rz-product, .product-about, [class*="product-main"], [class*="product-header"]') || /\/p\d+/i.test(window.location.href);
            if (isProductPage) {
                const productMain = document.querySelector('rz-product, .product-about, main, body') || document.body;
                const link = window.location.href.split('?')[0].split('#')[0];
                const h1 = document.querySelector('h1');
                const name = extractTitle(productMain, link) || (h1 ? h1.innerText.trim() : '');
                if (name && !sentLinks.has(link)) {
                    distinctTiles.push({ item: productMain, link, name });
                }
            }
        }

        if (distinctTiles.length === 0) return [];

        // 1. Extract embedded goods state from page
        const pageGoodsMap = extractPageGoodsState();

        // 2. Batch fetch official Rozetka product details & exact ratings
        const apiProductMap = new Map();
        const exactRatingMap = new Map();

        // Check if pageGoodsMap already has exact ratings/marks
        for (const { link } of distinctTiles) {
            const m = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})\//);
            if (m && m[1]) {
                const prodId = m[1];
                const pg = pageGoodsMap.get(prodId);
                if (pg && pg.rating && pg.rating > 0) {
                    exactRatingMap.set(prodId, pg.rating);
                }
            }
        }

        try {
            const productIds = [];
            for (const { link } of distinctTiles) {
                const m = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})\//);
                if (m && m[1]) productIds.push(m[1]);
            }
            if (productIds.length > 0) {
                // Batch fetch general product details (seller, price, stock) - zero rate-limit risk
                const chunkSize = 60;
                for (let i = 0; i < productIds.length; i += chunkSize) {
                    const chunk = productIds.slice(i, i + chunkSize);
                    const apiUrl = `https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=${chunk.join(',')}`;
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

                // Fetch genuine ratings from Schema.org microdata & Comments API for all items with reviews
                const prodsNeedingRating = [];
                for (const { item, link } of distinctTiles) {
                    const m = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})\//);
                    if (m && m[1]) {
                        const prodId = m[1];
                        const apiItem = apiProductMap.get(prodId);
                        const domRev = extractReviewsFromDomTile(item);
                        const revCount = (apiItem && apiItem.comments_amount !== undefined) ? parseInt(String(apiItem.comments_amount), 10) : domRev;
                        if (revCount > 0 && !exactRatingMap.has(prodId)) {
                            prodsNeedingRating.push({ link, prodId, revCount });
                        }
                    }
                }

                if (prodsNeedingRating.length > 0) {
                    const fetchChunks = [];
                    for (let i = 0; i < prodsNeedingRating.length; i += 8) {
                        fetchChunks.push(prodsNeedingRating.slice(i, i + 8));
                    }
                    for (const chunk of fetchChunks) {
                        await Promise.allSettled(chunk.map(async ({ link, prodId }) => {
                            const exact = await fetchProductSchemaRating(link, prodId);
                            if (exact > 0) {
                                exactRatingMap.set(prodId, exact);
                            }
                        }));
                    }
                }
            }
        } catch (_) {}

        const newItems = [];

        for (const { item, link, name } of distinctTiles) {
            try {
                const idMatch = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})\//);
                const prodId = idMatch ? String(idMatch[1]) : '';
                const apiDetails = prodId ? apiProductMap.get(prodId) : null;

                // 1. Current Price (Triple-layer Bulletproof Resolution)
                let price = 0;

                // Layer 1: Dedicated DOM Selectors
                const priceSelectors = [
                    'rz-tile-price .price',
                    '.price.color-red',
                    '.goods-tile__price-value',
                    '.goods-tile__price.price_color_red',
                    '.goods-tile__price',
                    'rz-price',
                    'app-price',
                    '.price:not(.old-price):not([class*="old"])',
                    '[class*="price-value"]',
                    '[class*="price__value"]',
                    '[class*="price__current"]',
                    '[class*="price_type_current"]',
                    '[data-testid*="price"]'
                ];
                for (const sel of priceSelectors) {
                    const el = item.querySelector(sel);
                    if (el && el.innerText) {
                        if (el.closest('.goods-tile__price--old, .old-price, [class*="old"], del, s, strike')) continue;
                        const val = parseInt(el.innerText.replace(/\D/g, ''), 10) || 0;
                        if (val > 0) {
                            price = val;
                            break;
                        }
                    }
                }

                // Layer 2: Text RegEx with currency symbol ₴ or грн
                if (price <= 0) {
                    const tileText = (item.innerText || item.textContent || '');
                    const mPrice = tileText.match(/(\d[\d\s\u00A0\u202F.,]*)\s*(?:₴|грн|uah)/i);
                    if (mPrice && mPrice[1]) {
                        const val = parseInt(mPrice[1].replace(/\D/g, ''), 10) || 0;
                        if (val > 0) price = val;
                    }
                }

                // Layer 3: Official Rozetka API Backend Details
                if (price <= 0 && apiDetails) {
                    if (apiDetails.price) {
                        price = parseInt(String(apiDetails.price).replace(/\D/g, ''), 10) || 0;
                    }
                    if (price <= 0 && apiDetails.old_price) {
                        price = parseInt(String(apiDetails.old_price).replace(/\D/g, ''), 10) || 0;
                    }
                }

                // 2. Discount & Old Price
                let discount = 0;
                const promoBadges = item.querySelectorAll('rz-promo-label, .promo-label, [class*="promo-label"], .goods-tile__badge, [class*="badge"]');
                for (const p of promoBadges) {
                    const txt = (p.textContent || '').trim();
                    const match = txt.match(/[−–-](\d+)\s*%/);
                    if (match) {
                        discount = parseInt(match[1], 10);
                        break;
                    }
                }

                const oldPriceSelectors = [
                    'rz-tile-price .old-price',
                    '.old-price',
                    '.goods-tile__price--old',
                    '.goods-tile__price.type_old',
                    '.goods-tile__price_type_old',
                    '[class*="price--old"]',
                    '[class*="price_type_old"]',
                    '[class*="old-price"]',
                    '.price--old',
                    'del', 's', 'strike'
                ];
                let oldPrice = 0;
                for (const sel of oldPriceSelectors) {
                    const el = item.querySelector(sel);
                    if (el && el.innerText) {
                        const val = parseInt(el.innerText.replace(/\D/g, ''), 10) || 0;
                        if (val > price) {
                            oldPrice = val;
                            break;
                        }
                    }
                }

                if (!oldPrice && apiDetails && apiDetails.old_price) {
                    const apiOld = parseInt(String(apiDetails.old_price).replace(/\D/g, ''), 10) || 0;
                    if (apiOld > price) oldPrice = apiOld;
                }

                if (oldPrice > price && discount === 0) {
                    discount = Math.round(((oldPrice - price) / oldPrice) * 100);
                } else if (discount > 0 && (!oldPrice || oldPrice <= price) && price > 0) {
                    oldPrice = Math.round(price / (1 - (discount / 100)));
                }

                // 3. Reviews Count directly from DOM Tile during page scrolling
                let reviews = extractReviewsFromDomTile(item);
                if (reviews === 0 && apiDetails && apiDetails.comments_amount) {
                    reviews = parseInt(String(apiDetails.comments_amount), 10) || 0;
                }

                // 4. Rating (1.0 to 5.0) - Exact Math Marks / Comments Stats + DOM Active Stars
                let rating = 0;

                if (reviews === 0) {
                    rating = 0;
                } else {
                    // Priority 0: Real-time visual star-fill geometry detected during paced scrolling
                    if (prodId && liveVisualRatingMap.has(prodId) && liveVisualRatingMap.get(prodId) > 0) {
                        rating = liveVisualRatingMap.get(prodId);
                    }

                    // Priority 1: Direct Rozetka Comments Marks API or Precomputed Exact Map
                    if (rating === 0 && prodId && exactRatingMap.has(prodId) && exactRatingMap.get(prodId) > 0) {
                        rating = exactRatingMap.get(prodId);
                    }

                    // Priority 2: Page Goods State from Angular SSR TransferState & JSON-LD
                    if (rating === 0 && prodId && pageGoodsMap.has(prodId)) {
                        const pg = pageGoodsMap.get(prodId);
                        if (pg && pg.rating && pg.rating > 0) {
                            rating = pg.rating;
                        }
                    }

                    // Priority 3: Direct DOM discrete filled stars or width on the tile
                    if (rating === 0) {
                        const domStars = extractStarsFromDomTile(item, reviews);
                        if (domStars > 0 && domStars <= 5) {
                            rating = domStars;
                        }
                    }

                    // Priority 4: Dedicated Product Comment Rating Element (excluding any seller/merchant block)
                    if (rating === 0) {
                        const commentRatingEls = item.querySelectorAll('rz-product-comments-stats, .product-comments__rating, .comments-stats, rz-product-comment-rating');
                        for (const commentRatingEl of commentRatingEls) {
                            if (commentRatingEl.closest('rz-product-seller, .product-seller, [class*="seller"], [class*="merchant"], [class*="shop"], [class*="store"], .seller-info')) continue;
                            
                            // Check CSS width first
                            const wEls = commentRatingEl.querySelectorAll('[style*="width"]');
                            for (const wEl of wEls) {
                                const mWidth = (wEl.getAttribute('style') || '').match(/width:\s*(?:calc\(\s*)?([\d.]+)%/i);
                                if (mWidth && mWidth[1]) {
                                    const percent = parseFloat(mWidth[1]);
                                    if (percent > 0 && percent <= 100) {
                                        rating = parseFloat(((percent / 100) * 5).toFixed(1));
                                        break;
                                    }
                                }
                            }
                            if (rating > 0) break;

                            const boldSpan = commentRatingEl.querySelector('.font-bold, b, strong, [class*="bold"]') || commentRatingEl;
                            const t = (boldSpan.textContent || boldSpan.innerText || '').trim();
                            if (/продавец|продавець|seller|магазин/i.test(t)) continue;
                            const m = t.match(/оцінка(?:\s+користувачів)?\s*([1-5](?:[.,]\d+)?)\s*(?:\/|з|\/5|з 5)\s*5?/i) || t.match(/([1-5](?:[.,]\d+)?)\s*(?:з|из|\/)\s*5/i);
                            if (m && m[1]) {
                                const val = parseFloat(m[1].replace(',', '.'));
                                if (val > 0 && val <= 5) {
                                    rating = parseFloat(val.toFixed(1));
                                    break;
                                }
                            }
                        }
                    }
                }

                // Final clean rating formatting
                if (reviews === 0 || rating < 0 || rating > 5) {
                    rating = 0;
                } else {
                    rating = parseFloat(rating.toFixed(1));
                    console.log(`[TradeScout Scraper] Tile "${name.slice(0, 30)}": reviews=${reviews}, rating=${rating}`);
                }

                let questions = 0;
                if (apiDetails && apiDetails.questions_amount) {
                    questions = parseInt(String(apiDetails.questions_amount), 10) || 0;
                }

                const itemText = item.innerText || '';
                let inStock = !(item.classList.contains('tile-disabled') || itemText.includes('Немає в наявності') || itemText.includes('Нет в наличии'));
                if (apiDetails && apiDetails.sell_status) {
                    inStock = (apiDetails.sell_status !== 'unavailable');
                }

                // Extract all available DOM params and chips
                const detailedSpecsMap = {};
                const paramNodes = item.querySelectorAll('.goods-tile__params li, .goods-tile__param, [class*="param-item"], [class*="tag"], [class*="characteristic"]');
                paramNodes.forEach(pn => {
                    const pText = (pn.innerText || '').trim();
                    if (pText && pText.includes(':')) {
                        const [k, v] = pText.split(':').map(x => x.trim());
                        if (k && v) detailedSpecsMap[k] = v;
                    }
                });

                const capacityMatch = name.match(/(?:^|[^\d])(\d{1,3}(?:\s\d{3})+|\d{3,6})\s*(?:mah|мАг|мАч|мah)\b/i);
                if (capacityMatch && !detailedSpecsMap['Ємність']) {
                    let cNum = parseInt(capacityMatch[1].replace(/\s+/g, ''), 10);
                    if (cNum > 100000) {
                        const s = String(cNum);
                        if (/^[1-9](10000|20000|30000|40000|50000|60000|100000|26800|15000)$/.test(s)) {
                            cNum = parseInt(s.slice(1), 10);
                        }
                    }
                    if (!isNaN(cNum)) detailedSpecsMap['Ємність'] = `${cNum.toLocaleString('uk-UA')} mAh`;
                }

                const powerMatch = name.match(/\b(\d+(?:\.\d+)?)\s*(?:W|Вт)\b/i);
                if (powerMatch && !detailedSpecsMap['Потужність']) {
                    detailedSpecsMap['Потужність'] = `${powerMatch[1]}W`;
                }

                // Brand detection
                const knownBrands = ['Xiaomi', 'Redmi', 'Baseus', 'Apple', 'Samsung', 'Anker', 'Hoco', 'Borofone', 'Romoss', 'Remax', 'Joyroom', 'ColorWay', '2E', 'Gelius', 'Ugreen', 'ZMI', 'Belkin', 'Choetech', 'Promate', 'Vinga', 'Defender', 'Canyon', 'BLUETTI', 'EcoFlow', 'Jackery'];
                for (const b of knownBrands) {
                    if (new RegExp(`\\b${b}\\b`, 'i').test(name)) {
                        detailedSpecsMap['Бренд'] = b;
                        break;
                    }
                }

                const specs = Object.entries(detailedSpecsMap).map(([k, v]) => `${k}: ${v}`).join('; ') || (capacityMatch ? `${capacityMatch[1]} mAh` : 'Стандартні');

                let seller = 'Rozetka';
                let sellerRating = 0;
                let sellerReviews = 0;
                if (apiDetails && apiDetails.seller) {
                    seller = (apiDetails.seller.title || apiDetails.seller.name || '').trim() || 'Rozetka';
                    if (apiDetails.seller.rating) sellerRating = parseFloat(String(apiDetails.seller.rating)) || 0;
                    if (apiDetails.seller.feedbacks) sellerReviews = parseInt(String(apiDetails.seller.feedbacks), 10) || 0;
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
                    questions,
                    inStock,
                    category: meta.category,
                    sessionTitle: meta.title,
                    sessionId: currentSessionId,
                    specs,
                    detailedSpecsMap,
                    description: '',
                    seller,
                    sellerRating,
                    sellerReviews,
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

    // Main scraping runner
    async function runTabScraper(initialPage) {
        const meta = getPageMetadata();
        currentPage = initialPage || 1;

        // Dynamically establish or refresh estimated total
        const detectedEst = getEstimatedTotalFromPage();
        if (detectedEst > currentEstimatedTotal) {
            currentEstimatedTotal = detectedEst;
        }
        if (currentEstimatedTotal <= 0) {
            currentEstimatedTotal = 60;
        }

        console.log(`TradeScout Tab ${currentTabId}: Started scraping "${meta.title}" (Page ${currentPage})... Target Total: ${currentEstimatedTotal}`);

        currentPercent = Math.min(100, Math.round((sentLinks.size / Math.max(1, currentEstimatedTotal)) * 100)) || 1;
        currentStatusMsg = `Збір: ${meta.title} (${sentLinks.size}/${currentEstimatedTotal})...`;

        // Check if forward pagination exists on Rozetka
        const nextPg = currentPage + 1;
        const targetUrl = getRozetkaNextPageUrl(window.location.href, nextPg);
        const hasNextPageInDom = !!document.querySelector(`
            a.pagination__direction--forward, 
            a[rel="next"], 
            [class*="pagination__direction_type_forward"], 
            [class*="pagination__direction--forward"],
            a.pagination__link[href*="page=${nextPg}"], 
            a.pagination__link[href*="page=${nextPg};"], 
            [class*="paginator"] a[href*="page=${nextPg}"],
            a[href*="page=${nextPg}"],
            a[href*="page=${nextPg};"]
        `);

        // Target for this page: if there's a next page or total > 60, target is 60 items. Otherwise remaining category items.
        let targetForThisPage = 60;
        if (currentEstimatedTotal > 0 && !hasNextPageInDom) {
            const remaining = currentEstimatedTotal - sentLinks.size;
            if (remaining > 0 && remaining < 60) {
                targetForThisPage = remaining;
            }
        }

        // Continuous adaptive incremental harvesting across lazy chunks
        const pageNewProducts = [];
        const pageLinksSeen = new Set();

        const harvestBatch = async () => {
            captureVisualRatingsInViewport();
            const batch = await scrapeCurrentDomItems(meta, currentPage);
            for (const item of batch) {
                if (item.link && !pageLinksSeen.has(item.link)) {
                    pageLinksSeen.add(item.link);
                    pageNewProducts.push(item);
                }
            }
        };

        // Round 0: Initial harvest of immediately mounted tiles
        await harvestBatch();

        // Progressive harvesting cycles (scroll down, trigger lazy-load & show-more until target reached)
        let consecutiveNoNewRounds = 0;
        let lastItemCount = pageNewProducts.length;

        for (let round = 0; round < 30 && pageNewProducts.length < targetForThisPage; round++) {
            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) return;

            // 1. Scroll directly to the bottom-most product tile in the current catalog
            const currentTiles = Array.from(document.querySelectorAll(TILE_SELECTORS));
            if (currentTiles.length > 0) {
                const lastTile = currentTiles[currentTiles.length - 1];
                lastTile.scrollIntoView({ behavior: 'smooth', block: 'end' });
            } else {
                const scrollY = Math.min(document.body.scrollHeight, (round + 1) * 750);
                window.scrollTo({ top: scrollY, behavior: 'smooth' });
            }
            window.dispatchEvent(new Event('scroll'));
            document.dispatchEvent(new Event('scroll'));

            // Allow DOM render and capture visual star fills
            await new Promise(r => setTimeout(r, 350));
            captureVisualRatingsInViewport();
            await harvestBatch();

            if (pageNewProducts.length >= targetForThisPage) break;

            // 2. Proactively trigger "Show More" / "Показати ще" button if available
            const clicked = await triggerShowMoreAndWait();
            if (clicked) {
                // When clicked, sample every 300ms for up to 1.5s for Rozetka AJAX chunks to attach
                for (let w = 0; w < 5; w++) {
                    await new Promise(r => setTimeout(r, 300));
                    await harvestBatch();
                    if (pageNewProducts.length >= targetForThisPage) break;
                }
            } else {
                // Also scroll past paginator area to trigger IntersectionObserver
                const paginator = document.querySelector('rz-paginator, .pagination, [class*="paginator"], [class*="catalog-grid__more"]');
                if (paginator) {
                    paginator.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    window.dispatchEvent(new Event('scroll'));
                    document.dispatchEvent(new Event('scroll'));
                    await new Promise(r => setTimeout(r, 400));
                    await harvestBatch();
                }
            }

            if (pageNewProducts.length > lastItemCount) {
                consecutiveNoNewRounds = 0;
                lastItemCount = pageNewProducts.length;
            } else {
                consecutiveNoNewRounds++;
                // If 5 full attempts produced no new items and we are past round 8, catalog on page is exhausted
                if (consecutiveNoNewRounds >= 5 && round >= 8) {
                    break;
                }
            }
        }

        // Upward sweep back to top to catch any unmounted items
        if (pageNewProducts.length < targetForThisPage) {
            window.scrollTo({ top: 0, behavior: 'auto' });
            window.dispatchEvent(new Event('scroll'));
            document.dispatchEvent(new Event('scroll'));
            await new Promise(r => setTimeout(r, 250));
            await harvestBatch();
        }

        // Update total estimate if catalog counter rendered during scroll
        const postEst = getEstimatedTotalFromPage();
        if (postEst > currentEstimatedTotal) {
            currentEstimatedTotal = postEst;
        }

        if (pageNewProducts.length > 0 && isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
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
                products: pageNewProducts,
                page: currentPage,
                isNewSession: currentPage === 1,
                sessionId: currentSessionId,
                sessionTitle: meta.title,
                category: meta.category,
                tabId: currentTabId
            });

            persistSessionState(currentPage);
        }

        // 3. Check if all items in catalog are collected
        const freshNextInDom = !!document.querySelector(`
            a.pagination__direction--forward, 
            a[rel="next"], 
            [class*="pagination__direction_type_forward"], 
            [class*="pagination__direction--forward"], 
            a.pagination__link[href*="page=${nextPg}"], 
            a.pagination__link[href*="page=${nextPg};"], 
            [class*="paginator"] a[href*="page=${nextPg}"],
            a[href*="page=${nextPg}"],
            a[href*="page=${nextPg};"]
        `);

        const maxPages = currentEstimatedTotal > 0 ? Math.ceil(currentEstimatedTotal / 60) : 999;
        const isFinished = (!freshNextInDom && currentEstimatedTotal > 0 && sentLinks.size >= currentEstimatedTotal) || 
                           (pageNewProducts.length === 0 && currentPage > 1 && !freshNextInDom) || 
                           (!freshNextInDom && (!targetUrl || targetUrl === window.location.href)) || 
                           (currentPage >= maxPages && !freshNextInDom);

        if (isFinished) {
            isTabScrapingActive = false;
            window.__tradeScoutIsScrapingActive = false;
            currentPercent = 100;
            currentStatusMsg = `Збір завершено! Всього ${sentLinks.size} товарів (100% каталогу).`;
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
            return;
        }

        // 4. Navigate directly to Next Page URL

        if (targetUrl && targetUrl !== window.location.href) {
            currentStatusMsg = `Перехід на стор. ${nextPg}...`;
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

            persistSessionState(nextPg);
            setTimeout(() => {
                window.location.href = targetUrl;
            }, 300);
        } else {
            // If URL did not change, complete
            isTabScrapingActive = false;
            window.__tradeScoutIsScrapingActive = false;
            clearPersistedSession();
            sendTabMessage({
                action: 'tabFinished',
                total: sentLinks.size,
                page: currentPage,
                percent: 100,
                statusMsg: `Збір завершено! Всього ${sentLinks.size} товарів.`,
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

    function resetTabState() {
        isTabScrapingActive = false;
        window.__tradeScoutIsScrapingActive = false;
        clearPersistedSession();
        sentLinks.clear();
        currentPercent = 0;
        currentEstimatedTotal = 0;
        currentStatusMsg = 'Готова до запуску';
        currentPage = 1;
        const meta = getPageMetadata();
        sendTabMessage({ action: 'tabIdle', sessionTitle: meta.title, category: meta.category });
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
                }, 350);
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
