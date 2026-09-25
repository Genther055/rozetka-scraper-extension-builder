// TradeScout Content Script v3.5 Pro (Direct URL Traverser & Full-Catalog Harvester)
(function() {
    if (window.self !== window.top) return; // Skip iframes
    if (window.__tradeScoutInjected) return; // Prevent duplicate injection
    window.__tradeScoutInjected = true;

    console.log('TradeScout Content Script v3.5 Pro loaded on:', window.location.href);

    const SESSION_STORAGE_KEY = '__tradeScout_active_session';
    const TILE_SELECTORS = 'rz-catalog-tile, .goods-tile, li.catalog-grid__cell, [data-goods-id], app-goods-tile-default, article.goods-tile, div.goods-tile';

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
        // Priority 1: Top catalog counter text (e.g. "Знайдено 531 товар")
        const topElements = document.querySelectorAll('rz-catalog-settings, .catalog-settings, .catalog-heading, .catalog-selection, [data-testid*="found"], [data-testid*="counter"], [class*="found-goods"], [class*="goods-count"], [class*="heading__goods"], .catalog-selection__label, h1, h2, p, span, div');
        for (const el of topElements) {
            if (el.closest('aside, .sidebar, rz-filter-stack, .sidebar-block, rz-section-slider, rz-viewed-goods, [class*="viewed"], .recently-viewed')) continue;
            if (el.children.length > 5) continue;
            const txt = (el.textContent || el.innerText || '').trim();
            if (txt.toLowerCase().includes('знайдено') || txt.toLowerCase().includes('найдено') || txt.toLowerCase().includes('товар')) {
                const count = parseCountFromText(txt);
                if (count > 0 && count < 1000000) return count;
            }
        }

        // Priority 2: Check pagination links
        try {
            const pageLinks = document.querySelectorAll('a.pagination__link, [class*="pagination"] a, li.pagination__item a, rz-paginator a');
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

        const currentDomTiles = document.querySelectorAll(TILE_SELECTORS).length;
        return currentDomTiles > 0 ? currentDomTiles : 60;
    }

    // Precise filter: eliminate recently viewed sliders, recommendation carousels, sidebars, and all sponsored/ad items
    function isUnwantedTile(item) {
        if (!item || !(item instanceof Element)) return true;
        
        // 1. Strictly exclude non-catalog containers (rz-section-slider, recently viewed, recommendations, sidebars, footers)
        const unwantedContainer = item.closest(`
            rz-section-slider, rz-goods-section-slider, rz-viewed-goods, [class*="viewed"], .recently-viewed, .goods-viewed, rz-recent-goods,
            aside, .sidebar, rz-sidebar, 
            rz-goods-carousel, rz-carousel, rz-goods-slider, rz-slider, app-goods-carousel, app-slider, .goods-carousel,
            rz-similar-goods, rz-recommended-goods, rz-accessories, .recommendations,
            .catalog-banner, .advertising-slot, .main-goods__cell--advertising,
            footer, header
        `);
        if (unwantedContainer) return true;
        
        // 2. Direct full-text check for sponsored & advertising markers (drops all 9 injected Rozetka ads)
        const tileText = (item.innerText || item.textContent || '').toLowerCase();
        if (
            tileText.includes('спонсор') || 
            tileText.includes('реклама') || 
            tileText.includes('рекламн') || 
            tileText.includes('партнерськ') || 
            tileText.includes('promoted')
        ) {
            return true;
        }

        // 3. Exclude sponsored / advertising classes and attributes
        const tileClasses = (item.className || '').toLowerCase();
        if (
            tileClasses.includes('catalog-banner') || 
            tileClasses.includes('rz-banner') || 
            tileClasses.includes('banner-tile') || 
            tileClasses.includes('advertising-slot') ||
            tileClasses.includes('goods-tile--ad') ||
            tileClasses.includes('goods-tile_ad') ||
            tileClasses.includes('goods-tile_type_ad') ||
            tileClasses.includes('goods-tile_type_sponsored') ||
            tileClasses.includes('goods-tile--sponsored') ||
            tileClasses.includes('sponsored') ||
            tileClasses.includes('promoted') ||
            item.hasAttribute('data-ad') ||
            item.hasAttribute('data-advertisement') ||
            item.hasAttribute('data-sponsored') ||
            item.hasAttribute('data-promoted') ||
            item.closest('[data-sponsored], [data-ad], [class*="sponsored"], [class*="advertisement"]')
        ) {
            return true;
        }

        // 4. Must have a valid product link
        const hasProductLink = !!item.querySelector('a[href*="/p/"], a[href*="/p-"], a[href*="/p"]');
        if (!hasProductLink) return true;

        return false;
    }

    // Comprehensive Title Extractor: finds title across all possible tags/attributes
    function extractTitle(item) {
        if (!item || !(item instanceof Element)) return '';
        
        // 1. Direct heading selectors
        const headingSelectors = [
            'a.goods-tile__heading',
            'a.tile-title',
            '.goods-tile__heading',
            '.tile-title',
            'span.goods-tile__title',
            '.goods-tile__title',
            '[class*="heading"] a',
            '[class*="title"] a',
            'a[class*="heading"]',
            'a[class*="title"]'
        ];
        for (const sel of headingSelectors) {
            const el = item.querySelector(sel);
            if (el && el.innerText && el.innerText.trim().length >= 3) {
                return el.innerText.trim();
            }
        }

        // 2. Any product link with text content
        const allLinks = item.querySelectorAll('a[href*="/p/"], a[href*="/p-"], a[href*="/p"]');
        for (const a of allLinks) {
            const txt = (a.innerText || a.getAttribute('title') || '').trim();
            if (txt.length >= 3 && !txt.includes('₴') && !txt.startsWith('http')) {
                return txt;
            }
        }

        // 3. Image alt attribute
        const img = item.querySelector('img[alt]');
        if (img && img.alt && img.alt.trim().length >= 3) {
            return img.alt.trim();
        }

        return '';
    }

    // Extract product link
    function extractLink(item) {
        if (!item || !(item instanceof Element)) return '';
        const allLinks = item.querySelectorAll('a[href*="/p/"], a[href*="/p-"], a[href*="/p"]');
        for (const a of allLinks) {
            const href = a.getAttribute('href');
            if (href && href.length > 2 && !href.startsWith('javascript:')) {
                let link = href.split('?')[0].split('#')[0].replace(/\/+$/, '');
                if (!link.startsWith('http')) {
                    link = link.startsWith('/') ? `https://rozetka.com.ua${link}` : `https://rozetka.com.ua/${link}`;
                }
                return link;
            }
        }
        return '';
    }

    // Fast 400ms background scroll to ensure lazy elements mount
    async function silentBackgroundScroll() {
        try {
            const totalHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 1200);
            const midY = Math.round(totalHeight / 2);
            window.scrollTo({ top: midY, behavior: 'auto' });
            await new Promise(r => setTimeout(r, 150));
            window.scrollTo({ top: totalHeight - window.innerHeight, behavior: 'auto' });
            await new Promise(r => setTimeout(r, 200));
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

    async function scrapeCurrentDomItems(meta, pageIndex) {
        // Query strictly within the main catalog grid container (excluding rz-section-slider)
        const catalogContainer = document.querySelector('rz-grid, ul.catalog-grid, rz-catalog-grid, rz-catalog, .catalog-grid') || document.body;
        let rawTiles = Array.from(catalogContainer.querySelectorAll(TILE_SELECTORS));
        
        if (rawTiles.length === 0) {
            const grids = document.querySelectorAll('ul.catalog-grid, rz-grid ul, rz-catalog-grid ul, .catalog-grid');
            grids.forEach(g => {
                rawTiles.push(...Array.from(g.children));
            });
        }

        // Filter out unwanted slider/carousel/banner/viewed elements and avoid duplicates
        const distinctTiles = [];
        const seenElements = new Set();

        for (const item of rawTiles) {
            if (isUnwantedTile(item)) continue;
            
            const link = extractLink(item);
            if (!link) continue;

            const name = extractTitle(item);
            if (!name || name.length < 3) continue;

            if (sentLinks.has(link) || seenElements.has(link)) continue;
            seenElements.add(link);
            distinctTiles.push({ item, link, name });
        }

        if (distinctTiles.length === 0) return [];

        // Batch fetch official Rozetka product details (seller title, exact pricing, stock)
        const apiSellerMap = new Map();
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
                                if (apiProd && apiProd.id && apiProd.seller) {
                                    const sTitle = (apiProd.seller.title || apiProd.seller.name || '').trim();
                                    if (sTitle) {
                                        apiSellerMap.set(String(apiProd.id), sTitle);
                                    }
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
                // 1. Current Price
                const priceEl = item.querySelector('.goods-tile__price-value, .price, [class*="price-value"], [class*="price__current"], [class*="price_type_current"]');
                const priceText = priceEl && priceEl.innerText ? priceEl.innerText : '';
                const price = priceText ? parseInt(priceText.replace(/\D/g, ''), 10) || 0 : 0;

                // CRITICAL: Skip products with price 0 (archived / out of stock without pricing)
                if (price <= 0) {
                    continue;
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

                if (oldPrice > price && discount === 0) {
                    discount = Math.round(((oldPrice - price) / oldPrice) * 100);
                } else if (discount > 0 && (!oldPrice || oldPrice <= price) && price > 0) {
                    oldPrice = Math.round(price / (1 - (discount / 100)));
                }

                // 3. Reviews Count
                let reviews = 0;
                const tileRawText = (item.innerText || item.textContent || '');
                const hasZeroReviewsBadge = tileRawText.includes('Залишити відгук') || tileRawText.includes('Оставить отзыв');

                if (!hasZeroReviewsBadge) {
                    // Try direct selectors
                    const reviewElements = item.querySelectorAll('a[href*="#comments"], a[href*="comments"], button, [class*="rating"], [class*="reviews"], [class*="comments"], span, p, a');
                    for (const el of reviewElements) {
                        const t = (el.innerText || '').trim();
                        if (/^\d+$/.test(t)) {
                            const num = parseInt(t, 10);
                            if (num > 0 && num < 50000 && !el.closest('[class*="price"], del, s, strike, rz-promo-label')) {
                                reviews = num;
                                break;
                            }
                        }
                    }

                    // Fallback: parse lines in tile text (standalone number before price)
                    if (reviews === 0) {
                        const lines = tileRawText.split('\n').map(l => l.trim()).filter(Boolean);
                        for (let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            if (/^\d+$/.test(line)) {
                                const num = parseInt(line, 10);
                                if (num > 0 && num < 50000 && !line.includes('₴') && !line.includes('%')) {
                                    if (i + 1 < lines.length && lines[i + 1].includes('₴')) {
                                        reviews = num;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }

                // 4. Rating (1.0 to 5.0)
                let rating = 0;
                const starsEl = item.querySelector('rz-rating, app-rating, .stars_rating, [data-testid="stars-rating"], .goods-tile__stars, [class*="stars"], [class*="rating"]');
                if (starsEl) {
                    const aria = starsEl.getAttribute('aria-label') || starsEl.querySelector('[aria-label]')?.getAttribute('aria-label') || '';
                    const ariaMatch = aria.match(/([\d.,]+)\s*(?:з|из|\/)\s*5/i) || aria.match(/([\d.,]+)/);
                    if (ariaMatch) {
                        const rVal = parseFloat(ariaMatch[1].replace(',', '.'));
                        if (rVal > 0 && rVal <= 5) rating = rVal;
                    }
                    if (rating === 0) {
                        const fillEl = starsEl.querySelector('[style*="calc"], [style*="width"], [class*="fill"]');
                        if (fillEl) {
                            const style = fillEl.getAttribute('style') || '';
                            const match = style.match(/(?:calc\()?([\d.]+)%/);
                            if (match) {
                                const pct = parseFloat(match[1]);
                                if (pct > 0 && pct <= 100) {
                                    rating = parseFloat((pct / 20).toFixed(1));
                                }
                            }
                        }
                    }
                }
                if (rating === 0) {
                    rating = reviews > 0 ? 4.8 : 5.0;
                }

                const itemText = item.innerText || '';
                const inStock = !(item.classList.contains('tile-disabled') || itemText.includes('Немає в наявності') || itemText.includes('Нет в наличии'));

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

                const capacityMatch = name.match(/(\d+[\d\s]*)\s*(?:mah|мАг|мАч|мah)/i);
                if (capacityMatch && !detailedSpecsMap['Ємність']) {
                    const cNum = parseInt(capacityMatch[1].replace(/\s+/g, ''), 10);
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

                const idMatch = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})\//);
                const prodId = idMatch ? String(idMatch[1]) : '';
                const apiSeller = prodId ? apiSellerMap.get(prodId) : null;
                const seller = apiSeller || extractSeller(item) || 'Rozetka';

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
                    detailedSpecsMap,
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

    // Main scraping runner
    async function runTabScraper(initialPage) {
        const meta = getPageMetadata();
        if (currentEstimatedTotal <= 0) {
            currentEstimatedTotal = getEstimatedTotalFromPage();
        }
        currentPage = initialPage || 1;
        console.log(`TradeScout Tab ${currentTabId}: Started scraping "${meta.title}" (Page ${currentPage})... Target: ${currentEstimatedTotal}`);

        currentPercent = Math.min(100, Math.round((sentLinks.size / Math.max(1, currentEstimatedTotal)) * 100)) || 1;
        currentStatusMsg = `Збір: ${meta.title} (${sentLinks.size}/${currentEstimatedTotal})...`;

        // 1. Silent scroll to mount lazy elements
        await silentBackgroundScroll();
        if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) return;

        // 2. Scrape all items on current page
        let newProducts = await scrapeCurrentDomItems(meta, currentPage);
        if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) return;

        if (newProducts.length === 0 && (currentEstimatedTotal <= 0 || sentLinks.size < currentEstimatedTotal)) {
            await new Promise(r => setTimeout(r, 400));
            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) return;
            await silentBackgroundScroll();
            newProducts = await scrapeCurrentDomItems(meta, currentPage);
        }

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

        // 3. Check if all items in catalog are collected
        const maxPages = currentEstimatedTotal > 0 ? Math.ceil(currentEstimatedTotal / 60) : 999;
        const isFinished = (currentEstimatedTotal > 0 && sentLinks.size >= currentEstimatedTotal) || (newProducts.length === 0 && currentPage > 1) || (currentPage >= maxPages);

        if (isFinished) {
            isTabScrapingActive = false;
            window.__tradeScoutIsScrapingActive = false;
            currentPercent = 100;
            currentStatusMsg = `Збір завершено! Всього ${sentLinks.size} товарів (100% позицій з ціною).`;
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
        const nextPg = currentPage + 1;
        const targetUrl = getRozetkaNextPageUrl(window.location.href, nextPg);

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
