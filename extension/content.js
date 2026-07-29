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
                console.warn('TradeScout: Detail fetch skipped for', product.name);
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

        async function scrapeAndSendNewProducts(webhookUrl, pageIndex) {
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
                    // 1. ПЕРЕВІРКА НА РЕКЛАМНИЙ БЛОК "Реклама"
                    if (isSponsoredTile(item)) {
                        console.log(`TradeScout: Filtered out ad tile ("Реклама")`);
                        return;
                    }

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

                    const reviewsEl = item.querySelector('.rating-block-rating, [class*="rating"], [class*="comments"]');
                    const reviewsText = reviewsEl && reviewsEl.innerText ? reviewsEl.innerText : '';
                    const reviews = reviewsText ? parseInt(reviewsText.replace(/\D/g, '')) || 0 : 0;

                    const starsEl = item.querySelector('.stars_rating, [data-testid="stars-rating"]');
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
                console.log(`TradeScout: Extracted ${newProducts.length} clean items. Total so far: ${sentLinks.size}`);

                // 1. Негайно надсилаємо базові товари на Дашборд
                await sendWebhookPayload(webhookUrl, { products: newProducts, page: pageIndex, skipBackgroundEnrichment: true });

                safeSendMessage({
                    action: 'progress',
                    page: pageIndex,
                    scraped: sentLinks.size,
                    total: sentLinks.size,
                    statusMsg: `Зібрано базові ${sentLinks.size} товарів...`,
                    estimatedTotal: 113
                });

                // 2. Фонове збагачення описами та таблицями характеристик (пачками по 6)
                console.log(`TradeScout: Enriching details & descriptions for ${newProducts.length} items...`);
                const BATCH_SIZE = 6;
                for (let i = 0; i < newProducts.length; i += BATCH_SIZE) {
                    const batch = newProducts.slice(i, i + BATCH_SIZE);
                    await Promise.all(batch.map(p => fetchDetailForProduct(p)));
                    await sendWebhookPayload(webhookUrl, { products: batch, page: pageIndex, skipBackgroundEnrichment: true, isEnriched: true });
                    await new Promise(resolve => setTimeout(resolve, 200));
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
            await scrapeAndSendNewProducts(state.webhookUrl, pageCount);
            await smoothScroll();
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
                console.log(`TradeScout: Clicking "Show more" (page ${pageCount})...`);
                showMoreBtn.click();
                pageCount++;
                await new Promise(resolve => setTimeout(resolve, 3500));
            } else {
                if (newItemsFound) {
                    console.log('TradeScout: Infinite scroll active, loaded new items. Continuing...');
                    pageCount++;
                    await new Promise(resolve => setTimeout(resolve, 1500));
                    continue;
                }
                
                if (consecutiveNoNewItems >= 2) {
                    console.log(`TradeScout: Reached catalog end. Total items collected: ${sentLinks.size}`);
                    break;
                }
                
                console.log('TradeScout: No button found, retrying scroll...');
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }

        console.log(`TradeScout: Scrape finished completely. Sent total of ${sentLinks.size} products.`);
        chrome.storage.local.set({ isRunning: false });
        safeSendMessage({ action: 'finished', total: sentLinks.size });
    });
}
