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

        function isSponsoredTile(tile) {
            const sponsoredSelectors = [
                '.goods-tile__sponsored',
                '[class*="sponsored"]',
                '.promo-label',
                '.promo-tag'
            ];
            for (const sel of sponsoredSelectors) {
                if (tile.querySelector(sel)) return true;
            }
            const badge = tile.querySelector('.goods-tile__badge');
            if (badge && (badge.innerText.includes('Реклама') || badge.innerText.includes('Promo'))) {
                return true;
            }
            const innerText = tile.innerText || '';
            if (innerText.includes('Реклама') && innerText.length < 150) {
                return true;
            }
            return false;
        }

        async function sendWebhookPayload(url, payload) {
            try {
                await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });
            } catch (e) {
                console.log('TradeScout: Webhook delivery failed', e.message);
            }
        }

        async function fetchDetailForProduct(product) {
            try {
                const charUrl = product.link;
                if (!charUrl) return;

                const res = await fetch(charUrl);
                if (!res.ok) return;
                const htmlText = await res.text();

                const parser = new DOMParser();
                const doc = parser.parseFromString(htmlText, 'text/html');

                const descSelectors = [
                    '.product-about__description-content',
                    '.product-description__content',
                    '#descriptionTab',
                    '.rz-description-tab',
                    '[class*="description"]'
                ];
                let description = '';
                for (const sel of descSelectors) {
                    const el = doc.querySelector(sel);
                    if (el && el.innerText.trim()) {
                        description = el.innerText.trim();
                        break;
                    }
                }
                product.description = description;

                const specsMap = {};
                const specsList = [];
                const rowSelectors = [
                    '.characteristics-full__item',
                    '.product-characteristics__item',
                    '.rz-characteristics-tab__item',
                    'tr.characteristics-table__row',
                    '[class*="characteristics-full__item"]',
                    'tr[class*="characteristics-table"]'
                ];
                const rows = doc.querySelectorAll(rowSelectors.join(', '));
                rows.forEach(row => {
                    const labelEl = row.querySelector('.characteristics-full__label, .characteristics-table__label, [class*="label"]');
                    const valueEl = row.querySelector('.characteristics-full__value, .characteristics-table__value, [class*="value"]');
                    if (labelEl && valueEl) {
                        const key = labelEl.innerText.trim().replace(/:$/, '');
                        const val = valueEl.innerText.trim();
                        if (key && val) {
                            specsMap[key] = val;
                            specsList.push(`${key}: ${val}`);
                        }
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

        const webhookUrl = state.webhookUrl;
        const sentLinks = new Set();
        
        // Черга та керування фоновим завантаженням деталей
        const detailsQueue = [];
        let activeEnrichmentThreads = 0;
        const MAX_CONCURRENT_ENRICHMENTS = 5; // Збільшено до 5 для паралельного фонового завантаження
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

        // Фоновий пулл завантаження деталей
        async function processDetailsQueue() {
            if (activeEnrichmentThreads >= MAX_CONCURRENT_ENRICHMENTS) return;

            while (detailsQueue.length > 0 && activeEnrichmentThreads < MAX_CONCURRENT_ENRICHMENTS) {
                if (!(await checkIsRunning())) break;

                const product = detailsQueue.shift();
                activeEnrichmentThreads++;

                // Мікро-пауза 100мс між запуском потоків для захисту від блокування
                await new Promise(r => setTimeout(r, 100));

                fetchDetailForProduct(product).then(async () => {
                    activeEnrichmentThreads--;
                    processedEnrichCount++;

                    // Відправляємо товар на сервер одразу після збагачення
                    await sendWebhookPayload(webhookUrl, { 
                        products: [product], 
                        page: 1, 
                        skipBackgroundEnrichment: true, 
                        isEnriched: true 
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
                const links = document.querySelectorAll('a[href*="/p"]');
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

                    const link = linkEl.split('?')[0].split('#')[0];
                    if (sentLinks.has(link)) return;

                    const nameEl = item.querySelector('.goods-tile__title, [class*="title"], a.goods-tile__heading');
                    const name = nameEl ? nameEl.innerText.trim() : '';
                    if (!name) return;

                    const priceEl = item.querySelector('.goods-tile__price-value, [class*="price-value"]');
                    const price = priceEl ? parseFloat(priceEl.innerText.replace(/\s/g, '')) || 0 : 0;

                    let reviews = 0;
                    const reviewsEl = item.querySelector('.goods-tile__reviews-link, [class*="reviews"]');
                    if (reviewsEl) {
                        const revMatch = reviewsEl.innerText.match(/\d+/);
                        if (revMatch) reviews = parseInt(revMatch[0]);
                    }

                    let rating = 5.0;
                    const starsEl = item.querySelector('.goods-tile__stars svg, [class*="stars"]');
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
                console.log(`TradeScout: Extracted ${newProducts.length} clean items. Total so far: ${sentLinks.size}`);

                // 1. Негайно надсилаємо базові товари на Дашборд
                await sendWebhookPayload(webhookUrl, { products: newProducts, page: pageIndex, skipBackgroundEnrichment: true });

                // 2. Додаємо в чергу на фонове збагачення
                const toEnrich = newProducts.filter(p => !alreadyEnrichedLinks.has(p.link));
                const alreadyEnriched = newProducts.filter(p => alreadyEnrichedLinks.has(p.link));

                if (alreadyEnriched.length > 0) {
                    console.log(`TradeScout: Skipping detail fetch for ${alreadyEnriched.length} products (already cached in DB).`);
                    await sendWebhookPayload(webhookUrl, { products: alreadyEnriched, page: pageIndex, skipBackgroundEnrichment: true, isEnriched: true });
                }

                if (toEnrich.length > 0) {
                    detailsQueue.push(...toEnrich);
                    totalEnrichCount += toEnrich.length;
                    
                    // Запускаємо фонову обробку деталей паралельно з перегортанням сторінок
                    processDetailsQueue();
                }

                // Швидке оновлення прогресу без затримки
                safeSendMessage({
                    action: 'progress',
                    page: pageIndex,
                    scraped: sentLinks.size,
                    total: sentLinks.size,
                    statusMsg: `Зібрано базові ${sentLinks.size} товарів...`,
                    estimatedTotal: getEstimatedTotalFromPage()
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

            const showMoreBtn = findShowMoreButton();
            if (showMoreBtn) {
                if (!(await checkIsRunning())) {
                    console.log('TradeScout: Stop signal detected before click. Exiting.');
                    break;
                }
                console.log(`TradeScout: Clicking "Show more" (page ${pageCount})...`);
                showMoreBtn.click();
                pageCount++;
                
                // Швидке очікування завантаження нової сторінки
                for (let w = 0; w < 7; w++) {
                    if (!(await checkIsRunning())) break;
                    await new Promise(resolve => setTimeout(resolve, 500));
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
            
            safeSendMessage({
                action: 'status',
                percent: percentVal,
                total: processed,
                estimatedTotal: totalEnrichCount,
                statusMsg: `Фонове збагачення деталей: ${processed}/${totalEnrichCount} товарів...`
            });
            
            await new Promise(resolve => setTimeout(resolve, 800));
        }

        console.log(`TradeScout: Scrape finished completely. Sent total of ${sentLinks.size} products.`);
        chrome.storage.local.set({ isRunning: false });
        safeSendMessage({ action: 'finished', total: sentLinks.size });
    });
}
