import pg from 'pg';
const { Pool } = pg;
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ScrapingFolder {
  id: string;
  name: string;
  icon?: string;
  color?: string;
  createdAt: string;
}

export interface ScrapingSnapshot {
  id: string;
  title: string;
  folderId: string | null;
  scrapedAt: string;
  itemCount: number;
  category: string;
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
  sellersCount: number;
  products: any[];
}

const DEFAULT_DATABASE_URL = 'postgresql://neondb_owner:npg_KbeUo8CqvT3Q@ep-quiet-firefly-b2wqehc5-pooler.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require';
const connectionString = process.env['DATABASE_URL'] || DEFAULT_DATABASE_URL;

// Local fallback paths
const dataDir = existsSync(join(process.cwd(), 'data')) 
  ? join(process.cwd(), 'data') 
  : join(import.meta.dirname, '../data');
const dataFilePath = join(dataDir, 'products.json');
const historyFilePath = join(dataDir, 'history.json');
const foldersFilePath = join(dataDir, 'folders.json');

if (!existsSync(dataDir)) {
  try { mkdirSync(dataDir, { recursive: true }); } catch (_) {}
}

let pool: pg.Pool | null = null;
let isDbAvailable = false;

try {
  pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000
  });
} catch (err) {
  console.error('[Neon DB] Pool creation failed, using file fallback:', err);
}

export async function initDb(): Promise<void> {
  if (!pool) return;
  try {
    const client = await pool.connect();
    try {
      // 1. Create tables
      await client.query(`
        CREATE TABLE IF NOT EXISTS current_products (
          id INT PRIMARY KEY DEFAULT 1,
          data JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS history_snapshots (
          id VARCHAR(255) PRIMARY KEY,
          folder_id VARCHAR(255),
          title TEXT NOT NULL,
          category TEXT,
          item_count INT DEFAULT 0,
          avg_price NUMERIC DEFAULT 0,
          min_price NUMERIC DEFAULT 0,
          max_price NUMERIC DEFAULT 0,
          sellers_count INT DEFAULT 1,
          scraped_at TIMESTAMP,
          products JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS folders (
          id VARCHAR(255) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          icon VARCHAR(50),
          color VARCHAR(50),
          created_at TIMESTAMP DEFAULT NOW()
        );
      `);

      isDbAvailable = true;
      console.log('[Neon DB] PostgreSQL connected and tables initialized successfully.');

      // 2. Initial migration from local JSON files if DB is empty
      await autoMigrateLocalData(client);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[Neon DB] Initialization error, falling back to local file storage:', err);
    isDbAvailable = false;
  }
}

async function autoMigrateLocalData(client: pg.PoolClient) {
  try {
    // Check current_products
    const prodRes = await client.query('SELECT data FROM current_products WHERE id = 1');
    if (prodRes.rowCount === 0) {
      let localProds: any[] = [];
      if (existsSync(dataFilePath)) {
        try {
          const raw = readFileSync(dataFilePath, 'utf-8').replace(/^\uFEFF/, '').trim();
          if (raw) localProds = JSON.parse(raw);
        } catch (_) {}
      }
      await client.query(
        'INSERT INTO current_products (id, data, updated_at) VALUES (1, $1, NOW()) ON CONFLICT (id) DO NOTHING',
        [JSON.stringify(localProds)]
      );
    }

    // Check folders
    const foldersRes = await client.query('SELECT COUNT(*) FROM folders');
    if (parseInt(foldersRes.rows[0].count, 10) === 0 && existsSync(foldersFilePath)) {
      try {
        const raw = readFileSync(foldersFilePath, 'utf-8').replace(/^\uFEFF/, '').trim();
        if (raw) {
          const localFolders: ScrapingFolder[] = JSON.parse(raw);
          for (const f of localFolders) {
            await client.query(
              'INSERT INTO folders (id, name, icon, color, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING',
              [f.id, f.name, f.icon || 'folder', f.color || '#6366f1', f.createdAt || new Date().toISOString()]
            );
          }
        }
      } catch (_) {}
    }

    // Check history
    const histRes = await client.query('SELECT COUNT(*) FROM history_snapshots');
    if (parseInt(histRes.rows[0].count, 10) === 0 && existsSync(historyFilePath)) {
      try {
        const raw = readFileSync(historyFilePath, 'utf-8').replace(/^\uFEFF/, '').trim();
        if (raw) {
          const localHistory: ScrapingSnapshot[] = JSON.parse(raw);
          for (const h of localHistory) {
            await client.query(`
              INSERT INTO history_snapshots (
                id, folder_id, title, category, item_count, avg_price, min_price, max_price, sellers_count, scraped_at, products, created_at
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW()) ON CONFLICT (id) DO NOTHING
            `, [
              h.id, h.folderId, h.title, h.category || '', h.itemCount || 0,
              h.avgPrice || 0, h.minPrice || 0, h.maxPrice || 0, h.sellersCount || 1,
              h.scrapedAt ? new Date(h.scrapedAt) : new Date(), JSON.stringify(h.products || [])
            ]);
          }
        }
      } catch (_) {}
    }
  } catch (err) {
    console.warn('[Neon DB] Auto-migration skipped:', err);
  }
}

// --- Current Products CRUD ---
export async function getCurrentProducts(): Promise<any[]> {
  if (pool && isDbAvailable) {
    try {
      const res = await pool.query('SELECT data FROM current_products WHERE id = 1');
      if (res.rows.length > 0 && res.rows[0].data) {
        return res.rows[0].data;
      }
      return [];
    } catch (err) {
      console.error('[Neon DB] Error reading products:', err);
    }
  }

  // Fallback
  if (existsSync(dataFilePath)) {
    try {
      const raw = readFileSync(dataFilePath, 'utf-8').replace(/^\uFEFF/, '').trim();
      return raw ? JSON.parse(raw) : [];
    } catch (_) {}
  }
  return [];
}

export async function saveCurrentProducts(products: any[]): Promise<void> {
  const safeProducts = Array.isArray(products) ? products : [];
  
  // Save to DB
  if (pool && isDbAvailable) {
    try {
      await pool.query(`
        INSERT INTO current_products (id, data, updated_at)
        VALUES (1, $1, NOW())
        ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()
      `, [JSON.stringify(safeProducts)]);
    } catch (err) {
      console.error('[Neon DB] Error saving products:', err);
    }
  }

  // Also sync to local file for offline resilience
  try {
    writeFileSync(dataFilePath, JSON.stringify(safeProducts, null, 2), 'utf-8');
  } catch (_) {}
}

export async function clearCurrentProducts(): Promise<void> {
  await saveCurrentProducts([]);
}

// --- History CRUD ---
export async function getHistory(): Promise<ScrapingSnapshot[]> {
  if (pool && isDbAvailable) {
    try {
      const res = await pool.query(`
        SELECT 
          id, folder_id AS "folderId", title, category,
          item_count AS "itemCount", avg_price AS "avgPrice",
          min_price AS "minPrice", max_price AS "maxPrice",
          sellers_count AS "sellersCount", scraped_at AS "scrapedAt",
          products
        FROM history_snapshots
        ORDER BY scraped_at DESC
      `);
      return res.rows.map(r => ({
        ...r,
        itemCount: Number(r.itemCount) || 0,
        avgPrice: Number(r.avgPrice) || 0,
        minPrice: Number(r.minPrice) || 0,
        maxPrice: Number(r.maxPrice) || 0,
        sellersCount: Number(r.sellersCount) || 1,
        scrapedAt: r.scrapedAt ? new Date(r.scrapedAt).toISOString() : new Date().toISOString(),
        products: r.products || []
      }));
    } catch (err) {
      console.error('[Neon DB] Error reading history:', err);
    }
  }

  // Fallback
  if (existsSync(historyFilePath)) {
    try {
      const raw = readFileSync(historyFilePath, 'utf-8').replace(/^\uFEFF/, '').trim();
      return raw ? JSON.parse(raw) : [];
    } catch (_) {}
  }
  return [];
}

export async function saveHistorySnapshot(snapshot: ScrapingSnapshot): Promise<void> {
  if (pool && isDbAvailable) {
    try {
      await pool.query(`
        INSERT INTO history_snapshots (
          id, folder_id, title, category, item_count, avg_price, min_price, max_price, sellers_count, scraped_at, products, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
        ON CONFLICT (id) DO UPDATE SET
          folder_id = $2, title = $3, category = $4, item_count = $5,
          avg_price = $6, min_price = $7, max_price = $8, sellers_count = $9,
          scraped_at = $10, products = $11
      `, [
        snapshot.id, snapshot.folderId || null, snapshot.title, snapshot.category || '',
        snapshot.itemCount || 0, snapshot.avgPrice || 0, snapshot.minPrice || 0,
        snapshot.maxPrice || 0, snapshot.sellersCount || 1,
        snapshot.scrapedAt ? new Date(snapshot.scrapedAt) : new Date(),
        JSON.stringify(snapshot.products || [])
      ]);
    } catch (err) {
      console.error('[Neon DB] Error saving history snapshot:', err);
    }
  }

  // Sync to file
  try {
    const list = await getHistory();
    const existingIdx = list.findIndex(h => h.id === snapshot.id);
    if (existingIdx !== -1) list[existingIdx] = snapshot;
    else list.unshift(snapshot);
    writeFileSync(historyFilePath, JSON.stringify(list, null, 2), 'utf-8');
  } catch (_) {}
}

export async function deleteHistorySnapshot(id: string): Promise<void> {
  if (pool && isDbAvailable) {
    try {
      await pool.query('DELETE FROM history_snapshots WHERE id = $1', [id]);
    } catch (err) {
      console.error('[Neon DB] Error deleting snapshot:', err);
    }
  }

  try {
    if (existsSync(historyFilePath)) {
      const raw = readFileSync(historyFilePath, 'utf-8').replace(/^\uFEFF/, '').trim();
      let list: ScrapingSnapshot[] = raw ? JSON.parse(raw) : [];
      list = list.filter(h => h.id !== id);
      writeFileSync(historyFilePath, JSON.stringify(list, null, 2), 'utf-8');
    }
  } catch (_) {}
}

export async function moveHistorySnapshot(id: string, folderId: string | null): Promise<void> {
  if (pool && isDbAvailable) {
    try {
      await pool.query('UPDATE history_snapshots SET folder_id = $1 WHERE id = $2', [folderId, id]);
    } catch (err) {
      console.error('[Neon DB] Error moving snapshot:', err);
    }
  }

  try {
    if (existsSync(historyFilePath)) {
      const raw = readFileSync(historyFilePath, 'utf-8').replace(/^\uFEFF/, '').trim();
      let list: ScrapingSnapshot[] = raw ? JSON.parse(raw) : [];
      const item = list.find(h => h.id === id);
      if (item) item.folderId = folderId;
      writeFileSync(historyFilePath, JSON.stringify(list, null, 2), 'utf-8');
    }
  } catch (_) {}
}

// --- Folders CRUD ---
export async function getFolders(): Promise<ScrapingFolder[]> {
  if (pool && isDbAvailable) {
    try {
      const res = await pool.query('SELECT id, name, icon, color, created_at AS "createdAt" FROM folders ORDER BY created_at ASC');
      return res.rows.map(r => ({
        ...r,
        createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString()
      }));
    } catch (err) {
      console.error('[Neon DB] Error reading folders:', err);
    }
  }

  // Fallback
  if (existsSync(foldersFilePath)) {
    try {
      const raw = readFileSync(foldersFilePath, 'utf-8').replace(/^\uFEFF/, '').trim();
      return raw ? JSON.parse(raw) : [];
    } catch (_) {}
  }
  return [];
}

export async function saveFolder(folder: ScrapingFolder): Promise<void> {
  if (pool && isDbAvailable) {
    try {
      await pool.query(`
        INSERT INTO folders (id, name, icon, color, created_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (id) DO UPDATE SET name = $2, icon = $3, color = $4
      `, [folder.id, folder.name, folder.icon || 'folder', folder.color || '#6366f1', folder.createdAt || new Date().toISOString()]);
    } catch (err) {
      console.error('[Neon DB] Error saving folder:', err);
    }
  }

  try {
    const list = await getFolders();
    const existingIdx = list.findIndex(f => f.id === folder.id);
    if (existingIdx !== -1) list[existingIdx] = folder;
    else list.push(folder);
    writeFileSync(foldersFilePath, JSON.stringify(list, null, 2), 'utf-8');
  } catch (_) {}
}

export async function deleteFolder(id: string): Promise<void> {
  if (pool && isDbAvailable) {
    try {
      await pool.query('UPDATE history_snapshots SET folder_id = NULL WHERE folder_id = $1', [id]);
      await pool.query('DELETE FROM folders WHERE id = $1', [id]);
    } catch (err) {
      console.error('[Neon DB] Error deleting folder:', err);
    }
  }

  try {
    if (existsSync(foldersFilePath)) {
      const raw = readFileSync(foldersFilePath, 'utf-8').replace(/^\uFEFF/, '').trim();
      let list: ScrapingFolder[] = raw ? JSON.parse(raw) : [];
      list = list.filter(f => f.id !== id);
      writeFileSync(foldersFilePath, JSON.stringify(list, null, 2), 'utf-8');
    }
  } catch (_) {}
}
