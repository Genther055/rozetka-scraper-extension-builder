// Цей скрипт запускається автоматично на кожній сторінці Rozetka
if (window.self !== window.top) {
    console.log('TradeScout: Running inside iframe, skipping.');
} else {
    console.log('TradeScout Content Script loaded in main page.');

    chrome.storage.local.get(['isRunning', 'webhookUrl', 'targetDb'], async (state) => {
        if (!state.isRunning) {
            return;
        }
        
        const categoryEl = document.querySelector('h1, .breadcrumbs__last');
        const pageCategory = categoryEl && categoryEl.innerText ? categoryEl.innerText.trim() : 'Загальна';
        const targetDbName = state.targetDb || pageCategory;

        console.log('TradeScout: Scraper ACTIVE! Starting item extraction...');

        function safeSendMessage(msg) {
            try {
                chrome.runtime.sendMessage(msg, () => {
                    if (chrome.runtime.lastError) {}
                });
            } catch (e) {}
        }

        async function checkIsRunning() {
            return new Promise(resolve => {
                chrome.storage.local.get(['isRunning'], (res) => resolve(!!res.isRunning));
            });
        }

        function getEstimatedTotalFromPage() {
            const selectors = [
                '.catalog-heading__goods', 
                '.catalog-selection__label',
                '.goods-count',
                '[class*="heading__goods"]',
                '[class*="selection__label"]'
            ];
            for (const sel of selectors) {
                try {
                    const el = document.querySelector(sel);
                    if (el) {
                        const txt = el.textContent || '';
                        const match = txt.replace(/\s/g, '').match(/\d+/);
                        if (match) return parseInt(match[0]);
                    }
                } catch (e) {}
            }
            return 155;
        }

        // Детектор рекламних вставок за точною міткою Rozetka ("Реклама")
        function isSponsoredTile(item) {
            const itemText = item.innerText || '';
            if (itemText.includes('Реклама') || itemText.includes('Спонсор') || itemText.includes('Рекламний')) {
                return true;
            }
            const spans = item.querySelectorAll('span, rz-tile-info, [class*="tile-info"], [class*="badge"]');
            for (const s of spans) {
                const txt = (s.innerText || '').trim().toLowerCase();
                if (txt === 'реклама' || txt.startsWith('реклама') || txt === 'спонсор') {
                    return true;
                }
            }
            if (item.querySelector('.goods-tile__badge_type_promo, [class*="sponsored"], [class*="advertising"], .promo-tile')) {
                return true;
            }
            return false;
        }

        // Потрійний гарантований канал відправки (Direct Fetch + Background Worker)
        async function sendWebhookPayload(webhookUrl, payload) {
            payload.database = targetDbName;
            let serverInfo = null;
            const targets = [];
            if (webhookUrl) {
                targets.push(webhookUrl);
            }
            const local4000 = 'http://localhost:4000/api/products';
            const local127 = 'http://127.0.0.1:4000/api/products';
            if (!targets.includes(local4000)) targets.push(local4000);
            if (!targets.includes(local127)) targets.push(local127);

            // Виконуємо всі запити паралельно з таймаутом 3 секунди, щоб уникнути зависання
            await Promise.all(targets.map(async (targetUrl) => {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 3000);

                    const res = await fetch(targetUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload),
                        signal: controller.signal
                    });

                    clearTimeout(timeoutId);

                    if (res.ok) {
                        const data = await res.json();
                        if (data && typeof data.count === 'number') {
                            serverInfo = {
                                count: data.count,
                                categoryCount: data.categoryCount || data.count
                            };
                        }
                    }
                } catch (e) {
                    // Мовчазне ігнорування недоступних хостів (наприклад, неактивного localhost)
                }
            }));

            safeSendMessage({
                action: 'sendWebhook',
                webhookUrl: webhookUrl || 'http://localhost:4000/api/products',
                payload: payload
            });

            return serverInfo;
        }

        // Глибокий витягувач опису та характеристики з картки товару через DOMParser
        async function fetchDetailForProduct(product) {
            if (!product.link) return;
            try {
                const charUrl = product.link.endsWith('/') ? `${product.link}characteristics/` : `${product.link}/characteristics/`;
                const res = await fetch(charUrl);
                if (!res.ok) return;
                const htmlText = await res.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(htmlText, 'text/html');

                // 1. Повний текстовий опис товару від продавця
                const descEl = doc.querySelector('.product-about__description, [class*="description-content"], .rz-product-description, [data-testid="description"]');
                if (descEl) {
                    const cleanDesc = descEl.innerText.trim();
                    if (cleanDesc && cleanDesc.length > 15) {
                        product.description = cleanDesc;
                    }
                }

                // 2. Повна таблиця характеристик товару
                const specsList = [];
                const specsMap = {};

                const dts = Array.from(doc.querySelectorAll('dt, .characteristics-full__label, [class*="characteristics"] [class*="label"], [class*="characteristics"] [class*="name"]'));
                dts.forEach(dt => {
                    const dd = dt.nextElementSibling || dt.parentElement.querySelector('dd, .characteristics-full__value, [class*="characteristics"] [class*="value"]');
                    const k = dt.innerText ? dt.innerText.trim() : '';
                    const v = dd && dd.innerText ? dd.innerText.trim() : '';
                    if (k && v && k.length > 1 && v.length > 0) {
                        specsMap[k] = v;
                        specsList.push(`${k}: ${v}`);
                    }
                });

                if (specsList.length > 0) {
                    product.specs = specsList.join('; ');
                    product.detailedSpecsMap = specsMap;
                }
            } catch (err) {
                console.log('TradeScout: Detail fetch skipped for', product.name);
            }
        }

        async function waitForCatalog() {
            for (let i = 0; i < 20; i++) {
                const items = document.querySelectorAll('rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], a[href*="/p"]');
                if (items.length > 0) {
                    console.log(`TradeScout: Catalog ready! Found ${items.length} potential items on DOM.`);
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            return false;
        }

        async function smoothScroll() {
            // Безпечний миттєвий скрол для фонових вкладок (запобігає зависанню requestAnimationFrame)
            const target = document.body.scrollHeight - window.innerHeight;
            window.scrollTo(0, target);
            // Коротка пауза для підвантаження контенту браузером
            await new Promise(resolve => setTimeout(resolve, 800));
        }

        const webhookUrl = state.webhookUrl;
        const sentLinks = new Set();
        
        // Черга та керування фоновим завантаженням деталей
        const detailsQueue = [];
        let activeEnrichmentThreads = 0;
        const MAX_CONCURRENT_ENRICHMENTS = 5;
        let totalEnrichCount = 0;
        let processedEnrichCount = 0;

        const alreadyEnrichedLinks = new Set();
        let alreadyEnrichedLoaded = false;

        async function loadAlreadyEnrichedLinks(webhookUrl) {
            if (alreadyEnrichedLoaded) return;
            try {
                const baseUrl = webhookUrl.replace('/api/products', '');
                const res = await fetch(`${baseUrl}/api/products`);
                if (res.ok) {
                    const data = await res.json();
                    if (data && data.products) {
                        data.products.forEach(p => {
                            if (p.link && p.specs && p.specs !== 'Стандартні' && p.specs !== '') {
                                alreadyEnrichedLinks.add(p.link.split('?')[0].split('#')[0]);
                            }
                        });
                        console.log(`TradeScout: Loaded ${alreadyEnrichedLinks.size} already enriched links from database.`);
                    }
                }
            } catch (err) {
                console.log('TradeScout: Failed to load already enriched links, will enrich all.', err);
            }
            alreadyEnrichedLoaded = true;
        }

        // Буфер пакетної відправки збагачених товарів
        let enrichedBuffer = [];
        let bufferTimeout = null;

        async function flushEnrichedBuffer() {
            if (enrichedBuffer.length === 0) return null;
            const batch = [...enrichedBuffer];
            enrichedBuffer = [];
            if (bufferTimeout) {
                clearTimeout(bufferTimeout);
                bufferTimeout = null;
            }
            return await sendWebhookPayload(webhookUrl, { 
                products: batch, 
                page: 1, 
                skipBackgroundEnrichment: true, 
                isEnriched: true 
            });
        }

        // Фоновий пул завантаження деталей
        async function processDetailsQueue() {
            if (activeEnrichmentThreads >= MAX_CONCURRENT_ENRICHMENTS) return;

            while (detailsQueue.length > 0 && activeEnrichmentThreads < MAX_CONCURRENT_ENRICHMENTS) {
                if (!(await checkIsRunning())) break;

                const product = detailsQueue.shift();
                activeEnrichmentThreads++;

                await new Promise(r => setTimeout(r, 100));

                fetchDetailForProduct(product).then(async () => {
                    activeEnrichmentThreads--;
                    processedEnrichCount++;

                    enrichedBuffer.push(product);
                    
                    let serverInfo = null;
                    if (enrichedBuffer.length >= 15) {
                        serverInfo = await flushEnrichedBuffer();
                    } else {
                        if (bufferTimeout) clearTimeout(bufferTimeout);
                        bufferTimeout = setTimeout(async () => {
                            serverInfo = await flushEnrichedBuffer();
                            if (serverInfo) {
                                chrome.storage.local.set({ syncedCount: serverInfo.categoryCount });
                                safeSendMessage({
                                    action: 'progress',
                                    page: 1,
                                    scraped: processedEnrichCount,
                                    total: processedEnrichCount,
                                    statusMsg: `Фонове збагачення деталей: ${processedEnrichCount}/${totalEnrichCount} товарів...`,
                                    estimatedTotal: totalEnrichCount,
                                    syncedCount: serverInfo.categoryCount
                                });
                            }
                        }, 1500);
                    }

                    // Отримуємо актуальний лічильник з сервера або вираховуємо приблизний
                    chrome.storage.local.get(['syncedCount'], (res) => {
                        const baseSynced = res.syncedCount || 0;
                        const currentSynced = serverInfo ? serverInfo.categoryCount : Math.max(baseSynced, processedEnrichCount);
                        
                        const percentVal = totalEnrichCount > 0 ? Math.round((processedEnrichCount / totalEnrichCount) * 100) : 100;
                        const statusMsg = `Фонове збагачення деталей: ${processedEnrichCount}/${totalEnrichCount} товарів...`;
                        
                        chrome.storage.local.set({
                            totalScraped: processedEnrichCount,
                            percentProgress: percentVal,
                            statusMsg: statusMsg,
                            syncedCount: currentSynced
                        });

                        safeSendMessage({
                            action: 'progress',
                            page: 1,
                            scraped: processedEnrichCount,
                            total: processedEnrichCount,
                            statusMsg: statusMsg,
                            estimatedTotal: totalEnrichCount,
                            syncedCount: currentSynced
                        });
                    });

                    processDetailsQueue();
                }).catch(() => {
                    activeEnrichmentThreads--;
                    processedEnrichCount++;
                    processDetailsQueue();
                });
            }
        }

        async function scrapeAndSendNewProducts(webhookUrl, pageIndex) {
            await loadAlreadyEnrichedLinks(webhookUrl);

            const tileSelectors = 'rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], div[class*="goods-tile"], article[class*="tile"]';
            let items = Array.from(document.querySelectorAll(tileSelectors)).filter(item => !item.closest('.recently-viewed'));
            
            if (items.length === 0) {
                const links = document.querySelectorAll('a[href*="/p/"], a[href*="/p-"]');
                items = Array.from(links).map(l => l.closest('li, div, rz-catalog-tile, article, section') || l).filter(Boolean);
            }

            if (items.length === 0) return;

            const categoryEl = document.querySelector('h1, .breadcrumbs__last');
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
                        if (match) rating = parseFloat(((parseFloat(match[1]) || 100) / 20).toFixed(1));
                    }

                    const itemText = item.innerText || '';
                    const inStock = !(item.classList.contains('tile-disabled') || itemText.includes('Немає в наявності'));

                    const capacityMatch = name.match(/(\d+)\s*(?:mah|мАг)/i);
                    const capacity = capacityMatch ? `${capacityMatch[1]} mAh` : '';
                    const powerMatch = name.match(/(\d+(?:\.\d+)?)\s*W/i);
                    const power = powerMatch ? `${powerMatch[1]}W` : '';
                    const specs = [capacity, power].filter(Boolean).join(', ') || 'Стандартні';

                    const merchantEl = item.querySelector('.goods-tile__merchant, [class*="merchant"]');
                    const seller = merchantEl && merchantEl.innerText ? merchantEl.innerText.trim() : 'Rozetka';

                    newProducts.push({
                        name,
                        price,
                        oldPrice: oldPrice || price,
                        discount,
                        rating,
                        reviews,
                        inStock,
                        category,
                        specs,
                        description: '',
                        seller,
                        sellersCount: 1,
                        priceChange: 0,
                        reviewsGrowth: 0,
                        link
                    });

                    sentLinks.add(link);
                } catch (err) {}
            });

            if (newProducts.length > 0) {
                console.log(`TradeScout: Extracted ${newProducts.length} clean items. Total so far: ${sentLinks.size}`);

                // 1. Негайно надсилаємо базові товари на Дашборд і дізнаємося кількість у базі
                const serverInfo = await sendWebhookPayload(webhookUrl, { products: newProducts, page: pageIndex, skipBackgroundEnrichment: true });
                const currentSyncedCount = serverInfo ? serverInfo.categoryCount : sentLinks.size;

                // 2. Додаємо в чергу на фонове збагачення
                const toEnrich = newProducts.filter(p => !alreadyEnrichedLinks.has(p.link));
                const alreadyEnriched = newProducts.filter(p => alreadyEnrichedLinks.has(p.link));

                if (alreadyEnriched.length > 0) {
                    console.log(`TradeScout: Skipping detail fetch for ${alreadyEnriched.length} products (already cached in DB).`);
                    const enrichServerInfo = await sendWebhookPayload(webhookUrl, { products: alreadyEnriched, page: pageIndex, skipBackgroundEnrichment: true, isEnriched: true });
                    if (enrichServerInfo) {
                        chrome.storage.local.set({ syncedCount: enrichServerInfo.categoryCount });
                    }
                }

                if (toEnrich.length > 0) {
                    detailsQueue.push(...toEnrich);
                    totalEnrichCount += toEnrich.length;
                    processDetailsQueue();
                }

                // Записуємо поточний стан базового скрапінгу
                const statusMsg = `Зібрано базові ${sentLinks.size} товарів...`;
                const estimatedTotal = getEstimatedTotalFromPage();
                const percentVal = Math.min(95, Math.round((sentLinks.size / estimatedTotal) * 100));
                
                chrome.storage.local.set({
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

        function findShowMoreButton() {
            const selectors = [
                'rz-catalog-more button', 
                '.catalog-more button', 
                '.catalog-more__btn', 
                'button.show-more', 
                '.show-more', 
                'a.show-more', 
                '[class*="catalog-more"] button',
                '[class*="catalog-more"] a'
            ];
            for (const sel of selectors) {
                try {
                    const btn = document.querySelector(sel);
                    if (btn && !btn.disabled && !btn.classList.contains('button--loading')) {
                        return btn;
                    }
                } catch (e) {}
            }

            const allElements = document.querySelectorAll('button, a, div[role="button"], span');
            for (const el of allElements) {
                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                if (txt === 'показати ще' || txt === 'показать еще' || txt.includes('показати ще') || txt.includes('показать еще') || txt === 'show more') {
                    if (el.closest('.sidebar') || el.closest('.filter') || el.closest('.recently-viewed')) {
                        continue;
                    }
                    if (el.disabled || el.classList.contains('button--loading')) {
                        continue;
                    }
                    return el;
                }
            }
            return null;
        }

        await waitForCatalog();

        let pageCount = 1;
        let lastScrapedCount = 0;
        let consecutiveNoNewItems = 0;
        const tileSelectors = 'rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], div[class*="goods-tile"], article[class*="tile"]';

        while (true) {
            if (!(await checkIsRunning())) {
                console.log('TradeScout: Stop signal detected at loop start. Exiting.');
                break;
            }

            await scrapeAndSendNewProducts(state.webhookUrl, pageCount);

            if (!(await checkIsRunning())) {
                console.log('TradeScout: Stop signal detected after scraping page. Exiting.');
                break;
            }

            await smoothScroll();

            if (!(await checkIsRunning())) {
                console.log('TradeScout: Stop signal detected after scroll. Exiting.');
                break;
            }

            await scrapeAndSendNewProducts(state.webhookUrl, pageCount);

            const currentScrapedCount = sentLinks.size;
            const newItemsFound = currentScrapedCount > lastScrapedCount;

            if (newItemsFound) {
                consecutiveNoNewItems = 0;
                lastScrapedCount = currentScrapedCount;
            } else {
                consecutiveNoNewItems++;
            }

            // Очікуємо повного фонового збагачення та відправки всіх товарів поточної сторінки перед переходом
            console.log('TradeScout: Waiting for current page enrichment to complete before page transition...');
            while (detailsQueue.length > 0 || activeEnrichmentThreads > 0) {
                if (!(await checkIsRunning())) break;
                await new Promise(resolve => setTimeout(resolve, 300));
            }

            const showMoreBtn = findShowMoreButton();
            if (showMoreBtn) {
                if (!(await checkIsRunning())) {
                    console.log('TradeScout: Stop signal detected before click. Exiting.');
                    break;
                }
                console.log(`TradeScout: Clicking "Show more" (page ${pageCount})...`);
                
                const previousCount = document.querySelectorAll(tileSelectors).length;
                showMoreBtn.click();
                pageCount++;
                
                // Динамічне очікування завантаження нових елементів до 15 секунд
                let loaded = false;
                for (let w = 0; w < 30; w++) {
                    if (!(await checkIsRunning())) break;
                    await new Promise(resolve => setTimeout(resolve, 500));
                    const currentCount = document.querySelectorAll(tileSelectors).length;
                    if (currentCount > previousCount) {
                        loaded = true;
                        break;
                    }
                }
                if (!loaded) {
                    console.log('TradeScout: Dynamic load timeout. Proceeding...');
                }
            } else {
                if (newItemsFound) {
                    console.log('TradeScout: Infinite scroll active, loaded new items. Continuing...');
                    pageCount++;
                    for (let w = 0; w < 3; w++) {
                        if (!(await checkIsRunning())) break;
                        await new Promise(resolve => setTimeout(resolve, 500));
                    }
                    continue;
                }
                
                if (consecutiveNoNewItems >= 2) {
                    console.log(`TradeScout: Reached catalog end. Total items collected: ${sentLinks.size}`);
                    break;
                }
                
                console.log('TradeScout: No button found, retrying scroll...');
                for (let w = 0; w < 3; w++) {
                    if (!(await checkIsRunning())) break;
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        }

        // В кінці скрапінгу чекаємо, поки завершиться фонове збагачення деталей
        console.log('TradeScout: Waiting for background details queue to finish...');
        while (detailsQueue.length > 0 || activeEnrichmentThreads > 0) {
            if (!(await checkIsRunning())) break;
            
            const processed = totalEnrichCount - detailsQueue.length - activeEnrichmentThreads;
            const percentVal = totalEnrichCount > 0 ? Math.round((processed / totalEnrichCount) * 100) : 100;
            const statusMsg = `Фонове збагачення деталей: ${processed}/${totalEnrichCount} товарів...`;
            
            chrome.storage.local.set({
                totalScraped: processed,
                percentProgress: percentVal,
                statusMsg: statusMsg
            });

            chrome.storage.local.get(['syncedCount'], (res) => {
                const currentSynced = res.syncedCount || processed;
                safeSendMessage({
                    action: 'status',
                    percent: percentVal,
                    total: processed,
                    estimatedTotal: totalEnrichCount,
                    statusMsg: statusMsg,
                    syncedCount: currentSynced
                });
            });
            
            await new Promise(resolve => setTimeout(resolve, 800));
        }

        // Забезпечимо фінальну відправку залишків буфера перед завершенням
        await flushEnrichedBuffer();

        console.log(`TradeScout: Scrape finished completely. Sent total of ${sentLinks.size} products.`);
        
        chrome.storage.local.get(['syncedCount'], (res) => {
            const finalSynced = res.syncedCount || sentLinks.size;
            chrome.storage.local.set({ 
                isRunning: false,
                totalScraped: sentLinks.size,
                percentProgress: 100,
                statusMsg: `Успішно зібрано ${sentLinks.size} товарів!`,
                syncedCount: finalSynced
            });
            safeSendMessage({ action: 'finished', total: sentLinks.size, syncedCount: finalSynced });
        });
    });
}
