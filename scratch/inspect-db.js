async function main() {
  const res = await fetch('https://rozetka-scraper-extension-builder.onrender.com/api/products');
  const d = await res.json();
  const list = d.products || [];
  console.log('Total products:', list.length);
  
  const sellers = {};
  list.forEach((p, idx) => {
    sellers[p.seller] = (sellers[p.seller] || 0) + 1;
    if (idx < 25 || idx > 165 || p.seller !== 'Rozetka') {
      console.log(`${idx+1}. [${p.seller}] ${p.name.slice(0, 60)} | ${p.link}`);
    }
  });
  console.log('\nSeller Summary:', sellers);
}

main().catch(console.error);
