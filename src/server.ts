import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const browserDistFolder = process.env['VERCEL'] === '1' ? '' : join(__dirname, '../browser');
let dataDir = join(process.cwd(), 'database_store');

// Спроба створити папку локально. Якщо файлова система read-only (як на Vercel), використовуємо /tmp
try {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  const testFile = join(dataDir, '.test_write');
  writeFileSync(testFile, 'test');
  unlinkSync(testFile);
} catch (e) {
  console.warn('[Backend Warning] Project directory is read-only. Falling back to /tmp/database_store.');
  dataDir = '/tmp/database_store';
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
}

const dataFilePath = join(dataDir, 'products.json');
const activeDbPath = join(dataDir, 'active_db.json');

// Migrate legacy products.json to db_default.json inside database_store
const legacyFilePath = join(process.cwd(), 'data/products.json');
const legacyDefaultDbPath = join(process.cwd(), 'data/db_default.json');
const defaultDbPath = join(dataDir, 'db_default.json');

if (existsSync(legacyFilePath) && !existsSync(defaultDbPath)) {
  try {
    try {
      renameSync(legacyFilePath, defaultDbPath);
    } catch (renameErr) {
      // Fallback if renaming across mount points (EXDEV)
      const data = readFileSync(legacyFilePath, 'utf-8');
      writeFileSync(defaultDbPath, data, 'utf-8');
      try { unlinkSync(legacyFilePath); } catch (e) {}
    }
  } catch (e) {
    console.error('Error migrating legacy products.json:', e);
  }
}
if (existsSync(legacyDefaultDbPath) && !existsSync(defaultDbPath)) {
  try {
    try {
      renameSync(legacyDefaultDbPath, defaultDbPath);
    } catch (renameErr) {
      // Fallback if renaming across mount points (EXDEV)
      const data = readFileSync(legacyDefaultDbPath, 'utf-8');
      writeFileSync(defaultDbPath, data, 'utf-8');
      try { unlinkSync(legacyDefaultDbPath); } catch (e) {}
    }
  } catch (e) {
    console.error('Error migrating legacy db_default.json:', e);
  }
}

function getActiveDbName(): string {
  if (existsSync(activeDbPath)) {
    try {
      const data = JSON.parse(readFileSync(activeDbPath, 'utf-8'));
      return data.active || 'default';
    } catch (e) {
      return 'default';
    }
  }
  return 'default';
}

function getDbFilePath(name: string): string {
  // Безпечне ім'я файлу для будь-яких мов (зокрема кирилиці)
  const safeName = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return join(dataDir, `db_${safeName}.json`);
}

function loadProductsOfActiveDb(name?: string): any[] {
  const dbName = name || getActiveDbName();
  const path = getDbFilePath(dbName);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch (e) {
      return [];
    }
  }
  // Ініціалізація за замовчуванням
  if (dbName === 'default') {
    try {
      writeFileSync(path, JSON.stringify([], null, 2), 'utf-8');
    } catch (e) {}
  }
  return [];
}

function saveProductsOfActiveDb(items: any[], name?: string) {
  const dbName = name || getActiveDbName();
  const path = getDbFilePath(dbName);
  try {
    writeFileSync(path, JSON.stringify(items, null, 2), 'utf-8');
  } catch (e) {
    console.error(`Failed to save database ${dbName}:`, e);
  }
}

export const app = express();
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
async function resolveSellerInServerBackground(productId: string, normalizedLink: string, dbName: string) {
  try {
    const apiUrl = `https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=${productId}`;
    const response = await fetch(apiUrl);
    if (response.ok) {
      const apiData: any = await response.json();
      const sellerTitle = apiData.data?.[0]?.seller?.title;
      if (sellerTitle) {
        const cleanedSeller = sellerTitle.trim();
        const activeProducts = loadProductsOfActiveDb(dbName);
        const index = activeProducts.findIndex((p: any) => p && p.link === normalizedLink);
        if (index !== -1) {
          activeProducts[index].seller = cleanedSeller;
          saveProductsOfActiveDb(activeProducts, dbName);
          console.log(`[Backend Enriched] Successfully updated seller for ${normalizedLink} -> ${cleanedSeller} in DB ${dbName}`);
        }
      }
    }
  } catch (error: any) {
    console.error(`[Backend Enrichment Error] Failed to resolve seller for ${productId}:`, error.message);
  }
}

const lastActivityFilePath = join(dataDir, 'last_activity.json');
let lastDbUpdateTime = Date.now();
if (existsSync(lastActivityFilePath)) {
  try {
    const raw = readFileSync(lastActivityFilePath, 'utf-8');
    lastDbUpdateTime = JSON.parse(raw).timestamp || Date.now();
  } catch (e) {
    console.error('Error loading last_activity.json:', e);
  }
}

function updateLastActivityTime() {
  lastDbUpdateTime = Date.now();
  try {
    writeFileSync(lastActivityFilePath, JSON.stringify({ timestamp: lastDbUpdateTime }), 'utf-8');
  } catch (e) {
    console.error('Error saving last_activity.json:', e);
  }
}

function checkAndCleanExpiredData() {
  const threeHoursMs = 3 * 60 * 60 * 1000;
  const activeProducts = loadProductsOfActiveDb('default');
  if (activeProducts.length > 0 && (Date.now() - lastDbUpdateTime > threeHoursMs)) {
    console.log('[Backend] 3 hours of inactivity reached. Auto-clearing active database.');
    saveProductsOfActiveDb([], 'default');
    updateLastActivityTime();
  }
}

app.post('/api/products', (req, res) => {
  checkAndCleanExpiredData();
  // Завжди зберігаємо у спільну дефолтну базу даних
  const dbName = 'default';
  const products = loadProductsOfActiveDb(dbName);
  let newItems = req.body ? (req.body.products || req.body) : [];
  
  // Визначаємо назву вкладки (сесії)
  const targetCategory = newItems && newItems[0] && newItems[0].category ? newItems[0].category : 'Загальна';
  const sessionName = req.body.database || targetCategory;
  if (typeof newItems === 'string') {
    try {
      const parsed = JSON.parse(newItems);
      newItems = parsed.products || parsed;
    } catch (e) {}
  }
  if (!Array.isArray(newItems)) {
    newItems = [];
  }
  
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

      const exists = products.some(p => {
        if (!p || typeof p !== 'object') return false;
        if (!p || typeof p !== 'object') return false;
        const pLink = p.link ? p.link.split('?')[0].split('#')[0] : '';
        return pLink === normalizedLink;
      });
      
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
          database: sessionName, // Мітка вкладки
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

        // Trigger background seller resolution
        const productIdMatch = normalizedLink.match(/p(\d+)/);
        const productId = productIdMatch ? productIdMatch[1] : null;
        if (productId) {
          resolveSellerInServerBackground(productId, normalizedLink, 'default');
        }
      } else {
        const index = products.findIndex(p => {
          if (!p || typeof p !== 'object') return false;
          if (!p || typeof p !== 'object') return false;
          const pLink = p.link ? p.link.split('?')[0].split('#')[0] : '';
          return pLink === normalizedLink;
        });
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
          if (item.category) products[index].category = item.category;
          products[index].database = sessionName; // Оновлюємо мітку вкладки
          if (item.specs) products[index].specs = item.specs;
          if (item.description) products[index].description = item.description;
          if (item.detailedSpecsMap) products[index].detailedSpecsMap = item.detailedSpecsMap;
          if (item.seller) products[index].seller = item.seller;
          if (item.sellersCount) products[index].sellersCount = item.sellersCount;

          // If the seller remains Rozetka, verify it in the background
          if (products[index].seller === 'Rozetka') {
            const productIdMatch = normalizedLink.match(/p(\d+)/);
            const productId = productIdMatch ? productIdMatch[1] : null;
            if (productId) {
              resolveSellerInServerBackground(productId, normalizedLink, 'default');
            }
          }
        }
      }
    } catch (e) {
      console.error('Error processing scraped product item:', e, item);
    }
  });

  // Рахуємо кількість товарів у поточній категорії для зворотного зв'язку
  const currentCategory = newItems[0]?.category || 'Загальна';
  const categoryCount = products.filter((p: any) => p && p.category === currentCategory).length;

  try {
    updateLastActivityTime();
    saveProductsOfActiveDb(products, 'default');
    res.json({ success: true, count: products.length, categoryCount: categoryCount });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/products', (req, res) => {
  checkAndCleanExpiredData();
  const products = loadProductsOfActiveDb('default');
  res.json({ success: true, products });
});

app.post('/api/products/clear', (req, res) => {
  try {
    const targetSession = req.body.database;
    if (targetSession && targetSession !== 'all') {
      // Очищуємо тільки товари конкретної вкладки
      const products = loadProductsOfActiveDb('default');
      const filtered = products.filter((p: any) => p && p.database !== targetSession);
      saveProductsOfActiveDb(filtered, 'default');
    } else {
      // Очищуємо абсолютно всі товари
      saveProductsOfActiveDb([], 'default');
    }
    updateLastActivityTime();
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

  // 4.5. Витягування точного сигналу повторних покупок з плашки Розетки ("12194 покупців придбали цей товар повторно")
  let realSalesCount: number | null = null;
  const salesMatch = htmlContent.match(/(\d+)\s*покупців\s*придбали\s*цей\s*товар/i);
  if (salesMatch) {
    realSalesCount = parseInt(salesMatch[1], 10);
  }

  const specs = `${capacity}, ${power}, ${fcString}, ${portsString}`;

  // 5. Визначення вердикту та статусу
  let status: 'ok' | 'warning' | 'suspicious' = 'ok';
  const verdicts: string[] = [];

  if (realSalesCount) {
    verdicts.push(`🔥 Офіційна статистика Розетки: ${realSalesCount} покупців придбали цей товар повторно!`);
  }

  const rating = productItem?.rating || 0;
  const reviews = productItem?.reviews || 0;
  const inStock = productItem?.inStock !== false;
  const seller = productItem?.seller || 'Rozetka';

  // Оцінка рейтингу
  if (rating > 0 && rating < 4.0) {
    status = 'warning';
    verdicts.push(`Увага: низький рейтинг товару (${rating}/5.0). Покупці вказують на технічні недоліки.`);
  } else if (rating >= 4.5) {
    verdicts.push(`Високий рейтинг (${rating}/5.0) підтверджує якість пристрою.`);
  } else if (rating === 0) {
    status = 'suspicious';
    verdicts.push(`Товар не має оцінок та відгуків покупців.`);
  }

  // Оцінка попиту (кількість відгуків)
  if (reviews > 50) {
    verdicts.push(`Підтверджений попит: більше 50 відгуків.`);
  } else if (reviews > 0 && reviews <= 10) {
    verdicts.push(`Слабкий інтерес покупців: менше 10 відгуків.`);
  }

  // Оцінка домінування Rozetka
  if (seller.toLowerCase() === 'rozetka') {
    if (status === 'ok') {
      status = 'warning';
    }
    verdicts.push(`Продавець — сама Rozetka. Конкурувати за позиції в топі буде складно.`);
  } else {
    verdicts.push(`Продається стороннім продавцем (${seller}), що полегшує вихід на ринок.`);
  }

  // Перевірка невідповідності характеристик назві
  const nameCapacityMatch = name.match(/(\d{3,6})\s*(?:mah|маг|мАг)/i);
  if (nameCapacityMatch && capacityMatch) {
    const nameCap = parseInt(nameCapacityMatch[1]);
    const bodyCap = parseInt(capacityMatch[1]);
    if (Math.abs(nameCap - bodyCap) > 1000) {
      status = 'suspicious';
      verdicts.push(`Критична невідповідність! У назві вказано ${nameCap} mAh, але характеристики сторінки зазначають ${bodyCap} mAh.`);
    }
  }

  if (!inStock) {
    verdicts.push(`Немає в наявності.`);
  }

  const verdict = verdicts.join(' ') || 'Характеристики відповідають опису. Товар стабільний.';

  return { status, verdict, specs, realSalesCount };
}

app.post('/api/products/analyze', async (req, res) => {
  const { link, name, useAi, database } = req.body;
  if (!link) {
    return res.status(400).json({ success: false, error: 'Product link is required' });
  }

  const dbName = database || getActiveDbName();
  const products = loadProductsOfActiveDb(dbName);
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
        saveProductsOfActiveDb(products, dbName);
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
    saveProductsOfActiveDb(products, dbName);
  }

  return res.json({
    success: true,
    status: auditResult.status,
    verdict: auditResult.verdict,
    specs: auditResult.specs,
    realSalesCount: auditResult.realSalesCount
  });
});

let angularApp: any = null;
const isVercel = process.env['VERCEL'] === '1';

if (!isVercel) {
  angularApp = new AngularNodeAppEngine();

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
}

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
  if (isVercel) {
    return next();
  }
  angularApp
    .handle(req)
    .then((response: any) =>
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

