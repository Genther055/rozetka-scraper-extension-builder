import express from 'express';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const dataDir = join(process.cwd(), 'data');
const dataFilePath = join(dataDir, 'products.json');

if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

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
        if (existsSync(dataFilePath)) {
          const raw = readFileSync(dataFilePath, 'utf-8');
          const currentProducts = JSON.parse(raw);
          const index = currentProducts.findIndex((p: any) => p && p.link === normalizedLink);
          if (index !== -1) {
            currentProducts[index].seller = cleanedSeller;
            writeFileSync(dataFilePath, JSON.stringify(currentProducts, null, 2), 'utf-8');
            console.log(`[Backend Enriched] Successfully updated seller for ${normalizedLink} -> ${cleanedSeller}`);
            
            // Also update the in-memory array in api-server.ts
            const memoryIndex = products.findIndex((p: any) => p && p.link === normalizedLink);
            if (memoryIndex !== -1) {
              products[memoryIndex].seller = cleanedSeller;
            }
          }
        }
      }
    }
  } catch (error: any) {
    console.error(`[Backend Enrichment Error] Failed to resolve seller for ${productId}:`, error.message);
  }
}

// Ingestion Endpoint (supports /api/products, /dashboard, /products)
app.post(['/api/products', '/dashboard', '/api/dashboard', '/products'], (req, res) => {
  console.log(`[API PORT 4000] Received POST request from n8n. Raw body keys:`, Object.keys(req.body || {}));
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
  console.log(`[API PORT 4000] Received batch of ${newItems.length} items. Current total in products.json: ${products.length}`);

  const getItemKey = (p: any) => {
    const pLink = p.link ? p.link.split('?')[0].split('#')[0] : '';
    const pSeller = (p.seller || 'rozetka').trim().toLowerCase();
    const pName = (p.name || '').trim().toLowerCase();
    return pLink ? `${pLink}::${pSeller}` : `${pName}::${pSeller}`;
  };

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
          if (item.category) products[index].category = item.category;
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
              resolveSellerInServerBackground(productId, normalizedLink);
            }
          }
        }
      }
    } catch (e) {
      console.error('Error processing scraped product item inside api-server:', e, item);
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

// Retrieval Endpoint
app.get(['/api/products', '/dashboard'], (req, res) => {
  if (existsSync(dataFilePath)) {
    try {
      const raw = readFileSync(dataFilePath, 'utf-8');
      products = JSON.parse(raw);
    } catch (e) {}
  }
  res.json({ success: true, products });
});

// Clear Endpoint
app.post('/api/products/clear', (req, res) => {
  products = [];
  try {
    writeFileSync(dataFilePath, JSON.stringify(products, null, 2), 'utf-8');
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

const PORT = process.env['PORT'] || 4000;
app.listen(PORT, () => {
  console.log(`🚀 TradeScout Pure Express API Server listening on port ${PORT} (IPv4 & IPv6)`);
});
