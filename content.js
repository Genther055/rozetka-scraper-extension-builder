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
                        const m = txt.match(/(\d[\d\s]*)/);
                        if (m) {
                            const num = parseInt(m[1].replace(/\s/g, ''), 10);
                            if (num > 0) return num;
                        }
                    }
                } catch (e) {}
            }
            try {
                const headingEl = document.querySelector('h1, .catalog-heading');
                if (headingEl) {
                    const txt = headingEl.textContent || '';
                    const m = txt.match(/(\d[\d\s]*)/);
                    if (m) {
                        const num = parseInt(m[1].replace(/\s/g, ''), 10);
                        if (num > 0) return num;
                    }
                }
            } catch (e) {}
            return 113;
        }

        // Потрійний гарантований канал відправки (Direct Fetch + Background Worker)
        async function sendWebhookPayload(webhookUrl, payload) {
            const targets = [
                'http://localhost:4000/api/products',
                'http://127.0.0.1:4000/api/products'
            ];
            if (webhookUrl && !targets.includes(webhookUrl)) {
                targets.push(webhookUrl);
            }

            for (const targetUrl of targets) {
                try {
                    await fetch(targetUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                } catch (e) {}
            }

            safeSendMessage({
                action: 'sendWebhook',
                webhookUrl: webhookUrl || 'http://localhost:4000/api/products',
                payload: payload
            });
        }

        // Детектор рекламних вставок за точною міткою Rozetka ("Реклама")
        function isSponsoredTile(item) {
            // 1. Точна перевірка тексту на плашках (як у DevTools: <span class="... color-black-60">Реклама</span>)
            const itemText = item.innerText || '';
            if (itemText.includes('Реклама') || itemText.includes('Спонсор') || itemText.includes('Рекламний')) {
                return true;
            }

            // 2. Додаткова перевірка вкладених тегів плашок
            const spans = item.querySelectorAll('span, rz-tile-info, [class*="tile-info"], [class*="badge"]');
            for (const s of spans) {
                const txt = (s.innerText || '').trim().toLowerCase();
                if (txt === 'реклама' || txt.startsWith('реклама') || txt === 'спонсор') {
                    return true;
                }
            }

            // 3. Перевірка рекламних CSS-класів
            if (item.querySelector('.goods-tile__badge_type_promo, [class*="sponsored"], [class*="advertising"], .promo-tile')) {
                return true;
            }

            return false;
        }

        // Глибокий витягувач опису та характеристики з картки товару через DOMParser
        async function fetchDetailForProduct(product) {
            if (!product.link) return;
            try {
                const charUrl = product.link.endsWith('/') ? `${product.link}characteristics/` : `${product.link}/characteristics/`;
                const res = await fetch(charUrl);
                if (!res.ok) return;
                const htmlText = await res.text();

                let description = '';
                let specsMap = {};
                const specsList = [];

                // 1. Fast regex parsing (Regex)
                const descMatch = htmlText.match(/class="[^"]*(?:product-about__description|rz-product-description|description-content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
                if (descMatch) {
                    description = descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                }

                const specMatches = htmlText.matchAll(/class="[^"]*(?:characteristics__label|characteristics-full__label)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>[\s\S]*?class="[^"]*(?:characteristics__value|characteristics-full__value)[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi);
                for (const m of specMatches) {
                    const k = m[1].replace(/<[^>]+>/g, '').trim();
                    const v = m[2].replace(/<[^>]+>/g, '').trim();
                    if (k && v && k.length > 1 && v.length > 0) {
                        specsMap[k] = v;
                        specsList.push(`${k}: ${v}`);
                    }
                }

                // 2. If Regex succeeded, save. Else fallback to DOMParser
                if (specsList.length > 0) {
                    product.specs = specsList.join('; ');
                    product.detailedSpecsMap = specsMap;
                    if (description && description.length > 15) {
                        product.description = description;
                    }
                } else {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(htmlText, 'text/html');

                    const descEl = doc.querySelector('.product-about__description, [class*="description-content"], .rz-product-description, [data-testid="description"]');
                    if (descEl) {
                        const cleanDesc = descEl.innerText.trim();
                        if (cleanDesc && cleanDesc.length > 15) {
                            product.description = cleanDesc;
                        }
                    }

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
                }
            } catch (err) {
                console.log('TradeScout: Detail fetch skipped for', product.name);
            }
        }

        // Чекаємо завантаження елементів каталогу Rozetka
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

        const sentLinks = new Set();

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

        async function scrapeAndSendNewProducts(webhookUrl, pageIndex) {
            // Завантажуємо вже відомі товари з бази, щоб уникнути повторного скрапінгу деталей
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

                safeSendMessage({
                    action: 'progress',
                    page: pageIndex,
                    scraped: sentLinks.size,
                    total: sentLinks.size,
                    statusMsg: `Зібрано базові ${sentLinks.size} товарів...`,
                    estimatedTotal: getEstimatedTotalFromPage()
                });

                // 2. Фільтруємо товари, для яких деталі ВЖЕ є у базі
                const toEnrich = newProducts.filter(p => !alreadyEnrichedLinks.has(p.link));
                const alreadyEnriched = newProducts.filter(p => alreadyEnrichedLinks.has(p.link));

                if (alreadyEnriched.length > 0) {
                    console.log(`TradeScout: Skipping detail fetch for ${alreadyEnriched.length} products (already cached in DB).`);
                    await sendWebhookPayload(webhookUrl, { products: alreadyEnriched, page: pageIndex, skipBackgroundEnrichment: true, isEnriched: true });
                }

                if (toEnrich.length > 0) {
                    console.log(`TradeScout: Fetching details for ${toEnrich.length} new products...`);
                    
                    const CONCURRENCY_LIMIT = 3;
                    let activeRequests = 0;
                    let currentIndex = 0;

                    await new Promise((resolve) => {
                        async function startNext() {
                            if (!(await checkIsRunning())) {
                                resolve();
                                return;
                            }

                            if (currentIndex >= toEnrich.length) {
                                if (activeRequests === 0) {
                                    resolve();
                                }
                                return;
                            }

                            const product = toEnrich[currentIndex++];
                            activeRequests++;

                            // Додаємо невелику затримку 150мс між запуском запитів у пулі
                            await new Promise(r => setTimeout(r, 150));

                            fetchDetailForProduct(product).then(async () => {
                                activeRequests--;
                                await sendWebhookPayload(webhookUrl, { products: [product], page: pageIndex, skipBackgroundEnrichment: true, isEnriched: true });
                                startNext();
                            }).catch(() => {
                                activeRequests--;
                                startNext();
                            });
                        }

                        for (let i = 0; i < Math.min(CONCURRENCY_LIMIT, toEnrich.length); i++) {
                            startNext();
                        }
                    });
                }
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
                
                // Wait 3.5s but check isRunning in between
                for (let w = 0; w < 7; w++) {
                    if (!(await checkIsRunning())) break;
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            } else {
                if (newItemsFound) {
                    console.log('TradeScout: Infinite scroll active, loaded new items. Continuing...');
                    pageCount++;
                    // Wait 1.5s but check isRunning
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
                // Wait 1.5s but check isRunning
                for (let w = 0; w < 3; w++) {
                    if (!(await checkIsRunning())) break;
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
        }

        console.log(`TradeScout: Scrape finished completely. Sent total of ${sentLinks.size} products.`);
        chrome.storage.local.set({ isRunning: false });
        safeSendMessage({ action: 'finished', total: sentLinks.size });
    });
}
