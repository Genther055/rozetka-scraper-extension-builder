// Цей скрипт запускається автоматично на кожній сторінці Rozetka
if (window.self !== window.top) {
    console.log('TradeScout: Running inside iframe, skipping.');
} else {
    console.log('TradeScout Content Script loaded in main page.');

    chrome.storage.local.get(['isRunning', 'webhookUrl'], async (state) => {
        if (!state.isRunning) {
            return;
        }

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

                // 3. Збираємо точного продавця з детальної сторінки
                const sellerSelectors = [
                    'a.product-seller__name',
                    '.product-seller__title a',
                    '[data-testid="seller-link"]',
                    '.product-seller__name',
                    '.product-seller__title',
                    '[class*="seller-name"]',
                    '[class*="seller__name"]',
                    '[class*="seller__title"] a',
                    '[class*="seller-link"]'
                ];
                
                let foundSeller = '';
                for (const selector of sellerSelectors) {
                    const el = doc.querySelector(selector);
                    if (el) {
                        const txt = el.innerText.replace(/Продавець:|Продавец:/i, '').trim();
                        if (txt && txt.length > 0 && txt.length < 50 && !txt.includes('назад') && !txt.includes('відгук') && !txt.includes('запитати')) {
                            foundSeller = txt;
                            break;
                        }
                    }
                }
                if (foundSeller) {
                    product.seller = foundSeller;
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
            await new Promise((resolve) => {
                const start = window.scrollY;
                const target = document.body.scrollHeight - window.innerHeight;
                if (target <= start) return resolve();
                
                const duration = 1500;
                let startTime = null;
                
                function animation(currentTime) {
                    if (startTime === null) startTime = currentTime;
                    const timeElapsed = currentTime - startTime;
                    const run = ease(timeElapsed, start, target - start, duration);
                    window.scrollTo(0, run);
                    
                    if (timeElapsed < duration) {
                        requestAnimationFrame(animation);
                    } else {
                        window.scrollTo(0, target);
                        resolve();
                    }
                }
                
                function ease(t, b, c, d) {
                    t /= d;
                    return -c * t * (t - 2) + b;
                }
                
                requestAnimationFrame(animation);
            });
            await new Promise(resolve => setTimeout(resolve, 800));
        }

        const webhookUrl = state.webhookUrl;
        const sentLinks = new Set();
        
        // Ознака завантажених збережених посилань
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

        // Посторінковий синхронний збирач деталей
        async function enrichPageProducts(productsToEnrich, pageIndex, currentSyncedCount) {
            const totalToEnrich = productsToEnrich.length;
            if (totalToEnrich === 0) return currentSyncedCount;

            let enrichedCount = 0;
            let activeWorkers = 0;
            let index = 0;
            let batchBuffer = [];
            let lastSynced = currentSyncedCount;

            return new Promise((resolve) => {
                async function startWorker() {
                    while (index < totalToEnrich) {
                        if (!(await checkIsRunning())) {
                            resolve(lastSynced);
                            break;
                        }
                        const currentIdx = index++;
                        const product = productsToEnrich[currentIdx];
                        activeWorkers++;

                        // Мікро-пауза 150мс між запитами для захисту від блокування
                        await new Promise(r => setTimeout(r, 150));

                        try {
                            await fetchDetailForProduct(product);
                            batchBuffer.push(product);
                        } catch (e) {
                            console.warn('TradeScout: Error enriching product:', product.name, e.message);
                        } finally {
                            activeWorkers--;
                            enrichedCount++;

                            const statusMsg = `Характеристики (стор. ${pageIndex}): ${enrichedCount}/${totalToEnrich} товарів...`;
                            const percentVal = Math.round((enrichedCount / totalToEnrich) * 100);

                            if (batchBuffer.length >= 15 || enrichedCount === totalToEnrich) {
                                const batch = [...batchBuffer];
                                batchBuffer = [];
                                const resInfo = await sendWebhookPayload(webhookUrl, { 
                                    products: batch, 
                                    page: pageIndex, 
                                    skipBackgroundEnrichment: true, 
                                    isEnriched: true 
                                });
                                if (resInfo) {
                                    lastSynced = resInfo.categoryCount;
                                }
                            }

                            chrome.storage.local.set({
                                totalScraped: sentLinks.size,
                                percentProgress: percentVal,
                                statusMsg: statusMsg,
                                syncedCount: lastSynced
                            });

                            safeSendMessage({
                                action: 'progress',
                                page: pageIndex,
                                scraped: sentLinks.size,
                                total: sentLinks.size,
                                statusMsg: statusMsg,
                                estimatedTotal: getEstimatedTotalFromPage(),
                                syncedCount: lastSynced
                            });

                            // Вирішуємо проміс тільки тоді, коли абсолютно всі товари оброблені та відправлені
                            if (enrichedCount === totalToEnrich) {
                                resolve(lastSynced);
                            }
                        }
                    }
                }

                // Використовуємо 4 паралельних потоки для оптимальної швидкості на сторінці
                const concurrency = Math.min(4, totalToEnrich);
                for (let c = 0; c < concurrency; c++) {
                    startWorker();
                }
            });
        }

        async function scrapeAndSendNewProducts(webhookUrl, pageIndex, lastScrapedCount) {
            await loadAlreadyEnrichedLinks(webhookUrl);

            // Оповіщаємо про початок обробки сторінки
            const startMsg = `Аналіз сторінки ${pageIndex}...`;
            safeSendMessage({
                action: 'progress',
                page: pageIndex,
                scraped: sentLinks.size,
                total: sentLinks.size,
                statusMsg: startMsg,
                estimatedTotal: getEstimatedTotalFromPage()
            });

            const tileSelectors = 'rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], div[class*="goods-tile"], article[class*="tile"]';
            let items = Array.from(document.querySelectorAll(tileSelectors)).filter(item => !item.closest('.recently-viewed'));
            
            if (items.length === 0) {
                const links = document.querySelectorAll('a[href*="/p"]');
                items = Array.from(links).map(l => l.closest('li, div, rz-catalog-tile, article, section') || l).filter(Boolean);
            }

            const categoryEl = document.querySelector('h1, .breadcrumbs__last');
            const category = categoryEl && categoryEl.innerText ? categoryEl.innerText.trim() : 'Повербанки та УМБ';
            const newProducts = [];

            // Проходимо по всіх елементах каталогу та відбираємо нові за унікальними посиланнями (sentLinks)
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
                // 1. Негайно надсилаємо базові товари на Дашборд і дізнаємося кількість у базі
                const serverInfo = await sendWebhookPayload(webhookUrl, { products: newProducts, page: pageIndex, skipBackgroundEnrichment: true });
                let currentSyncedCount = serverInfo ? serverInfo.categoryCount : sentLinks.size;

                // 2. Розділяємо на збагачені (в базі) та нові
                const toEnrich = newProducts.filter(p => !alreadyEnrichedLinks.has(p.link));
                const alreadyEnriched = newProducts.filter(p => alreadyEnrichedLinks.has(p.link));

                if (alreadyEnriched.length > 0) {
                    console.log(`TradeScout: Skipping detail fetch for ${alreadyEnriched.length} products (already cached in DB).`);
                    const enrichServerInfo = await sendWebhookPayload(webhookUrl, { products: alreadyEnriched, page: pageIndex, skipBackgroundEnrichment: true, isEnriched: true });
                    if (enrichServerInfo) {
                        currentSyncedCount = enrichServerInfo.categoryCount;
                    }
                }

                // 3. Синхронно чекаємо завершення збагачення деталей для поточної сторінки
                if (toEnrich.length > 0) {
                    currentSyncedCount = await enrichPageProducts(toEnrich, pageIndex, currentSyncedCount);
                }
            }

            return sentLinks.size;
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
        const tileSelectors = 'rz-product-tile, .goods-tile, rz-catalog-tile, li.catalog-grid__cell, [data-goods-id], div[class*="goods-tile"], article[class*="tile"]';

        while (true) {
            if (!(await checkIsRunning())) {
                console.log('TradeScout: Stop signal detected at loop start. Exiting.');
                break;
            }

            // Зчитуємо та опрацьовуємо товари поточної сторінки повністю (разом із деталями)
            lastScrapedCount = await scrapeAndSendNewProducts(state.webhookUrl, pageCount, lastScrapedCount);

            if (!(await checkIsRunning())) {
                console.log('TradeScout: Stop signal detected after scraping page. Exiting.');
                break;
            }

            await smoothScroll();

            if (!(await checkIsRunning())) {
                console.log('TradeScout: Stop signal detected after scroll. Exiting.');
                break;
            }

            const showMoreBtn = findShowMoreButton();
            if (showMoreBtn) {
                console.log(`TradeScout: Clicking "Show more" (page ${pageCount})...`);
                
                const previousCount = document.querySelectorAll(tileSelectors).length;
                showMoreBtn.click();
                pageCount++;
                
                // Чекаємо, поки нові товари завантажаться
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
                console.log(`TradeScout: Reached catalog end. Total items collected: ${sentLinks.size}`);
                break;
            }
        }

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
