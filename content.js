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

    // Step-by-step scrolling through full height to ensure all 60 items mount
    async function silentBackgroundScroll() {
        try {
            let lastHeight = 0;
            let currentScroll = 0;
            for (let i = 0; i < 15; i++) {
                const maxH = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 2500);
                currentScroll = Math.min(maxH, currentScroll + 650);
                window.scrollTo({ top: currentScroll, behavior: 'auto' });
                await new Promise(r => setTimeout(r, 140));
                if (currentScroll >= maxH && maxH === lastHeight) break;
                lastHeight = maxH;
            }
            window.scrollTo({ top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), behavior: 'auto' });
            await new Promise(r => setTimeout(r, 350));
        } catch (_) {}
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

    // --- DECOUPLED COLUMN EXTRACTORS (Zero cross-interference) ---

    function extractPrice(item, apiDetails) {
        try {
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
                    if (val > 0) return val;
                }
            }

            const tileText = (item.innerText || item.textContent || '');
            const mPrice = tileText.match(/(\d[\d\s\u00A0\u202F.,]*)\s*(?:₴|грн|uah)/i);
            if (mPrice && mPrice[1]) {
                const val = parseInt(mPrice[1].replace(/\D/g, ''), 10) || 0;
                if (val > 0) return val;
            }

            if (apiDetails) {
                if (apiDetails.price) {
                    const val = parseInt(String(apiDetails.price).replace(/\D/g, ''), 10) || 0;
                    if (val > 0) return val;
                }
                if (apiDetails.old_price) {
                    const val = parseInt(String(apiDetails.old_price).replace(/\D/g, ''), 10) || 0;
                    if (val > 0) return val;
                }
            }
        } catch (_) {}
        return 0;
    }

    function extractOldPriceAndDiscount(item, price, apiDetails) {
        let discount = 0;
        let oldPrice = 0;
        try {
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
        } catch (_) {}
        return { oldPrice: oldPrice || price, discount };
    }

    function extractReviews(item, apiDetails) {
        try {
            const tileRawText = (item.innerText || item.textContent || '');
            if (tileRawText.includes('Залишити відгук') || tileRawText.includes('Оставить отзыв')) {
                return 0;
            }

            // Priority 1: rz-tile-rating container
            const rzRating = item.querySelector('rz-tile-rating');
            if (rzRating) {
                const revSpan = rzRating.querySelector('span, a, [data-testid*="review"], [class*="review"]');
                if (revSpan) {
                    const countMatch = (revSpan.textContent || '').match(/(\d[\d\s\u00A0]*)/);
                    if (countMatch && countMatch[1]) {
                        const num = parseInt(countMatch[1].replace(/\D/g, ''), 10);
                        if (num > 0 && num < 1000000) return num;
                    }
                }
            }

            // Priority 2: dedicated review elements
            const reviewSelectors = [
                '[data-testid="reviews-link"]',
                '[data-testid*="review"]',
                '[data-testid*="comment"]',
                'a.goods-tile__reviews-link',
                '.goods-tile__reviews-link',
                '.goods-tile__reviews-count',
                'a[href*="#comments"]',
                'a[href*="comments"]',
                'a[href*="reviews"]',
                '[class*="reviews-link"]',
                '[class*="reviews-count"]'
            ];
            for (const sel of reviewSelectors) {
                const el = item.querySelector(sel);
                if (el) {
                    if (el.closest('[class*="price"], del, s, strike, rz-promo-label, rz-tile-price')) continue;
                    const t = (el.innerText || el.textContent || '').trim();
                    const countMatch = t.match(/(\d[\d\s\u00A0]*)/);
                    if (countMatch && countMatch[1]) {
                        const num = parseInt(countMatch[1].replace(/\D/g, ''), 10);
                        if (num > 0 && num < 1000000) return num;
                    }
                }
            }

            // Priority 3: Regex match
            const revTextMatch = tileRawText.match(/(\d[\d\s\u00A0]*)\s*(?:відгук|відгуки|відгуків|отзыв|отзыва|отзывов)/i);
            if (revTextMatch && revTextMatch[1]) {
                const num = parseInt(revTextMatch[1].replace(/\D/g, ''), 10);
                if (num > 0 && num < 1000000) return num;
            }

            // Priority 4: API
            if (apiDetails && apiDetails.comments_amount) {
                const num = parseInt(String(apiDetails.comments_amount), 10) || 0;
                if (num > 0) return num;
            }
        } catch (_) {}
        return 0;
    }

    function extractRating(item, reviews, apiDetails) {
        if (reviews === 0) return 0;
        try {
            // Priority 1: style="width: calc(X% - 2px)" on [data-testid="stars-rating"]
            const fillerElements = item.querySelectorAll('[data-testid="stars-rating"], [class*="stars-rating__filler"], [class*="stars_rating__filler"], [class*="stars-rating-progress"] [style*="%"], rz-stars-rating-progress [style*="%"], [data-testid="stars-rating"][style*="%"]');
            for (const el of fillerElements) {
                const style = el.getAttribute('style') || '';
                const match = style.match(/([\d.]+)%/);
                if (match && match[1]) {
                    const pct = parseFloat(match[1]);
                    if (pct > 0 && pct <= 100) {
                        return parseFloat((pct / 20).toFixed(1));
                    }
                }
            }

            // Priority 2: aria-label with "X / 5" or "X з 5"
            const starAriaElements = item.querySelectorAll('[data-testid="stars-rating"], rz-tile-rating, rz-stars-rating-progress, .goods-tile__stars, [class*="stars"], [class*="rating"]');
            for (const el of starAriaElements) {
                const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
                const ariaMatch = aria.match(/([\d.,]+)\s*(?:з|из|\/)\s*5/i);
                if (ariaMatch && ariaMatch[1]) {
                    const val = parseFloat(ariaMatch[1].replace(',', '.'));
                    if (val > 0 && val <= 5) return val;
                }
            }

            // Priority 3: API
            if (apiDetails) {
                if (apiDetails.stars_rating) {
                    const apiVal = parseFloat(String(apiDetails.stars_rating).replace(',', '.'));
                    if (apiVal > 0 && apiVal <= 5) return apiVal;
                }
                if (apiDetails.stars) {
                    const apiVal = parseFloat(String(apiDetails.stars).replace(',', '.'));
                    if (apiVal > 5 && apiVal <= 100) return parseFloat((apiVal / 20).toFixed(1));
                    else if (apiVal > 0 && apiVal <= 5) return apiVal;
                }
                if (apiDetails.rating) {
                    const apiVal = parseFloat(String(apiDetails.rating).replace(',', '.'));
                    if (apiVal > 0 && apiVal <= 5) return apiVal;
                }
            }
        } catch (_) {}
        return 0;
    }

    function extractInStock(item, apiDetails) {
        try {
            const itemText = item.innerText || '';
            let inStock = !(item.classList.contains('tile-disabled') || itemText.includes('Немає в наявності') || itemText.includes('Нет в наличии'));
            if (apiDetails && apiDetails.sell_status) {
                inStock = (apiDetails.sell_status !== 'unavailable');
            }
            return inStock;
        } catch (_) {
            return true;
        }
    }

    function extractSpecs(item, name) {
        try {
            const detailedSpecsMap = {};
            const paramNodes = item.querySelectorAll('.goods-tile__params li, .goods-tile__param, [class*="param-item"], [class*="tag"], [class*="characteristic"]');
            paramNodes.forEach(pn => {
                const pText = (pn.innerText || '').trim();
                if (pText && pText.includes(':')) {
                    const [k, v] = pText.split(':').map(x => x.trim());
                    if (k && v) detailedSpecsMap[k] = v;
                }
            });

            const capacityMatch = name.match(/(\d+[\d\s]*)\s*(?:mah|мАг|мАч|мah)/i);
            if (capacityMatch && !detailedSpecsMap['Ємність']) {
                const cNum = parseInt(capacityMatch[1].replace(/\s+/g, ''), 10);
                if (!isNaN(cNum)) detailedSpecsMap['Ємність'] = `${cNum.toLocaleString('uk-UA')} mAh`;
            }

            const powerMatch = name.match(/\b(\d+(?:\.\d+)?)\s*(?:W|Вт)\b/i);
            if (powerMatch && !detailedSpecsMap['Потужність']) {
                detailedSpecsMap['Потужність'] = `${powerMatch[1]}W`;
            }

            const knownBrands = ['Xiaomi', 'Redmi', 'Baseus', 'Apple', 'Samsung', 'Anker', 'Hoco', 'Borofone', 'Romoss', 'Remax', 'Joyroom', 'ColorWay', '2E', 'Gelius', 'Ugreen', 'ZMI', 'Belkin', 'Choetech', 'Promate', 'Vinga', 'Defender', 'Canyon', 'BLUETTI', 'EcoFlow', 'Jackery'];
            for (const b of knownBrands) {
                if (new RegExp(`\\b${b}\\b`, 'i').test(name)) {
                    detailedSpecsMap['Бренд'] = b;
                    break;
                }
            }

            const specs = Object.entries(detailedSpecsMap).map(([k, v]) => `${k}: ${v}`).join('; ') || (capacityMatch ? `${capacityMatch[1]} mAh` : 'Стандартні');
            return { specs, detailedSpecsMap };
        } catch (_) {
            return { specs: 'Стандартні', detailedSpecsMap: {} };
        }
    }

    function extractSellerInfo(item, apiDetails) {
        let seller = 'Rozetka';
        let sellerRating = 0;
        let sellerReviews = 0;
        try {
            if (apiDetails && apiDetails.seller) {
                seller = (apiDetails.seller.title || apiDetails.seller.name || '').trim() || 'Rozetka';
                if (apiDetails.seller.rating) sellerRating = parseFloat(String(apiDetails.seller.rating)) || 0;
                if (apiDetails.seller.feedbacks) sellerReviews = parseInt(String(apiDetails.seller.feedbacks), 10) || 0;
            } else {
                seller = extractSeller(item) || 'Rozetka';
            }
        } catch (_) {}
        return { seller, sellerRating, sellerReviews };
    }

    async function scrapeCurrentDomItems(meta, pageIndex) {
        let rawTiles = Array.from(document.querySelectorAll(TILE_SELECTORS));

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

        if (distinctTiles.length === 0) return [];

        // Batch fetch official Rozetka product details
        const apiProductMap = new Map();
        try {
            const productIds = [];
            for (const { link } of distinctTiles) {
                const m = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})\//);
                if (m && m[1]) productIds.push(m[1]);
            }
            if (productIds.length > 0) {
                const chunkSize = 60;
                for (let i = 0; i < productIds.length; i += chunkSize) {
                    const chunk = productIds.slice(i, i + chunkSize);
                    const apiUrl = `https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=${chunk.join(',')}`;
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 2500);
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
            }
        } catch (_) {}

        const newItems = [];

        for (const { item, link, name } of distinctTiles) {
            try {
                const idMatch = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})\//);
                const prodId = idMatch ? String(idMatch[1]) : '';
                const apiDetails = prodId ? apiProductMap.get(prodId) : null;

                const price = extractPrice(item, apiDetails);
                const { oldPrice, discount } = extractOldPriceAndDiscount(item, price, apiDetails);
                const reviews = extractReviews(item, apiDetails);
                const rating = extractRating(item, reviews, apiDetails);
                const inStock = extractInStock(item, apiDetails);
                const { specs, detailedSpecsMap } = extractSpecs(item, name);
                const { seller, sellerRating, sellerReviews } = extractSellerInfo(item, apiDetails);
                const questions = (apiDetails && apiDetails.questions_amount) ? parseInt(String(apiDetails.questions_amount), 10) || 0 : 0;

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

        // Target for this page:
        // If there is pagination/next page, this page MUST harvest strictly 60 items!
        // Only if there is DEFINITELY no next page AND remaining < 60, target is remaining.
        let targetForThisPage = 60;
        if (hasNextPageInDom) {
            targetForThisPage = 60;
            if (currentEstimatedTotal < (currentPage + 1) * 60) {
                currentEstimatedTotal = Math.max(currentEstimatedTotal, (currentPage + 1) * 60);
            }
        } else if (currentEstimatedTotal > 0 && currentEstimatedTotal > sentLinks.size) {
            const remaining = currentEstimatedTotal - sentLinks.size;
            if (remaining > 0 && remaining < 60) {
                targetForThisPage = remaining;
            }
        }

        // Continuous incremental step-by-step downward & upward harvesting
        const pageNewProducts = [];
        const pageLinksSeen = new Set();

        const harvestBatch = async () => {
            const batch = await scrapeCurrentDomItems(meta, currentPage);
            for (const item of batch) {
                if (item.link && !pageLinksSeen.has(item.link)) {
                    pageLinksSeen.add(item.link);
                    pageNewProducts.push(item);
                }
            }
        };

        // Rozetka DOM Chunk & Sentinel Trigger Helper
        const triggerRozetkaChunkLoader = () => {
            try {
                const tiles = Array.from(document.querySelectorAll(TILE_SELECTORS));
                if (tiles.length > 0) {
                    const lastEl = tiles[tiles.length - 1];
                    lastEl.scrollIntoView({ block: 'center', behavior: 'auto' });
                }
                const paginator = document.querySelector('rz-paginator, .pagination, [class*="paginator"], rz-catalog-paginator, .catalog-selection');
                if (paginator) {
                    paginator.scrollIntoView({ block: 'nearest', behavior: 'auto' });
                }
            } catch (_) {}
            window.dispatchEvent(new Event('scroll'));
            window.dispatchEvent(new Event('resize'));
            document.dispatchEvent(new Event('scroll'));
        };

        // Pass 1: Harvest top elements immediately
        await harvestBatch();

        // Pass 2: Progressive downward scroll with chunk sentinel triggers (35 steps * 400px)
        let currentY = 0;
        for (let s = 0; s < 35; s++) {
            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) return;
            if (pageNewProducts.length >= targetForThisPage) break;

            currentY += 400;
            window.scrollTo({ top: currentY, behavior: 'auto' });
            triggerRozetkaChunkLoader();
            
            // Allow Rozetka DOM render & change detection
            await new Promise(r => setTimeout(r, 180));
            await harvestBatch();
        }

        // Pass 3: Active chunk-waiting loop (specifically pulls chunk 2 [42 items] and chunk 3 [60 items])
        // If under target, actively scrolls into view the last tile and paginator, waiting for Rozetka chunk 3 to mount
        for (let attempt = 0; attempt < 15; attempt++) {
            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) return;
            if (pageNewProducts.length >= targetForThisPage) break;

            triggerRozetkaChunkLoader();
            
            // Subtle scroll jitter to force Rozetka IntersectionObserver callback
            window.scrollBy(0, (attempt % 2 === 0 ? 150 : -100));
            window.dispatchEvent(new Event('scroll'));
            
            await new Promise(r => setTimeout(r, 350));
            await harvestBatch();
        }

        // Pass 4: Upward scroll back to top if still under target (captures any unmounted top/middle items)
        if (pageNewProducts.length < targetForThisPage) {
            let upY = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            for (let s = 0; s < 25; s++) {
                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) return;
                if (pageNewProducts.length >= targetForThisPage) break;

                upY = Math.max(0, upY - 400);
                window.scrollTo({ top: upY, behavior: 'auto' });
                window.dispatchEvent(new Event('scroll'));
                await new Promise(r => setTimeout(r, 150));
                await harvestBatch();
                if (upY <= 0) break;
            }
        }

        // Back to top
        window.scrollTo({ top: 0, behavior: 'auto' });
        await new Promise(r => setTimeout(r, 100));
        await harvestBatch();

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
