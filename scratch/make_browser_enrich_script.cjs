const fs = require('fs');

const ids = JSON.parse(fs.readFileSync('scratch/all_343_ids.json', 'utf8'));

const browserScript = `
(async function enrichCurrent343Products() {
  console.log('🚀 TradeScout Seller Discovery Script Started...');
  const ids = ${JSON.stringify(ids)};
  const serverUrl = 'https://rozetka-scraper-extension-builder.onrender.com/api/products';
  
  // 1. Fetch current products from server
  const getRes = await fetch(serverUrl);
  const getData = await getRes.json();
  const products = getData.products || [];
  console.log('📦 Loaded ' + products.length + ' products from database.');
  
  const idToProduct = new Map();
  products.forEach(p => {
    const m = (p.link || '').match(/\\/p(\\d+)/) || (p.link || '').match(/p-(\\d+)/);
    if (m && m[1]) idToProduct.set(m[1], p);
  });
  
  // 2. Fetch true seller details in chunks of 50 via Rozetka Common API
  const sellerCounts = {};
  let enrichedCount = 0;
  
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const apiUrl = 'https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=' + chunk.join(',');
    try {
      const res = await fetch(apiUrl);
      if (res.ok) {
        const json = await res.json();
        if (Array.isArray(json?.data)) {
          for (const item of json.data) {
            if (item && item.id) {
              const target = idToProduct.get(String(item.id));
              if (target) {
                const sTitle = item.seller?.title || item.seller?.name || item.seller_title;
                const finalSeller = (sTitle && sTitle.trim() && sTitle.toLowerCase() !== 'rozetka') 
                  ? sTitle.trim() 
                  : (item.seller?.id === 5 ? 'Rozetka' : (sTitle || 'Rozetka'));
                
                target.seller = finalSeller;
                if (typeof item.sellers_count === 'number' && item.sellers_count > 0) {
                  target.sellersCount = item.sellers_count;
                }
                sellerCounts[finalSeller] = (sellerCounts[finalSeller] || 0) + 1;
                enrichedCount++;
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('Error on chunk:', e);
    }
    console.log('Progress: ' + Math.min(ids.length, i + 50) + '/' + ids.length + ' products processed...');
  }
  
  console.log('✅ Discovery complete! Found sellers breakdown:', sellerCounts);
  
  // 3. Save enriched products back to Neon DB
  console.log('💾 Saving enriched dataset to database...');
  const postRes = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      products: products,
      clearBefore: true
    })
  });
  
  const postData = await postRes.json();
  console.log('🎉 SAVED TO NEON DB SUCCESSFULLY!', postData);
  alert('🎉 Успішно! Знайдено ' + Object.keys(sellerCounts).length + ' магазинів. Дані оновлено в базі. Тепер натисніть «Оновити» на дашборді!');
})();
`;

fs.writeFileSync('scratch/browser_enrich_script.js', browserScript.trim());
console.log('Script written to scratch/browser_enrich_script.js. Length:', browserScript.length);
