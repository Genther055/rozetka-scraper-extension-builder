import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_KbeUo8CqvT3Q@ep-quiet-firefly-b2wqehc5-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const snapRes = await pool.query('SELECT id, title, item_count, products FROM history_snapshots ORDER BY created_at DESC LIMIT 20');
  console.log('--- FOUND SNAPSHOTS ---');
  snapRes.rows.forEach((s, idx) => console.log(`[${idx+1}] ${s.title} (${s.item_count} items)`));

  const seen = new Set();
  const foreignItems = [];

  for (const row of snapRes.rows) {
    const prods = row.products || [];
    prods.forEach(p => {
      const b = (p.detailedSpecsMap && p.detailedSpecsMap['Бренд']) || p.brand || '';
      const name = p.name || '';
      if (b && !['Xiaomi', 'Mi Power', 'Redmi', 'Poco', '70mai', 'ZMI', 'Cuktech', 'Ugreen'].includes(b)) {
        if (!seen.has(name)) {
          seen.add(name);
          foreignItems.push({ name, brand: b, seller: p.seller, price: p.price, link: p.link });
        }
      }
    });
  }

  console.log(`\n=== ВИЯВЛЕНІ СТОРОННІ ТОВАРИ У ВИДАЧІ (${foreignItems.length} шт.) ===`);
  foreignItems.forEach((item, i) => {
    console.log(`${i+1}. [Тег бренду: ${item.brand}] ${item.name} | Ціна: ${item.price} ₴ | Магазин: ${item.seller}`);
  });

  await pool.end();
}

run().catch(console.error);
