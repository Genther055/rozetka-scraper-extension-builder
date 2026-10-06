function extractProductId(item, link) {
    if (item && typeof item === 'object') {
        const attrId = item.getAttribute ? (item.getAttribute('data-goods-id') || item.getAttribute('data-id') || item.getAttribute('goods-id') || item.getAttribute('data-product-id')) : null;
        if (attrId && /^\d+$/.test(attrId.trim())) return attrId.trim();
        
        if (item.id && /^\d+$/.test(item.id)) return item.id;
    }
    if (link) {
        const m = link.match(/\/p(\d+)/i) || link.match(/p(\d+)/i) || link.match(/\/(\d{5,})(?:\/|$|\?)/);
        if (m && m[1]) return m[1];
    }
    return '';
}

const testUrls = [
    "https://rozetka.com.ua/ua/459482989/p459482989/",
    "https://rozetka.com.ua/459482989/p459482989/",
    "https://rozetka.com.ua/ua/sigma-mobile-4827798987612/p611141153/",
    "https://rozetka.com.ua/p611141153/",
    "/ua/universalnye-mobilnye-batarei/c387969/p1234567/"
];

testUrls.forEach(u => {
    console.log(`URL "${u}" -> ID: "${extractProductId(null, u)}"`);
});
