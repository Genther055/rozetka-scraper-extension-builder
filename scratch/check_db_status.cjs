const { Pool } = require('pg');

const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_KbeUo8CqvT3Q@ep-quiet-firefly-b2wqehc5-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require',
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    const res = await pool.query('SELECT jsonb_array_length(data) as count FROM current_products WHERE id = 1');
    const total = res.rows[0]?.count || 0;
    console.log('Total products in current_products JSONB:', total);

    const sellersRes = await pool.query(`
      SELECT elem->>'seller' as seller, COUNT(*) as count 
      FROM current_products, jsonb_array_elements(data) as elem
      WHERE id = 1
      GROUP BY elem->>'seller'
      ORDER BY count DESC 
      LIMIT 15
    `);
    console.log('Top Sellers:');
    console.table(sellersRes.rows);

    const catsRes = await pool.query(`
      SELECT elem->>'category' as category, COUNT(*) as count 
      FROM current_products, jsonb_array_elements(data) as elem
      WHERE id = 1
      GROUP BY elem->>'category'
      ORDER BY count DESC 
      LIMIT 10
    `);
    console.log('Categories:');
    console.table(catsRes.rows);

    const brandsRes = await pool.query(`
      SELECT elem->'detailedSpecsMap'->>'Бренд' as brand, COUNT(*) as count 
      FROM current_products, jsonb_array_elements(data) as elem
      WHERE id = 1
      GROUP BY elem->'detailedSpecsMap'->>'Бренд'
      ORDER BY count DESC 
      LIMIT 10
    `);
    console.log('Brands:');
    console.table(brandsRes.rows);
  } catch (err) {
    console.error('DB Error:', err);
  } finally {
    await pool.end();
  }
}

main();
