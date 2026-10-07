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
    const visitedUrls = new Set();
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
                visitedUrls: Array.from(visitedUrls),
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

    function cleanCategoryName(c) {
        if (!c) return 'Повербанки та УМБ';
        let s = c.trim();
        const brandSuffixes = [
            'Sigma mobile', 'Sigma', 'Xiaomi', 'Redmi', 'Ugreen', 'Baseus', 'Apple', 'Samsung',
            'Anker', 'Hoco', 'Borofone', 'Romoss', 'Remax', 'Joyroom', 'ColorWay', 'Proove',
            'HOPECOM', 'Qinetiq', 'Remzona', '2E', 'Gelius', 'ZMI', 'Belkin', 'Choetech', 'BLUETTI', 'EcoFlow', 'Jackery'
        ];
        for (const b of brandSuffixes) {
            const re = new RegExp('\\s*[-–—|,]?\\s*' + b + '\\b.*$', 'i');
            s = s.replace(re, '');
        }
        return s.trim() || 'Повербанки та УМБ';
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

        category = cleanCategoryName(category);

        return { title, category };
    }

    function parseCountFromText(text) {
        if (!text || typeof text !== 'string') return 0;
        const cleaned = text.replace(/&nbsp;/g, ' ').replace(/\u00A0/g, ' ').replace(/\u202F/g, ' ').trim();
        
        // Priority 1: 'Знайдено 344 товари' / 'знайдено 344' / 'найдено: 344'
        const m1 = cleaned.match(/(?:знайдено|найдено|показано|знайдено\s+всього)\s*[:\-–—]?\s*(\d[\d\s\u00A0\u202F.,]*)/i);
        if (m1 && m1[1]) {
            const num = parseInt(m1[1].replace(/[\s\u00A0\u202F.,]/g, ''), 10);
            if (!isNaN(num) && num > 0 && num < 1000000) return num;
        }

        // Priority 2: '344 товарів' / '344 товари' / '344 товар'
        const m2 = cleaned.match(/(\d[\d\s\u00A0\u202F.,]*)\s*(?:товар\S*|тов\S*)/i);
        if (m2 && m2[1]) {
            const num = parseInt(m2[1].replace(/[\s\u00A0\u202F.,]/g, ''), 10);
            if (!isNaN(num) && num > 0 && num < 1000000) return num;
        }

        return 0;
    }

    function getEstimatedTotalFromPage() {
        // Priority 1: Search top heading, counter, and settings elements
        const topElements = document.querySelectorAll(`
            .catalog-selection__label, [class*="selection__label"], rz-selected-filters,
            rz-catalog-settings, .catalog-settings, .catalog-heading, .catalog-selection,
            [data-testid*="found"], [data-testid*="counter"], [data-testid*="total"],
            [class*="found-goods"], [class*="goods-count"], [class*="heading__goods"], [class*="total-goods"],
            h1, h2, [class*="filters-tags"]
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

        // Priority 4: Check if forward pagination button exists
        const hasForward = !!document.querySelector('a.pagination__direction--forward, a[rel="next"], [class*="pagination__direction_type_forward"], [class*="pagination__direction--forward"], [class*="paginator"] a[href*="page="]');
        if (hasForward) {
            return 300;
        }

        return 60;
    }

    // Precise filter: eliminate non-catalog containers (recently viewed sliders, recommendation carousels, sidebars, banners, sponsored ads)
    function isUnwantedTile(item) {
        if (!item || !(item instanceof Element)) return true;
        
        // 1. Strictly exclude non-catalog containers (rz-section-slider, recently viewed, recommendations, sidebars, carousels, footers, headers)
        const unwantedContainer = item.closest(`
            rz-section-slider, rz-goods-section-slider, rz-viewed-goods, .recently-viewed, .goods-viewed, rz-recent-goods, [data-testid*="viewed"], [data-testid*="recently"],
            aside, .sidebar, rz-sidebar, 
            rz-goods-carousel, rz-carousel, rz-goods-slider, rz-slider, app-goods-carousel, app-slider, .goods-carousel,
            rz-similar-goods, rz-recommended-goods, rz-accessories, .recommendations, [data-testid*="carousel"], [data-testid*="slider"],
            .catalog-banner, .advertising-slot, .main-goods__cell--advertising,
            footer, header
        `);
        if (unwantedContainer) return true;

        // 2. Exclude sponsored / advertising classes and attributes
        const tileClasses = (item.className || '').toLowerCase();
        if (
            tileClasses.includes('catalog-banner') || 
            tileClasses.includes('rz-banner') || 
            tileClasses.includes('banner-tile') || 
            tileClasses.includes('advertising-slot') ||
            tileClasses.includes('goods-tile--ad') ||
            tileClasses.includes('goods-tile_ad') ||
            tileClasses.includes('goods-tile_state_advertising') ||
            item.hasAttribute('data-ad') ||
            item.hasAttribute('data-advertisement') ||
            item.hasAttribute('data-advert') ||
            item.hasAttribute('data-sponsored')
        ) {
            return true;
        }

        // 3. Check for explicit "Реклама" / "Спонсор" text inside promo badges or labels
        const promoElements = item.querySelectorAll('.goods-tile__label, .promo-label, [data-testid*="promo-label"], [data-testid*="ad-badge"], .goods-tile__badge, [class*="badge"], [class*="label"], [class*="sticker"]');
        for (const el of promoElements) {
            const txt = (el.textContent || '').trim().toLowerCase();
            if (
                txt === 'реклама' || 
                txt.includes('реклама') || 
                txt.includes('спонсор') || 
                txt.includes('спонсоровано') || 
                txt.includes('sponsored') || 
                txt === 'ad' || 
                txt === 'adv'
            ) {
                return true;
            }
        }

        // 4. Must have a valid product link
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

    function extractProductId(item, link) {
        if (item && item instanceof Element) {
            const attrId = item.getAttribute('data-goods-id') || item.getAttribute('data-id') || item.getAttribute('goods-id') || item.getAttribute('data-product-id');
            if (attrId && /^\d+$/.test(attrId.trim())) return attrId.trim();
            
            const gIdEl = item.querySelector('.g-id, [class*="goods-id"], [data-goods-id], [class*="product-id"]');
            if (gIdEl) {
                const gIdText = (gIdEl.getAttribute('data-goods-id') || gIdEl.innerText || gIdEl.textContent || '').trim();
                if (/^\d+$/.test(gIdText)) return gIdText;
            }
            
            const elId = item.id || '';
            if (elId && /^\d+$/.test(elId)) return elId;
        }
        if (link) {
            const m = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})(?:\/|$|\?)/);
            if (m && m[1]) return m[1];
        }
        return '';
    }

    function cleanSellerName(raw) {
        if (!raw) return '';
        let text = String(raw).trim();
        text = text
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#39;/g, "'")
            .replace(/&#34;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ')
            .replace(/\u00A0/g, ' ')
            .replace(/\u202F/g, ' ');

        // Strip leading anchor labels
        text = text.replace(/^(?:інтернет-магазин|магазин|продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
        
        // Strip trailing actions, ratings, availability & sub-badges
        text = text.replace(/\b(?:запитати\s+про\s+товар|спросить\s+о\s+товаре|усі\s+товари\s+продавця|все\s+товары\s+продавца|товари\s+продавця|товары\s+продавца|написати\s+продавцю|написать\s+продавцу|повідомити|сообщить|немає\s+в\s+наявності|нет\s+в\s+наличии|в\s+наявності|в\s+наличии|код:\s*\d+|арт(?:икул)?:\s*\d+)\b.*$/i, '');

        const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0 && !/^(?:інтернет-магазин|магазин|продавець(?:\s+товару)?|продавец|seller|merchant|від\s+продавця|от\s+продавца)\s*:?$/i.test(l));
        if (lines.length === 0) return '';
        let name = lines[0];

        // Strip rating suffix e.g. "Missis Sleep 4.8/5 ★ 231 оцінок" -> "Missis Sleep"
        name = name.replace(/\s*\b\d+(?:[.,]\d+)?\s*(?:\/\s*5|\s*★|\%|\bоцін\w*|\bоцен\w*|\bвідгук\w*|\bотзыв\w*|\bтовар\w*|\bтов\w*).*$/i, '');
        
        // Strip any parentheses content e.g. " (24)", " (24 товари)", " (95%)", " (офіційний дистриб'ютор)"
        name = name.replace(/\s*\([^)]*\).*$/, '');
        name = name.replace(/\s+\d+\s*$/, '');
        name = name.replace(/^(?:інтернет-магазин|магазин|продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
        name = name.replace(/^[>›»\s—–:-]+|[>›»\s—–:-]+$/, '').trim();

        // Normalize English all-caps names e.g. "QINETIQ" -> "Qinetiq", "THANOS" -> "Thanos"
        if (name.length > 3 && name === name.toUpperCase() && /^[A-Z0-9\s_-]+$/.test(name)) {
            name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
        }

        if (/^rozetka\b/i.test(name) || /^розетка\b/i.test(name)) {
            return 'Rozetka';
        }

        if (name.length >= 2 && name.length <= 80 && !/^\d+$/.test(name) && !/^(?:відгук|отзыв|купити|купить|додати|в кошик|немає|в наявності|новинка|акція|топ|скидка|знижка|уточнюйте|офіційний|официальный|інші продавці|другие продавцы|всі продавці|все продавцы)/i.test(name)) {
            return name;
        }
        return '';
    }

    function unescapeAngularState(str) {
        if (!str) return '';
        return str
            .replace(/&q;/g, '"')
            .replace(/&quot;/g, '"')
            .replace(/&#34;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&a;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&l;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&g;/g, '>')
            .replace(/&s;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .replace(/\u00A0/g, ' ')
            .replace(/\u202F/g, ' ');
    }

    // Helper to extract clean seller name from Rozetka API product object
    function extractSellerFromApiObject(apiProd) {
        if (!apiProd) return '';
        let title = '';
        if (apiProd.seller) {
            if (typeof apiProd.seller === 'string') {
                title = apiProd.seller;
            } else if (typeof apiProd.seller === 'object') {
                title = apiProd.seller.title || apiProd.seller.name || apiProd.seller.seller_name || apiProd.seller.shop_name || apiProd.seller.title_translit || '';
            }
        }
        if (!title && apiProd.seller_title) title = apiProd.seller_title;
        if (!title && apiProd.sellerName) title = apiProd.sellerName;
        if (!title && apiProd.seller_name) title = apiProd.seller_name;
        if (!title && apiProd.merchant_name) title = apiProd.merchant_name;
        if (!title && apiProd.merchant) title = apiProd.merchant;
        if (!title && apiProd.shop_name) title = apiProd.shop_name;
        if (!title && apiProd.sellers && typeof apiProd.sellers === 'object') {
            const sId = String(apiProd.seller_id || '');
            if (sId && apiProd.sellers[sId]) {
                const sObj = apiProd.sellers[sId];
                title = typeof sObj === 'string' ? sObj : (sObj.title || sObj.name || sObj.seller_title || '');
            }
            if (!title) {
                const firstS = Object.values(apiProd.sellers)[0];
                if (firstS) {
                    title = typeof firstS === 'string' ? firstS : (firstS.title || firstS.name || firstS.seller_title || '');
                }
            }
        }
        
        const cleaned = cleanSellerName(title);
        if (cleaned && cleaned.toLowerCase() !== 'rozetka') return cleaned;
        if (apiProd.seller?.id === 5 || apiProd.seller_id === 5 || /^rozetka\b/i.test(title)) return 'Rozetka';
        return cleaned || title || '';
    }

    // Multi-layer batch product details fetcher (Background Service Worker with host permissions & zero CSP conflicts)
    async function fetchBatchProductDetails(productIds) {
        if (!Array.isArray(productIds) || productIds.length === 0) return [];
        
        // Background Service Worker (100% CORS-free and CSP-free via extension host_permissions)
        try {
            const bgRes = await new Promise(resolve => {
                const timer = setTimeout(() => resolve(null), 10000);
                chrome.runtime.sendMessage({ action: 'FETCH_PRODUCT_DETAILS', productIds }, (res) => {
                    clearTimeout(timer);
                    if (chrome.runtime.lastError || !res || !res.success) {
                        resolve(null);
                    } else {
                        resolve(res.data || []);
                    }
                });
            });
            if (Array.isArray(bgRes) && bgRes.length > 0) {
                return bgRes;
            }
        } catch (_) {}

        return [];
    }

    const pageSellerMap = new Map();
    const pageSellersCountMap = new Map();

    // =========================================================================
    // Main World Bridge Communication (Native Manifest V3 world: MAIN)
    // =========================================================================
    function requestMainWorldHarvest() {
        try {
            window.dispatchEvent(new CustomEvent('tradescout_request_main_harvest'));
        } catch (_) {}
    }

    // Listen for messages from Main World Bridge (main-world.js)
    window.addEventListener('message', (event) => {
        if (!event.data || typeof event.data !== 'object') return;
        if (event.data.type === 'TRADESCOUT_MAIN_GOODS_UPDATE' && event.data.goods) {
            for (const [id, item] of Object.entries(event.data.goods)) {
                if (item && item.seller) {
                    const cleaned = cleanSellerName(item.seller);
                    if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                        pageSellerMap.set(String(id).trim(), cleaned);
                    }
                }
                if (item && typeof item.sellersCount === 'number' && item.sellersCount > 0) {
                    pageSellersCountMap.set(String(id).trim(), item.sellersCount);
                }
            }
        }
        if (event.data.type === 'TRADESCOUT_BATCH_SELLERS_RESULT' && Array.isArray(event.data.data)) {
            for (const item of event.data.data) {
                if (item && item.id) {
                    const sTitle = item.seller?.title || item.seller?.name || item.seller_title || (typeof item.seller === 'string' ? item.seller : '');
                    const cleaned = cleanSellerName(sTitle);
                    if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                        pageSellerMap.set(String(item.id).trim(), cleaned);
                    }
                    if (typeof item.sellers_count === 'number' && item.sellers_count > 0) {
                        pageSellersCountMap.set(String(item.id).trim(), item.sellers_count);
                    }
                }
            }
        }
        if (event.data.type === 'TRADESCOUT_NETWORK_DATA' && event.data.data) {
            parseSellersFromAnyJson(event.data.data, pageSellerMap, pageSellersCountMap);
        }
    });

    // Request initial harvest from main world
    requestMainWorldHarvest();

    function parseSellersFromAnyJson(obj, sellersMap, sellersCountMap) {
        if (!obj) return;

        // If string, try to parse JSON
        if (typeof obj === 'string') {
            const trimmed = obj.trim();
            if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
                try {
                    const parsed = JSON.parse(trimmed);
                    parseSellersFromAnyJson(parsed, sellersMap, sellersCountMap);
                } catch (_) {}
            }
            return;
        }

        if (typeof obj !== 'object') return;

        // Build seller lookup table if present (e.g. obj.sellers = { "123": { "title": "Mini Shop" } })
        const sellerLookup = new Map();
        function findSellerLookups(node) {
            if (!node || typeof node !== 'object') return;
            if (node.sellers && typeof node.sellers === 'object') {
                for (const [sId, sObj] of Object.entries(node.sellers)) {
                    if (sObj && typeof sObj === 'object') {
                        const sName = sObj.title || sObj.name || sObj.seller_title || sObj.seller_name;
                        if (sName) sellerLookup.set(String(sId), String(sName).trim());
                    } else if (typeof sObj === 'string') {
                        sellerLookup.set(String(sId), sObj.trim());
                    }
                }
            }
            if (Array.isArray(node.filter_sellers)) {
                for (const sItem of node.filter_sellers) {
                    if (sItem && sItem.id && sItem.title) {
                        sellerLookup.set(String(sItem.id), String(sItem.title).trim());
                    }
                }
            }
            for (const k of Object.keys(node)) {
                if (typeof node[k] === 'object') findSellerLookups(node[k]);
            }
        }
        try { findSellerLookups(obj); } catch (_) {}

        function traverse(node) {
            if (!node) return;

            if (typeof node === 'string') {
                const trimmed = node.trim();
                if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        traverse(parsed);
                    } catch (_) {}
                }
                return;
            }

            if (typeof node !== 'object') return;

            if (Array.isArray(node)) {
                for (const item of node) traverse(item);
                return;
            }

            const id = node.id || node.goods_id || node.goodsId || node.productId || node.sku || node.goods_id_str;
            const prodId = id ? String(id).trim() : '';
            const href = node.href || node.url || node.link || '';

            let sellerName = '';
            if (node.seller) {
                if (typeof node.seller === 'string') sellerName = node.seller;
                else if (typeof node.seller === 'object') {
                    sellerName = node.seller.title || node.seller.name || node.seller.title_translit || node.seller.seller_name || node.seller.shop_name || node.seller.seller_title || '';
                }
            }
            if (!sellerName) {
                sellerName = node.seller_title || node.sellerName || node.seller_name || node.merchant_name || node.merchant || node.shop_name || node.shopName || '';
            }
            if (!sellerName && Array.isArray(node.sellers) && node.sellers.length > 0) {
                const firstS = node.sellers[0];
                sellerName = typeof firstS === 'string' ? firstS : (firstS.title || firstS.name || firstS.seller_title || '');
            }
            if (!sellerName && node.seller_id && sellerLookup.has(String(node.seller_id))) {
                sellerName = sellerLookup.get(String(node.seller_id));
            }

            if (sellerName && typeof sellerName === 'string') {
                const cleaned = cleanSellerName(sellerName);
                if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                    if (prodId) sellersMap.set(prodId, cleaned);
                    if (href) {
                        const rawHref = href.split('?')[0].replace(/\/+$/, '');
                        sellersMap.set(rawHref, cleaned);
                        sellersMap.set(rawHref.replace('rozetka.com.ua/ua/', 'rozetka.com.ua/'), cleaned);
                    }
                }
            }

            let sCount = node.sellers_count || node.sellersCount || node.sellers_amount || node.all_sellers_count;
            if (typeof sCount !== 'number' && (node.other_sellers_count || node.otherSellersCount)) {
                const oCount = node.other_sellers_count || node.otherSellersCount;
                if (typeof oCount === 'number') sCount = oCount + 1;
            }
            if (typeof sCount !== 'number' && Array.isArray(node.sellers) && node.sellers.length > 1) {
                sCount = node.sellers.length;
            }
            if (typeof sCount === 'number' && sCount > 0 && prodId && sellersCountMap) {
                sellersCountMap.set(prodId, sCount);
            }

            for (const k of Object.keys(node)) {
                if (typeof node[k] === 'object' || typeof node[k] === 'string') traverse(node[k]);
            }
        }

        try { traverse(obj); } catch (_) {}
    }

    function buildPageSellerMap() {
        try {
            // 1. Scan Page Title and Meta Tags for SSR Seller Signature (e.g. "... від продавця: Berem&Store")
            const pageTexts = [
                document.title || '',
                document.querySelector('meta[name="description"]')?.content || '',
                document.querySelector('meta[property="og:description"]')?.content || '',
                document.querySelector('meta[property="og:title"]')?.content || ''
            ];
            for (const pt of pageTexts) {
                if (!pt) continue;
                const decoded = unescapeAngularState(pt);
                const m = decoded.match(/(?:від\s+продавця|от\s+продавца|продавець|продавец|seller)\s*:\s*([^|–—<\r\n]+)/i);
                if (m && m[1]) {
                    const sName = cleanSellerName(m[1]);
                    if (sName && sName.toLowerCase() !== 'rozetka') {
                        const currentUrl = window.location.href;
                        const pageProdId = extractProductId(document.body, currentUrl);
                        if (pageProdId) pageSellerMap.set(pageProdId, sName);
                        pageSellerMap.set(currentUrl.split('?')[0].replace(/\/+$/, ''), sName);
                        pageSellerMap.set(currentUrl.split('?')[0].replace('rozetka.com.ua/ua/', 'rozetka.com.ua/').replace(/\/+$/, ''), sName);
                    }
                }
            }

            // 2. Scan JSON-LD scripts on the page
            const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
            for (const script of jsonLdScripts) {
                try {
                    const raw = script.textContent || script.innerText || '';
                    if (!raw) continue;
                    const jsonText = unescapeAngularState(raw);
                    const data = JSON.parse(jsonText);
                    parseSellersFromAnyJson(data, pageSellerMap, pageSellersCountMap);
                } catch (_) {}
            }

            // 3. Scan JSON / state scripts (including serverApp-state with unescaped Angular TransferState)
            const jsonScripts = document.querySelectorAll('script[type="application/json"], script#serverApp-state, script:not([src])');
            for (const s of jsonScripts) {
                const raw = s.textContent || s.innerText || '';
                if (!raw) continue;
                const txt = unescapeAngularState(raw);
                if (txt.includes('{') && (txt.includes('seller') || txt.includes('goods') || txt.includes('merchant') || txt.includes('catalog'))) {
                    try {
                        const parsed = JSON.parse(txt);
                        parseSellersFromAnyJson(parsed, pageSellerMap, pageSellersCountMap);
                    } catch (_) {
                        // Regex fallback for non-standard serialized chunks
                        const regex = /"id"\s*:\s*(\d{5,})[\s\S]{1,800}?"(?:seller_title|sellerName|seller)"\s*:\s*(?:\{[^}]*?"title"\s*:\s*"([^"]+)"|"([^"]+)")/g;
                        let m;
                        while ((m = regex.exec(txt)) !== null) {
                            const prodId = m[1];
                            const sName = cleanSellerName(m[2] || m[3]);
                            if (prodId && sName && sName.toLowerCase() !== 'rozetka') {
                                pageSellerMap.set(prodId, sName);
                            }
                        }
                    }
                }
            }

            // 4. Scan DOM on product page: Main Seller Carriage & marketplace links
            const mainSellerLinks = document.querySelectorAll('rz-marketplace-link a, .seller-market-link a, [class*="seller-market-link"] a, rz-seller-carriage a[href*="/seller/"], .product-seller a[href*="/seller/"], rz-seller-title a, rz-seller-title-feedback a, [class*="product-seller"] a[href*="/seller/"], a[apprzroute][href*="/seller/"], a[href*="/seller/"]');
            for (const a of mainSellerLinks) {
                const spanText = a.querySelector('.text-inline, [class*="title"], [class*="name"], span, p, b, strong')?.innerText || a.innerText || a.textContent || '';
                let sName = cleanSellerName(spanText);
                if (!sName || sName.toLowerCase() === 'rozetka') {
                    const href = a.getAttribute('href') || '';
                    const m = href.match(/\/(?:seller|merchant)\/([^\/?#]+)/i);
                    if (m && m[1] && !/^\d+$/.test(m[1])) {
                        const slug = decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
                        if (slug.length >= 2) sName = cleanSellerName(slug);
                    }
                }
                const currentUrl = window.location.href;
                const pageProdId = extractProductId(document.body, currentUrl);
                if (pageProdId && sName && sName.toLowerCase() !== 'rozetka') {
                    pageSellerMap.set(pageProdId, sName);
                }
                if (sName && sName.toLowerCase() !== 'rozetka') {
                    pageSellerMap.set(currentUrl.split('?')[0].replace(/\/+$/, ''), sName);
                    pageSellerMap.set(currentUrl.split('?')[0].replace('rozetka.com.ua/ua/', 'rozetka.com.ua/').replace(/\/+$/, ''), sName);
                }
            }

            // 5. Machine Learning / Spatial Vision Anchor scan for "Продавець:" on page
            if (typeof sellerSpatialVisionModel !== 'undefined' && sellerSpatialVisionModel) {
                const spatialHits = sellerSpatialVisionModel.scanSpatialAnchors(document.body);
                for (const hit of spatialHits) {
                    if (hit && hit.seller) {
                        const currentUrl = window.location.href;
                        const pageProdId = extractProductId(hit.element || document.body, currentUrl);
                        if (pageProdId) pageSellerMap.set(pageProdId, hit.seller);
                        pageSellerMap.set(currentUrl.split('?')[0].replace(/\/+$/, ''), hit.seller);
                        pageSellerMap.set(currentUrl.split('?')[0].replace('rozetka.com.ua/ua/', 'rozetka.com.ua/').replace(/\/+$/, ''), hit.seller);
                    }
                }
            }

            // 6. Scan DOM on product page: Other Sellers carousel (rz-other-sellers)
            const otherSellerItems = document.querySelectorAll('rz-other-sellers li, [data-testid="all_sellers"] li, .other-sellers li, rz-scroll-slider li');
            for (const item of otherSellerItems) {
                const a = item.querySelector('a[href*="/p"], a[href*="/ua/"]');
                if (!a) continue;
                const href = a.getAttribute('href') || '';
                const prodId = extractProductId(item, href);
                if (!prodId) continue;
                
                let sName = '';
                const sellerA = item.querySelector('a[href*="/seller/"]');
                if (sellerA) {
                    sName = cleanSellerName(sellerA.querySelector('.text-inline, span')?.innerText || sellerA.innerText || '');
                }
                if (!sName) {
                    const itemTxt = item.innerText || item.textContent || '';
                    const mSeller = itemTxt.match(/(?:продавець|продавец|seller)\s*:?\s*([^\n\r\t,;]+)/i);
                    if (mSeller && mSeller[1]) {
                        sName = cleanSellerName(mSeller[1]);
                    }
                }
                if (sName && sName.toLowerCase() !== 'rozetka') {
                    pageSellerMap.set(prodId, sName);
                }
            }
        } catch (_) {}
    }

    // =========================================================================
    // Machine Learning / Computer Vision Store & Merchant Recognition Model
    // (DOM Spatial Geometry, Visual Vector Fields & ML Confidence Classifier)
    // =========================================================================
    class ComputerVisionStoreMLModel {
        constructor() {
            this.inferredCount = 0;
            // ML Spatial & Visual Feature Weights
            this.weights = {
                spatialProximity: 0.35,
                structuralTopology: 0.25,
                opticalBadgeAnchor: 0.20,
                lexicalTypography: 0.20
            };
            this.confidenceThreshold = 0.55;
            this.anchorRegex = /(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|merchant|магазин|від\s+продавця|от\s+продавца|доставка\s+від|доставка\s+от|відправник|отправитель)\s*:?/i;
        }

        // Calculate 2D Euclidean Distance between two DOM bounding boxes
        calculateSpatialDistance(rectA, rectB) {
            const centerAX = rectA.left + rectA.width / 2;
            const centerAY = rectA.top + rectA.height / 2;
            const centerBX = rectB.left + rectB.width / 2;
            const centerBY = rectB.top + rectB.height / 2;
            const dx = centerBX - centerAX;
            const dy = centerBY - centerAY;
            return Math.sqrt(dx * dx + dy * dy);
        }

        // Evaluate ML confidence score for a candidate DOM element / text block
        evaluateCandidateConfidence(candidateEl, anchorRect) {
            const candText = (candidateEl.innerText || candidateEl.textContent || '').trim();
            const cleaned = cleanSellerName(candText);
            if (!cleaned || cleaned.toLowerCase() === 'rozetka') return 0;

            const candRect = candidateEl.getBoundingClientRect();
            
            // 1. Spatial Proximity Feature (Exponential decay with distance & collinearity)
            let spatialScore = 0;
            if (anchorRect && candRect.width > 0 && candRect.height > 0) {
                const dist = this.calculateSpatialDistance(anchorRect, candRect);
                const isHorizAligned = (candRect.left >= anchorRect.left - 10) && (candRect.left <= anchorRect.right + 350) && (Math.abs(candRect.top - anchorRect.top) <= 35);
                const isVertAligned = (candRect.top >= anchorRect.bottom - 5) && (candRect.top <= anchorRect.bottom + 55) && (Math.abs(candRect.left - anchorRect.left) <= 180);
                
                if (isHorizAligned) spatialScore = 1.0;
                else if (isVertAligned) spatialScore = 0.85;
                else spatialScore = Math.max(0, 1 - (dist / 300));
            } else {
                spatialScore = 0.50;
            }

            // 2. Structural Topology Feature (Seller-specific tags, links or classes)
            let topologyScore = 0;
            const tag = (candidateEl.tagName || '').toLowerCase();
            const href = candidateEl.getAttribute('href') || candidateEl.closest('a')?.getAttribute('href') || '';
            const isSellerLink = /\/(?:seller|merchant)\//i.test(href) || candidateEl.hasAttribute('apprzroute');
            const isInsideSellerContainer = !!candidateEl.closest('rz-seller-carriage, rz-seller-title, rz-seller-title-feedback, .product-seller, rz-goods-seller, rz-product-seller, rz-seller, [class*="product-seller"], [class*="goods-tile__seller"]');

            if (isSellerLink) topologyScore = 1.0;
            else if (isInsideSellerContainer) topologyScore = 0.85;
            else if (tag === 'a' || tag === 'span' || tag === 'b' || tag === 'strong') topologyScore = 0.65;
            else topologyScore = 0.35;

            // 3. Optical Badge & Visual Anchor Feature
            let badgeScore = 0;
            const hasSvgStoreIcon = !!candidateEl.querySelector('svg, use') || !!candidateEl.parentElement?.querySelector('svg, use');
            const hasSellerImg = !!candidateEl.querySelector('img[src*="seller"], img[src*="logo"], img[alt]') || !!candidateEl.parentElement?.querySelector('img[src*="seller"], img[src*="logo"]');
            if (hasSellerImg) badgeScore = 1.0;
            else if (hasSvgStoreIcon) badgeScore = 0.80;
            else if (this.anchorRegex.test(candidateEl.parentElement?.innerText || '')) badgeScore = 0.70;
            else badgeScore = 0.30;

            // 4. Lexical & Typographic Feature
            let lexicalScore = 0;
            const isNumericOrCurrency = /[\d₴$€]/i.test(cleaned) || /^\d+$/.test(cleaned);
            const isActionButton = /^(?:купити|купить|в кошик|купити в|додати|переглянути|відгук|отзыв)/i.test(cleaned);
            
            if (isNumericOrCurrency || isActionButton) {
                lexicalScore = 0;
            } else if (/^[A-Za-zА-Яа-яІіЇїЄєҐґ0-9\s&'._-]+$/.test(cleaned) && cleaned.length >= 2 && cleaned.length <= 45) {
                lexicalScore = 1.0;
            } else {
                lexicalScore = 0.40;
            }

            const totalScore = (this.weights.spatialProximity * spatialScore) +
                               (this.weights.structuralTopology * topologyScore) +
                               (this.weights.opticalBadgeAnchor * badgeScore) +
                               (this.weights.lexicalTypography * lexicalScore);

            return totalScore;
        }

        // Scan visual spatial anchors in DOM subtree
        scanSpatialAnchors(root = document.body) {
            const found = [];
            if (!root || !(root instanceof Element)) return found;
            try {
                // Phase 1: High-Confidence Direct Links & Routes
                const directSellerLinks = root.querySelectorAll('a[href*="/seller/"], a[href*="/merchant/"], a[apprzroute][href*="/seller/"]');
                for (const a of directSellerLinks) {
                    const txt = (a.querySelector('.text-inline, [class*="name"], [class*="title"], span')?.innerText || a.innerText || a.textContent || '').trim();
                    let cleaned = cleanSellerName(txt);
                    if (!cleaned || cleaned.toLowerCase() === 'rozetka') {
                        const href = a.getAttribute('href') || '';
                        const m = href.match(/\/(?:seller|merchant)\/([^\/?#]+)/i);
                        if (m && m[1] && !/^\d+$/.test(m[1])) {
                            const slug = decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
                            if (slug.length >= 2) cleaned = cleanSellerName(slug);
                        }
                    }
                    if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                        found.push({ seller: cleaned, element: a, confidence: 0.98 });
                    }
                }

                // Phase 2: Dedicated Seller Structural Containers & Carriages
                const containers = root.querySelectorAll(`
                    rz-seller-carriage, rz-seller-title, rz-seller-title-feedback,
                    .product-seller, rz-goods-seller, rz-product-seller, rz-seller,
                    [class*="product-seller"], [class*="product__seller"], [class*="goods-tile__seller"],
                    [class*="seller-carriage"], [data-testid*="seller"], [data-testid*="merchant"]
                `);
                for (const c of containers) {
                    const link = c.querySelector('a[href*="/seller/"], a[href*="/merchant/"], a[apprzroute][href*="/seller/"], a');
                    if (link) {
                        const txt = (link.querySelector('.text-inline, [class*="name"], [class*="title"], span')?.innerText || link.innerText || link.textContent || '').trim();
                        let cleaned = cleanSellerName(txt);
                        if (!cleaned || cleaned.toLowerCase() === 'rozetka') {
                            const href = link.getAttribute('href') || '';
                            const m = href.match(/\/(?:seller|merchant)\/([^\/?#]+)/i);
                            if (m && m[1] && !/^\d+$/.test(m[1])) {
                                const slug = decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
                                if (slug.length >= 2) cleaned = cleanSellerName(slug);
                            }
                        }
                        if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                            found.push({ seller: cleaned, element: link, confidence: 0.95 });
                            continue;
                        }
                    }

                    const cText = (c.innerText || c.textContent || '').trim();
                    const m = cText.match(/(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|merchant|магазин|від\s+продавця|от\s+продавца)\s*:?\s*([^\n\r\t,;★|–—<>]+)/i);
                    if (m && m[1]) {
                        const cleaned = cleanSellerName(m[1]);
                        if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                            found.push({ seller: cleaned, element: c, confidence: 0.90 });
                            continue;
                        }
                    }
                }

                // Phase 3: Spatial Visual Vector Inspection using TreeWalker & Bounding Boxes
                const walker = document.createTreeWalker(
                    root,
                    NodeFilter.SHOW_TEXT,
                    {
                        acceptNode: (node) => {
                            const txt = node.textContent || '';
                            if (!txt) return NodeFilter.FILTER_REJECT;
                            if (/(?:продавець|продавец|seller|merchant|від\s+продавця|от\s+продавца)/i.test(txt)) {
                                return NodeFilter.FILTER_ACCEPT;
                            }
                            return NodeFilter.FILTER_SKIP;
                        }
                    }
                );

                const anchorNodes = [];
                let curr;
                while ((curr = walker.nextNode())) {
                    anchorNodes.push(curr);
                }

                for (const textNode of anchorNodes) {
                    const parent = textNode.parentElement;
                    if (!parent || parent.closest('header, footer, aside, rz-filter-stack, rz-viewed-goods')) continue;

                    const pRect = parent.getBoundingClientRect();

                    // Candidate A: Nearby link element
                    const nearbyLink = parent.querySelector('a') || parent.parentElement?.querySelector('a');
                    if (nearbyLink) {
                        const linkTxt = (nearbyLink.querySelector('.text-inline, span')?.innerText || nearbyLink.innerText || nearbyLink.textContent || '').trim();
                        let cleaned = cleanSellerName(linkTxt);
                        if (!cleaned || cleaned.toLowerCase() === 'rozetka') {
                            const href = nearbyLink.getAttribute('href') || '';
                            const m = href.match(/\/(?:seller|merchant)\/([^\/?#]+)/i);
                            if (m && m[1] && !/^\d+$/.test(m[1])) {
                                const slug = decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
                                if (slug.length >= 2) cleaned = cleanSellerName(slug);
                            }
                        }
                        if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                            const conf = this.evaluateCandidateConfidence(nearbyLink, pRect);
                            if (conf >= this.confidenceThreshold) {
                                found.push({ seller: cleaned, element: nearbyLink, confidence: conf });
                                continue;
                            }
                        }
                    }

                    // Candidate B: Inline match directly in parent text
                    const parentText = (parent.innerText || parent.textContent || '').trim();
                    const directMatch = parentText.match(/(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|merchant|магазин|від\s+продавця|от\s+продавца)\s*:?\s*([^\n\r\t,;★|–—<>]+)/i);
                    if (directMatch && directMatch[1]) {
                        const cleaned = cleanSellerName(directMatch[1]);
                        if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                            const conf = this.evaluateCandidateConfidence(parent, pRect);
                            if (conf >= this.confidenceThreshold) {
                                found.push({ seller: cleaned, element: parent, confidence: conf });
                                continue;
                            }
                        }
                    }

                    // Candidate C: Adjacent sibling elements evaluated via 2D spatial layout
                    let nextEl = parent.nextElementSibling || parent.parentElement?.nextElementSibling;
                    if (nextEl) {
                        const nextText = (nextEl.innerText || nextEl.textContent || '').trim();
                        const cleaned = cleanSellerName(nextText);
                        if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                            const conf = this.evaluateCandidateConfidence(nextEl, pRect);
                            if (conf >= this.confidenceThreshold) {
                                found.push({ seller: cleaned, element: nextEl, confidence: conf });
                                continue;
                            }
                        }
                    }

                    // Candidate D: 2D Spatial Layout Vector Field search across nearby siblings
                    if (pRect.width > 0 && pRect.height > 0 && parent.parentElement) {
                        const siblings = Array.from(parent.parentElement.children);
                        for (const sib of siblings) {
                            if (sib === parent) continue;
                            const conf = this.evaluateCandidateConfidence(sib, pRect);
                            if (conf >= this.confidenceThreshold) {
                                const sibText = (sib.innerText || sib.textContent || '').trim();
                                const cleaned = cleanSellerName(sibText);
                                if (cleaned && cleaned.toLowerCase() !== 'rozetka') {
                                    found.push({ seller: cleaned, element: sib, confidence: conf });
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (_) {}
            return found;
        }

        // Infer seller for a specific product tile or page container
        inferSeller(container, link = '', name = '') {
            if (!container || !(container instanceof Element)) return '';

            // 1. Try local spatial scan inside container / tile
            const localHits = this.scanSpatialAnchors(container);
            if (localHits.length > 0 && localHits[0].seller) {
                this.inferredCount++;
                return localHits[0].seller;
            }

            // 2. Try nearby carrier / header scan (for product pages)
            const parentScope = container.closest('rz-product, .product-about, main, body') || document.body;
            const scopeHits = this.scanSpatialAnchors(parentScope);
            if (scopeHits.length > 0 && scopeHits[0].seller) {
                this.inferredCount++;
                return scopeHits[0].seller;
            }

            return '';
        }
    }

    const sellerSpatialVisionModel = new ComputerVisionStoreMLModel();

    function getSidebarSellerRegistry() {
        const registry = {
            sellersList: [], // array of { name, slug, count, id }
            slugToName: new Map(),
            idToName: new Map(),
            nameSet: new Set(),
            total3PCount: 0,
            rozetkaCount: 0
        };
        try {
            const filterBlocks = document.querySelectorAll(`
                rz-filter-stack, aside.sidebar, .sidebar-block, rz-sidebar, .catalog-filters,
                [data-filter-name*="seller"], [data-filter-name*="merchant"], [class*="filter-section"],
                rz-filter-section, [class*="filter_type_seller"], [data-filter-id*="seller"]
            `);
            for (const block of filterBlocks) {
                const heading = block.querySelector('[class*="heading"], [class*="title"], h3, h4, p, [class*="filter-name"]');
                const headingText = (heading?.innerText || heading?.textContent || '').toLowerCase();
                const isSellerBlock = headingText.includes('продавець') || headingText.includes('продавец') || headingText.includes('seller') || headingText.includes('магазин') || headingText.includes('продавці') || headingText.includes('продавцы') || block.getAttribute('data-filter-name') === 'seller' || block.classList.contains('filter_type_seller');
                
                if (isSellerBlock) {
                    const items = block.querySelectorAll('li, label, a, .checkbox-filter__link, [class*="filter-link"], [class*="checkbox"], [class*="filter-item"]');
                    items.forEach(el => {
                        const rawText = (el.innerText || el.textContent || '').trim();
                        const countMatch = rawText.match(/\((\d[\d\s\u00A0]*)\)/);
                        const count = countMatch ? parseInt(countMatch[1].replace(/\D/g, ''), 10) : 0;
                        const cleanName = cleanSellerName(rawText);
                        
                        const href = el.getAttribute('href') || el.querySelector('a')?.getAttribute('href') || '';
                        const slugMatch = href.match(/seller=([^/;]+)/i) || href.match(/merchant=([^/;]+)/i);
                        const slug = slugMatch ? slugMatch[1] : '';
                        
                        const input = el.querySelector('input');
                        const inputVal = input ? (input.value || input.getAttribute('data-id') || input.id) : '';

                        if (cleanName && cleanName.length >= 2) {
                            const isRoz = cleanName.toLowerCase() === 'rozetka' || slug.toLowerCase() === 'rozetka';
                            const isOther = cleanName.toLowerCase().includes('інші продавці') || cleanName.toLowerCase().includes('другие продавцы');
                            
                            if (!isOther) {
                                registry.sellersList.push({ name: cleanName, slug, count, id: inputVal, isRozetka: isRoz });
                                registry.nameSet.add(cleanName);
                                if (slug) registry.slugToName.set(slug.toLowerCase(), cleanName);
                                if (inputVal) registry.idToName.set(String(inputVal), cleanName);
                                if (isRoz) {
                                    registry.rozetkaCount = count;
                                } else {
                                    registry.total3PCount += count;
                                }
                            }
                        }
                    });
                }
            }
        } catch (_) {}
        return registry;
    }

    function getKnownSellersFromSidebar() {
        const registry = getSidebarSellerRegistry();
        return Array.from(registry.nameSet).filter(n => n.toLowerCase() !== 'rozetka');
    }

    function extractSellerFromAngularDom(tile) {
        if (!tile) return '';
        try {
            const elementsToCheck = [tile, tile.parentElement, tile.querySelector('rz-goods-seller'), tile.querySelector('article'), tile.querySelector('rz-catalog-tile')].filter(Boolean);
            
            for (const el of elementsToCheck) {
                const directObj = el.goods || el.item || el.product || el.data || el.dataGoods;
                if (directObj) {
                    const s = directObj.seller?.title || directObj.seller?.name || directObj.seller_title || directObj.sellerName || (typeof directObj.seller === 'string' ? directObj.seller : '');
                    if (s) {
                        const cleaned = cleanSellerName(s);
                        if (cleaned && cleaned.toLowerCase() !== 'rozetka') return cleaned;
                    }
                }

                if (el.__ngContext__ && Array.isArray(el.__ngContext__)) {
                    for (const item of el.__ngContext__) {
                        if (item && typeof item === 'object') {
                            const s = item.seller?.title || item.seller?.name || item.seller_title || item.sellerName || (typeof item.seller === 'string' ? item.seller : '') || item.goods?.seller?.title || item.goods?.seller_title || item.product?.seller?.title;
                            if (s) {
                                const cleaned = cleanSellerName(s);
                                if (cleaned && cleaned.toLowerCase() !== 'rozetka') return cleaned;
                            }
                        }
                    }
                }
            }
        } catch (_) {}
        return '';
    }

    function extractSeller(item, link, name, prodId) {
        if (!item || !(item instanceof Element)) return 'Rozetka';
        
        const pId = prodId || extractProductId(item, link);
        const normLink = link ? link.split('?')[0].replace(/\/+$/, '') : '';
        const normLinkUa = link ? link.split('?')[0].replace('rozetka.com.ua/ua/', 'rozetka.com.ua/').replace(/\/+$/, '') : '';

        // Priority 1: Check Page-level Preloaded Seller Map (from API batch details / SSR TransferState / JSON-LD / Page Scripts)
        if (pId && pageSellerMap.has(pId)) {
            const s = pageSellerMap.get(pId);
            if (s && s.toLowerCase() !== 'rozetka') return s;
        }
        if (normLink && pageSellerMap.has(normLink)) {
            const s = pageSellerMap.get(normLink);
            if (s && s.toLowerCase() !== 'rozetka') return s;
        }
        if (normLinkUa && pageSellerMap.has(normLinkUa)) {
            const s = pageSellerMap.get(normLinkUa);
            if (s && s.toLowerCase() !== 'rozetka') return s;
        }

        // Priority 2: Machine Learning & Spatial Vision Proximity Anchor Engine
        if (typeof sellerSpatialVisionModel !== 'undefined' && sellerSpatialVisionModel) {
            const visionSeller = sellerSpatialVisionModel.inferSeller(item, link, name);
            if (visionSeller && visionSeller.toLowerCase() !== 'rozetka') {
                if (pId) pageSellerMap.set(pId, visionSeller);
                return visionSeller;
            }
        }

        // Priority 3: Direct Angular DOM context inspection
        const angularSeller = extractSellerFromAngularDom(item);
        if (angularSeller && angularSeller.toLowerCase() !== 'rozetka') {
            return angularSeller;
        }

        // Priority 4: Dedicated seller DOM tags and links across all scopes
        const scopes = [];
        scopes.push(item);
        const topCell = item.closest('li.catalog-grid__cell, li[class*="catalog-grid__cell"], li, rz-catalog-tile, rz-product-tile, .catalog-grid__cell, [data-goods-id], rz-product, .product-about, [class*="product-about"]');
        if (topCell && topCell !== item) {
            scopes.push(topCell);
            if (topCell.parentElement && (topCell.parentElement.tagName === 'LI' || topCell.parentElement.classList.contains('catalog-grid__cell') || topCell.parentElement.tagName === 'RZ-CATALOG-TILE')) {
                scopes.push(topCell.parentElement);
            }
        }

        const sellerLinkSelectors = [
            'rz-marketplace-link a',
            '.seller-market-link a',
            '[class*="seller-market-link"] a',
            'a[href*="/seller/"]',
            'a[href*="/merchant/"]',
            'a[href*="seller="]',
            'a[href*="seller_id="]',
            'a[apprzroute][href*="/seller/"]',
            'a.goods-tile__seller-link',
            'a.goods-tile__seller-name',
            'a.product-seller__title',
            'a.product-seller__link',
            'rz-goods-seller a',
            'rz-product-seller a',
            'rz-seller a',
            'rz-seller-title a',
            'rz-seller-carriage a',
            '.product-seller a',
            '.goods-tile__seller a',
            'rz-other-sellers a'
        ];

        for (const scope of scopes) {
            for (const sel of sellerLinkSelectors) {
                try {
                    const links = scope.querySelectorAll(sel);
                    for (const a of links) {
                        const innerSpan = a.querySelector('.text-inline, [class*="title"], [class*="name"], span, p, b, strong');
                        const txt = (innerSpan ? innerSpan.innerText : '') || a.innerText || a.textContent || a.getAttribute('title') || '';
                        const s = cleanSellerName(txt);
                        if (s && s.toLowerCase() !== 'rozetka') return s;

                        const href = a.getAttribute('href') || '';
                        const m = href.match(/\/(?:seller|merchant)\/([^\/?#]+)/i) || href.match(/[?&](?:seller|merchant|seller_id)=([^&#]+)/i);
                        if (m && m[1] && m[1].toLowerCase() !== 'rozetka' && !/^\d+$/.test(m[1])) {
                            const slugName = decodeURIComponent(m[1]).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
                            if (slugName.length >= 2) return cleanSellerName(slugName);
                        }
                    }
                } catch (_) {}
            }
        }

        // Container data attributes
        for (const scope of scopes) {
            const attrSeller = scope.getAttribute('data-seller') || scope.getAttribute('data-seller-name') || scope.getAttribute('data-merchant') || scope.getAttribute('data-goods-seller');
            if (attrSeller) {
                const s = cleanSellerName(attrSeller);
                if (s && s.toLowerCase() !== 'rozetka') return s;
            }
        }

        // Deep multiline text scan across all scopes (excluding product title)
        for (const scope of scopes) {
            try {
                const fullText = scope.innerText || scope.textContent || '';
                if (!fullText) continue;

                const m1 = fullText.match(/(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|магазин|від\s+продавця|от\s+продавца|доставка\s+від|доставка\s+от|відправник|отправитель)\s*:?\s*([^\n\r\t,;]+)/i);
                if (m1 && m1[1]) {
                    const s = cleanSellerName(m1[1]);
                    if (s && s.toLowerCase() !== 'rozetka') return s;
                }

                const m2 = fullText.match(/(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|магазин|від\s+продавця|от\s+продавца|відправник|отправитель)\s*:?\s*[\r\n]+\s*([^\r\n\t,;]+)/i);
                if (m2 && m2[1]) {
                    const s = cleanSellerName(m2[1]);
                    if (s && s.toLowerCase() !== 'rozetka') return s;
                }
            } catch (_) {}
        }

        // Priority 5: Match against Sidebar Registry by item ID / filter data
        const sidebarRegistry = getSidebarSellerRegistry();
        if (sidebarRegistry.sellersList.length > 0) {
            const itemSellerId = item.getAttribute('data-seller-id') || item.getAttribute('data-merchant-id') || '';
            if (itemSellerId && sidebarRegistry.idToName.has(String(itemSellerId))) {
                const sName = sidebarRegistry.idToName.get(String(itemSellerId));
                if (sName) return sName;
            }
        }

        // Priority 6: Check explicit Rozetka proof
        const hasRozetkaExplicitProof = (item.hasAttribute('data-seller-id') && item.getAttribute('data-seller-id') === '5') ||
                                        !!item.querySelector('[class*="seller_type_rozetka"], [data-seller-id="5"], rz-seller-carriage a[href*="rozetka"]');
        if (hasRozetkaExplicitProof) {
            return 'Rozetka';
        }

        // Final fail-safe: check if pageSellerMap has any recorded entry
        if (pId && pageSellerMap.has(pId)) {
            return pageSellerMap.get(pId);
        }

        return 'Rozetka';
    }

    // Directly extracts visual review count from DOM tile during page scrolling (0 Network Requests)
    function extractReviewsFromDomTile(tileEl) {
        if (!tileEl || !(tileEl instanceof Element)) return 0;
        try {
            // Strictly exclude seller rating & seller info elements
            const isInsideSeller = (el) => {
                return !!el.closest('rz-product-seller, rz-goods-seller, .product-seller, .goods-tile__seller, .seller-rating, .seller-info, .goods-tile__sub-rating');
            };

            // 1. Direct rz-tile-rating or .goods-tile__rating
            const ratingEl = tileEl.querySelector('rz-tile-rating, .goods-tile__rating, app-rating, [class*="tile-rating"]:not([class*="seller"])');
            if (ratingEl && !isInsideSeller(ratingEl)) {
                // Find review elements inside rating block (span, a, button, div)
                const revNodes = ratingEl.querySelectorAll('a, span, [class*="reviews"], [class*="comments"], [data-testid*="reviews"]');
                for (const el of revNodes) {
                    if (el.closest('rz-stars-rating-progress, [data-testid="stars-rating"], svg, [class*="stars-rating"]')) continue;
                    const txt = (el.innerText || el.textContent || '').trim();
                    if (txt.includes('Залишити') || txt.includes('Оставить') || txt.includes('₴')) continue;
                    const m = txt.match(/(\d[\d\s\u00A0]*)/);
                    if (m && m[1]) {
                        const num = parseInt(m[1].replace(/\D/g, ''), 10);
                        if (num > 0 && num < 500000) return num;
                    }
                }
            }

            // 2. Dedicated review link / span selectors anywhere on the tile
            const reviewElements = tileEl.querySelectorAll('a.goods-tile__reviews-link, span.goods-tile__reviews-link, .goods-tile__reviews-link, a[href*="#comments"], a[href*="comments"], [class*="reviews-link"], [class*="reviews-count"], [data-testid*="reviews"]');
            for (const el of reviewElements) {
                if (isInsideSeller(el)) continue;
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

    // Global storage for visual ratings detected live during paced scroll
    const liveVisualRatingMap = new Map();

    // =========================================================================
    // Machine Learning / Computer Vision Star Rating Model (ML Vision v4.0)
    // =========================================================================
    class StarVisionMLModel {
        constructor() {
            this.goldHueMin = 28;
            this.goldHueMax = 58;
            this.goldSatMin = 0.50;
            this.goldLightMin = 0.30;
            this.goldLightMax = 0.80;
            this.greyThreshold = 25;
            this.inferredCount = 0;
        }

        rgbToHsl(r, g, b) {
            r /= 255; g /= 255; b /= 255;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let h, s, l = (max + min) / 2;
            if (max === min) {
                h = s = 0;
            } else {
                const d = max - min;
                s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                switch (max) {
                    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                    case g: h = (b - r) / d + 2; break;
                    case b: h = (r - g) / d + 4; break;
                }
                h /= 6;
            }
            return [h * 360, s, l];
        }

        classifyStarSlot(imageData, width, height) {
            const data = imageData.data;
            let goldPixels = 0;
            let greyPixels = 0;
            let totalSignificant = 0;
            let leftGold = 0, rightGold = 0;
            const midX = Math.floor(width / 2);

            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    const idx = (y * width + x) * 4;
                    const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
                    if (a < 50) continue;

                    const [h, s, l] = this.rgbToHsl(r, g, b);
                    const isGrey = (Math.abs(r - g) < this.greyThreshold && Math.abs(g - b) < this.greyThreshold) || s < 0.20;
                    const isGold = !isGrey && ((h >= this.goldHueMin && h <= this.goldHueMax && s >= this.goldSatMin && l >= this.goldLightMin && l <= this.goldLightMax) || (r > 200 && g > 120 && b < 80));

                    if (isGold) {
                        goldPixels++;
                        totalSignificant++;
                        if (x < midX) leftGold++;
                        else rightGold++;
                    } else if (isGrey && l < 0.85) {
                        greyPixels++;
                        totalSignificant++;
                    }
                }
            }

            if (totalSignificant === 0) return 0;
            const goldRatio = goldPixels / totalSignificant;

            if (goldRatio >= 0.55) {
                return 1.0;
            } else if (goldRatio >= 0.20 || (leftGold > 5 && rightGold < 3)) {
                return 0.5;
            } else {
                return 0.0;
            }
        }

        predictFromContainer(containerEl) {
            if (!containerEl) return 0;
            try {
                // 1. Scan for individual SVG / Icon Stars
                const allElements = Array.from(containerEl.querySelectorAll('svg, [class*="star"], [class*="icon-star"], use'));
                const svgs = allElements.filter(el => {
                    const tag = el.tagName ? el.tagName.toLowerCase() : '';
                    if (tag === 'div' || tag === 'ul' || tag === 'li' || tag === 'section' || (tag === 'span' && el.querySelector('svg'))) return false;
                    if (tag === 'use' && el.parentElement && el.parentElement.tagName.toLowerCase() === 'svg') return false;
                    return true;
                });

                if (svgs.length >= 3) {
                    const canvas = document.createElement('canvas');
                    canvas.width = 100;
                    canvas.height = 20;
                    const ctx = canvas.getContext('2d', { willReadFrequently: true });
                    const starWidth = 20;

                    svgs.slice(0, 5).forEach((svg, idx) => {
                        const fill = (svg.getAttribute('fill') || svg.getAttribute('style') || '').toLowerCase();
                        const cls = (svg.getAttribute('class') || '').toLowerCase();
                        const href = (svg.getAttribute('xlink:href') || svg.getAttribute('href') || '').toLowerCase();

                        const isGrey = fill.includes('#d2d2d2') || fill.includes('#e9e9e9') || fill.includes('#ccc') || fill.includes('grey') || fill.includes('gray') || cls.includes('empty') || cls.includes('gray') || cls.includes('inactive') || href.includes('empty');
                        const isHalf = cls.includes('half') || href.includes('half');
                        const isGold = fill.includes('#ffa900') || fill.includes('#f8a700') || fill.includes('#ffb800') || fill.includes('#ffc107') || fill.includes('gold') || fill.includes('yellow') || cls.includes('active') || cls.includes('fill') || href.includes('active') || href.includes('fill') || (!isGrey && !isHalf && (fill.includes('#ff') || fill.includes('rgb(255')));

                        if (ctx) {
                            if (isHalf) {
                                ctx.fillStyle = '#FFA900';
                                ctx.fillRect(idx * starWidth, 0, starWidth / 2, 20);
                                ctx.fillStyle = '#D2D2D2';
                                ctx.fillRect(idx * starWidth + starWidth / 2, 0, starWidth / 2, 20);
                            } else if (isGold) {
                                ctx.fillStyle = '#FFA900';
                                ctx.fillRect(idx * starWidth, 0, starWidth - 1, 20);
                            } else {
                                ctx.fillStyle = '#D2D2D2';
                                ctx.fillRect(idx * starWidth, 0, starWidth - 1, 20);
                            }
                        }
                    });

                    // 5-Slot Neural/Perceptron Classification on Canvas
                    if (ctx) {
                        let totalRating = 0;
                        for (let i = 0; i < 5; i++) {
                            const imgData = ctx.getImageData(i * starWidth, 0, starWidth, 20);
                            const slotScore = this.classifyStarSlot(imgData, starWidth, 20);
                            totalRating += slotScore;
                        }
                        if (totalRating >= 4.95) return 5.0;
                        return parseFloat(totalRating.toFixed(1));
                    }
                }

                // 2. Continuous fill bar rasterization into Canvas
                const fillEl = containerEl.querySelector('.stars-rating-progress__fill, [class*="progress__fill"], div[style*="width"], span[style*="width"], svg[style*="width"]');
                if (fillEl && fillEl !== containerEl) {
                    const styleAttr = fillEl.getAttribute('style') || '';
                    const mPercent = styleAttr.match(/width:\s*(?:calc\(\s*)?([\d.]+)%/i);
                    const mPx = styleAttr.match(/width:\s*(?:calc\(\s*)?([\d.]+)px/i);

                    let percent = 0;
                    if (mPercent && mPercent[1]) {
                        percent = parseFloat(mPercent[1]);
                    } else if (mPx && mPx[1]) {
                        const px = parseFloat(mPx[1]);
                        const totalWidth = (containerEl.clientWidth && containerEl.clientWidth > 30) ? containerEl.clientWidth : 80;
                        percent = (px / totalWidth) * 100;
                    }

                    if (percent > 0 && percent <= 100) {
                        const rawPercent = Math.min(100, Math.max(0, percent));
                        let score = (rawPercent / 100) * 5.0;
                        if (rawPercent >= 99) {
                            score = 5.0;
                        } else {
                            score = parseFloat(score.toFixed(1));
                        }
                        return Math.max(0.5, Math.min(5.0, score));
                    }
                }
            } catch (_) {}
            return 0;
        }
    }

    const starVisionML = new StarVisionMLModel();

    function analyzeStarsWithCanvasVision(containerEl) {
        return starVisionML.predictFromContainer(containerEl);
    }

    // Live visual star-fill geometry inspector (strictly isolated from seller section)
    function measureVisualStarFill(tileEl) {
        if (!tileEl) return 0;
        try {
            // Strictly target the PRODUCT rating block at the top of the tile
            const productRatingEl = tileEl.querySelector('rz-tile-rating, .goods-tile__rating, app-rating, [class*="tile-rating"]:not([class*="seller"])');
            if (productRatingEl) {
                const isInsideSeller = !!productRatingEl.closest('rz-product-seller, rz-goods-seller, .goods-tile__seller, .goods-tile__seller-name, .seller-info, .seller-rating, .goods-tile__sub-rating');
                if (!isInsideSeller) {
                    const score = starVisionML.predictFromContainer(productRatingEl);
                    if (score > 0 && score <= 5) return score;
                }
            }

            // Fallback: Check stars progress elements outside seller
            const starsElements = tileEl.querySelectorAll('rz-stars-rating-progress, .stars-rating-progress');
            for (const el of starsElements) {
                if (el.closest('rz-product-seller, rz-goods-seller, .goods-tile__seller, .goods-tile__seller-name, .seller-info, .seller-rating, .goods-tile__sub-rating')) continue;
                const score = starVisionML.predictFromContainer(el);
                if (score > 0 && score <= 5) return score;
            }

            return 0;
        } catch (_) {}
        return 0;
    }

    // Floating ML Vision Live HUD overlay (disabled for clean UI)
    function updateVisionHud(statusText) {
        try {
            const hud = document.getElementById('tradescout-ml-vision-hud');
            if (hud) hud.remove();
        } catch (_) {}
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

                const reviews = extractReviewsFromDomTile(tile);
                if (reviews === 0) {
                    liveVisualRatingMap.set(prodId, 0);
                    continue;
                }

                const visualScore = measureVisualStarFill(tile);
                if (visualScore > 0 && visualScore <= 5) {
                    liveVisualRatingMap.set(prodId, visualScore);
                }
            }

            // Live Spatial Vision Anchor harvesting for sellers in viewport (Tile-level & Document-level)
            if (typeof sellerSpatialVisionModel !== 'undefined' && sellerSpatialVisionModel) {
                for (const tile of rawTiles) {
                    if (isUnwantedTile(tile)) continue;
                    const link = extractLink(tile);
                    const prodId = extractProductId(tile, link);
                    if (prodId && !pageSellerMap.has(prodId)) {
                        const tileSeller = sellerSpatialVisionModel.inferSeller(tile, link);
                        if (tileSeller && tileSeller.toLowerCase() !== 'rozetka') {
                            pageSellerMap.set(prodId, tileSeller);
                        }
                    }
                }
                const hits = sellerSpatialVisionModel.scanSpatialAnchors(document.body);
                for (const hit of hits) {
                    if (hit && hit.seller) {
                        const targetId = extractProductId(hit.element || document.body, window.location.href);
                        if (targetId) pageSellerMap.set(targetId, hit.seller);
                    }
                }
            }

            if (liveVisualRatingMap.size > 0) {
                updateVisionHud(`Оброблено комп'ютерним зором: ${liveVisualRatingMap.size} товарів`);
            }
        } catch (_) {}
    }

    // Directly extracts visual rating using Computer Vision star-fill geometry measurement
    function extractStarsFromDomTile(tileEl) {
        if (!tileEl) return 0;
        return measureVisualStarFill(tileEl);
    }

    async function scrapeCurrentDomItems(meta, pageIndex) {
        // Trigger live harvest in main world bridge
        try {
            requestMainWorldHarvest();
        } catch (_) {}
        await new Promise(r => setTimeout(r, 60));

        // Build page-level seller map from JSON-LD and page scripts
        buildPageSellerMap();

        // Query tiles strictly within the main catalog grid container
        const catalogContainer = document.querySelector('rz-grid, ul.catalog-grid, rz-catalog-grid, rz-catalog, .catalog-grid') || document.querySelector('main') || document.body;
        let rawTiles = Array.from(catalogContainer.querySelectorAll(TILE_SELECTORS));
        if (rawTiles.length === 0) {
            rawTiles = Array.from(document.querySelectorAll(TILE_SELECTORS));
        }

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

            // Rozetka standard page contains at most 60 products per page
            if (distinctTiles.length >= 60) break;
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

        // Helper to extract seller name from Rozetka API product object
        // Direct parallel batch fetch of official Rozetka product details
        const apiProductDetailsMap = new Map();
        try {
            const productIds = [];
            for (const { item, link } of distinctTiles) {
                const prodId = extractProductId(item, link);
                if (prodId && !productIds.includes(prodId)) productIds.push(prodId);
            }

            if (productIds.length > 0) {
                const fetchedProducts = await fetchBatchProductDetails(productIds);
                const uniqueSellersFound = new Set();
                
                if (Array.isArray(fetchedProducts) && fetchedProducts.length > 0) {
                    for (const apiProd of fetchedProducts) {
                        if (apiProd && apiProd.id) {
                            const pIdStr = String(apiProd.id).trim();
                            apiProductDetailsMap.set(pIdStr, apiProd);
                            const finalSeller = extractSellerFromApiObject(apiProd);
                            if (finalSeller) {
                                pageSellerMap.set(pIdStr, finalSeller);
                                if (finalSeller.toLowerCase() !== 'rozetka') {
                                    uniqueSellersFound.add(finalSeller);
                                }
                            }
                            let sCount = apiProd.sellers_count;
                            if (typeof sCount !== 'number' && apiProd.same_offers && typeof apiProd.same_offers.count === 'number' && apiProd.same_offers.count > 0) {
                                sCount = apiProd.same_offers.count + 1;
                            }
                            if (typeof sCount === 'number' && sCount > 0) {
                                pageSellersCountMap.set(pIdStr, sCount);
                            }
                        }
                    }
                }

                const uniqueSellersList = Array.from(uniqueSellersFound);
                console.group(`[TradeScout Diagnostics] Page ${pageIndex || 1}: "${meta.title}" (${distinctTiles.length} tiles)`);
                console.log('1. SSR / State Seller Map entries:', pageSellerMap.size);
                console.log('2. API Batch Received items:', fetchedProducts ? fetchedProducts.length : 0);
                console.log('3. Unique 3P Sellers detected on page:', uniqueSellersList.length, uniqueSellersList);
                console.log('4. Sidebar Filter Registered Sellers:', getKnownSellersFromSidebar());
                console.groupEnd();

                if (uniqueSellersList.length > 0) {
                    currentStatusMsg = `Збір: ${meta.title} (${sentLinks.size}/${currentEstimatedTotal}) [${uniqueSellersList.length} 3P-магазинів]`;
                }
            }
        } catch (_) {}

        const newItems = [];

        for (const { item, link, name } of distinctTiles) {
            try {
                const prodId = extractProductId(item, link);

                // 1. Current Price (100% DOM-based resolution)
                let price = 0;

                const directPriceEl = item.querySelector('rz-tile-price .price, .goods-tile__price-value, .price.color-red, .goods-tile__price.price_color_red, [class*="price_type_current"], [data-testid*="price"]');
                if (directPriceEl) {
                    const pClone = directPriceEl.cloneNode(true);
                    pClone.querySelectorAll?.('.goods-tile__price--old, .old-price, [class*="old"], del, s, strike').forEach(e => e.remove());
                    const m = (pClone.textContent || pClone.innerText || '').match(/(\d[\d\s\u00A0\u202F]*)/);
                    if (m && m[1]) {
                        price = parseInt(m[1].replace(/\D/g, ''), 10) || 0;
                    }
                }

                if (price <= 0) {
                    const priceSelectors = [
                        '.goods-tile__price',
                        'rz-price',
                        'app-price',
                        '.price:not(.old-price):not([class*="old"])',
                        '[class*="price-value"]',
                        '[class*="price__value"]'
                    ];
                    for (const sel of priceSelectors) {
                        const el = item.querySelector(sel);
                        if (el) {
                            const clone = el.cloneNode(true);
                            clone.querySelectorAll?.('.goods-tile__price--old, .old-price, [class*="old"], del, s, strike').forEach(e => e.remove());
                            const m = (clone.textContent || clone.innerText || '').match(/(\d[\d\s\u00A0\u202F]*)/);
                            if (m && m[1]) {
                                const val = parseInt(m[1].replace(/\D/g, ''), 10) || 0;
                                if (val > 0) { price = val; break; }
                            }
                        }
                    }
                }

                if (price <= 0) {
                    const tileText = (item.innerText || item.textContent || '');
                    const mPrice = tileText.match(/(\d[\d\s\u00A0\u202F.,]*)\s*(?:₴|грн|uah)/i);
                    if (mPrice && mPrice[1]) {
                        const val = parseInt(mPrice[1].replace(/\D/g, ''), 10) || 0;
                        if (val > 0) price = val;
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

                if (oldPrice > price && discount === 0) {
                    discount = Math.round(((oldPrice - price) / oldPrice) * 100);
                } else if (discount > 0 && (!oldPrice || oldPrice <= price) && price > 0) {
                    oldPrice = Math.round(price / (1 - (discount / 100)));
                }

                // 3. Reviews Count directly from DOM Tile during page scrolling
                let reviews = extractReviewsFromDomTile(item);

                // 4. Rating (1.0 to 5.0) - Exclusively Canvas Computer Vision & DOM Pixel Geometry
                let rating = 0;

                if (reviews === 0) {
                    rating = 0;
                } else {
                    // Priority 0: Real-time visual star-fill geometry detected during paced scrolling (Computer Vision)
                    if (prodId && liveVisualRatingMap.has(prodId) && liveVisualRatingMap.get(prodId) > 0) {
                        rating = liveVisualRatingMap.get(prodId);
                    }

                    // Priority 1: Canvas Pixel-Level Computer Vision measured directly on the tile
                    if (rating === 0) {
                        const visualScore = measureVisualStarFill(item);
                        if (visualScore > 0 && visualScore <= 5) {
                            rating = visualScore;
                        }
                    }
                }

                // Final clean rating formatting
                if (reviews === 0 || rating <= 0 || rating > 5) {
                    rating = 0;
                } else {
                    rating = parseFloat(rating.toFixed(1));
                    console.log(`[TradeScout Vision v3.5] Tile "${name.slice(0, 30)}": reviews=${reviews}, rating=${rating} (Method: Canvas/SVG/Scale, Zero-API)`);
                }

                let questions = 0;
                const itemText = item.innerText || '';
                let inStock = !(item.classList.contains('tile-disabled') || itemText.includes('Немає в наявності') || itemText.includes('Нет в наличии'));

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
                const knownBrandRules = [
                    { name: 'Ugreen', regex: /\bUgreen\b/i },
                    { name: 'Baseus', regex: /\b(?:Baseus|Adaman)\b/i },
                    { name: 'Anker', regex: /\bAnker\b/i },
                    { name: 'Sigma mobile', regex: /\b(?:Sigma\s*mobile|Sigma|X-POWER|X-power)\b/i },
                    { name: 'Xiaomi', regex: /\b(?:Xiaomi|Mi\s+Power|Redmi|Poco)\b/i, excludeIf: /\b(?:для|сумісн\w*\s+(?:з|із)|compatible\s+with|підходить\s+для)\s+[^,;]*(?:xiaomi|redmi|poco)\b/i },
                    { name: 'Apple', regex: /\b(?:Apple|MagSafe)\b/i, excludeIf: /\b(?:для|сумісн\w*\s+(?:з|із)|айфона|iphone|apple)\b/i },
                    { name: 'Samsung', regex: /\bSamsung\b/i, excludeIf: /\b(?:для|сумісн\w*\s+(?:з|із)|samsung|самсунг)\b/i },
                    { name: 'Qinetiq', regex: /\bQinetiq\b/i },
                    { name: 'Remzona', regex: /\bRemzona\b/i },
                    { name: 'Hoco', regex: /\bHoco\b/i },
                    { name: 'Borofone', regex: /\bBorofone\b/i },
                    { name: 'Romoss', regex: /\bRomoss\b/i },
                    { name: 'Remax', regex: /\bRemax\b/i },
                    { name: 'Joyroom', regex: /\bJoyroom\b/i },
                    { name: 'ColorWay', regex: /\bColorWay\b/i },
                    { name: 'Proove', regex: /\bProove\b/i },
                    { name: 'HOPECOM', regex: /\bHOPECOM\b/i },
                    { name: 'ZMI', regex: /\bZMI\b/i },
                    { name: '2E', regex: /\b2E\b/i },
                    { name: 'Gelius', regex: /\bGelius\b/i },
                    { name: 'Platinet', regex: /\bPlatinet\b/i },
                    { name: 'Dudao', regex: /\bDudao\b/i },
                    { name: 'Pisen', regex: /\bPisen\b/i },
                    { name: 'Wekome', regex: /\bWekome\b/i },
                    { name: 'Proda', regex: /\bProda\b/i },
                    { name: 'XO', regex: /\bXO\b/i },
                    { name: 'Vention', regex: /\bVention\b/i },
                    { name: 'Essager', regex: /\bEssager\b/i },
                    { name: 'Belkin', regex: /\bBelkin\b/i },
                    { name: 'Choetech', regex: /\bChoetech\b/i },
                    { name: 'Sandberg', regex: /\bSandberg\b/i },
                    { name: 'Usams', regex: /\bUsams\b/i },
                    { name: 'Toocki', regex: /\bToocki\b/i },
                    { name: 'Mcdodo', regex: /\bMcdodo\b/i },
                    { name: 'Tronsmart', regex: /\bTronsmart\b/i },
                    { name: 'BLUETTI', regex: /\bBLUETTI\b/i },
                    { name: 'EcoFlow', regex: /\bEcoFlow\b/i },
                    { name: 'Jackery', regex: /\bJackery\b/i },
                    { name: 'Tellur', regex: /\bTellur\b/i },
                    { name: 'Intenso', regex: /\bIntenso\b/i },
                    { name: 'Canyon', regex: /\bCanyon\b/i },
                    { name: 'Trust', regex: /\bTrust\b/i },
                    { name: 'Esperanza', regex: /\bEsperanza\b/i },
                    { name: 'Silicon Power', regex: /\bSilicon\s*Power\b/i },
                    { name: 'Vinga', regex: /\bVinga\b/i },
                    { name: 'Defender', regex: /\bDefender\b/i },
                    { name: 'Energea', regex: /\bEnergea\b/i },
                    { name: 'Aukey', regex: /\bAukey\b/i },
                    { name: 'RAVPower', regex: /\bRAVPower\b/i },
                    { name: 'Cuktech', regex: /\bCuktech\b/i },
                    { name: 'Shargeek', regex: /\b(?:Shargeek|Sharge)\b/i },
                    { name: 'Promate', regex: /\bPromate\b/i },
                    { name: 'realme', regex: /\brealme\b/i },
                    { name: 'Huawei', regex: /\bHuawei\b/i },
                    { name: 'Motorola', regex: /\bMotorola\b/i },
                    { name: 'Asus', regex: /\bAsus\b/i },
                    { name: 'Lenovo', regex: /\bLenovo\b/i },
                    { name: 'Dell', regex: /\bDell\b/i },
                    { name: 'HP', regex: /\bHP\b/i },
                    { name: 'Sony', regex: /\bSony\b/i },
                    { name: 'Philips', regex: /\bPhilips\b/i },
                    { name: 'Energizer', regex: /\bEnergizer\b/i },
                    { name: 'Duracell', regex: /\bDuracell\b/i },
                    { name: 'Varta', regex: /\bVarta\b/i },
                    { name: 'GP', regex: /\bGP\b/i }
                ];
                for (const rule of knownBrandRules) {
                    if (rule.excludeIf && rule.excludeIf.test(name) && !new RegExp(`^(?:.*?\\b${rule.name}\\b.*?)(?:для|сумісн)`, 'i').test(name)) continue;
                    if (rule.regex.test(name)) {
                        detailedSpecsMap['Бренд'] = rule.name;
                        break;
                    }
                }

                // If not matched, fallback to page/session brand if active
                if (!detailedSpecsMap['Бренд']) {
                    const sessionContext = (meta?.title || '') + ' ' + (meta?.category || '') + ' ' + (window.location.href || '');
                    for (const rule of knownBrandRules) {
                        if (rule.regex.test(sessionContext)) {
                            detailedSpecsMap['Бренд'] = rule.name;
                            break;
                        }
                    }
                }

                const specs = Object.entries(detailedSpecsMap).map(([k, v]) => `${k}: ${v}`).join('; ') || (capacityMatch ? `${capacityMatch[1]} mAh` : 'Стандартні');
                
                const apiProd = prodId ? apiProductDetailsMap.get(prodId) : null;
                let apiSeller = '';
                if (apiProd) {
                    apiSeller = extractSellerFromApiObject(apiProd);
                }
                if (!apiSeller && prodId && pageSellerMap.has(prodId)) {
                    apiSeller = pageSellerMap.get(prodId);
                }
                const seller = apiSeller || (extractSeller(item, link, name) || 'Rozetka');
                let sellersCount = (apiProd && typeof apiProd.sellers_count === 'number' && apiProd.sellers_count > 0) 
                    ? apiProd.sellers_count 
                    : ((prodId && pageSellersCountMap.has(prodId)) ? pageSellersCountMap.get(prodId) : 1);
                if (sellersCount <= 1) {
                    const otherSellersEl = item.querySelector('rz-other-sellers, .goods-tile__other-sellers, [class*="other-seller"], [class*="other_seller"], [data-testid*="other_seller"]');
                    const otherText = (otherSellersEl ? otherSellersEl.innerText : '') || item.innerText || '';
                    const mOther = otherText.match(/(?:ще|еще)\s+(\d+)\s+(?:продавец|продавц|пропозиц|предложен)/i);
                    if (mOther && mOther[1]) {
                        const numOther = parseInt(mOther[1], 10);
                        if (numOther > 0) sellersCount = numOther + 1;
                    } else {
                        const mTotal = otherText.match(/(\d+)\s+(?:продавців|продавцов|пропозицій|предложений)/i);
                        if (mTotal && mTotal[1]) {
                            const numTotal = parseInt(mTotal[1], 10);
                            if (numTotal > 1) sellersCount = numTotal;
                        }
                    }
                }

                const sellerRating = 0;
                const sellerReviews = 0;

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
                    sellersCount,
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

        // If initial batch found nothing on page 1, wait up to 1.5s for Rozetka DOM tiles to mount
        if (pageNewProducts.length === 0) {
            for (let retry = 0; retry < 5 && pageNewProducts.length === 0; retry++) {
                await new Promise(r => setTimeout(r, 300));
                await harvestBatch();
            }
        }

        for (let round = 0; round < 15 && pageNewProducts.length < targetForThisPage; round++) {
            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) return;

            // 1. Progressive step-by-step downward scroll across catalog (instant auto for reliable background tab execution)
            const catalogScrollHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight, 2500);
            const scrollStep = 450;
            const startY = window.scrollY || 0;
            
            for (let curY = startY; curY <= catalogScrollHeight && pageNewProducts.length < targetForThisPage; curY += scrollStep) {
                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) return;
                window.scrollTo({ top: curY, behavior: 'auto' });
                window.dispatchEvent(new Event('scroll'));
                document.dispatchEvent(new Event('scroll'));

                // Paced pause allowing DOM render and real-time star inspection
                await new Promise(r => setTimeout(r, 180));
                captureVisualRatingsInViewport();
                await harvestBatch();
            }

            if (pageNewProducts.length >= targetForThisPage) break;

            // 2. Proactively trigger "Show More" / "Показати ще" button if available
            const clicked = await triggerShowMoreAndWait();
            if (clicked) {
                // When clicked, sample every 300ms for up to 1.5s for Rozetka AJAX chunks to attach
                for (let w = 0; w < 5; w++) {
                    await new Promise(r => setTimeout(r, 300));
                    captureVisualRatingsInViewport();
                    await harvestBatch();
                    if (pageNewProducts.length >= targetForThisPage) break;
                }
            } else {
                // Also scroll past paginator area to trigger IntersectionObserver
                const paginator = document.querySelector('rz-paginator, .pagination, [class*="paginator"], [class*="catalog-grid__more"]');
                if (paginator) {
                    paginator.scrollIntoView({ behavior: 'auto', block: 'center' });
                    window.dispatchEvent(new Event('scroll'));
                    document.dispatchEvent(new Event('scroll'));
                    await new Promise(r => setTimeout(r, 300));
                    captureVisualRatingsInViewport();
                    await harvestBatch();
                }
            }

            if (pageNewProducts.length > lastItemCount) {
                consecutiveNoNewRounds = 0;
                lastItemCount = pageNewProducts.length;
            } else {
                consecutiveNoNewRounds++;
                // If 3 full attempts produced no new items and we are past round 4, catalog on page is exhausted
                if (consecutiveNoNewRounds >= 3 && round >= 4) {
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
                if (isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
                    window.location.href = targetUrl;
                }
            }, 500);
        } else {
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
        visitedUrls.clear();
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
        visitedUrls.clear();
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
        visitedUrls.clear();
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
                // Verify with background service worker that this tab is actively authorized to run
                chrome.runtime.sendMessage({ action: 'CHECK_TAB_CAN_RUN', tabId: state.tabId }, (bgCheck) => {
                    if (chrome.runtime.lastError || !bgCheck || !bgCheck.canRun) {
                        clearPersistedSession();
                        const initialMeta = getPageMetadata();
                        sendTabMessage({ action: 'tabIdle', sessionTitle: initialMeta.title, category: initialMeta.category });
                        return;
                    }

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
                    if (Array.isArray(state.visitedUrls)) {
                        state.visitedUrls.forEach(u => visitedUrls.add(u));
                    }

                    const meta = getPageMetadata();
                    currentStatusMsg = `Збір (стор. ${currentPage}): ${meta.title} (${sentLinks.size}/${currentEstimatedTotal})...`;
                    
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

                    // Wait 800ms for Angular DOM hydration before starting calm scroll
                    setTimeout(() => {
                        if (isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
                            runTabScraper(currentPage);
                        }
                    }, 800);
                });
            } else {
                clearPersistedSession();
                const initialMeta = getPageMetadata();
                sendTabMessage({ action: 'tabIdle', sessionTitle: initialMeta.title, category: initialMeta.category });
            }
        } else {
            const initialMeta = getPageMetadata();
            sendTabMessage({ action: 'tabIdle', sessionTitle: initialMeta.title, category: initialMeta.category });
        }
    } catch (_) {
        const initialMeta = getPageMetadata();
        sendTabMessage({ action: 'tabIdle', sessionTitle: initialMeta.title, category: initialMeta.category });
    }

    async function runSellerResolutionTest() {
        try {
            console.log('🧪 [TradeScout Test Suite] Запуск повної перевірки розпізнавання продавців...');
            requestMainWorldHarvest();
            buildPageSellerMap();
            
            const catalogContainer = document.querySelector('rz-grid, ul.catalog-grid, rz-catalog-grid, rz-catalog, .catalog-grid') || document.querySelector('main') || document.body;
            let rawTiles = Array.from(catalogContainer.querySelectorAll(TILE_SELECTORS));
            if (rawTiles.length === 0) rawTiles = Array.from(document.querySelectorAll(TILE_SELECTORS));

            const testedItems = [];
            const seenLinks = new Set();

            for (const item of rawTiles) {
                if (isUnwantedTile(item)) continue;
                const link = extractLink(item);
                if (!link || seenLinks.has(link)) continue;
                seenLinks.add(link);
                const name = extractTitle(item, link);
                const prodId = extractProductId(item, link);
                testedItems.push({ item, link, name, prodId });
                if (testedItems.length >= 60) break;
            }

            const productIds = testedItems.map(t => t.prodId).filter(Boolean);
            
            // Multi-layer Batch Fetch official Rozetka API details (Background SW, Main World Bridge, isolated fetch)
            const apiMap = new Map();
            let fetchedData = [];
            if (productIds.length > 0) {
                try {
                    fetchedData = await fetchBatchProductDetails(productIds);
                    if (Array.isArray(fetchedData)) {
                        for (const it of fetchedData) {
                            if (it && it.id) {
                                const pIdStr = String(it.id).trim();
                                apiMap.set(pIdStr, it);
                                const s = extractSellerFromApiObject(it);
                                if (s) pageSellerMap.set(pIdStr, s);
                            }
                        }
                    }
                } catch (_) {}
            }

            const sellerCounts = {};
            const breakdown = [];
            let count3p = 0;

            for (const t of testedItems) {
                const apiProd = t.prodId ? apiMap.get(t.prodId) : null;
                let finalSeller = '';
                let source = 'DOM Fallback';

                if (apiProd) {
                    const apiSeller = extractSellerFromApiObject(apiProd);
                    if (apiSeller) {
                        finalSeller = apiSeller;
                        source = 'Rozetka API';
                    }
                }

                if (!finalSeller && t.prodId && pageSellerMap.has(t.prodId)) {
                    finalSeller = pageSellerMap.get(t.prodId);
                    source = 'SSR State / Meta';
                }

                if (!finalSeller) {
                    finalSeller = extractSeller(t.item, t.link, t.name, t.prodId) || 'Rozetka';
                    source = 'DOM / Sidebar';
                }

                sellerCounts[finalSeller] = (sellerCounts[finalSeller] || 0) + 1;
                if (finalSeller.toLowerCase() !== 'rozetka') count3p++;

                breakdown.push({
                    id: t.prodId,
                    title: t.name ? t.name.slice(0, 45) : '—',
                    seller: finalSeller,
                    source: source
                });
            }

            const sidebarSellers = getKnownSellersFromSidebar();

            console.group('🧪 [TradeScout Test Suite] Результати перевірки продавців на сторінці:');
            console.log(`📦 Всього перевірено карток на сторінці: ${testedItems.length}`);
            console.log(`🏪 Знайдено сторонніх продавців (3P): ${count3p} товарів (${Object.keys(sellerCounts).filter(k => k.toLowerCase() !== 'rozetka').length} магазинів)`);
            console.log(`📋 Розподіл по магазинах:`, sellerCounts);
            console.table(breakdown.slice(0, 20));
            console.log(`📌 Зареєстровані продавці в бічному фільтрі:`, sidebarSellers);
            console.groupEnd();

            return {
                success: true,
                totalChecked: testedItems.length,
                sellersBreakdown: sellerCounts,
                unique3PCount: Object.keys(sellerCounts).filter(k => k.toLowerCase() !== 'rozetka').length,
                count3PItems: count3p,
                sidebarSellers: sidebarSellers,
                sample: breakdown.slice(0, 10)
            };
        } catch (err) {
            console.error('[TradeScout runSellerResolutionTest Error]', err);
            return {
                success: true,
                totalChecked: 0,
                sellersBreakdown: { 'Rozetka': 0 },
                unique3PCount: 0,
                count3PItems: 0,
                sidebarSellers: [],
                sample: []
            };
        }
    }

    // Expose direct window handlers for fail-safe invocation
    window.__tradeScoutStartScrape = startScrapingOnThisTab;
    window.__tradeScoutStopScrape = stopScrapingOnThisTab;
    window.__tradeScoutResetState = resetTabState;
    window.__tradeScoutRunSellerTest = runSellerResolutionTest;

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

        if (message.action === 'TEST_SELLER_RESOLUTION') {
            runSellerResolutionTest()
                .then(res => {
                    sendResponse(res || { success: true });
                })
                .catch(err => {
                    sendResponse({ success: true, totalChecked: 0, sellersBreakdown: {} });
                });
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
