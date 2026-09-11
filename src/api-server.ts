import express from 'express';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import {
  initDb,
  getCurrentProducts,
  saveCurrentProducts,
  clearCurrentProducts,
  getHistory,
  saveHistorySnapshot,
  deleteHistorySnapshot,
  getFolders,
  saveFolder,
  deleteFolder,
  getUsers,
  getUserByUsername,
  getUserById,
  createUser,
  updateUser,
  updateUserPassword,
  recordUserLogin,
  deleteUser,
  verifyPassword,
  ScrapingFolder,
  ScrapingSnapshot,
  AppUser
} from './db.js';

// Initialize DB on launch
initDb().catch(err => console.error('[Neon DB API-Server Startup Error]', err));

const app = express();

// Global CORS & Header Cleanup
app.use((req, res, next) => {
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

// Ingestion Endpoint (supports /api/products, /dashboard, /products)
app.post(['/api/products', '/dashboard', '/api/dashboard', '/products'], async (req, res) => {
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
        console.error('Error processing scraped product item inside api-server:', e, item);
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

    res.json({ success: true, count: products.length, categoryCount: categoryCount });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Retrieval Endpoint
app.get(['/api/products', '/dashboard'], async (req, res) => {
  try {
    const products = await getCurrentProducts();
    res.json({ success: true, products });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Clear Endpoint
app.post('/api/products/clear', async (req, res) => {
  try {
    await clearCurrentProducts();
    activeScrapes.clear();
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Replace Endpoint
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
    const { name, icon, color } = req.body || {};
    if (!name || !name.trim()) {
      res.status(400).json({ success: false, error: 'Вкажіть назву папки' });
      return;
    }

    const newFolder: ScrapingFolder = {
      id: 'fld_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      name: name.trim(),
      icon: icon || 'folder',
      color: color || '#6366f1',
      createdAt: new Date().toISOString()
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

// Algorithmic Audit
function performAlgorithmicAudit(name: string, htmlContent: string, productItem: any) {
  const textToSearch = (String(name || '') + ' ' + String(htmlContent || '')).toLowerCase();

  let capacity = '';
  const capacityMatch = textToSearch.match(/(\d{3,6})\s*(?:mah|маг|мАг|милиампер|міліампер)/i);
  if (capacityMatch) {
    capacity = `${capacityMatch[1]} mAh`;
  } else {
    const nameCapMatch = name.match(/(\d{3,6})\s*(?:mah|маг|мАг)/i);
    capacity = nameCapMatch ? `${nameCapMatch[1]} mAh` : '20000 mAh';
  }

  let power = '';
  const powerMatch = textToSearch.match(/(\d+(?:\.\d+)?)\s*(?:w|вт|ват)/i);
  if (powerMatch) {
    power = `${powerMatch[1]}W`;
  } else {
    const namePowerMatch = name.match(/(\d+(?:\.\d+)?)\s*W/i);
    power = namePowerMatch ? `${namePowerMatch[1]}W` : '15W';
  }

  const fastCharging: string[] = [];
  if (textToSearch.includes('pd') || textToSearch.includes('power delivery') || textToSearch.includes('power-delivery')) {
    fastCharging.push('PD');
  }
  if (textToSearch.includes('qc') || textToSearch.includes('quick charge') || textToSearch.includes('quick-charge')) {
    fastCharging.push('QC');
  }
  const fcString = fastCharging.length > 0 ? fastCharging.join('/') : 'Стандарт';

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

  const rating = productItem?.rating || 0;
  const reviews = productItem?.reviews || 0;
  const inStock = productItem?.inStock !== false;
  const seller = productItem?.seller || 'Rozetka';

  if (rating > 0 && rating < 4.0) {
    status = 'warning';
    verdicts.push(`Увага: низький рейтинг товару (${rating}/5.0). Покупці вказують на технічні недоліки.`);
  } else if (rating >= 4.5) {
    verdicts.push(`Високий рейтинг (${rating}/5.0) підтверджує якість пристрою.`);
  } else if (rating === 0) {
    status = 'suspicious';
    verdicts.push(`Товар не має оцінок та відгуків покупців.`);
  }

  if (reviews > 50) {
    verdicts.push(`Підтверджений попит: більше 50 відгуків.`);
  } else if (reviews > 0 && reviews <= 10) {
    verdicts.push(`Слабкий інтерес покупців: менше 10 відгуків.`);
  }

  if (seller.toLowerCase() === 'rozetka') {
    if (status === 'ok') {
      status = 'warning';
    }
    verdicts.push(`Продавець — сама Rozetka. Конкурувати за позиції в топі буде складно.`);
  } else {
    verdicts.push(`Продається стороннім продавцем (${seller}), що полегшує вихід на ринок.`);
  }

  const verdict = verdicts.join(' ') || 'Характеристики відповідають опису. Товар стабільний.';
  return { status, verdict, specs, realSalesCount };
}

app.post('/api/products/analyze', async (req, res) => {
  const { link, name } = req.body;
  if (!link) {
    return res.status(400).json({ success: false, error: 'Product link is required' });
  }

  const products = await getCurrentProducts();
  const productItem = products.find(p => p && p.link === link) || {};
  let htmlContent = '';
  
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
  } catch (e) {}

  const auditResult = performAlgorithmicAudit(name, htmlContent, productItem);

  const prodIndex = products.findIndex(p => p && p.link === link);
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

// --- AUTH & USER MANAGEMENT ENDPOINTS ---

// 1. User Login with credentials verification
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, error: "Будь ласка, введіть логін та пароль" });
  }

  const user = await getUserByUsername(username);
  if (!user) {
    return res.status(401).json({ success: false, error: "Користувача з таким логіном не знайдено" });
  }

  if (!user.isActive) {
    return res.status(403).json({ success: false, error: "Цей обліковий запис заблоковано. Зверніться до адміністратора" });
  }

  const isMatch = verifyPassword(password, user.passwordHash);
  if (!isMatch) {
    return res.status(401).json({ success: false, error: "Неправильний пароль. Перевірте введені дані" });
  }

  await recordUserLogin(user.id);

  return res.json({
    success: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      displayName: user.displayName,
      avatarGradient: user.avatarGradient,
      isActive: user.isActive,
      lastLoginAt: new Date().toISOString()
    }
  });
});

// 2. Public / Self-serve Registration
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, displayName, avatarGradient } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: "Логін та пароль обов'язкові" });
    }

    const cleanUsername = username.trim().toLowerCase();
    if (cleanUsername.length < 3) {
      return res.status(400).json({ success: false, error: "Логін має містити щонайменше 3 символи" });
    }

    if (password.trim().length < 3) {
      return res.status(400).json({ success: false, error: "Пароль має містити щонайменше 3 символи" });
    }

    const existing = await getUserByUsername(cleanUsername);
    if (existing) {
      return res.status(400).json({ success: false, error: "Користувач з таким логіном вже зареєстрований" });
    }

    const created = await createUser({
      username: cleanUsername,
      password: password.trim(),
      role: 'analyst',
      displayName: displayName?.trim() || cleanUsername,
      avatarGradient: avatarGradient || 'from-indigo-600 to-purple-600'
    });

    await recordUserLogin(created.id);

    return res.json({
      success: true,
      user: {
        id: created.id,
        username: created.username,
        role: created.role,
        displayName: created.displayName,
        avatarGradient: created.avatarGradient,
        isActive: created.isActive,
        lastLoginAt: new Date().toISOString()
      }
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Get all users
app.get('/api/users', async (req, res) => {
  try {
    const list = await getUsers();
    const safeList = list.map(u => ({
      id: u.id,
      username: u.username,
      role: u.role,
      displayName: u.displayName,
      avatarGradient: u.avatarGradient,
      isActive: u.isActive,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt
    }));
    return res.json({ success: true, users: safeList });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Create new user
app.post('/api/users', async (req, res) => {
  try {
    const { username, password, role, displayName, avatarGradient } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: "Логін та пароль обов'язкові" });
    }

    const cleanUsername = username.trim().toLowerCase();
    const existing = await getUserByUsername(cleanUsername);
    if (existing) {
      return res.status(400).json({ success: false, error: "Користувач з таким логіном вже існує" });
    }

    const created = await createUser({
      username: cleanUsername,
      password: password.trim(),
      role: role === 'admin' ? 'admin' : 'analyst',
      displayName: displayName || cleanUsername,
      avatarGradient: avatarGradient || 'from-indigo-600 to-purple-600'
    });

    return res.json({
      success: true,
      user: {
        id: created.id,
        username: created.username,
        role: created.role,
        displayName: created.displayName,
        avatarGradient: created.avatarGradient,
        isActive: created.isActive,
        createdAt: created.createdAt,
        lastLoginAt: created.lastLoginAt
      }
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Update user details (name, role, avatar, active status)
app.put('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { displayName, role, avatarGradient, isActive } = req.body;
    const updated = await updateUser(id, {
      displayName,
      role: role === 'admin' ? 'admin' : 'analyst',
      avatarGradient,
      isActive: typeof isActive === 'boolean' ? isActive : true
    });

    if (!updated) {
      return res.status(404).json({ success: false, error: "Користувача не знайдено" });
    }

    return res.json({
      success: true,
      user: {
        id: updated.id,
        username: updated.username,
        role: updated.role,
        displayName: updated.displayName,
        avatarGradient: updated.avatarGradient,
        isActive: updated.isActive,
        createdAt: updated.createdAt,
        lastLoginAt: updated.lastLoginAt
      }
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Change user password
app.post('/api/users/:id/password', async (req, res) => {
  try {
    const { id } = req.params;
    const { newPassword } = req.body;
    if (!newPassword || newPassword.trim().length < 3) {
      return res.status(400).json({ success: false, error: "Пароль має містити щонайменше 3 символи" });
    }

    const user = await getUserById(id);
    if (!user) {
      return res.status(404).json({ success: false, error: "Користувача не знайдено" });
    }

    await updateUserPassword(id, newPassword.trim());
    return res.json({ success: true, message: "Пароль успішно змінено" });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 6. Delete user
app.delete('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allUsers = await getUsers();
    const adminCount = allUsers.filter(u => u.role === 'admin' && u.isActive).length;
    const target = allUsers.find(u => u.id === id);

    if (target?.role === 'admin' && adminCount <= 1) {
      return res.status(400).json({ success: false, error: "Неможливо видалити останнього активного адміністратора системи" });
    }

    await deleteUser(id);
    return res.json({ success: true, message: "Користувача видалено" });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env['PORT'] || 4000;
app.listen(PORT, () => {
  console.log(`🚀 TradeScout Pure Express API Server listening on port ${PORT} (IPv4 & IPv6)`);
});
