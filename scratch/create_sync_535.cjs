const https = require('https');
const fs = require('fs');

https.get('https://rozetka-scraper-extension-builder.onrender.com/api/products', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      const prods = json.products || [];
      const ids = prods.map(p => {
        const m = p.link.match(/\/p(\d+)/) || p.link.match(/\/(\d{5,})\//);
        return m ? m[1] : null;
      }).filter(Boolean);

      console.log(`Extracted ${ids.length} product IDs for 535 products.`);
      
      const snippet = `(async function() {
  const ids = ${JSON.stringify(ids)};
  console.log("Отримую продавців для " + ids.length + " товарів через Rozetka API...");
  const sellerMap = {};
  
  for (let i = 0; i < ids.length; i += 60) {
    const chunk = ids.slice(i, i + 60);
    try {
      const res = await fetch("https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=" + chunk.join(","));
      const data = await res.json();
      if (Array.isArray(data.data)) {
        for (const item of data.data) {
          const sTitle = item?.seller?.title || item?.seller?.name || item?.seller_title || (item?.seller?.id === 5 ? "Rozetka" : "Rozetka");
          sellerMap[item.id] = sTitle;
        }
      }
    } catch(e) { console.error("Помилка на пачці " + i, e); }
  }
  
  console.log("Отримано продавців:", Object.keys(sellerMap).length);
  const out = JSON.stringify(sellerMap);
  console.log("===РЕЗУЛЬТАТ===");
  console.log(out);
  try { await navigator.clipboard.writeText(out); console.log("СКОПІЙОВАНО В БУФЕР ОБМІНУ!"); } catch(e) {}
})();`;

      fs.writeFileSync('scratch/console_sync_535.js', snippet, 'utf-8');
      console.log('Saved snippet to scratch/console_sync_535.js');
    } catch (e) {
      console.error(e);
    }
  });
});
