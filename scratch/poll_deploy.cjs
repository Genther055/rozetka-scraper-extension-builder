const fetch = globalThis.fetch;

async function poll() {
  console.log('Starting polling loop...');
  for (let i = 1; i <= 30; i++) {
    try {
      const res = await fetch('https://rozetka-scraper-extension-builder.onrender.com/api/version');
      const text = await res.text();
      if (res.ok && text.startsWith('{')) {
        const json = JSON.parse(text);
        console.log(`\n🎉 [Attempt ${i}] NEW DEPLOYMENT LIVE:`, json);
        
        // Trigger seller enrichment
        const enrichRes = await fetch('https://rozetka-scraper-extension-builder.onrender.com/api/enrich-sellers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const enrichJson = await enrichRes.json();
        console.log('🎉 Retroactive Seller Enrichment Result:', enrichJson);
        process.exit(0);
      } else {
        process.stdout.write(`[${i}] Server still building/restarting (${res.status})...\r`);
      }
    } catch (e) {
      process.stdout.write(`[${i}] Waiting for connection...\r`);
    }
    await new Promise(r => setTimeout(r, 8000));
  }
  console.log('\nPolling completed.');
}

poll();
