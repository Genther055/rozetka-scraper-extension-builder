import pg from 'pg';
const { Pool } = pg;

const DEFAULT_DATABASE_URL = 'postgresql://neondb_owner:npg_KbeUo8CqvT3Q@ep-quiet-firefly-b2wqehc5-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const connectionString = process.env['DATABASE_URL'] || DEFAULT_DATABASE_URL;

const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function clean() {
  const res = await pool.query('SELECT data FROM current_products WHERE id = 1');
  if (res.rows.length > 0) {
    const prods = res.rows[0].data;
    console.log('Original count in DB:', prods.length);

    // Keep Ugreen and Xiaomi items
    const allowed = ['Ugreen', 'Xiaomi', 'Redmi', 'Poco', '70mai', 'ZMI', 'Cuktech'];
    const filtered = prods.filter(p => {
      const b = p.detailedSpecsMap?.['Бренд'] || (p.specs && p.specs.match(/Бренд:\s*([^;]+)/)?.[1]);
      return allowed.includes(b);
    });

    console.log('Filtered count:', filtered.length);
    const breakdown = {};
    filtered.forEach(p => {
      const b = p.detailedSpecsMap?.['Бренд'] || (p.specs && p.specs.match(/Бренд:\s*([^;]+)/)?.[1]) || 'Unknown';
      breakdown[b] = (breakdown[b] || 0) + 1;
    });
    console.log('New breakdown:', breakdown);

    await pool.query('UPDATE current_products SET data = $1, updated_at = NOW() WHERE id = 1', [JSON.stringify(filtered)]);
    console.log('Updated DB successfully!');
  }
  await pool.end();
}

clean().catch(console.error);
