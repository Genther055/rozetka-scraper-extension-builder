// TradeScout Content Script v3.0 (Multi-Tab, Controlled Scraper & Live Floating HUD)
(function() {
    if (window.self !== window.top) return; // Skip iframes
    if (window.__tradeScoutInjected) return; // Prevent duplicate injection
    window.__tradeScoutInjected = true;

    console.log('TradeScout Content Script loaded on:', window.location.href);

    let isTabScrapingActive = false;
    window.__tradeScoutIsScrapingActive = false;
    let currentSessionId = null;
    let currentTabId = null;
    let webhookEndpoint = 'https://rozetka-scraper-extension-builder.onrender.com/api/products';
    const sentLinks = new Set();
    let hudTimerInterval = null;
    let hudStartTime = null;

    // --- Floating In-Page HUD Widget ---
    let hudContainer = null;
    let hudShadow = null;

    function createOrGetHud() {
        if (hudContainer && document.body.contains(hudContainer)) {
            return hudShadow;
        }

        hudContainer = document.createElement('div');
        hudContainer.id = 'tradescout-inpage-hud-host';
        hudContainer.style.position = 'fixed';
        hudContainer.style.bottom = '20px';
        hudContainer.style.right = '20px';
        hudContainer.style.zIndex = '2147483647';
        hudContainer.style.fontFamily = 'Segoe UI, system-ui, -apple-system, sans-serif';

        hudShadow = hudContainer.attachShadow({ mode: 'open' });
        hudShadow.innerHTML = `
            <style>
                .hud-box {
                    width: 290px;
                    background: #0f172a;
                    border: 1px solid rgba(255, 255, 255, 0.15);
                    border-radius: 12px;
                    padding: 12px;
                    color: #f8fafc;
                    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(99, 102, 241, 0.2);
                    backdrop-filter: blur(12px);
                    font-size: 12px;
                    line-height: 1.4;
                    box-sizing: border-box;
                    animation: slideUp 0.3s ease-out;
                }
                @keyframes slideUp {
                    from { transform: translateY(20px); opacity: 0; }
                    to { transform: translateY(0); opacity: 1; }
                }
                .hud-header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 8px;
                    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                    padding-bottom: 6px;
                }
                .hud-brand {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                    font-weight: 800;
                    font-size: 12px;
                    color: #ffffff;
                }
                .hud-dot {
                    width: 8px;
                    height: 8px;
                    border-radius: 50%;
                    background: #94a3b8;
                }
                .hud-title {
                    font-weight: 700;
                    color: #38bdf8;
                    font-size: 12px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    margin-bottom: 6px;
                }
                .hud-progress-bg {
                    width: 100%;
                    height: 6px;
                    background: #1e293b;
                    border-radius: 3px;
                    overflow: hidden;
                    margin-bottom: 6px;
                    border: 1px solid rgba(255, 255, 255, 0.05);
                }
                .hud-progress-fill {
                    height: 100%;
                    width: 0%;
                    background: linear-gradient(90deg, #10b981, #6366f1);
                    border-radius: 3px;
                    transition: width 0.25s ease;
                }
                .hud-status-row {
                    display: flex;
                    justify-content: space-between;
                    font-size: 11px;
                    color: #94a3b8;
                    margin-bottom: 8px;
                    font-weight: 600;
                }
                .hud-msg {
                    font-size: 11px;
                    color: #cbd5e1;
                    margin-bottom: 8px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .hud-actions {
                    display: flex;
                    gap: 6px;
                }
                .hud-btn {
                    flex: 1;
                    padding: 5px 8px;
                    border-radius: 6px;
                    font-size: 11px;
                    font-weight: 700;
                    cursor: pointer;
                    border: none;
                    transition: all 0.2s;
                }
                .hud-btn-start {
                    background: #10b981;
                    color: #fff;
                }
                .hud-btn-start:hover { background: #059669; }
                .hud-btn-stop {
                    background: #ef4444;
                    color: #fff;
                }
                .hud-btn-stop:hover { background: #dc2626; }
                .hud-btn-min {
                    background: #334155;
                    color: #cbd5e1;
                    padding: 5px 8px;
                }
                .hud-btn-min:hover { background: #475569; }
                .minimized {
                    width: auto !important;
                    padding: 6px 10px !important;
                }
            </style>
            <div class="hud-box" id="hud-box">
                <div class="hud-header">
                    <div class="hud-brand">
                        <div class="hud-dot" id="hud-dot"></div>
                        <span>TradeScout</span>
                        <span style="font-size: 9px; color: #10b981; font-weight: bold;">LIVE</span>
                    </div>
                    <button class="hud-btn hud-btn-min" id="btn-hud-min" title="Згорнути/Розгорнути">_</button>
                </div>
                <div id="hud-body">
                    <div class="hud-title" id="hud-title">Каталог Rozetka</div>
                    <div class="hud-progress-bg">
                        <div class="hud-progress-fill" id="hud-fill"></div>
                    </div>
                    <div class="hud-status-row">
                        <span id="hud-count">0 товарів</span>
                        <span id="hud-timer">Час: 00:00</span>
                    </div>
                    <div class="hud-msg" id="hud-msg">Готовий до запуску</div>
                    <div class="hud-actions">
                        <button class="hud-btn hud-btn-start" id="btn-hud-start">Запустити збір</button>
                        <button class="hud-btn hud-btn-stop" id="btn-hud-stop" style="display: none;">Зупинити</button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(hudContainer);

        // Bind in-page HUD buttons
        const btnStart = hudShadow.getElementById('btn-hud-start');
        const btnStop = hudShadow.getElementById('btn-hud-stop');
        const btnMin = hudShadow.getElementById('btn-hud-min');
        const hudBody = hudShadow.getElementById('hud-body');
        const hudBox = hudShadow.getElementById('hud-box');

        btnMin.addEventListener('click', () => {
            const isHidden = hudBody.style.display === 'none';
            hudBody.style.display = isHidden ? 'block' : 'none';
            if (isHidden) {
                hudBox.classList.remove('minimized');
                btnMin.innerText = '_';
            } else {
                hudBox.classList.add('minimized');
                btnMin.innerText = '□';
            }
        });

        btnStart.addEventListener('click', () => {
            startScrapingOnThisTab();
        });

        btnStop.addEventListener('click', () => {
            stopScrapingOnThisTab();
        });

        return hudShadow;
    }

    function updateHud(state) {
        const shadow = createOrGetHud();
        if (!shadow) return;

        const hudTitle = shadow.getElementById('hud-title');
        const hudFill = shadow.getElementById('hud-fill');
        const hudCount = shadow.getElementById('hud-count');
        const hudMsg = shadow.getElementById('hud-msg');
        const hudDot = shadow.getElementById('hud-dot');
        const btnStart = shadow.getElementById('btn-hud-start');
        const btnStop = shadow.getElementById('btn-hud-stop');

        if (state.sessionTitle) hudTitle.innerText = state.sessionTitle;
        if (state.percent !== undefined) hudFill.style.width = `${Math.min(100, Math.max(0, state.percent))}%`;
        if (state.total !== undefined) {
            if (state.estimatedTotal && state.estimatedTotal > 0) {
                hudCount.innerText = `${state.total} / ${state.estimatedTotal} тов. (${state.percent || 0}%)`;
            } else {
                hudCount.innerText = `${state.total} товарів`;
            }
        }
        if (state.statusMsg) hudMsg.innerText = state.statusMsg;

        if (state.isRunning) {
            hudDot.style.background = '#10b981';
            hudDot.style.boxShadow = '0 0 8px #10b981';
            btnStart.style.display = 'none';
            btnStop.style.display = 'block';
        } else {
            hudDot.style.background = state.finished ? '#10b981' : '#94a3b8';
            hudDot.style.boxShadow = 'none';
            btnStart.style.display = 'block';
            btnStop.style.display = 'none';
            btnStart.innerText = state.finished ? 'Зібрати повторно' : 'Запустити збір';
        }
    }

    function startHudTimer() {
        if (hudTimerInterval) clearInterval(hudTimerInterval);
        hudStartTime = Date.now();
        hudTimerInterval = setInterval(() => {
            const shadow = createOrGetHud();
            if (!shadow) return;
            const timerEl = shadow.getElementById('hud-timer');
            if (timerEl) {
                const sec = Math.floor((Date.now() - hudStartTime) / 1000);
                const m = String(Math.floor(sec / 60)).padStart(2, '0');
                const s = String(sec % 60).padStart(2, '0');
                timerEl.innerText = `Час: ${m}:${s}`;
            }
        }, 1000);
    }

    function stopHudTimer() {
        if (hudTimerInterval) {
            clearInterval(hudTimerInterval);
            hudTimerInterval = null;
        }
    }

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

    function findPaginationActionElements(currentPage) {
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

        const nextPageNum = currentPage + 1;
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
            element.scrollIntoView({ behavior: 'auto', block: 'center' });
        } catch (_) {}

        try {
            element.focus();
            element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
            element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, view: window }));
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            element.click();
            element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        } catch (_) {
            try { element.click(); } catch (__) {}
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
        let estimatedTotal = getEstimatedTotalFromPage();
        console.log(`TradeScout Tab ${currentTabId}: Started scraping "${meta.title}"...`);

        startHudTimer();
        const initialPercent = Math.min(100, Math.round((sentLinks.size / Math.max(1, estimatedTotal)) * 100)) || 1;
        updateHud({
            sessionTitle: meta.title,
            percent: initialPercent,
            total: sentLinks.size,
            estimatedTotal: estimatedTotal,
            statusMsg: `Збір: ${meta.title} (${sentLinks.size}/${estimatedTotal})...`,
            isRunning: true
        });

        let pageCount = initialPage || 1;
        let consecutiveNoNew = 0;
        let lastCount = sentLinks.size;
        const tileSelectors = 'rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], div[class*="goods-tile"], article[class*="tile"], [data-testid="goods-tile"]';

        while (isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
            const latestEstimated = getEstimatedTotalFromPage();
            if (latestEstimated > estimatedTotal) {
                estimatedTotal = latestEstimated;
            }

            // 1. Silent scroll
            await silentBackgroundScroll();
            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;

            // 2. Scrape all items on current page
            let newProducts = await scrapeCurrentDomItems(meta, pageCount);
            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;
            
            if (newProducts.length === 0 || (sentLinks.size < estimatedTotal && newProducts.length % 60 !== 0)) {
                await new Promise(r => setTimeout(r, 300));
                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;
                const extraSweep = await scrapeCurrentDomItems(meta, pageCount);
                if (extraSweep.length > 0) {
                    newProducts = newProducts.concat(extraSweep);
                }
            }
            if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;
            
            if (newProducts.length > 0 && isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
                const percent = Math.min(100, Math.round((sentLinks.size / Math.max(1, estimatedTotal)) * 100));
                const statusMsg = `Зібрано ${sentLinks.size} з ${estimatedTotal} товарів (стор. ${pageCount})...`;

                updateHud({
                    sessionTitle: meta.title,
                    percent,
                    total: sentLinks.size,
                    estimatedTotal: estimatedTotal,
                    statusMsg,
                    isRunning: true
                });

                sendTabMessage({
                    action: 'tabProgress',
                    total: sentLinks.size,
                    page: pageCount,
                    percent,
                    statusMsg,
                    syncedCount: sentLinks.size,
                    estimatedTotal: estimatedTotal,
                    sessionTitle: meta.title,
                    category: meta.category,
                    sessionId: currentSessionId,
                    startTime: hudStartTime
                });

                await sendWebhookPayload({
                    products: newProducts,
                    page: pageCount,
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
            if (estimatedTotal > 0 && sentLinks.size >= estimatedTotal) {
                console.log(`TradeScout Tab ${currentTabId}: All ${sentLinks.size}/${estimatedTotal} items collected!`);
                break;
            }

            // 4. Trigger next page via DOM click
            let pageTransitionSuccess = false;
            const maxTransitionAttempts = 3;

            for (let attempt = 1; attempt <= maxTransitionAttempts; attempt++) {
                if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;

                const prevDomCount = document.querySelectorAll(tileSelectors).length;
                const actionObj = findPaginationActionElements(pageCount);

                if (actionObj) {
                    if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;

                    updateHud({
                        statusMsg: `Завантаження стор. ${pageCount + 1}...`,
                        total: sentLinks.size,
                        isRunning: true
                    });

                    dispatchSafeClick(actionObj.element);

                    for (let w = 0; w < 16; w++) {
                        if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;
                        await new Promise(r => setTimeout(r, 200));
                        const currentDomCount = document.querySelectorAll(tileSelectors).length;
                        if (currentDomCount > prevDomCount) {
                            pageTransitionSuccess = true;
                            break;
                        }
                    }

                    if (!isTabScrapingActive || !window.__tradeScoutIsScrapingActive) break;

                    if (pageTransitionSuccess) {
                        pageCount++;
                        consecutiveNoNew = 0;
                        break;
                    }
                }

                if (attempt < maxTransitionAttempts) {
                    await silentBackgroundScroll();
                    await new Promise(r => setTimeout(r, attempt * 600));
                }
            }

            if (!pageTransitionSuccess) {
                if (consecutiveNoNew >= 2) {
                    console.log(`TradeScout Tab ${currentTabId}: Catalog finished with ${sentLinks.size} items.`);
                    break;
                }
                await new Promise(r => setTimeout(r, 800));
            }
        }

        if (isTabScrapingActive && window.__tradeScoutIsScrapingActive) {
            isTabScrapingActive = false;
            window.__tradeScoutIsScrapingActive = false;
            stopHudTimer();
            console.log(`TradeScout Tab ${currentTabId}: Scrape completed with ${sentLinks.size} items.`);
            
            updateHud({
                percent: 100,
                total: sentLinks.size,
                statusMsg: `Збір завершено! Всього ${sentLinks.size} товарів.`,
                isRunning: false,
                finished: true
            });

            sendTabMessage({
                action: 'tabFinished',
                total: sentLinks.size,
                sessionTitle: meta.title,
                category: meta.category,
                sessionId: currentSessionId
            });
        }
    }

    function startScrapingOnThisTab(tabId, customUrl) {
        stopHudTimer();
        isTabScrapingActive = true;
        window.__tradeScoutIsScrapingActive = true;
        currentTabId = tabId || currentTabId || Date.now();
        currentSessionId = `session_${currentTabId}_${Date.now()}`;
        if (customUrl) webhookEndpoint = customUrl;
        sentLinks.clear();
        hudStartTime = Date.now();
        startHudTimer(hudStartTime);

        const meta = getPageMetadata();
        const estTotal = getEstimatedTotalFromPage();

        sendTabMessage({
            action: 'tabProgress',
            total: 0,
            page: 1,
            percent: 1,
            statusMsg: `Запуск скрейпінгу: ${meta.title}...`,
            sessionTitle: meta.title,
            category: meta.category,
            sessionId: currentSessionId,
            estimatedTotal: estTotal,
            startTime: hudStartTime
        });

        runTabScraper(1);
    }

    function stopScrapingOnThisTab() {
        isTabScrapingActive = false;
        window.__tradeScoutIsScrapingActive = false;
        stopHudTimer();
        const meta = getPageMetadata();
        
        updateHud({
            statusMsg: 'Скрейпінг зупинено.',
            total: sentLinks.size,
            isRunning: false
        });

        sendTabMessage({
            action: 'tabStopped',
            total: sentLinks.size,
            page: 1,
            percent: 0,
            statusMsg: 'Скрейпінг зупинено.',
            sessionTitle: meta.title,
            category: meta.category,
            sessionId: currentSessionId
        });
    }

    // Auto-create floating HUD on page load in 100% idle state
    const initialMeta = getPageMetadata();
    createOrGetHud();
    updateHud({
        sessionTitle: initialMeta.title,
        total: 0,
        percent: 0,
        statusMsg: 'Готовий до запуску',
        isRunning: false
    });

    // Notify background that tab is idle and ready
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
                estimatedTotal: est,
                sessionTitle: meta.title,
                category: meta.category,
                sessionId: currentSessionId
            });
            return true;
        }
    });

})();
