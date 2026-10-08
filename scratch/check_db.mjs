import pg from 'pg';
const { Pool } = pg;

const DEFAULT_DATABASE_URL = 'postgresql://neondb_owner:npg_KbeUo8CqvT3Q@ep-quiet-firefly-b2wqehc5-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const connectionString = process.env['DATABASE_URL'] || DEFAULT_DATABASE_URL;

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function check() {
  const res = await pool.query('SELECT data FROM current_products WHERE id = 1');
  if (res.rows.length > 0) {
    const prods = res.rows[0].data;
    console.log('Total in DB:', prods.length);
    const brands = {};
    const foreignItems = [];
    prods.forEach(p => {
      const b = p.detailedSpecsMap?.['Бренд'] || (p.specs && p.specs.match(/Бренд:\s*([^;]+)/)?.[1]) || 'Unknown';
      brands[b] = (brands[b] || 0) + 1;
      if (b !== 'Anker' && b !== 'Ugreen') {
        foreignItems.push({ name: p.name, price: p.price, brand: b, seller: p.seller });
      }
    });
    console.log('Brand breakdown:', brands);
    console.log('Foreign items count:', foreignItems.length);
    console.log('Sample foreign items:', JSON.stringify(foreignItems.slice(0, 5), null, 2));
  } else {
    console.log('No rows found');
  }
  await pool.end();
}

check().catch(console.error);
