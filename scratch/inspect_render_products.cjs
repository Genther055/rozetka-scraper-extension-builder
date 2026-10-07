const https = require('https');

https.get('https://rozetka-scraper-extension-builder.onrender.com/api/products', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      const prods = json.products || [];
      console.log('Total prods on server:', prods.length);
      console.log('Sample 5 items:');
      prods.slice(0, 5).forEach((p, i) => {
        console.log(`${i + 1}. [${p.seller}] ${p.name} -> ${p.link}`);
      });
      
      const ids = prods.map(p => {
        const m = p.link.match(/\/p(\d+)/) || p.link.match(/\/(\d{5,})\//);
        return m ? m[1] : null;
      }).filter(Boolean);
      console.log(`Extracted ${ids.length} product IDs.`);
      
      // Check brands
      const brands = {};
      prods.forEach(p => {
        const b = p.detailedSpecsMap?.['Бренд'] || 'Unknown';
        brands[b] = (brands[b] || 0) + 1;
      });
      console.log('Brands breakdown:', brands);
    } catch (e) {
      console.error(e);
    }
  });
});
