import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_KbeUo8CqvT3Q@ep-quiet-firefly-b2wqehc5-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const dataRes = await pool.query('SELECT data FROM current_products WHERE id = 1');
  const prods = dataRes.rows[0]?.data || [];

  console.log('--- DATABASE VERIFICATION ---');
  console.log('Total products currently in DB:', prods.length);

  const brandCounts = {};
  const inStockCounts = { inStock: 0, outOfStock: 0 };
  const priceStats = { min: 999999, max: 0, sum: 0 };
  const sellers = new Set();

  prods.forEach(p => {
    const b = (p.detailedSpecsMap && p.detailedSpecsMap['Бренд']) || 'Unknown';
    brandCounts[b] = (brandCounts[b] || 0) + 1;
    if (p.inStock) inStockCounts.inStock++; else inStockCounts.outOfStock++;
    const pr = Number(p.price) || 0;
    if (pr > 0) {
      if (pr < priceStats.min) priceStats.min = pr;
      if (pr > priceStats.max) priceStats.max = pr;
      priceStats.sum += pr;
    }
    if (p.seller) sellers.add(p.seller);
  });

  console.log('Brands breakdown in DB:', brandCounts);
  console.log('In-stock vs Out-of-stock:', inStockCounts);
  console.log('Price stats:', { min: priceStats.min, max: priceStats.max, avg: Math.round(priceStats.sum / (prods.length || 1)) });
  console.log('Total unique sellers:', sellers.size);
  
  console.log('\n--- SAMPLE 10 PRODUCTS IN DB ---');
  prods.slice(0, 10).forEach((p, i) => {
    console.log(`${i+1}. [${p.detailedSpecsMap?.['Бренд'] || 'No brand'}] ${p.name.slice(0, 60)} | ${p.price} ₴ | ${p.seller} | ${p.inStock ? 'В наявності' : 'Немає'}`);
  });

  await pool.end();
}

run().catch(console.error);
