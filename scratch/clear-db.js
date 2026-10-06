async function clearDb() {
    try {
        const res = await fetch('https://rozetka-scraper-extension-builder.onrender.com/api/products/clear', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const json = await res.json().catch(() => ({}));
        console.log('Clear response:', res.status, json);
    } catch (e) {
        console.error('Clear error:', e);
    }
}
clearDb();
