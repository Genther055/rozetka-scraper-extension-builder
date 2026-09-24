// TradeScout Content Script v3.5 Pro (Multi-Tab Background Worker & Strict 60-Items/Page Scraper)
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
        
        // Match: "Знайдено 531 товар" or "Знайдено 508 товарів" or "Найдено 355 товаров"
        const m1 = cleaned.match(/(?:знайдено|найдено|показано)\s*([\d\s\u00A0\u202F.,]+)\s*(?:товар\w*|тов\w*)?/i);
        if (m1 && m1[1]) {
            const num = parseInt(m1[1].replace(/[\s\u00A0\u202F.,]/g, ''), 10);
            if (!isNaN(num) && num > 0 && num < 1000000) return num;
        }

        // Match: "531 товар", "508 товарів", "24 товари", "100 товаров", "350 товаров"
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
        // Priority 1: Top catalog counter text (e.g. "Знайдено 531 товар", "531 товар")
        const topElements = document.querySelectorAll('rz-catalog-settings, .catalog-settings, .catalog-heading, .catalog-selection, [data-testid*="found"], [data-testid*="counter"], [class*="found-goods"], [class*="goods-count"], [class*="heading__goods"], .catalog-selection__label, [class*="catalog-selection"], h1, h2, p, span, div');
        for (const el of topElements) {
            if (el.children.length > 6) continue;
            const txt = (el.textContent || el.innerText || '').trim();
            if (txt.toLowerCase().includes('знайдено') || txt.toLowerCase().includes('найдено') || txt.toLowerCase().includes('товар')) {
                const count = parseCountFromText(txt);
                if (count > 0 && count < 1000000) return count;
            }
        }

        // Priority 2: Check pagination links - find max page number * 60 items per page
        let maxPage = 1;
        try {
            const pageLinks = document.querySelectorAll('a.pagination__link, [class*="pagination"] a, li.pagination__item a');
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
        } catch (e) {}

        if (maxPage > 1) {
            return maxPage * 60;
        }

        const currentDomTiles = document.querySelectorAll('rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], app-goods-tile-default').length;
        return currentDomTiles > 0 ? currentDomTiles : 60;
    }

    // Filter: eliminate sidebars, recommendation widgets, recently viewed, and banners (NEVER filter promo items or items with image sliders)
    function isUnwantedTile(item) {
        if (!item || !(item instanceof Element)) return true;
        
        // 1. Check all non-catalog containers (sidebar, header, footer, recently viewed, recommendations, banners)
        if (item.closest('aside, .sidebar, header, footer, rz-viewed-goods, .recently-viewed, rz-similar-goods, rz-recommended-goods, rz-accessories, .catalog-banner, .advertising-slot, .main-goods__cell--advertising')) {
            return true;
        }
        
        // 2. Check if tile itself is an ad banner or placeholder
        const tileClasses = (item.className || '').toLowerCase();
        if (tileClasses.includes('catalog-banner') || tileClasses.includes('banner-tile') || tileClasses.includes('advertising-slot')) {
            return true;
        }

        // 3. Must have a product link
        const linkTag = item.tagName === 'A' ? item : (item.querySelector('a.goods-tile__heading, a.tile-title, [class*="heading"] a, a[href*="/p/"], a[href*="/p-"], a[href*="/p"]') || item.querySelector('a[href]'));
        if (!linkTag) return true;

        const href = linkTag.getAttribute('href') || '';
        if (!href || href === '#' || href.startsWith('javascript:')) return true;

        return false;
    }

    async function silentBackgroundScroll() {
        try {
            const totalHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            const viewH = window.innerHeight || 800;
            const steps = [0.25, 0.50, 0.75, 1.0];
            for (const step of steps) {
                const targetY = Math.max(0, Math.round((totalHeight - viewH) * step));
                window.scrollTo({ top: targetY, behavior: 'auto' });
                window.dispatchEvent(new Event('scroll'));
                await new Promise(r => setTimeout(r, 120));
            }
        } catch (_) {}
    }

    function tryTriggerShowMoreOnCurrentPage() {
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
                    if (btn.closest('.sidebar') || btn.closest('.filter') || btn.closest('.recently-viewed') || btn.closest('header')) continue;
                    dispatchSafeClick(btn);
                    return true;
                }
            } catch (e) {}
        }

        const allButtons = document.querySelectorAll('button, a, div[role="button"]');
        for (const el of allButtons) {
            const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
            if (txt === 'показати ще' || txt === 'показать еще' || txt.includes('показати ще') || txt.includes('показать еще') || txt === 'show more') {
                if (el.closest('.sidebar') || el.closest('.filter') || el.closest('.recently-viewed') || el.closest('header')) continue;
                if (el.disabled || el.classList.contains('button--loading') || el.classList.contains('disabled')) continue;
                dispatchSafeClick(el);
                return true;
            }
        }
        return false;
    }

    function findNextPageElement(pageIndex) {
        // Priority 1: Numbered next page link (e.g. page=2, page=3...)
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
                    if (txt === String(nextPageNum) || href.includes(`page=${nextPageNum}`) || href.includes(`page=${nextPageNum}/`)) {
                        return { type: 'pageNum', element: link, pageNum: nextPageNum, href };
                    }
                }
            } catch (e) {}
        }

        // Priority 2: Forward arrow / next button
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
        // 1. Locate all catalog tiles flexibly across the page
        const catalogContainer = document.querySelector('rz-grid, ul.catalog-grid, .catalog-grid, rz-catalog-grid, rz-catalog-tiles, .catalog-selection__goods, section.catalog-grid') || document.querySelector('main') || document.body;
        
        let rawTiles = Array.from(catalogContainer.querySelectorAll('li.catalog-grid__cell, rz-catalog-tile, rz-product-tile, [data-goods-id], .goods-tile, app-goods-tile-default'));
        if (rawTiles.length === 0) {
            rawTiles = Array.from(document.querySelectorAll('rz-catalog-tile, rz-product-tile, [data-goods-id], .goods-tile, li.catalog-grid__cell, app-goods-tile-default'));
        }

        // Calculate max items for this page (standard Rozetka catalog page has up to 60 items)
        let maxItemsThisPage = 60;
        if (currentEstimatedTotal > 0 && pageIndex >= Math.ceil(currentEstimatedTotal / 60)) {
            const remainder = currentEstimatedTotal - sentLinks.size;
            if (remainder > 0 && remainder <= 60) {
                maxItemsThisPage = remainder;
            }
        }

        // Filter out unwanted slider/carousel/banner elements and avoid nested child duplicates
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

            // Strictly cap at exactly max items needed for this page
            if (distinctTiles.length >= maxItemsThisPage) break;
        }

        if (distinctTiles.length === 0) return [];

        // Batch fetch official Rozetka product details (seller title, exact pricing, old_price, discounts) for all items on this page
        const apiProductMap = new Map();
        try {
            const productIds = [];
            for (const { link } of distinctTiles) {
                const m = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})\//);
                if (m && m[1]) productIds.push(m[1]);
            }
            if (productIds.length > 0) {
                const apiUrl = `https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=${productIds.join(',')}`;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 3500);
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

                const idMatch = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})\//);
                const prodId = idMatch ? String(idMatch[1]) : '';
                const apiProd = prodId ? apiProductMap.get(prodId) : null;

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
                if (!price && apiProd && apiProd.price) {
                    price = parseInt(String(apiProd.price).replace(/\D/g, ''), 10) || 0;
                }

                // --- 2. OLD (PRE-DISCOUNT) PRICE & DISCOUNT EXTRACTION ---
                let oldPrice = 0;
                let discount = 0;

                // A. Official Rozetka API data
                if (apiProd) {
                    if (apiProd.old_price && Number(apiProd.old_price) > 0) {
                        const parsedOld = parseInt(String(apiProd.old_price).replace(/\D/g, ''), 10) || 0;
                        if (parsedOld > price) {
                            oldPrice = parsedOld;
                        }
                    } else if (apiProd.oldPrice && Number(apiProd.oldPrice) > 0) {
                        const parsedOld = parseInt(String(apiProd.oldPrice).replace(/\D/g, ''), 10) || 0;
                        if (parsedOld > price) {
                            oldPrice = parsedOld;
                        }
                    }

                    if (apiProd.discount) {
                        if (typeof apiProd.discount === 'number' && apiProd.discount > 0) {
                            discount = apiProd.discount;
                        } else if (typeof apiProd.discount === 'object' && apiProd.discount.value) {
                            discount = parseInt(apiProd.discount.value, 10) || 0;
                        }
                    }
                }

                // B. DOM Old Price Element Search
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
                        if (parsed > price) {
                            oldPrice = parsed;
                        }
                    }
                }

                // C. DOM Promo Badges / Discount Stickers
                if (!discount) {
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
                }

                // D. Harmonize oldPrice & discount
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

                const apiSeller = apiProd && apiProd.seller ? ((apiProd.seller.title || apiProd.seller.name || '').trim()) : null;
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

    async function processAndReportHarvest(items, meta, pageIndex) {
        if (!items || items.length === 0) return;
        currentPercent = Math.min(100, Math.round((sentLinks.size / Math.max(1, currentEstimatedTotal)) * 100));
        currentStatusMsg = `Зібрано ${sentLinks.size} з ${currentEstimatedTotal} товарів (стор. ${pageIndex})...`;

        sendTabMessage({
            action: 'tabProgress',
            total: sentLinks.size,
            page: pageIndex,
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

        await sendWebhookPayload({
            products: items,
            page: pageIndex,
            sessionId: currentSessionId,
            sessionTitle: meta.title,
            category: meta.category,
            tabId: currentTabId
        });
    }

    // Main scraping runner
    async function runTabScraper(initialPage) {
        const meta = getPageMetadata();
        if (currentEstimatedTotal <= 0) {
            currentEstimatedTotal = getEstimatedTotalFromPage();
        }
        currentPage = initialPage || currentPage || 1;
        console.log(`TradeScout Tab ${currentTabId}: Running page ${currentPage}... Total scraped so far: ${sentLinks.size}/${currentEstimatedTotal}`);

        while (isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
            if (currentEstimatedTotal <= 0) {
                const latestEstimated = getEstimatedTotalFromPage();
                if (latestEstimated > 0) currentEstimatedTotal = latestEstimated;
            }

            // Always reset viewport to top first
            window.scrollTo({ top: 0, behavior: 'auto' });
            window.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise(r => setTimeout(r, 350));

            // Harvest initially visible items
            let pageHarvestedCount = 0;
            const expectedPageLimit = 60;

            const initialProducts = await scrapeCurrentDomItems(meta, currentPage);
            if (initialProducts.length > 0) {
                pageHarvestedCount += initialProducts.length;
                await processAndReportHarvest(initialProducts, meta, currentPage);
            }

            // Thorough progressive step-scroll down the page to trigger Rozetka's lazy-load
            const totalHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 3500);
            const stepSize = 400;
            const totalSteps = Math.ceil(totalHeight / stepSize);

            for (let step = 1; step <= totalSteps; step++) {
                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;
                if (pageHarvestedCount >= expectedPageLimit) break;

                const targetY = Math.min(totalHeight, step * stepSize);
                window.scrollTo({ top: targetY, behavior: 'auto' });
                window.dispatchEvent(new Event('scroll', { bubbles: true }));
                document.dispatchEvent(new Event('scroll', { bubbles: true }));
                
                await new Promise(r => setTimeout(r, 160));

                const stepProducts = await scrapeCurrentDomItems(meta, currentPage);
                if (stepProducts.length > 0) {
                    pageHarvestedCount += stepProducts.length;
                    await processAndReportHarvest(stepProducts, meta, currentPage);
                }
            }

            // Quick second pass at bottom
            if (pageHarvestedCount < expectedPageLimit && isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
                window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' });
                window.dispatchEvent(new Event('scroll', { bubbles: true }));
                await new Promise(r => setTimeout(r, 400));
                window.scrollBy({ top: -500, behavior: 'auto' });
                window.dispatchEvent(new Event('scroll', { bubbles: true }));
                await new Promise(r => setTimeout(r, 200));

                const endProducts = await scrapeCurrentDomItems(meta, currentPage);
                if (endProducts.length > 0) {
                    pageHarvestedCount += endProducts.length;
                    await processAndReportHarvest(endProducts, meta, currentPage);
                }
            }

            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;

            // Check if catalog complete
            const actionObj = findNextPageElement(currentPage);
            const hasNextPage = !!actionObj;

            if ((currentEstimatedTotal > 0 && sentLinks.size >= currentEstimatedTotal) || (!hasNextPage && pageHarvestedCount === 0)) {
                console.log(`TradeScout Tab ${currentTabId}: Target reached or no next page (${sentLinks.size}/${currentEstimatedTotal}). Finishing!`);
                break;
            }

            if (!hasNextPage) {
                console.log(`TradeScout Tab ${currentTabId}: No next page button found. Catalog complete.`);
                break;
            }

            // Proceed to Next Page
            const nextPageNum = currentPage + 1;
            currentStatusMsg = `Завантаження стор. ${nextPageNum}...`;
            sendTabMessage({
                action: 'tabProgress',
                total: sentLinks.size,
                page: nextPageNum,
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

            // If actionObj has an href, construct full URL
            let nextUrl = actionObj.href || '';
            if (nextUrl && !nextUrl.startsWith('http')) {
                nextUrl = nextUrl.startsWith('/') ? `https://rozetka.com.ua${nextUrl}` : `https://rozetka.com.ua/${nextUrl}`;
            }

            // Scroll next button into view and click
            try {
                actionObj.element.scrollIntoView({ behavior: 'auto', block: 'center' });
                await new Promise(r => setTimeout(r, 200));
            } catch (_) {}

            const prevHref = window.location.href;
            dispatchSafeClick(actionObj.element);

            // Wait up to 2 seconds to check if Rozetka did an in-page SPA transition or page reload
            let spaTransitionDetected = false;
            for (let w = 0; w < 8; w++) {
                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;
                await new Promise(r => setTimeout(r, 250));

                if (window.location.href !== prevHref) {
                    spaTransitionDetected = true;
                    break;
                }
                const freshItems = Array.from(document.querySelectorAll('li.catalog-grid__cell, rz-catalog-tile, .goods-tile'));
                const hasUnscraped = freshItems.some(tile => {
                    if (isUnwantedTile(tile)) return false;
                    const linkTag = tile.querySelector('a.goods-tile__heading, a.tile-title, a[href*="/p/"], a[href*="/p-"], a[href*="/p"]');
                    if (!linkTag) return false;
                    let href = (linkTag.getAttribute('href') || '').split('?')[0].split('#')[0].replace(/\/+$/, '');
                    return href && !sentLinks.has(href) && !sentLinks.has(`https://rozetka.com.ua${href}`);
                });
                if (hasUnscraped) {
                    spaTransitionDetected = true;
                    break;
                }
            }

            if (spaTransitionDetected) {
                currentPage = nextPageNum;
                window.scrollTo({ top: 0, behavior: 'auto' });
                await new Promise(r => setTimeout(r, 450));
                continue;
            }

            // If click didn't trigger navigation within 2s, force direct URL navigation
            if (nextUrl && nextUrl !== prevHref) {
                console.log(`TradeScout Tab ${currentTabId}: Navigating directly to next page: ${nextUrl}`);
                window.location.href = nextUrl;
                // Execution pauses here and auto-resumes on new page load via checkAndResumeSessionOnLoad
                return;
            } else {
                // If no next URL found and click didn't change page, finish
                break;
            }
        }

        // Scraping completed
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
                sessionId: currentSessionId,
                sentLinks: Array.from(sentLinks),
                webhookUrl: webhookEndpoint
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
        currentTabId = session.tabId || currentTabId || Date.now();
        currentSessionId = session.sessionId || `session_${currentTabId}_${Date.now()}`;
        if (session.webhookUrl) webhookEndpoint = session.webhookUrl;

        sentLinks.clear();
        if (Array.isArray(session.sentLinks)) {
            session.sentLinks.forEach(link => sentLinks.add(link));
        }

        // Detect page number from URL or fallback to session
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
                    resumeScrapingSession(res.session);
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
