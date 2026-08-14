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

const browserDistFolder = join(import.meta.dirname, '../browser');
const dataDir = join(import.meta.dirname, '../data');
const dataFilePath = join(dataDir, 'products.json');

// Ensure data folder exists
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Load initial products
let products: any[] = [];
if (existsSync(dataFilePath)) {
  try {
    const raw = readFileSync(dataFilePath, 'utf-8');
    products = JSON.parse(raw);
  } catch (e) {
    console.error('Error loading products.json:', e);
  }
}

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

app.post('/api/products', (req, res) => {
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
  
  newItems.forEach((item: any) => {
    if (!item || typeof item !== 'object') return;
    try {
      const normalizedLink = item.link ? item.link.split('?')[0].split('#')[0] : '';
      item.link = normalizedLink;
      
      const itemPrice = typeof item.price === 'number' ? item.price : parseFloat(item.price) || 0;
      const itemReviews = typeof item.reviews === 'number' ? item.reviews : parseInt(item.reviews) || 0;
      const itemRating = typeof item.rating === 'number' ? item.rating : parseFloat(item.rating) || 5.0;

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
          rating: itemRating,
          reviews: itemReviews,
          inStock: item.inStock !== false,
          category: item.category || 'Загальна',
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
          products[index].reviews = itemReviews;
          products[index].rating = itemRating;
          products[index].name = item.name || products[index].name;
          products[index].inStock = item.inStock !== false;
          if (item.category) products[index].category = item.category;
          if (item.specs) products[index].specs = item.specs;
          if (item.description) products[index].description = item.description;
          if (item.detailedSpecsMap) products[index].detailedSpecsMap = item.detailedSpecsMap;
          if (item.seller) products[index].seller = item.seller;
          if (item.sellersCount) products[index].sellersCount = item.sellersCount;
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
    writeFileSync(dataFilePath, JSON.stringify(products, null, 2), 'utf-8');
    res.json({ success: true, count: products.length, categoryCount: categoryCount });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/products', (req, res) => {
  res.json({ success: true, products });
});

app.post('/api/products/clear', (req, res) => {
  products = [];
  try {
    writeFileSync(dataFilePath, JSON.stringify(products, null, 2), 'utf-8');
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
  const { link, name, useAi } = req.body;
  if (!link) {
    return res.status(400).json({ success: false, error: 'Product link is required' });
  }

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
        writeFileSync(dataFilePath, JSON.stringify(products, null, 2), 'utf-8');
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
    writeFileSync(dataFilePath, JSON.stringify(products, null, 2), 'utf-8');
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
