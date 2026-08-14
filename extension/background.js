// Background Service Worker for TradeScout Extension
console.log('TradeScout Background Service Worker initialized.');

const LOCAL_DASHBOARD_API = 'http://localhost:4000/api/products';
const LOCAL_IP_API = 'http://127.0.0.1:4000/api/products';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'fetchSeller') {
        const { productId } = message;
        const apiUrl = `https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=${productId}`;
        fetch(apiUrl)
            .then(res => {
                if (!res.ok) throw new Error(`HTTP status ${res.status}`);
                return res.json();
            })
            .then(data => {
                const sellerObj = data.data?.[0]?.seller;
                const title = sellerObj && sellerObj.title ? sellerObj.title.trim() : 'Rozetka';
                sendResponse({ success: true, seller: title });
            })
            .catch(err => {
                console.warn(`TradeScout Background: Failed to fetch seller for ID ${productId}:`, err.message);
                sendResponse({ success: false, seller: 'Rozetka' });
            });
        return true; // Keep message channel open for asynchronous sendResponse
    }

    if (message.action === 'sendWebhook') {
        const { webhookUrl, payload } = message;
        const itemCount = payload?.products?.length || 0;
        console.log(`TradeScout Background: Processing ${itemCount} products...`);

        // 1. Завжди автоматично відправляємо базові товари на локальну платформу (Port 4000)
        const sendToPlatform = Promise.all([
            fetch(LOCAL_DASHBOARD_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => null),
            fetch(LOCAL_IP_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => null)
        ]);

        // 2. Додатковий вебхук (n8n)
        let sendToWebhook = Promise.resolve();
        if (webhookUrl && webhookUrl !== LOCAL_DASHBOARD_API && webhookUrl !== LOCAL_IP_API) {
            sendToWebhook = fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).catch(() => null);
        }

        Promise.all([sendToPlatform, sendToWebhook]).then(() => {
            sendResponse({ success: true });
        });

        // 3. Запускаємо асинхронне фонове збагачення описами та деталями (не блокує скрапер)
        if (payload?.products && payload.products.length > 0 && !payload.skipBackgroundEnrichment && !payload.isEnriched) {
            enrichProductsInBackground(payload.products, webhookUrl);
        }

        return true;
    }
});

// Асинхронне фонове витягування характеристик та опису
async function fetchProductDetails(product) {
    if (!product.link) return;
    try {
        const charUrl = product.link.endsWith('/') ? `${product.link}characteristics/` : `${product.link}/characteristics/`;
        const res = await fetch(charUrl);
        if (!res.ok) return;
        const htmlText = await res.text();

        // 1. Опис
        const descMatch = htmlText.match(/class="[^"]*(?:product-about__description|rz-product-description)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        if (descMatch) {
            const cleanDesc = descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (cleanDesc && cleanDesc.length > 10) {
                product.description = cleanDesc;
            }
        }

        // 2. Структуровані характеристики
        const specsList = [];
        const specMatches = htmlText.matchAll(/class="[^"]*characteristics__label[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>[\s\S]*?class="[^"]*characteristics__value[^"]*"[^>]*>([\s\S]*?)<\/[^>]+>/gi);
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
    } catch (e) {
        console.warn('TradeScout Background: Detail fetch skipped for', product.name);
    }
}

async function enrichProductsInBackground(products, webhookUrl) {
    const BATCH_SIZE = 5;
    console.log(`TradeScout Background: Enriching details for ${products.length} products in background...`);
    
    for (let i = 0; i < products.length; i += BATCH_SIZE) {
        const batch = products.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(p => fetchProductDetails(p)));
        await new Promise(r => setTimeout(r, 200));

        // Надсилаємо оновлені детальні дані на Дашборд
        const enrichedPayload = { products: batch };
        const targets = [LOCAL_DASHBOARD_API, LOCAL_IP_API];
        if (webhookUrl && !targets.includes(webhookUrl)) {
            targets.push(webhookUrl);
        }

        for (const targetUrl of targets) {
            fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(enrichedPayload)
            }).catch(() => {});
        }
    }
    console.log('TradeScout Background: All product details enriched successfully.');
}
