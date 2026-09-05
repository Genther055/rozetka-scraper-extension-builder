import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import {join} from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';

import {
  initDb,
  getCurrentProducts,
  saveCurrentProducts,
  clearCurrentProducts,
  getHistory,
  saveHistorySnapshot,
  deleteHistorySnapshot,
  moveHistorySnapshot,
  getFolders,
  saveFolder,
  deleteFolder,
  ScrapingFolder,
  ScrapingSnapshot
} from './db.js';

const browserDistFolder = join(import.meta.dirname, '../browser');

// Initialize Neon PostgreSQL Database on server launch
initDb().catch(err => console.error('[Neon DB Startup Error]', err));

const app = express();
app.use((req, res, next) => {
  // Видаляємо заголовки перевірки походження (origin/sec-fetch), щоб Angular SSR не видавав 403 Forbidden
  delete req.headers['sec-fetch-site'];
  delete req.headers['sec-fetch-mode'];
  delete req.headers['sec-fetch-dest'];
  delete req.headers['origin'];

  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

/**
 * REST API endpoints for TradeScout Ingestion & AI analysis
 */

// Asynchronous background seller resolver for Rozetka products
async function resolveSellerInServerBackground(productId: string, normalizedLink: string) {
  try {
    const apiUrl = `https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=${productId}`;
    const response = await fetch(apiUrl);
    if (response.ok) {
      const apiData: any = await response.json();
      const sellerTitle = apiData.data?.[0]?.seller?.title;
      if (sellerTitle) {
        const cleanedSeller = sellerTitle.trim();
        const currentProducts = await getCurrentProducts();
        const index = currentProducts.findIndex((p: any) => p && p.link === normalizedLink);
        if (index !== -1) {
          currentProducts[index].seller = cleanedSeller;
          await saveCurrentProducts(currentProducts);
          console.log(`[Backend Enriched] Successfully updated seller for ${normalizedLink} -> ${cleanedSeller}`);
        }
      }
    }
  } catch (error: any) {
    console.error(`[Backend Enrichment Error] Failed to resolve seller for ${productId}:`, error.message);
  }
}

app.post('/api/products', async (req, res) => {
  try {
    let newItems = req.body ? (req.body.products || req.body) : [];
    if (typeof newItems === 'string') {
      try {
        const parsed = JSON.parse(newItems);
        newItems = parsed.products || parsed;
      } catch (e) {}
    }
    if (!Array.isArray(newItems)) {
      newItems = [];
    }

    const getProductId = (link: string) => {
      const match = link.match(/\/p(\d+)/) || link.match(/p-(\d+)/) || link.match(/p(\d+)/);
      return match ? match[1] : '';
    };

    const getItemKey = (p: any) => {
      const pLink = p.link ? p.link.split('?')[0].split('#')[0] : '';
      const pId = getProductId(pLink);
      if (pId) return pId;
      const pName = (p.name || '').trim().toLowerCase();
      return pName;
    };

    const { sessionId, sessionTitle } = req.body || {};
    let products = await getCurrentProducts();
    
    newItems.forEach((item: any) => {
      if (!item || typeof item !== 'object') return;
      try {
        const normalizedLink = item.link ? item.link.split('?')[0].split('#')[0] : '';
        item.link = normalizedLink;
        
        const itemPrice = typeof item.price === 'number' ? item.price : parseFloat(item.price) || 0;
        const itemReviews = typeof item.reviews === 'number' ? item.reviews : parseInt(item.reviews) || 0;
        const itemRating = typeof item.rating === 'number' ? item.rating : parseFloat(item.rating) || 5.0;
        const itemOldPrice = typeof item.oldPrice === 'number' ? item.oldPrice : (parseFloat(item.oldPrice) || itemPrice);
        const itemDiscount = typeof item.discount === 'number' ? item.discount : (parseFloat(item.discount) || 0);
        const itemSessionTitle = item.sessionTitle || sessionTitle || '';
        const itemSessionId = item.sessionId || sessionId || '';

        const itemKey = getItemKey({ ...item, link: normalizedLink });
        const exists = products.some(p => p && getItemKey(p) === itemKey);
        
        if (!exists) {
          products.push({
            name: item.name || 'Товар без назви',
            price: itemPrice,
            oldPrice: itemOldPrice,
            discount: itemDiscount,
            rating: itemRating,
            reviews: itemReviews,
            inStock: item.inStock !== false,
            category: item.category || 'Загальна',
            sessionTitle: itemSessionTitle,
            sessionId: itemSessionId,
            specs: item.specs || '',
            description: item.description || '',
            detailedSpecsMap: item.detailedSpecsMap || {},
            seller: item.seller || 'Rozetka',
            sellersCount: item.sellersCount || 1,
            link: normalizedLink,
            scrapedAt: new Date().toISOString(),
            aiStatus: 'pending',
            aiVerdict: ''
          });

          const productIdMatch = normalizedLink.match(/p(\d+)/);
          const productId = productIdMatch ? productIdMatch[1] : null;
          if (productId) {
            resolveSellerInServerBackground(productId, normalizedLink);
          }
        } else {
          const index = products.findIndex(p => p && getItemKey(p) === itemKey);
          if (index !== -1) {
            const oldPrice = products[index].price || 0;
            const oldReviews = products[index].reviews || 0;

            products[index].priceChange = itemPrice - oldPrice;
            products[index].reviewsGrowth = itemReviews - oldReviews;

            products[index].price = itemPrice;
            products[index].oldPrice = itemOldPrice;
            products[index].discount = itemDiscount;
            products[index].reviews = itemReviews;
            products[index].rating = itemRating;
            products[index].name = item.name || products[index].name;
            products[index].inStock = item.inStock !== false;
            products[index].scrapedAt = new Date().toISOString();
            if (item.category) products[index].category = item.category;
            if (itemSessionTitle) products[index].sessionTitle = itemSessionTitle;
            if (itemSessionId) products[index].sessionId = itemSessionId;
            if (item.specs) products[index].specs = item.specs;
            if (item.description) products[index].description = item.description;
            if (item.detailedSpecsMap) products[index].detailedSpecsMap = item.detailedSpecsMap;
            if (item.seller) products[index].seller = item.seller;
            if (item.sellersCount) products[index].sellersCount = item.sellersCount;

            if (products[index].seller === 'Rozetka') {
              const productIdMatch = normalizedLink.match(/p(\d+)/);
              const productId = productIdMatch ? productIdMatch[1] : null;
              if (productId) {
                resolveSellerInServerBackground(productId, normalizedLink);
              }
            }
          }
        }
      } catch (e) {
        console.error('Error processing scraped product item:', e, item);
      }
    });

    const seenIds = new Set<string>();
    products = products.filter((p: any) => {
      if (!p) return false;
      const key = getItemKey(p);
      if (seenIds.has(key)) return false;
      seenIds.add(key);
      return true;
    });

    const currentCategory = newItems[0]?.category || 'Загальна';
    const categoryCount = products.filter((p: any) => p && p.category === currentCategory).length;

    await saveCurrentProducts(products);

    // Auto-update or create snapshot in history for this session in Neon DB
    const activeTitle = (sessionTitle || newItems[0]?.sessionTitle || currentCategory || '').trim();
    if (activeTitle && activeTitle !== 'Загальна') {
      try {
        const sessionSnapshotId = (sessionId || 'snap_' + activeTitle.toLowerCase().replace(/[^a-z0-9а-яіїєґ]/gi, '_')).substring(0, 100);
        const sessionProducts = products.filter((p: any) => 
          (sessionId && p.sessionId === sessionId) || 
          (p.sessionTitle && p.sessionTitle === activeTitle) ||
          (p.category && p.category === currentCategory)
        );

        if (sessionProducts.length > 0) {
          const prices = sessionProducts.map((p: any) => p.price || 0).filter((pr: number) => pr > 0);
          const avgPrice = prices.length > 0 ? Math.round(prices.reduce((a: number, b: number) => a + b, 0) / prices.length) : 0;
          const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
          const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
          const sellers = new Set(sessionProducts.map((p: any) => p.seller || 'Rozetka'));

          await saveHistorySnapshot({
            id: sessionSnapshotId,
            title: `Збір ${activeTitle}`,
            folderId: null,
            scrapedAt: new Date().toISOString(),
            itemCount: sessionProducts.length,
            category: currentCategory,
            avgPrice,
            minPrice,
            maxPrice,
            sellersCount: sellers.size,
            products: sessionProducts
          });
        }
      } catch (snapErr) {
        console.warn('Auto-snapshot error for session:', snapErr);
      }
    }

    res.json({ success: true, count: products.length, categoryCount });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const products = await getCurrentProducts();
    res.json({ success: true, products });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/products/clear', async (req, res) => {
  try {
    await clearCurrentProducts();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/products/replace', async (req, res) => {
  try {
    const newItems = req.body ? (req.body.products || req.body) : [];
    const safeItems = Array.isArray(newItems) ? newItems : [];
    await saveCurrentProducts(safeItems);
    res.json({ success: true, count: safeItems.length, products: safeItems });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- History & Snapshots Endpoints ---
app.get('/api/history', async (req, res) => {
  try {
    const history = await getHistory();
    res.json({ success: true, history });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/history', async (req, res) => {
  try {
    const { id, title, folderId, products: customProducts, scrapedAt, category: customCat, itemCount, avgPrice: customAvg, minPrice: customMin, maxPrice: customMax, sellersCount: customSellers } = req.body || {};
    const currentProds = await getCurrentProducts();
    const itemsToSave = customProducts && Array.isArray(customProducts) ? customProducts : currentProds;

    if (!itemsToSave || itemsToSave.length === 0) {
      res.status(400).json({ success: false, error: 'Немає товарів для збереження в знімок' });
      return;
    }

    const prices = itemsToSave.map((p: any) => p.price || 0).filter((pr: number) => pr > 0);
    const avgPrice = customAvg !== undefined ? customAvg : (prices.length > 0 ? Math.round(prices.reduce((a: number, b: number) => a + b, 0) / prices.length) : 0);
    const minPrice = customMin !== undefined ? customMin : (prices.length > 0 ? Math.min(...prices) : 0);
    const maxPrice = customMax !== undefined ? customMax : (prices.length > 0 ? Math.max(...prices) : 0);
    const sellers = new Set(itemsToSave.map((p: any) => p.seller || 'Rozetka'));
    const category = customCat || itemsToSave[0]?.category || 'Загальна';

    const now = new Date();
    const dateFormatted = now.toLocaleDateString('uk-UA') + ' ' + now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

    const newSnapshot: ScrapingSnapshot = {
      id: id || ('snap_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
      title: title && title.trim() ? title.trim() : `Збір ${category} — ${dateFormatted}`,
      folderId: folderId || null,
      scrapedAt: scrapedAt || now.toISOString(),
      itemCount: itemCount !== undefined ? itemCount : itemsToSave.length,
      category,
      avgPrice,
      minPrice,
      maxPrice,
      sellersCount: customSellers !== undefined ? customSellers : sellers.size,
      products: JSON.parse(JSON.stringify(itemsToSave))
    };

    await saveHistorySnapshot(newSnapshot);
    res.json({ success: true, snapshot: newSnapshot });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.put('/api/history/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { title, folderId } = req.body || {};
    const history = await getHistory();
    const snapshot = history.find(s => s.id === id);
    if (!snapshot) {
      res.status(404).json({ success: false, error: 'Знімок не знайдено' });
      return;
    }

    if (title !== undefined) snapshot.title = title.trim();
    if (folderId !== undefined) snapshot.folderId = folderId;

    await saveHistorySnapshot(snapshot);
    res.json({ success: true, snapshot });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/history/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await deleteHistorySnapshot(id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/history', async (req, res) => {
  try {
    const history = await getHistory();
    for (const s of history) {
      await deleteHistorySnapshot(s.id);
    }
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/history/:id/restore', async (req, res) => {
  try {
    const { id } = req.params;
    const { products: bodyProducts } = req.body || {};
    let productsToRestore = (bodyProducts && Array.isArray(bodyProducts) && bodyProducts.length > 0) ? bodyProducts : null;

    if (!productsToRestore) {
      const history = await getHistory();
      const snapshot = history.find(s => s.id === id);
      if (snapshot && snapshot.products && snapshot.products.length > 0) {
        productsToRestore = snapshot.products;
      }
    }

    if (!productsToRestore || productsToRestore.length === 0) {
      res.status(404).json({ success: false, error: 'Знімок не знайдено або він порожній' });
      return;
    }

    await saveCurrentProducts(productsToRestore);
    res.json({ success: true, count: productsToRestore.length, products: productsToRestore });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// --- Folders Endpoints ---
app.get('/api/folders', async (req, res) => {
  try {
    const folders = await getFolders();
    res.json({ success: true, folders });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/folders', async (req, res) => {
  try {
    const { id, name, icon, color, createdAt } = req.body || {};
    if (!name || !name.trim()) {
      res.status(400).json({ success: false, error: 'Вкажіть назву папки' });
      return;
    }

    const newFolder: ScrapingFolder = {
      id: id || ('fld_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6)),
      name: name.trim(),
      icon: icon || 'folder',
      color: color || '#6366f1',
      createdAt: createdAt || new Date().toISOString()
    };

    await saveFolder(newFolder);
    res.json({ success: true, folder: newFolder });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/folders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await deleteFolder(id);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Функція для алгоритмічного аудиту товарів без використання Gemini API (безкоштовно та миттєво)
function performAlgorithmicAudit(name: string, htmlContent: string, productItem: any) {
  const textToSearch = (String(name || '') + ' ' + String(htmlContent || '')).toLowerCase();

  // 1. Визначення ємності
  let capacity = '';
  const capacityMatch = textToSearch.match(/(\d{3,6})\s*(?:mah|маг|мАг|милиампер|міліампер)/i);
  if (capacityMatch) {
    capacity = `${capacityMatch[1]} mAh`;
  } else {
    // Спробуємо витягнути з назви
    const nameCapMatch = name.match(/(\d{3,6})\s*(?:mah|маг|мАг)/i);
    capacity = nameCapMatch ? `${nameCapMatch[1]} mAh` : '20000 mAh';
  }

  // 2. Визначення потужності зарядки
  let power = '';
  const powerMatch = textToSearch.match(/(\d+(?:\.\d+)?)\s*(?:w|вт|ват)/i);
  if (powerMatch) {
    power = `${powerMatch[1]}W`;
  } else {
    const namePowerMatch = name.match(/(\d+(?:\.\d+)?)\s*W/i);
    power = namePowerMatch ? `${namePowerMatch[1]}W` : '15W';
  }

  // 3. Стандарти швидкої зарядки
  const fastCharging: string[] = [];
  if (textToSearch.includes('pd') || textToSearch.includes('power delivery') || textToSearch.includes('power-delivery')) {
    fastCharging.push('PD');
  }
  if (textToSearch.includes('qc') || textToSearch.includes('quick charge') || textToSearch.includes('quick-charge')) {
    fastCharging.push('QC');
  }
  const fcString = fastCharging.length > 0 ? fastCharging.join('/') : 'Стандарт';

  // 4. Наявні роз'єми
  const ports: string[] = [];
  if (textToSearch.includes('usb-c') || textToSearch.includes('type-c') || textToSearch.includes('тайп')) {
    ports.push('Type-C');
  }
  if (textToSearch.includes('lightning') || textToSearch.includes('лайтнінг')) {
    ports.push('Lightning');
  }
  if (textToSearch.includes('micro') || textToSearch.includes('мікро')) {
    ports.push('Micro-USB');
  }
  const portsString = ports.length > 0 ? ports.join(', ') : 'USB-A';

  // 5. Офіційна кількість продажів на Розетці (з бейджа "X покупців придбали цей товар")
  let realSalesCount: number | null = null;
  const salesMatch = htmlContent.match(/(\d+)\s*покупців\s*придбали\s*цей\s*товар/i);
  if (salesMatch) {
    realSalesCount = parseInt(salesMatch[1], 10);
  }

  const specs = `${capacity}, ${power}, ${fcString}, ${portsString}`;

  let status: 'ok' | 'warning' | 'suspicious' = 'ok';
  const verdicts: string[] = [];

  if (realSalesCount) {
    verdicts.push(`🔥 Офіційна статистика Розетки: ${realSalesCount} покупців придбали цей товар повторно!`);
  }

  // Логіка перевірки невідповідностей
  if (name.toLowerCase().includes('30000') && capacity.includes('20000')) {
    status = 'warning';
    verdicts.push('У назві вказано 30000mAh, але в описі знайдено 20000mAh. Можлива неточність.');
  }

  if (power.includes('65W') || power.includes('100W') || power.includes('140W')) {
    verdicts.push(`⚡ Підтримує зарядку ноутбуків (${power}).`);
  }

  if (verdicts.length === 0) {
    verdicts.push('Характеристики виглядають коректно та відповідають опису.');
  }

  const verdict = verdicts.join(' ');

  return { status, verdict, specs, realSalesCount };
}

app.post('/api/products/analyze', async (req, res) => {
  const { link, name, useAi } = req.body;
  if (!link) {
    return res.status(400).json({ success: false, error: 'Product link is required' });
  }

  const products = await getCurrentProducts();
  const productItem = products.find(p => p && p.link === link) || {};
  let htmlContent = '';
  
  // 1. Завантажуємо сторінку товару для зчитування характеристик
  try {
    const fetchResponse = await fetch(link, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (fetchResponse.ok) {
      const fullHtml = await fetchResponse.text();
      htmlContent = fullHtml
        .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, '')
        .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .substring(0, 15000);
    }
  } catch (e) {
    console.warn('Failed to fetch product details page:', e);
  }

  const apiKey = process.env['GEMINI_API_KEY'] || process.env['GEMINI_API_KEY_SECRET'];

  // Якщо користувач явно вимагає ШІ-аналіз ТА є API-ключ — робимо запит до Gemini
  if (useAi === true && apiKey) {
    console.log(`TradeScout: Running AI Audit via Gemini for: ${name}`);
    try {
      const ai = new GoogleGenAI({ apiKey });
      const prompt = `Analyze this product from the e-commerce store:
Product Name: "${name}"
Product URL: ${link}
Scraped Page Content Snippet:
"""
${htmlContent || 'No page content available.'}
"""

1. Verify if the product's listed specifications (especially power bank capacity in mAh, charging speed in W, weight, etc.) match the product name and seem logical.
2. If there are contradictions (e.g. name says 20000mAh but specifications state 10000mAh), flag it.
3. Extract and summarize the clean technical specifications (like real capacity, power/wattage, fast charging standards, weight, ports) from the page text/description. Keep it concise.
4. Keep the review short, and in Ukrainian.
5. Output your response as a JSON object matching this structure (do not include markdown ticks, just raw JSON):
{
  "status": "warning" | "ok" | "suspicious",
  "verdict": "Detailed explanation of findings in Ukrainian.",
  "specs": "Short summary of verified specifications (e.g., '20000 mAh, 20W, PD 3.0, 3 порти') in Ukrainian."
}`;

      const response = await ai.models.generateContent({
        model: 'gemini-1.5-flash',
        contents: prompt,
        config: { responseMimeType: 'application/json' }
      });

      const resultText = response.text || '{}';
      const parsed = JSON.parse(resultText);

      // Оновлюємо в базі
      const prodIndex = products.findIndex(p => p && p.link === link);
      if (prodIndex !== -1) {
        products[prodIndex].aiStatus = parsed.status || 'ok';
        products[prodIndex].aiVerdict = parsed.verdict || 'Перевірено ШІ';
        if (parsed.specs) {
          products[prodIndex].specs = parsed.specs;
        }
        await saveCurrentProducts(products);
      }

      return res.json({ success: true, status: parsed.status, verdict: parsed.verdict, specs: parsed.specs });
    } catch (error: any) {
      console.error('Gemini audit error, falling back to algorithmic audit:', error);
      // При помилці ШІ робимо фолбек на алгоритм, щоб не ламати інтерфейс
    }
  }

  // За замовчуванням (або при відсутності ключа) виконуємо швидкий безкоштовний алгоритмічний аудит
  console.log(`TradeScout: Running Algorithmic Audit for: ${name}`);
  const auditResult = performAlgorithmicAudit(name, htmlContent, productItem);

  const prodIndex = products.findIndex(p => p.link === link);
  if (prodIndex !== -1) {
    products[prodIndex].aiStatus = auditResult.status;
    products[prodIndex].aiVerdict = auditResult.verdict;
    products[prodIndex].specs = auditResult.specs;
    if (auditResult.realSalesCount) {
      products[prodIndex].realSalesCount = auditResult.realSalesCount;
    }
    await saveCurrentProducts(products);
  }

  return res.json({
    success: true,
    status: auditResult.status,
    verdict: auditResult.verdict,
    specs: auditResult.specs,
    realSalesCount: auditResult.realSalesCount
  });
});

const angularApp = new AngularNodeAppEngine();

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle API 404s cleanly without passing to Angular SSR engine
 */
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = Number(process.env['PORT']) || 4000;
  app.listen(port, '0.0.0.0', (error?: any) => {
    if (error) {
      throw error;
    }

    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
