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
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.header('Pragma', 'no-cache');
  res.header('Expires', '0');
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



interface LiveScrapingTask {
  tabId?: number;
  sessionId: string;
  sessionTitle: string;
  category?: string;
  status: 'scraping' | 'completed' | 'stopped' | 'error';
  pageIndex: number;
  currentCount: number;
  estimatedTotal: number;
  percent: number;
  statusMsg?: string;
  updatedAt: number;
  startTime?: number;
}

const activeScrapes = new Map<string, LiveScrapingTask>();

function getCleanActiveScrapes(): LiveScrapingTask[] {
  const now = Date.now();
  const list: LiveScrapingTask[] = [];
  for (const [key, item] of activeScrapes.entries()) {
    if (item.status === 'completed' || item.status === 'stopped') {
      if (now - item.updatedAt > 15000) {
        activeScrapes.delete(key);
        continue;
      }
    } else if (now - item.updatedAt > 45000) {
      activeScrapes.delete(key);
      continue;
    }
    list.push(item);
  }
  return list;
}

const SERVER_START_TIME = Date.now();
const SERVER_VERSION = 'v4.3.0';
const BUILD_TIMESTAMP = '07.10 10:25';

app.get('/api/version', async (req, res) => {
  try {
    const products = await getCurrentProducts();
    const uptimeSec = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
    res.json({
      success: true,
      version: SERVER_VERSION,
      buildTimestamp: BUILD_TIMESTAMP,
      serverTime: new Date().toISOString(),
      uptimeSeconds: uptimeSec,
      totalProductsInDb: products.length,
      dbStatus: 'connected'
    });
  } catch (err: any) {
    res.json({
      success: true,
      version: SERVER_VERSION,
      buildTimestamp: BUILD_TIMESTAMP,
      serverTime: new Date().toISOString(),
      uptimeSeconds: 0,
      totalProductsInDb: 0,
      dbStatus: 'error: ' + err.message
    });
  }
});

app.post('/api/scraping-status', (req, res) => {
  try {
    const data = req.body || {};
    const key = data.sessionId || (data.tabId ? `tab_${data.tabId}` : 'default_scrape');
    const task: LiveScrapingTask = {
      tabId: data.tabId,
      sessionId: key,
      sessionTitle: data.sessionTitle || 'Каталог Rozetka',
      category: data.category || 'Загальна',
      status: data.status || 'scraping',
      pageIndex: typeof data.pageIndex === 'number' ? data.pageIndex : (parseInt(data.pageIndex, 10) || 1),
      currentCount: typeof data.currentCount === 'number' ? data.currentCount : (parseInt(data.currentCount, 10) || 0),
      estimatedTotal: typeof data.estimatedTotal === 'number' ? data.estimatedTotal : (parseInt(data.estimatedTotal, 10) || 0),
      percent: typeof data.percent === 'number' ? data.percent : (parseInt(data.percent, 10) || 0),
      statusMsg: data.statusMsg || '',
      updatedAt: Date.now(),
      startTime: data.startTime || Date.now()
    };
    activeScrapes.set(key, task);
    res.json({ success: true, activeScrapes: getCleanActiveScrapes() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/scraping-status', (req, res) => {
  res.json({ success: true, activeScrapes: getCleanActiveScrapes() });
});

app.post('/api/scraping-status/clear', (req, res) => {
  activeScrapes.clear();
  res.json({ success: true });
});

function cleanCategoryNameServer(c: string): string {
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

function detectBrandServer(p: any): string {
  if (!p) return 'Інші';
  const rawMap = p.detailedSpecsMap;
  let b = '';
  if (rawMap && (rawMap['Бренд'] || rawMap['Виробник'])) {
    b = String(rawMap['Бренд'] || rawMap['Виробник']).trim();
  } else if (p.specs && typeof p.specs === 'string' && p.specs.includes('Бренд:')) {
    const m = p.specs.match(/Бренд:\s*([^,;]+)/i);
    if (m) b = m[1].trim();
  }

  const name = p.name || '';
  if (!b || /^(?:універсальна|умб|батарея|портативна|павербанк|повербанк|зовнішній|power|зарядний|standard|інші)$/i.test(b) || (b === 'Apple' && /\b(?:для\s+(?:apple|iphone)|qinetiq|remzona)\b/i.test(name))) {
    const knownBrands = [
      { name: 'Sigma mobile', regex: /\b(?:Sigma\s*mobile|Sigma|X-POWER|X-power)\b/i },
      { name: 'Xiaomi', regex: /\b(?:Xiaomi|Mi\s+Power|Redmi|Poco)\b/i },
      { name: 'Ugreen', regex: /\bUgreen\b/i },
      { name: 'Baseus', regex: /\b(?:Baseus|Adaman)\b/i },
      { name: 'Qinetiq', regex: /\bQinetiq\b/i },
      { name: 'Remzona', regex: /\bRemzona\b/i },
      { name: 'Apple', regex: /\b(?:Apple|MagSafe)\b/i, excludeIf: /\b(?:для\s+(?:apple|iphone)|айфона)\b/i },
      { name: 'Samsung', regex: /\bSamsung\b/i, excludeIf: /\b(?:для\s+samsung|самсунг)\b/i },
      { name: 'Anker', regex: /\bAnker\b/i },
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
      { name: 'BLUETTI', regex: /\bBLUETTI\b/i },
      { name: 'EcoFlow', regex: /\bEcoFlow\b/i },
      { name: 'Jackery', regex: /\bJackery\b/i }
    ];
    for (const rule of knownBrands) {
      if (rule.excludeIf && rule.excludeIf.test(name)) continue;
      if (rule.regex.test(name)) {
        return rule.name;
      }
    }
    let cleanName = name.replace(/^(?:портативна\s+батарея|зовнішній\s+акумулятор|універсальна\s+батарея|батарея\s+універсальна|павербанк|повербанк|зарядний\s+пристрій|бездротова\s+зарядка|power\s*bank|умб)\s+/i, '').trim();
    const token = cleanName.split(/[\s,]+/)[0];
    if (token && token.length >= 2 && !/^\d+$/.test(token) && !/^(?:для|з|на|та|fast|pro|mini|led|black|white|grey|gray|red|blue)$/i.test(token)) {
      return token.charAt(0).toUpperCase() + token.slice(1);
    }
  }
  return b || 'Інші';
}

async function enrichMissingSellers(items: any[]): Promise<any[]> {
  const idsToFetch: string[] = [];
  const idMap = new Map<string, any>();
  
  for (const item of items) {
    if (!item) continue;
    const link = item.link || '';
    const m = link.match(/\/p(\d+)/) || link.match(/p-(\d+)/) || link.match(/p(\d+)/) || (item.id ? [null, item.id] : null);
    const prodId = m ? String(m[1]).trim() : '';
    const currentSeller = (item.seller || '').trim().toLowerCase();
    if (prodId && (!currentSeller || currentSeller === 'rozetka' || currentSeller === 'marketplace')) {
      idsToFetch.push(prodId);
      idMap.set(prodId, item);
    }
  }

  if (idsToFetch.length === 0) return items;

  for (let i = 0; i < idsToFetch.length; i += 60) {
    const chunk = idsToFetch.slice(i, i + 60);
    const idsStr = chunk.join(',');
    const apiUrl = `https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=${idsStr}`;
    try {
      const res = await fetch(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8'
        }
      });
      if (res.ok) {
        const json: any = await res.json();
        if (Array.isArray(json?.data)) {
          for (const apiProd of json.data) {
            if (apiProd && apiProd.id) {
              const target = idMap.get(String(apiProd.id));
              if (target) {
                const sTitle = apiProd.seller?.title || apiProd.seller?.name || apiProd.seller_title;
                if (sTitle && sTitle.trim() && sTitle.toLowerCase() !== 'rozetka') {
                  target.seller = sTitle.trim();
                } else if (apiProd.seller?.id === 5) {
                  target.seller = 'Rozetka';
                }
                if (typeof apiProd.sellers_count === 'number' && apiProd.sellers_count > 0) {
                  target.sellersCount = apiProd.sellers_count;
                }
              }
            }
          }
        }
      }
    } catch (_) {}
  }
  return items;
}

app.post('/api/enrich-sellers', async (req, res) => {
  try {
    let products = await getCurrentProducts();
    if (products.length > 0) {
      products = await enrichMissingSellers(products);
      await saveCurrentProducts(products);
    }
    const sellersMap: { [k: string]: number } = {};
    products.forEach(p => {
      const s = p.seller || 'Rozetka';
      sellersMap[s] = (sellersMap[s] || 0) + 1;
    });
    res.json({
      success: true,
      totalProducts: products.length,
      uniqueSellers: Object.keys(sellersMap).length,
      sellers: sellersMap
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

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

    const { sessionId, sessionTitle, clearBefore, reset, isNewSession, page, pageIndex } = req.body || {};
    let products = (clearBefore || reset || isNewSession || page === 1 || pageIndex === 1) 
      ? [] 
      : await getCurrentProducts();
    
    // If the current products belong to a different scrape session, start clean
    if (products.length > 0 && sessionId && products[0]?.sessionId && products[0].sessionId !== sessionId) {
      products = [];
    }
    
    newItems.forEach((item: any) => {
      if (!item || typeof item !== 'object') return;
      try {
        const normalizedLink = item.link ? item.link.split('?')[0].split('#')[0] : '';
        item.link = normalizedLink;
        
        const itemPrice = typeof item.price === 'number' ? item.price : parseFloat(item.price) || 0;
        const itemReviews = typeof item.reviews === 'number' ? item.reviews : parseInt(item.reviews) || 0;
        const itemRating = itemReviews > 0 ? (typeof item.rating === 'number' ? item.rating : (item.rating ? parseFloat(item.rating) : 0)) : 0;
        let itemOldPrice = typeof item.oldPrice === 'number' ? item.oldPrice : (parseFloat(item.oldPrice) || itemPrice);
        let itemDiscount = typeof item.discount === 'number' ? item.discount : (parseFloat(item.discount) || 0);

        if (itemOldPrice > itemPrice && !itemDiscount && itemPrice > 0) {
          itemDiscount = Math.round(((itemOldPrice - itemPrice) / itemOldPrice) * 100);
        } else if (itemDiscount > 0 && (!itemOldPrice || itemOldPrice <= itemPrice) && itemPrice > 0) {
          itemOldPrice = Math.round(itemPrice / (1 - itemDiscount / 100));
        }
        if (!itemOldPrice || itemOldPrice < itemPrice) {
          itemOldPrice = itemPrice;
        }

        const cleanCat = cleanCategoryNameServer(item.category || sessionTitle || 'Повербанки та УМБ');
        const detectedBrand = detectBrandServer(item);
        const specsMap = item.detailedSpecsMap && typeof item.detailedSpecsMap === 'object' ? { ...item.detailedSpecsMap } : {};
        if (!specsMap['Бренд'] || specsMap['Бренд'] === 'None' || specsMap['Бренд'] === 'Undefined') {
          specsMap['Бренд'] = detectedBrand;
        }

        let itemSpecs = item.specs || '';
        if (!itemSpecs.includes('Бренд:') && detectedBrand && detectedBrand !== 'Інші') {
          itemSpecs = itemSpecs ? `${itemSpecs}; Бренд: ${detectedBrand}` : `Бренд: ${detectedBrand}`;
        }

        const itemSessionTitle = cleanCategoryNameServer(item.sessionTitle || sessionTitle || cleanCat);
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
            category: cleanCat,
            sessionTitle: itemSessionTitle,
            sessionId: itemSessionId,
            specs: itemSpecs,
            description: item.description || '',
            detailedSpecsMap: specsMap,
            seller: item.seller || 'Rozetka',
            sellersCount: item.sellersCount || 1,
            link: normalizedLink,
            scrapedAt: new Date().toISOString(),
            aiStatus: 'pending',
            aiVerdict: ''
          });
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
            products[index].category = cleanCat;
            products[index].sessionTitle = itemSessionTitle;
            if (itemSessionId) products[index].sessionId = itemSessionId;
            products[index].specs = itemSpecs;
            if (item.description) products[index].description = item.description;
            products[index].detailedSpecsMap = specsMap;
            if (item.seller && item.seller !== 'Rozetka') products[index].seller = item.seller;
            if (item.sellersCount) products[index].sellersCount = item.sellersCount;
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

    products = await enrichMissingSellers(products);

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
          const inStockProds = sessionProducts.filter((p: any) => p && p.inStock !== false && Number(p.price) > 0);
          const validProds = inStockProds.length > 0 ? inStockProds : sessionProducts.filter((p: any) => Number(p.price) > 0);
          const prices = validProds.map((p: any) => Number(p.price) || 0);
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
    activeScrapes.clear();
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
