// Цей скрипт запускається автоматично на кожній сторінці Rozetka
if (window.self !== window.top) {
    console.log('TradeScout: Running inside iframe, skipping.');
} else {
    console.log('TradeScout Content Script loaded in main page.');

    // Запитуємо ID поточної вкладки у background script для ізоляції стану
    chrome.runtime.sendMessage({ action: 'getTabId' }, async (response) => {
        const tabId = response ? response.tabId : null;
        if (!tabId) {
            console.error('TradeScout: Failed to resolve tab ID, exiting.');
            return;
        }

        console.log(`TradeScout: Initialized with Tab ID ${tabId}`);

        // Помічники для збереження ізольованого стану в chrome.storage.local
        function getTabKey(key) {
            return `${key}_${tabId}`;
        }

        function getStorageState(keys) {
            return new Promise(resolve => {
                const mappedKeys = keys.map(k => k === 'webhookUrl' ? 'webhookUrl' : getTabKey(k));
                chrome.storage.local.get(mappedKeys, (res) => {
                    const mappedResult = {};
                    keys.forEach(k => {
                        if (k === 'webhookUrl') {
                            mappedResult[k] = res[k];
                        } else {
                            mappedResult[k] = res[getTabKey(k)];
                        }
                    });
                    resolve(mappedResult);
                });
            });
        }

        function setStorageState(stateObj) {
            return new Promise(resolve => {
                const mappedState = {};
                Object.keys(stateObj).forEach(k => {
                    if (k === 'webhookUrl') {
                        mappedState[k] = stateObj[k];
                    } else {
                        mappedState[getTabKey(k)] = stateObj[k];
                    }
                });
                chrome.storage.local.set(mappedState, () => resolve());
            });
        }

        const state = await getStorageState(['isRunning', 'webhookUrl', 'targetDb']);
        if (!state.isRunning) {
            return;
        }

        const categoryEl = document.querySelector('h1, .breadcrumbs__last');
        const pageCategory = categoryEl && categoryEl.innerText ? categoryEl.innerText.trim() : 'Загальна';
        const targetDbName = state.targetDb || pageCategory;

        console.log(`TradeScout: Scraper ACTIVE! Target session tab name: ${targetDbName}`);

        function safeSendMessage(msg) {
            try {
                chrome.runtime.sendMessage(msg, () => {
                    if (chrome.runtime.lastError) {}
                });
            } catch (e) {}
        }

        async function checkIsRunning() {
            const res = await getStorageState(['isRunning']);
            return !!res.isRunning;
        }

        function getEstimatedTotalFromPage(doc = document) {
            const selectors = [
                '.catalog-heading__goods', 
                '.catalog-selection__label',
                '.goods-count',
                '[class*="heading__goods"]',
                '[class*="selection__label"]'
            ];
            for (const sel of selectors) {
                try {
                    const el = doc.querySelector(sel);
                    if (el) {
                        const txt = el.textContent || '';
                        const match = txt.replace(/s/g, '').match(/d+/);
                        if (match) return parseInt(match[0]);
                    }
                } catch (e) {}
            }
            return 155;
        }

        const sentLinks = new Set();
        const alreadyEnrichedLinks = new Set();
        let syncedCountVal = 0;

        async function sendWebhookPayload(webhookUrl, payload) {
            payload.database = targetDbName; // Завжди маркуємо товари назвою вкладки (сесії)
            
            try {
                // Відправляємо на локальну платформу (через background script для обходу CORS)
                const res = await new Promise((resolve) => {
                    chrome.runtime.sendMessage({
                        action: 'sendWebhook',
                        webhookUrl: webhookUrl,
                        payload: payload
                    }, (response) => {
                        resolve(response);
                    });
                });
                return res;
            } catch (e) {
                console.error('TradeScout Webhook Error:', e);
                return null;
            }
        }

        async function loadAlreadyEnrichedLinks(webhookUrl) {
            try {
                // Отримуємо з бекенду список товарів, що вже пройшли аудит, щоб не скрапити їх опис по колу
                const productsUrl = webhookUrl.replace('/products', '/products'); 
                const res = await fetch(productsUrl);
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.products) {
                        data.products.forEach(p => {
                            if (p && p.link) {
                                const normLink = p.link.split('?')[0].split('#')[0];
                                if (p.specs && p.specs !== 'Стандартні' && p.specs !== 'Стандарт') {
                                    alreadyEnrichedLinks.add(normLink);
                                }
                            }
                        });
                        console.log(`TradeScout: Loaded ${alreadyEnrichedLinks.size} already enriched links from DB.`);
                    }
                }
            } catch (e) {
                console.warn('TradeScout: Failed to load cached database products, will enrich all items.', e.message);
            }
        }

        function isSponsoredTile(item) {
            const sponsoredText = item.querySelector('.promo-label, [class*="promo"], .goods-tile__label_type_promo');
            if (sponsoredText) return true;
            
            const advertisementTag = item.querySelector('span.goods-tile__label');
            if (advertisementTag && (advertisementTag.innerText.toLowerCase().includes('реклама') || advertisementTag.innerText.toLowerCase().includes('реклама'))) {
                return true;
            }
            return false;
        }

        // Черга та пули потоків для фонового збагачення описами (Enrichment)
        const detailsQueue = [];
        const MAX_CONCURRENT_THREAD = 6;
        let activeEnrichmentThreads = 0;
        let totalEnrichedCount = 0;
        let totalEnrichCount = 0;

        async function processDetailsQueue() {
            if (activeEnrichmentThreads >= MAX_CONCURRENT_THREAD || detailsQueue.length === 0) {
                return;
            }

            activeEnrichmentThreads++;
            const product = detailsQueue.shift();

            try {
                await fetchProductDetails(product, state.webhookUrl);
            } catch (e) {
                console.warn('Details enrichment error for product:', product.name, e);
            } finally {
                activeEnrichmentThreads--;
                totalEnrichedCount++;

                // Оновлюємо статус прогресу збагачення
                const isRunning = await checkIsRunning();
                if (isRunning) {
                    const statusStr = `Скрапінг: Збагачено деталей ${totalEnrichedCount}/${totalEnrichCount}...`;
                    const estimatedTotal = getEstimatedTotalFromPage();
                    const percentVal = Math.min(99, Math.round((sentLinks.size / estimatedTotal) * 100));
                    
                    await setStorageState({
                        statusMsg: statusStr,
                        percentProgress: percentVal
                    });

                    safeSendMessage({
                        action: 'status',
                        statusMsg: statusStr,
                        percent: percentVal,
                        total: sentLinks.size,
                        estimatedTotal: estimatedTotal,
                        syncedCount: syncedCountVal
                    });
                }

                // Запускаємо наступний потік
                processDetailsQueue();
            }
        }

        async function fetchProductDetails(product, webhookUrl) {
            if (!product.link) return;
            
            const charUrl = product.link.endsWith('/') ? `${product.link}characteristics/` : `${product.link}/characteristics/`;
            const res = await fetch(charUrl);
            if (!res.ok) return;
            const htmlText = await res.text();

            // 1. Опис товару
            const descMatch = htmlText.match(/class="[^"]*(?:product-about__description|rz-product-description)[^"]*"[^>]*>([sS]*?)</div>/i);
            if (descMatch) {
                const cleanDesc = descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                if (cleanDesc && cleanDesc.length > 10) {
                    product.description = cleanDesc;
                }
            }

            // 2. Структуровані характеристики
            const specsList = [];
            const specMatches = htmlText.matchAll(/class="[^"]*characteristics__label[^"]*"[^>]*>([sS]*?)</[^>]+>[sS]*?class="[^"]*characteristics__value[^"]*"[^>]*>([sS]*?)</[^>]+>/gi);
            for (const m of specMatches) {
                const k = m[1].replace(/<[^>]+>/g, '').trim();
                const v = m[2].replace(/<[^>]+>/g, '').trim();
                if (k && v) {
                    specsList.push(`${k}: ${v}`);
                }
            }
            if (specsList.length > 0) {
                product.specs = specsList.join('; ');
            }

            // Надсилаємо оновлені детальні характеристики на дашборд
            const serverInfo = await sendWebhookPayload(webhookUrl, { products: [product], skipBackgroundEnrichment: true, isEnriched: true });
            if (serverInfo && serverInfo.success) {
                syncedCountVal = serverInfo.categoryCount;
                await setStorageState({ syncedCount: syncedCountVal });
            }
        }

        async function scrapeAndSendNewProducts(webhookUrl, pageIndex, doc = document) {
            await loadAlreadyEnrichedLinks(webhookUrl);

            const tileSelectors = 'rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], div[class*="goods-tile"], article[class*="tile"]';
            let items = Array.from(doc.querySelectorAll(tileSelectors)).filter(item => !item.closest('.recently-viewed'));
            
            if (items.length === 0) {
                const links = doc.querySelectorAll('a[href*="/p/"], a[href*="/p-"]');
                items = Array.from(links).map(l => l.closest('li, div, rz-catalog-tile, article, section') || l).filter(Boolean);
            }

            if (items.length === 0) return;

            const categoryEl = doc.querySelector('h1, .breadcrumbs__last');
            const category = categoryEl && categoryEl.innerText ? categoryEl.innerText.trim() : 'Повербанки та УМБ';
            const newProducts = [];

            items.forEach((item) => {
                try {
                    if (isSponsoredTile(item)) return;

                    const linkTag = item.tagName === 'A' ? item : item.querySelector('a[href*="/p"], a[href]');
                    if (!linkTag) return;
                    
                    const linkEl = linkTag.getAttribute('href');
                    if (!linkEl) return;

                    const titleEl = item.querySelector('a.tile-title, a.goods-tile__heading, .goods-tile__heading, .tile-title, [class*="heading"], [class*="title"]') || linkTag;
                    const name = titleEl && titleEl.innerText ? titleEl.innerText.trim() : linkTag.innerText.trim();
                    if (!name || name.length < 3) return;

                    let link = linkEl.startsWith('http') ? linkEl : (linkEl.startsWith('/') ? `https://rozetka.com.ua${linkEl}` : `https://rozetka.com.ua/${linkEl}`);
                    link = link.split('?')[0].split('#')[0];

                    if (sentLinks.has(link)) return;

                    const priceEl = item.querySelector('.price, [class*="price"], .goods-tile__price-value');
                    const priceText = priceEl && priceEl.innerText ? priceEl.innerText : '';
                    const price = priceText ? parseInt(priceText.replace(/\D/g, '')) || 0 : 0;

                    const oldPriceEl = item.querySelector('.goods-tile__price--old, [class*="price--old"], .price--old, .goods-tile__price-value_type_old');
                    const oldPriceText = oldPriceEl && oldPriceEl.innerText ? oldPriceEl.innerText : '';
                    const oldPrice = oldPriceText ? parseInt(oldPriceText.replace(/\D/g, '')) || 0 : 0;
                    const discount = (oldPrice && oldPrice > price) ? Math.round(((oldPrice - price) / oldPrice) * 100) : 0;

                    const reviewsEl = item.querySelector('.rating-block-rating, [class*="rating"], [class*="comments"], .goods-tile__reviews-link');
                    const reviewsText = reviewsEl && reviewsEl.innerText ? reviewsEl.innerText : '';
                    const reviews = reviewsText ? parseInt(reviewsText.replace(/\D/g, '')) || 0 : 0;

                    const starsEl = item.querySelector('.stars_rating, [data-testid="stars-rating"], .goods-tile__stars svg');
                    let rating = 5.0;
                    if (starsEl) {
                        const style = starsEl.getAttribute('style') || '';
                        const match = style.match(/width:\s*calc\(([\d.]+)%/);
                        if (match) {
                            rating = parseFloat(((parseFloat(match[1]) / 100) * 5.0).toFixed(1));
                        } else {
                            const starClass = starsEl.getAttribute('class') || '';
                            const classMatch = starClass.match(/rating-(d+)/);
                            if (classMatch) rating = parseFloat(classMatch[1]);
                        }
                    }

                    const inStockText = item.querySelector('.goods-tile__availability, [class*="availability"], .status');
                    const inStock = inStockText ? !inStockText.innerText.toLowerCase().includes('немає') : true;

                    // Збираємо короткі характеристики з картки товару
                    const characteristicsList = [];
                    const charBlocks = item.querySelectorAll('.goods-tile__characteristics-item, [class*="characteristics"] span, [class*="features"]');
                    charBlocks.forEach(c => {
                        const t = c.innerText ? c.innerText.trim() : '';
                        if (t) characteristicsList.push(t);
                    });
                    const specs = characteristicsList.join('; ') || 'Стандартні';

                    const payloadProduct = {
                        name,
                        price,
                        oldPrice: oldPrice || price,
                        discount,
                        rating,
                        reviews,
                        inStock,
                        category,
                        specs,
                        link,
                        seller: 'Rozetka',
                        scrapedAt: new Date().toISOString()
                    };

                    newProducts.push(payloadProduct);
                    sentLinks.add(link);

                } catch (e) {
                    console.error('Error parsing product card:', e);
                }
            });

            if (newProducts.length > 0) {
                // 1. Негайно надсилаємо базові товари на Дашборд і дізнаємося кількість у базі
                const serverInfo = await sendWebhookPayload(webhookUrl, { products: newProducts, page: pageIndex, skipBackgroundEnrichment: true });
                if (serverInfo && serverInfo.success) {
                    syncedCountVal = serverInfo.categoryCount;
                }
                const currentSyncedCount = syncedCountVal || sentLinks.size;

                // 2. Додаємо в чергу на фонове збагачення (детальні опис та характеристики)
                const toEnrich = newProducts.filter(p => !alreadyEnrichedLinks.has(p.link));
                const alreadyEnriched = newProducts.filter(p => alreadyEnrichedLinks.has(p.link));

                if (alreadyEnriched.length > 0) {
                    console.log(`TradeScout: Skipping detail fetch for ${alreadyEnriched.length} products (already cached in DB).`);
                    const enrichServerInfo = await sendWebhookPayload(webhookUrl, { products: alreadyEnriched, page: pageIndex, skipBackgroundEnrichment: true, isEnriched: true });
                    if (enrichServerInfo && enrichServerInfo.success) {
                        syncedCountVal = enrichServerInfo.categoryCount;
                        await setStorageState({ syncedCount: syncedCountVal });
                    }
                }

                if (toEnrich.length > 0) {
                    detailsQueue.push(...toEnrich);
                    totalEnrichCount += toEnrich.length;
                    // Запуск збагачення у MAX_CONCURRENT_THREAD паралельних потоках
                    for (let th = 0; th < MAX_CONCURRENT_THREAD; th++) {
                        processDetailsQueue();
                    }
                }

                // Записуємо поточний стан базового скрапінгу
                const statusMsg = `Зібрано базові ${sentLinks.size} товарів...`;
                const estimatedTotal = getEstimatedTotalFromPage(doc);
                const percentVal = Math.min(95, Math.round((sentLinks.size / estimatedTotal) * 100));
                
                await setStorageState({
                    totalScraped: sentLinks.size,
                    percentProgress: percentVal,
                    statusMsg: statusMsg,
                    syncedCount: currentSyncedCount
                });

                safeSendMessage({
                    action: 'progress',
                    page: pageIndex,
                    scraped: sentLinks.size,
                    total: sentLinks.size,
                    statusMsg: statusMsg,
                    estimatedTotal: estimatedTotal,
                    syncedCount: currentSyncedCount
                });
            }
        }

        // Помічник для побудови правильних URL-адрес пагінації Rozetka
        function getPageUrl(baseUrl, pageIndex) {
            const urlObj = new URL(window.location.href);
            let path = urlObj.pathname;
            
            // Видаляємо наявні сегменти пагінації /page=X/
            path = path.replace(/\/page=\d+\/?/, '/');
            if (!path.endsWith('/')) {
                path += '/';
            }
            
            // Додаємо сегмент нової сторінки
            if (pageIndex > 1) {
                path += `page=${pageIndex}/`;
            }
            
            urlObj.pathname = path;
            return urlObj.toString();
        }

        // ------------------ ГОЛОВНИЙ ЦИКЛ ФОНОВОГО СКРАПІНГУ ------------------
        (async function() {
            console.log('TradeScout: Initializing background crawl session...');
            
            let pageCount = 1;
            const maxPages = 15; // Ліміт глибини скрапінгу
            let lastScrapedCount = 0;
            let consecutiveNoNewItems = 0;

            const baseUrl = window.location.href.split('?')[0].split('#')[0];

            // Отримуємо раніше синхронізовану кількість
            const syncState = await getStorageState(['syncedCount']);
            syncedCountVal = syncState.syncedCount || 0;

            while (pageCount <= maxPages) {
                if (!(await checkIsRunning())) {
                    console.log('TradeScout: Stop signal detected. Exiting.');
                    break;
                }

                // Будуємо лінк наступної сторінки
                const pageUrl = getPageUrl(baseUrl, pageCount);
                
                safeSendMessage({
                    action: 'status',
                    statusMsg: `Завантаження сторінки ${pageCount}...`,
                    percent: Math.min(95, Math.round((pageCount / maxPages) * 100)),
                    total: sentLinks.size,
                    syncedCount: syncedCountVal
                });

                try {
                    // Робимо фоновий запит fetch
                    const res = await fetch(pageUrl);
                    if (!res.ok) {
                        throw new Error(`HTTP статус ${res.status}`);
                    }
                    const html = await res.text();
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');

                    // Запускаємо парсинг завантаженого DOM сторінки
                    await scrapeAndSendNewProducts(state.webhookUrl, pageCount, doc);

                    const currentScrapedCount = sentLinks.size;
                    const newItemsFound = currentScrapedCount > lastScrapedCount;

                    if (newItemsFound) {
                        consecutiveNoNewItems = 0;
                        lastScrapedCount = currentScrapedCount;
                    } else {
                        consecutiveNoNewItems++;
                    }

                    // Перевіряємо, чи є взагалі картки товарів на сторінці
                    const tilesOnPage = doc.querySelectorAll('rz-product-tile, .goods-tile, rz-catalog-tile').length;
                    if (tilesOnPage === 0 || consecutiveNoNewItems >= 3) {
                        console.log('TradeScout: No more items or pagination limit reached. Ending crawl.');
                        break;
                    }

                } catch (err) {
                    console.error(`TradeScout Error crawling page ${pageCount}:`, err);
                    safeSendMessage({
                        action: 'status',
                        statusMsg: `Помилка сторінки ${pageCount}: ${err.message}. Продовження...`,
                        total: sentLinks.size
                    });
                }

                pageCount++;

                // Захисна затримка 1.5 - 2 секунди
                await new Promise(resolve => setTimeout(resolve, 1500 + Math.random() * 500));
            }

            // Очікуємо закінчення всіх активних потоків збагачення
            console.log('TradeScout: Waiting for active detail enrichments...');
            while (detailsQueue.length > 0 || activeEnrichmentThreads > 0) {
                if (!(await checkIsRunning())) break;
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            safeSendMessage({
                action: 'finished',
                total: sentLinks.size,
                syncedCount: syncedCountVal
            });
            
            // Вимикаємо прапорець запуску
            await setStorageState({ isRunning: false });

        })();
    });
}
