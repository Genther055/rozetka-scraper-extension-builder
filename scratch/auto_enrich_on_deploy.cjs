const fetch = globalThis.fetch;

async function autoEnrichWhenReady() {
  console.log('Listening for Render deploy completion...');
  for (let i = 1; i <= 60; i++) {
    try {
      const res = await fetch('https://rozetka-scraper-extension-builder.onrender.com/api/version');
      if (res.ok) {
        const text = await res.text();
        if (text.startsWith('{')) {
          const json = JSON.parse(text);
          console.log(`\n========================================`);
          console.log(`🚀 RENDER DEPLOYMENT ACTIVE: ${json.version} (${json.buildTimestamp})`);
          console.log(`Database Status: ${json.dbStatus} | Products in DB: ${json.totalProductsInDb}`);
          console.log(`========================================\n`);

          console.log('Executing automated seller enrichment for all existing catalog items...');
          const enrichRes = await fetch('https://rozetka-scraper-extension-builder.onrender.com/api/enrich-sellers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          if (enrichRes.ok) {
            const enrichJson = await enrichRes.json();
            console.log('✅ ENRICHMENT COMPLETE!');
            console.log(`Total Products: ${enrichJson.totalProducts}`);
            console.log(`Unique Sellers Discovered: ${enrichJson.uniqueSellers}`);
            console.log('Sellers Summary:', enrichJson.sellers);
          }
          process.exit(0);
        }
      }
    } catch (_) {}
    await new Promise(r => setTimeout(r, 10000));
  }
}

autoEnrichWhenReady();
