async function inspectDb() {
    try {
        const res = await fetch('https://rozetka-scraper-extension-builder.onrender.com/api/products');
        const json = await res.json().catch(() => ({}));
        const products = json.products || [];
        console.log(`Total products in DB: ${products.length}`);
        
        // Group by seller
        const sellers = {};
        for (const p of products) {
            const s = p.seller || 'Unknown';
            sellers[s] = (sellers[s] || 0) + 1;
        }
        console.log('Sellers breakdown:', sellers);
        
        // Sample 10 items: name, seller, link
        console.log('Sample 10 items:');
        products.slice(0, 10).forEach(p => {
            console.log(`- "${p.name?.slice(0, 40)}" | Seller: "${p.seller}" | Link: ${p.link}`);
        });
    } catch (e) {
        console.error('Inspect error:', e);
    }
}
inspectDb();
