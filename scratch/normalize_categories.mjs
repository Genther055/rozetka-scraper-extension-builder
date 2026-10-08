import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_KbeUo8CqvT3Q@ep-quiet-firefly-b2wqehc5-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function run() {
  const dataRes = await pool.query('SELECT data FROM current_products WHERE id = 1');
  const prods = dataRes.rows[0]?.data || [];

  let count = 0;
  for (const p of prods) {
    if (p.category === 'Повербанки' || p.category === 'Універсальні мобільні батареї' || p.category === 'Павербанки') {
      p.category = 'Повербанки та УМБ';
      count++;
    }
    if (p.sessionTitle === 'Повербанки Xiaomi' || p.sessionTitle === 'Універсальні мобільні батареї Xiaomi') {
      p.sessionTitle = 'Повербанки та УМБ Xiaomi';
    }
  }

  await pool.query('UPDATE current_products SET data = $1::jsonb, updated_at = NOW() WHERE id = 1', [JSON.stringify(prods)]);
  console.log(`Updated ${count} products in Neon DB. Total products: ${prods.length}`);

  const checkRes = await pool.query('SELECT data FROM current_products WHERE id = 1');
  const checkProds = checkRes.rows[0]?.data || [];
  const cats = new Map();
  checkProds.forEach(p => cats.set(p.category, (cats.get(p.category) || 0) + 1));
  console.log('Categories now in DB:', Object.fromEntries(cats));

  await pool.end();
}

run().catch(console.error);
