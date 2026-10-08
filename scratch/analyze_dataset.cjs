const fetch = globalThis.fetch;

async function run() {
  const res = await fetch('https://rozetka-scraper-extension-builder.onrender.com/api/products');
  const data = await res.json();
  const prods = data.products || [];
  
  console.log('Total Products:', prods.length);
  
  // Sorted by reviews
  const byReviews = [...prods].sort((a, b) => (Number(b.reviews) || 0) - (Number(a.reviews) || 0));
  console.log('\n--- ТОП-5 ТОВАРІВ ЗА ПОПИТОМ (ВІДГУКАМИ) ---');
  byReviews.slice(0, 5).forEach((p, idx) => {
    console.log(`${idx + 1}. [${p.reviews} відгуків | Оцінка: ${p.rating || '—'}] ${p.name.slice(0, 65)}... | Ціна: ${p.price} ₴ | Наявність: ${p.inStock !== false ? 'В наявності' : 'Немає'}`);
  });

  // Price segments
  const budget = prods.filter(p => p.price < 1500);
  const mid = prods.filter(p => p.price >= 1500 && p.price <= 4000);
  const premium = prods.filter(p => p.price > 4000);

  console.log('\n--- ЦІНОВІ СЕГМЕНТИ ---');
  console.log(`1. Бюджетний (< 1 500 ₴): ${budget.length} SKU (${((budget.length / prods.length) * 100).toFixed(1)}%) | Відгуків: ${budget.reduce((a,b)=>a+(Number(b.reviews)||0),0)}`);
  console.log(`2. Середній (1 500 - 4 000 ₴): ${mid.length} SKU (${((mid.length / prods.length) * 100).toFixed(1)}%) | Відгуків: ${mid.reduce((a,b)=>a+(Number(b.reviews)||0),0)}`);
  console.log(`3. Преміум (> 4 000 ₴): ${premium.length} SKU (${((premium.length / prods.length) * 100).toFixed(1)}%) | Відгуків: ${premium.reduce((a,b)=>a+(Number(b.reviews)||0),0)}`);

  // Weighted Demand Price
  const totalRev = prods.reduce((a,b) => a + (Number(b.reviews) || 0), 0);
  const weightedPrice = totalRev > 0 ? Math.round(prods.reduce((a,b) => a + (Number(b.price) || 0) * (Number(b.reviews) || 0), 0) / totalRev) : 0;
  console.log('\nЗважена ціна попиту (Weighted Price by Reviews):', weightedPrice, '₴');
}

run();
