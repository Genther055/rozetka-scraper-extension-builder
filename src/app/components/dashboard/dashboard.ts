import {Component, OnInit, ChangeDetectorRef} from '@angular/core';
import {Router} from '@angular/router';
import {HttpClient} from '@angular/common/http';
import {FormsModule} from '@angular/forms';
import {CommonModule} from '@angular/common';
import * as ExcelJS from 'exceljs';

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
  products?: Product[];
}

interface Product {
  name: string;
  price: number;
  oldPrice?: number;
  discount?: number;
  rating: number;
  reviews: number;
  link: string;
  scrapedAt: string;
  aiStatus: 'pending' | 'ok' | 'warning' | 'suspicious';
  aiVerdict?: string;
  isAuditing?: boolean;
  inStock?: boolean;
  category?: string;
  specs?: string;
  description?: string;
  seller?: string;
  sellersCount?: number;
  priceChange?: number;
  reviewsGrowth?: number;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.html',
})
export class DashboardComponent implements OnInit {
  apiUrl: string = typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'http://localhost:4000'
    : 'https://rozetka-scraper-extension-builder.onrender.com';

  products: Product[] = [];
  filteredProducts: Product[] = [];
  
  // Navigation & Tabs
  activeTab: 'overview' | 'explorer' | 'demand' | 'tracker' | 'details' | 'history' = 'overview';

  // Filters
  searchQuery = '';
  minPrice = 0;
  maxPrice: number | null = null;
  minRating = 0;
  statusFilter = 'all';
  stockFilter = 'all';

  // History & Folders State
  folders: ScrapingFolder[] = [];
  snapshots: ScrapingSnapshot[] = [];
  selectedFolderId: string | null = 'all'; // 'all', 'unassigned', or folder.id
  searchHistoryQuery = '';
  autoSaveHistory = true;
  historyLoading = false;
  historySuccessMsg = '';
  historyErrorMsg = '';

  // Modal / Creation States
  showNewFolderModal = false;
  newFolderName = '';
  newFolderColor = '#6366f1';
  newFolderIcon = 'folder';

  showSaveSnapshotModal = false;
  newSnapshotTitle = '';
  newSnapshotFolderId: string | null = null;

  activeSnapshotDetails: ScrapingSnapshot | null = null;
  movingSnapshot: ScrapingSnapshot | null = null;

  // Collapsible Details State
  expandedDescMap: Record<string, boolean> = {};
  expandedSpecsMap: Record<string, boolean> = {};
  activeModalProduct: Product | null = null;

  openSpecsModal(product: Product) {
    this.activeModalProduct = product;
    this.cdr.markForCheck();
  }

  closeSpecsModal() {
    this.activeModalProduct = null;
    this.cdr.markForCheck();
  }

  toggleDesc(link: string) {
    this.expandedDescMap[link] = !this.expandedDescMap[link];
    this.cdr.markForCheck();
  }

  isDescExpanded(link: string): boolean {
    return !!this.expandedDescMap[link];
  }

  toggleSpecs(link: string) {
    this.expandedSpecsMap[link] = !this.expandedSpecsMap[link];
    this.cdr.markForCheck();
  }

  isSpecsExpanded(link: string): boolean {
    return !!this.expandedSpecsMap[link];
  }

  getBadgeSpecs(product: any): { text: string; style: string }[] {
    if (!product) return [];
    const badges: { text: string; style: string }[] = [];
    
    // Спершу витягуємо ключові характеристики зі структурованого об'єкта
    if (product.detailedSpecsMap && Object.keys(product.detailedSpecsMap).length > 0) {
      const map = product.detailedSpecsMap;
      
      const capacityKey = Object.keys(map).find(k => /ємність|capacity|mah|мАг/i.test(k));
      if (capacityKey) {
        const val = map[capacityKey];
        const match = val.match(/\d+[\d\s]*(?:mah|мАг)/i);
        const text = match ? match[0] : (val.length > 20 ? val.slice(0, 18) + '...' : val);
        badges.push({ text, style: 'bg-indigo-950/80 text-indigo-300 border-indigo-800/60' });
      }
      
      const powerKey = Object.keys(map).find(k => /потужність|power| W| Вт/i.test(k));
      if (powerKey) {
        const val = map[powerKey];
        const match = val.match(/\d+(?:\.\d+)?\s*(?:W|Вт)/i);
        const text = match ? match[0] : (val.length > 20 ? val.slice(0, 18) + '...' : val);
        badges.push({ text, style: 'bg-purple-950/80 text-purple-300 border-purple-800/60' });
      }
      
      const techKey = Object.keys(map).find(k => /magsafe|quickcharge|qc|pd|бездрот|ліхтарик/i.test(k));
      if (techKey) {
        const val = map[techKey];
        badges.push({ text: val.length > 20 ? val.slice(0, 18) + '...' : val, style: 'bg-emerald-950/80 text-emerald-300 border-emerald-800/60' });
      }
      
      if (badges.length < 3) {
        const keys = Object.keys(map).filter(k => k !== capacityKey && k !== powerKey && k !== techKey);
        for (const k of keys) {
          if (badges.length >= 3) break;
          const val = map[k];
          if (val) {
            const text = val.length > 20 ? val.slice(0, 18) + '...' : val;
            badges.push({ text, style: 'bg-slate-800/80 text-slate-300 border-slate-700/60' });
          }
        }
      }
      if (badges.length > 0) return badges;
    }

    // Резервний варіант (розбір рядка)
    const specsStr = product.specs;
    if (!specsStr) return [];
    const parts = specsStr.split(';').map((s: any) => s.trim()).filter(Boolean);

    const getPartVal = (str: string) => {
      const idx = str.indexOf(':');
      return idx !== -1 ? str.slice(idx + 1).trim() : str.trim();
    };

    for (const part of parts) {
      if (/mah|мАг/i.test(part)) {
        const match = part.match(/\d+[\d\s]*(?:mah|мАг)/i);
        const text = match ? match[0] : (part.length > 20 ? part.slice(0, 18) + '...' : part);
        badges.push({ text, style: 'bg-indigo-950/80 text-indigo-300 border-indigo-800/60' });
      } else if (/\d+\s*W|\b\d+\s*Вт\b/i.test(part)) {
        const match = part.match(/\d+(?:\.\d+)?\s*(?:W|Вт)/i);
        const text = match ? match[0] : (part.length > 20 ? part.slice(0, 18) + '...' : part);
        badges.push({ text, style: 'bg-purple-950/80 text-purple-300 border-purple-800/60' });
      } else if (/magsafe|quickcharge|qc|pd|бездрот|ліхтарик/i.test(part)) {
        const val = getPartVal(part);
        badges.push({ text: val.length > 20 ? val.slice(0, 18) + '...' : val, style: 'bg-emerald-950/80 text-emerald-300 border-emerald-800/60' });
      } else if (badges.length < 3) {
        const val = getPartVal(part);
        if (val.length > 0) {
          badges.push({ text: val.length > 20 ? val.slice(0, 18) + '...' : val, style: 'bg-slate-800/80 text-slate-300 border-slate-700/60' });
        }
      }
    }
    return badges;
  }

  normalizeSpecKey(key: string): string {
    const k = key.trim().toLowerCase();
    if (k.includes('ємність') || k.includes('емкость')) return 'Ємність батареї';
    if (k.includes('потужність') || k.includes('мощность')) return 'Потужність';
    if (k.includes('колір') || k.includes('цвет')) return 'Колір';
    if (k.includes('тип акум') || k.includes('тип батаре') || k.includes('тип акк')) return 'Тип батареї';
    if (k.includes('вхідні') || k.includes('входные') || k.includes('вхідний')) return 'Вхідні роз\'єми';
    if (k.includes('вихідні') || k.includes('выходные') || k.includes('вихідний')) return 'Вихідні роз\'єми';
    if (k.includes('вага') || k.includes('вес')) return 'Вага';
    if (k.includes('розмір') || k.includes('габарит') || k.includes('размер')) return 'Розміри';
    if (k.includes('функції заряд') || k.includes('функции заряд') || k.includes('швидка заряд')) return 'Швидка зарядка';
    return key.charAt(0).toUpperCase() + key.slice(1);
  }

  // Metrics
  totalItems = 0;
  avgPrice = 0;
  avgRating = 0.0;
  aiAlertsCount = 0;
  nicheOpportunityScore = 0; // Оцінка ніші від 1 до 10

  // Global loading states
  loading = false;

  // Demand Estimator Filters
  demandSearchQuery = '';
  demandMinPrice: number | null = null;
  demandMaxPrice: number | null = null;
  demandStockFilter = 'all';
  demandLevelFilter = 'all';
  demandSortColumn = 'reviews';
  demandSortDirection: 'asc' | 'desc' = 'desc';

  constructor(
    private router: Router, 
    private http: HttpClient,
    public cdr: ChangeDetectorRef
  ) {
    // Session Verification
    if (typeof window !== 'undefined' && localStorage.getItem('tradescout_auth') !== 'true') {
      this.router.navigate(['/login']);
    }
  }

  autoRefreshTimer: any;

  ngOnInit() {
    if (typeof window !== 'undefined') {
      const savedAuto = localStorage.getItem('tradescout_auto_save_history');
      if (savedAuto !== null) {
        this.autoSaveHistory = savedAuto === 'true';
      }

      this.loadProducts();
      this.loadFolders();
      this.loadHistory();

      this.autoRefreshTimer = setInterval(() => {
        this.loadProducts(true);
      }, 3000);
    }
  }

  ngOnDestroy() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
    }
  }

  loadProducts(silent = false) {
    if (!silent) this.loading = true;
    this.http.get<{ success: boolean, products: Product[] }>(`${this.apiUrl}/api/products`)
      .subscribe({
        next: (res) => {
          if (res.success) {
            this.products = res.products || [];
            this.applyFilters();
            this.calculateMetrics();
          }
          if (!silent) this.loading = false;
          this.cdr.markForCheck();
        },
        error: (err) => {
          console.error('Failed to load products:', err);
          if (!silent) this.loading = false;
          this.cdr.markForCheck();
        }
      });
  }

  getLastScrapedDate(): Date | null {
    if (!this.products || this.products.length === 0) return null;
    let maxTime = 0;
    for (const p of this.products) {
      if (p.scrapedAt) {
        const t = new Date(p.scrapedAt).getTime();
        if (!isNaN(t) && t > maxTime) {
          maxTime = t;
        }
      }
    }
    return maxTime > 0 ? new Date(maxTime) : null;
  }

  getLastScrapedText(): string {
    const d = this.getLastScrapedDate();
    if (!d) return 'дані ще не збиралися';

    return d.toLocaleString('uk-UA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  getLastScrapedRelative(): string | null {
    const d = this.getLastScrapedDate();
    if (!d) return null;

    const now = Date.now();
    const diffMs = now - d.getTime();
    if (diffMs < 0) return 'щойно';

    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHours = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSec < 60) return 'щойно';
    if (diffMin < 60) return `${diffMin} хв тому`;
    if (diffHours < 24) return `${diffHours} год тому`;
    if (diffDays === 1) return 'вчора';
    return `${diffDays} дн. тому`;
  }

  // --- History & Folders Methods ---

  loadFolders() {
    this.http.get<{ success: boolean, folders: ScrapingFolder[] }>(`${this.apiUrl}/api/folders`)
      .subscribe({
        next: (res) => {
          if (res.success) {
            this.folders = res.folders || [];
            this.cdr.markForCheck();
          }
        },
        error: (err) => console.error('Failed to load folders:', err)
      });
  }

  loadHistory() {
    this.historyLoading = true;
    this.http.get<{ success: boolean, history: ScrapingSnapshot[] }>(`${this.apiUrl}/api/history`)
      .subscribe({
        next: (res) => {
          this.historyLoading = false;
          if (res.success) {
            this.snapshots = res.history || [];
            this.cdr.markForCheck();
          }
        },
        error: (err) => {
          this.historyLoading = false;
          console.error('Failed to load history:', err);
          this.cdr.markForCheck();
        }
      });
  }

  createFolder() {
    if (!this.newFolderName || !this.newFolderName.trim()) return;
    this.http.post<{ success: boolean, folder: ScrapingFolder }>(`${this.apiUrl}/api/folders`, {
      name: this.newFolderName.trim(),
      color: this.newFolderColor,
      icon: this.newFolderIcon
    }).subscribe({
      next: (res) => {
        if (res.success && res.folder) {
          this.folders.push(res.folder);
          this.selectedFolderId = res.folder.id;
          this.newFolderName = '';
          this.showNewFolderModal = false;
          this.showNotification('Папку успішно створено');
          this.cdr.markForCheck();
        }
      },
      error: (err) => this.showNotification('Помилка при створенні папки: ' + (err.error?.error || err.message), true)
    });
  }

  deleteFolder(folder: ScrapingFolder, event?: Event) {
    if (event) event.stopPropagation();
    if (!confirm(`Ви дійсно бажаєте видалити папку «${folder.name}»? (Збережені збори залишаться в архіві без папки)`)) return;

    this.http.delete<{ success: boolean }>(`${this.apiUrl}/api/folders/${folder.id}`)
      .subscribe({
        next: (res) => {
          if (res.success) {
            this.folders = this.folders.filter(f => f.id !== folder.id);
            this.snapshots.forEach(s => {
              if (s.folderId === folder.id) s.folderId = null;
            });
            if (this.selectedFolderId === folder.id) {
              this.selectedFolderId = 'all';
            }
            this.showNotification('Папку видалено');
            this.cdr.markForCheck();
          }
        },
        error: (err) => this.showNotification('Помилка видалення папки', true)
      });
  }

  openSaveSnapshotModal() {
    if (this.products.length === 0) {
      alert('У поточній базі немає товарів для збереження в знімок.');
      return;
    }
    const cat = this.products[0]?.category || 'Товари';
    const now = new Date();
    const formattedDate = now.toLocaleDateString('uk-UA') + ' ' + now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    this.newSnapshotTitle = `Збір ${cat} (${this.products.length} шт) — ${formattedDate}`;
    this.newSnapshotFolderId = this.selectedFolderId !== 'all' && this.selectedFolderId !== 'unassigned' ? this.selectedFolderId : null;
    this.showSaveSnapshotModal = true;
    this.cdr.markForCheck();
  }

  saveCurrentSnapshot() {
    if (this.products.length === 0) return;
    this.http.post<{ success: boolean, snapshot: ScrapingSnapshot }>(`${this.apiUrl}/api/history`, {
      title: this.newSnapshotTitle || undefined,
      folderId: this.newSnapshotFolderId || null,
      products: this.products
    }).subscribe({
      next: (res) => {
        if (res.success && res.snapshot) {
          this.snapshots.unshift(res.snapshot);
          this.showSaveSnapshotModal = false;
          this.showNotification('Знімок скрейпінгу збережено в архів!');
          this.cdr.markForCheck();
        }
      },
      error: (err) => this.showNotification('Помилка збереження: ' + (err.error?.error || err.message), true)
    });
  }

  deleteSnapshot(snapshot: ScrapingSnapshot, event?: Event) {
    if (event) event.stopPropagation();
    if (!confirm(`Ви дійсно бажаєте видалити цей знімок («${snapshot.title}»)?`)) return;

    this.http.delete<{ success: boolean }>(`${this.apiUrl}/api/history/${snapshot.id}`)
      .subscribe({
        next: (res) => {
          if (res.success) {
            this.snapshots = this.snapshots.filter(s => s.id !== snapshot.id);
            if (this.activeSnapshotDetails?.id === snapshot.id) {
              this.activeSnapshotDetails = null;
            }
            this.showNotification('Знімок видалено з історії');
            this.cdr.markForCheck();
          }
        },
        error: (err) => this.showNotification('Помилка видалення знімка', true)
      });
  }

  clearAllHistory() {
    if (this.snapshots.length === 0) return;
    if (!confirm('Ви дійсно бажаєте очистити ВСЮ історію скрейпінгів? Цю дію неможливо скасувати.')) return;

    this.http.delete<{ success: boolean }>(`${this.apiUrl}/api/history`)
      .subscribe({
        next: (res) => {
          if (res.success) {
            this.snapshots = [];
            this.activeSnapshotDetails = null;
            this.showNotification('Всю історію успішно очищено');
            this.cdr.markForCheck();
          }
        },
        error: (err) => this.showNotification('Помилка очищення історії', true)
      });
  }

  restoreSnapshot(snapshot: ScrapingSnapshot) {
    if (!confirm(`Завантажити знімок «${snapshot.title}» (${snapshot.itemCount} товарів) у робочу область дашборду? Поточна робоча таблиця буде замінена цими даними.`)) return;

    this.http.post<{ success: boolean, count: number, products: Product[] }>(`${this.apiUrl}/api/history/${snapshot.id}/restore`, {})
      .subscribe({
        next: (res) => {
          if (res.success) {
            this.products = res.products || [];
            this.applyFilters();
            this.calculateMetrics();
            this.showNotification(`Збір «${snapshot.title}» успішно завантажено в робочу область!`);
            this.activeTab = 'overview';
            this.cdr.markForCheck();
          }
        },
        error: (err) => this.showNotification('Помилка завантаження знімка', true)
      });
  }

  moveSnapshot(snapshot: ScrapingSnapshot, newFolderId: string | null) {
    this.http.put<{ success: boolean, snapshot: ScrapingSnapshot }>(`${this.apiUrl}/api/history/${snapshot.id}`, {
      folderId: newFolderId
    }).subscribe({
      next: (res) => {
        if (res.success) {
          snapshot.folderId = newFolderId;
          this.movingSnapshot = null;
          this.showNotification('Знімок переміщено');
          this.cdr.markForCheck();
        }
      },
      error: (err) => this.showNotification('Помилка переміщення', true)
    });
  }

  async exportSpecificSnapshotToExcel(snapshot: ScrapingSnapshot, event?: Event) {
    if (event) event.stopPropagation();
    if (!snapshot.products || snapshot.products.length === 0) return;
    
    // Temporarily point filteredProducts to snapshot products and export
    const tempFiltered = this.filteredProducts;
    this.filteredProducts = snapshot.products;
    await this.exportToExcel();
    this.filteredProducts = tempFiltered;
  }

  getFilteredSnapshots(): ScrapingSnapshot[] {
    return this.snapshots.filter(s => {
      // Filter by folder
      if (this.selectedFolderId === 'unassigned') {
        if (s.folderId !== null) return false;
      } else if (this.selectedFolderId !== 'all') {
        if (s.folderId !== this.selectedFolderId) return false;
      }

      // Filter by search query
      if (this.searchHistoryQuery && this.searchHistoryQuery.trim()) {
        const q = this.searchHistoryQuery.toLowerCase().trim();
        const matchTitle = (s.title || '').toLowerCase().includes(q);
        const matchCat = (s.category || '').toLowerCase().includes(q);
        if (!matchTitle && !matchCat) return false;
      }

      return true;
    });
  }

  getFolderSnapshotsCount(folderId: string | null): number {
    if (folderId === 'all') return this.snapshots.length;
    if (folderId === 'unassigned') return this.snapshots.filter(s => s.folderId === null).length;
    return this.snapshots.filter(s => s.folderId === folderId).length;
  }

  getFolderName(folderId: string | null): string {
    if (!folderId) return 'Без папки';
    const folder = this.folders.find(f => f.id === folderId);
    return folder ? folder.name : 'Без папки';
  }

  getFolderColor(folderId: string | null): string {
    if (!folderId) return '#64748b';
    const folder = this.folders.find(f => f.id === folderId);
    return folder?.color || '#6366f1';
  }

  toggleAutoSaveHistory() {
    this.autoSaveHistory = !this.autoSaveHistory;
    if (typeof window !== 'undefined') {
      localStorage.setItem('tradescout_auto_save_history', String(this.autoSaveHistory));
    }
    this.showNotification(this.autoSaveHistory ? 'Автозбереження скрейпінгів увімкнено' : 'Автозбереження скрейпінгів вимкнено (режим інкогніто)');
  }

  showNotification(msg: string, isError = false) {
    if (isError) {
      this.historyErrorMsg = msg;
      this.historySuccessMsg = '';
    } else {
      this.historySuccessMsg = msg;
      this.historyErrorMsg = '';
    }
    setTimeout(() => {
      this.historySuccessMsg = '';
      this.historyErrorMsg = '';
      this.cdr.markForCheck();
    }, 4500);
    this.cdr.markForCheck();
  }

  clearActiveDatabase() {
    if (this.products.length === 0) return;
    if (!confirm('Видалити всі товари з поточної робочої бази? (Збережені в історії знімки залишаться неушкодженими)')) return;

    this.http.post<{ success: boolean }>(`${this.apiUrl}/api/products/clear`, {})
      .subscribe({
        next: (res) => {
          if (res.success) {
            this.products = [];
            this.applyFilters();
            this.calculateMetrics();
            this.showNotification('Поточну робочу базу товарів очищено');
            this.cdr.markForCheck();
          }
        },
        error: (err) => this.showNotification('Помилка очищення бази', true)
      });
  }

  calculateLQS(p: Product): number {
    let score = 0;
    // 1. Оцінка рейтингу
    if (p.rating >= 4.5) score += 2;
    else if (p.rating >= 4.0) score += 1;
    
    // 2. Оцінка попиту (кількість відгуків)
    if (p.reviews >= 50) score += 2;
    else if (p.reviews >= 10) score += 1;
    
    // 3. Заповненість характеристик
    if (p.specs && p.specs !== 'Стандартні' && p.specs !== 'Стандарт') score += 2;
    
    // 4. Проходження аудиту
    if (p.aiStatus && p.aiStatus !== 'pending') score += 2;
    
    // 5. Наявність на складі
    if (p.inStock !== false) score += 2;
    
    return score;
  }

  calculateOpportunityScore() {
    if (this.products.length === 0) {
      this.nicheOpportunityScore = 0;
      return;
    }

    // 1. Рівень попиту (середня кількість відгуків)
    const avgReviews = this.products.reduce((acc, p) => acc + p.reviews, 0) / this.products.length;
    let demandScore = 0;
    if (avgReviews > 100) demandScore = 4;
    else if (avgReviews > 30) demandScore = 3;
    else if (avgReviews > 10) demandScore = 2;
    else demandScore = 1;

    // 2. Рівень конкуренції (частка Rozetka як продавця)
    const rozetkaSellers = this.products.filter(p => p.seller && p.seller.toLowerCase() === 'rozetka').length;
    const rozetkaShare = rozetkaSellers / this.products.length;
    let compScore = 0;
    if (rozetkaShare < 0.25) compScore = 3; // мало товарів від Rozetka -> високі шанси для нас
    else if (rozetkaShare < 0.6) compScore = 2;
    else compScore = 1; // Rozetka домінує -> низькі шанси

    // 3. Рівень оптимізації конкурентів (середній LQS)
    const avgLqs = this.products.reduce((acc, p) => acc + this.calculateLQS(p), 0) / this.products.length;
    let lqsScore = 0;
    if (avgLqs < 5.5) lqsScore = 3; // у конкурентів погано налаштовані картки -> великий потенціал
    else if (avgLqs < 7.5) lqsScore = 2;
    else lqsScore = 1;

    this.nicheOpportunityScore = demandScore + compScore + lqsScore;
  }

  calculateMetrics() {
    this.totalItems = this.products.length;
    if (this.totalItems > 0) {
      const sumPrice = this.products.reduce((acc, curr) => acc + curr.price, 0);
      this.avgPrice = Math.round(sumPrice / this.totalItems);

      const ratedProducts = this.products.filter(p => p.rating > 0);
      if (ratedProducts.length > 0) {
        const sumRating = ratedProducts.reduce((acc, curr) => acc + curr.rating, 0);
        this.avgRating = parseFloat((sumRating / ratedProducts.length).toFixed(1));
      } else {
        this.avgRating = 0;
      }
    } else {
      this.avgPrice = 0;
      this.avgRating = 0.0;
    }
    
    this.aiAlertsCount = this.products.filter(p => p.aiStatus === 'warning' || p.aiStatus === 'suspicious').length;
    this.calculateOpportunityScore();
  }

  // Sorting State
  sortColumn: string = 'price';
  sortDirection: 'asc' | 'desc' = 'desc';

  sortBy(column: string) {
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortColumn = column;
      this.sortDirection = column === 'price' || column === 'oldPrice' || column === 'discount' || column === 'rating' || column === 'reviews' || column === 'lqs' ? 'desc' : 'asc';
    }
    this.applyFilters();
    this.cdr.markForCheck();
  }

  applyFilters() {
    this.filteredProducts = this.products.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(this.searchQuery.toLowerCase());
      const matchesPrice = p.price >= (this.minPrice || 0) && (this.maxPrice === null || this.maxPrice === undefined || p.price <= this.maxPrice);
      const matchesRating = p.rating >= this.minRating;
      const matchesStatus = this.statusFilter === 'all' || p.aiStatus === this.statusFilter;
      
      let matchesStock = true;
      if (this.stockFilter === 'inStock') {
        matchesStock = p.inStock !== false;
      } else if (this.stockFilter === 'outOfStock') {
        matchesStock = p.inStock === false;
      }
      
      return matchesSearch && matchesPrice && matchesRating && matchesStatus && matchesStock;
    });

    if (this.sortColumn) {
      this.filteredProducts.sort((a, b) => {
        let valA: any = (a as any)[this.sortColumn];
        let valB: any = (b as any)[this.sortColumn];

        if (this.sortColumn === 'lqs') {
          valA = this.calculateLQS(a);
          valB = this.calculateLQS(b);
        } else if (this.sortColumn === 'name') {
          valA = a.name.toLowerCase();
          valB = b.name.toLowerCase();
        } else if (this.sortColumn === 'category') {
          valA = (a.category || '').toLowerCase();
          valB = (b.category || '').toLowerCase();
        } else if (this.sortColumn === 'seller') {
          valA = (a.seller || '').toLowerCase();
          valB = (b.seller || '').toLowerCase();
        } else if (this.sortColumn === 'price') {
          valA = a.price || 0;
          valB = b.price || 0;
        } else if (this.sortColumn === 'oldPrice') {
          valA = a.oldPrice || a.price || 0;
          valB = b.oldPrice || b.price || 0;
        } else if (this.sortColumn === 'discount') {
          valA = a.discount || 0;
          valB = b.discount || 0;
        } else if (this.sortColumn === 'rating') {
          valA = a.rating || 0;
          valB = b.rating || 0;
        } else if (this.sortColumn === 'reviews') {
          valA = a.reviews || 0;
          valB = b.reviews || 0;
        } else if (this.sortColumn === 'sellersCount') {
          valA = a.sellersCount || 1;
          valB = b.sellersCount || 1;
        } else if (this.sortColumn === 'priceChange') {
          valA = a.priceChange || 0;
          valB = b.priceChange || 0;
        } else if (this.sortColumn === 'reviewsGrowth') {
          valA = a.reviewsGrowth || 0;
          valB = b.reviewsGrowth || 0;
        } else if (this.sortColumn === 'inStock') {
          valA = a.inStock !== false ? 1 : 0;
          valB = b.inStock !== false ? 1 : 0;
        } else if (this.sortColumn === 'aiStatus') {
          valA = a.aiStatus || '';
          valB = b.aiStatus || '';
        }

        if (valA < valB) return this.sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return this.sortDirection === 'asc' ? 1 : -1;
        return 0;
      });
    }
  }

  onFilterChange() {
    this.applyFilters();
  }

   resetFilters() {
    this.searchQuery = '';
    this.minPrice = 0;
    this.maxPrice = null;
    this.minRating = 0;
    this.statusFilter = 'all';
    this.stockFilter = 'all';
    this.applyFilters();
  }

  clearAllData() {
    if (confirm('Ви впевнені, що хочете видалити всі зібрані товари?')) {
      this.loading = true;
      // Миттєве очищення інтерфейсу для відгуку користувачу (опимістичний апдейт)
      this.products = [];
      this.applyFilters();
      this.calculateMetrics();
      this.cdr.markForCheck();

      this.http.post(`${this.apiUrl}/api/products/clear`, {})
        .subscribe({
          next: () => {
            this.loadProducts();
          },
          error: (err) => {
            console.error('Failed to clear data:', err);
            this.loading = false;
            this.cdr.markForCheck();
          }
        });
    }
  }

  auditProduct(product: Product) {
    product.isAuditing = true;
    this.cdr.markForCheck();

    this.http.post<{ success: boolean, status: any, verdict: string, specs?: string }>(`${this.apiUrl}/api/products/analyze`, {
      link: product.link,
      name: product.name
    }).subscribe({
      next: (res) => {
        product.isAuditing = false;
        if (res.success) {
          product.aiStatus = res.status;
          product.aiVerdict = res.verdict;
          if (res.specs) {
            product.specs = res.specs;
          }
          this.calculateMetrics();
        }
        this.cdr.markForCheck();
      },
      error: (err) => {
        console.error('AI Audit failed:', err);
        product.isAuditing = false;
        product.aiStatus = 'pending';
        product.aiVerdict = 'Помилка аудиту: перевірте API ключ або підключення.';
        this.cdr.markForCheck();
      }
    });
  }

  // Demand Estimator logic (estimated monthly sales based on review count)
  getEstimatedSales(reviews: number): number {
    if (!reviews || reviews < 0 || isNaN(reviews)) {
      return 0;
    }
    // standard model: 1 review roughly represents 12 sales
    return reviews * 12;
  }

  getFilteredDemandProducts(): Product[] {
    const filtered = this.products.filter(p => {
      // 1. Search Query
      if (this.demandSearchQuery) {
        const matchesSearch = p.name.toLowerCase().includes(this.demandSearchQuery.toLowerCase());
        if (!matchesSearch) return false;
      }
      
      // 2. Min Price
      if (this.demandMinPrice !== null && this.demandMinPrice !== undefined) {
        if (p.price < this.demandMinPrice) return false;
      }
      
      // 3. Max Price
      if (this.demandMaxPrice !== null && this.demandMaxPrice !== undefined) {
        if (p.price > this.demandMaxPrice) return false;
      }
      
      // 4. Stock
      if (this.demandStockFilter === 'inStock' && p.inStock === false) return false;
      if (this.demandStockFilter === 'outOfStock' && p.inStock !== false) return false;
      
      // 5. Demand Level
      if (this.demandLevelFilter !== 'all') {
        const sales = this.getEstimatedSales(p.reviews);
        if (this.demandLevelFilter === 'high' && sales <= 200) return false;
        if (this.demandLevelFilter === 'moderate' && (sales < 50 || sales > 200)) return false;
        if (this.demandLevelFilter === 'low' && sales >= 50) return false;
      }
      
      return true;
    });

    // Apply Sorting
    if (this.demandSortColumn) {
      filtered.sort((a, b) => {
        let valA: any;
        let valB: any;

        if (this.demandSortColumn === 'name') {
          valA = a.name.toLowerCase();
          valB = b.name.toLowerCase();
        } else if (this.demandSortColumn === 'price') {
          valA = a.price;
          valB = b.price;
        } else if (this.demandSortColumn === 'inStock') {
          valA = a.inStock !== false ? 1 : 0;
          valB = b.inStock !== false ? 1 : 0;
        } else if (this.demandSortColumn === 'reviews') {
          valA = a.reviews;
          valB = b.reviews;
        } else if (this.demandSortColumn === 'revenue') {
          valA = this.getEstimatedSales(a.reviews) * a.price;
          valB = this.getEstimatedSales(b.reviews) * b.price;
        } else {
          valA = a.reviews;
          valB = b.reviews;
        }

        if (valA < valB) return this.demandSortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return this.demandSortDirection === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return filtered;
  }

  sortDemandBy(column: string) {
    if (this.demandSortColumn === column) {
      this.demandSortDirection = this.demandSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.demandSortColumn = column;
      this.demandSortDirection = 'desc'; // Default to descending
    }
    this.cdr.markForCheck();
  }

  resetDemandFilters() {
    this.demandSearchQuery = '';
    this.demandMinPrice = null;
    this.demandMaxPrice = null;
    this.demandStockFilter = 'all';
    this.demandLevelFilter = 'all';
    this.demandSortColumn = 'reviews';
    this.demandSortDirection = 'desc';
    this.cdr.markForCheck();
  }

  getNicheCompetitiveness(): { level: string, colorClass: string, desc: string } {
    const totalReviews = this.products.reduce((acc, p) => acc + p.reviews, 0);
    const count = this.products.length;

    if (count === 0) {
      return { level: 'Немає даних', colorClass: 'text-slate-400 bg-slate-900', desc: 'Зберіть дані про товари, щоб оцінити конкуренцію.' };
    }

    // High competition if average reviews > 50 or many items
    const avgReviews = totalReviews / count;
    if (count > 25 && avgReviews > 30) {
      return { 
        level: 'Висока', 
        colorClass: 'text-red-400 bg-red-950/40 border-red-800/80',
        desc: 'Ніша насичена великою кількістю продавців та великою кількістю накопичених відгуків. Вхід складний.'
      };
    } else if (count > 10 || avgReviews > 10) {
      return { 
        level: 'Середня', 
        colorClass: 'text-amber-400 bg-amber-950/40 border-amber-800/80',
        desc: 'Присутня помірна конкуренція. Є можливість зайти з гарною ціною або унікальними характеристиками.' 
      };
    } else {
      return { 
        level: 'Низька', 
        colorClass: 'text-emerald-400 bg-emerald-950/40 border-emerald-800/80',
        desc: 'Конкурентів мало, кількість відгуків незначна. Відмінний час для швидкого старту!' 
      };
    }
  }

  getWebhookUrl(): string {
    return `${this.apiUrl}/api/products`;
  }

  getPort(): string {
    if (typeof window !== 'undefined') {
      return window.location.port || '80';
    }
    return '3000';
  }

  logout() {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('tradescout_auth');
    }
    this.router.navigate(['/login']);
  }

  async exportToExcel() {
    if (this.filteredProducts.length === 0) return;

    // 1. Збираємо всі унікальні НАДІЙНО НОРМАЛІЗОВАНІ назви характеристик
    const dynamicKeysSet = new Set<string>();
    this.filteredProducts.forEach(p => {
      const specsArr = this.getSpecsArray(p);
      specsArr.forEach(s => {
        const normKey = this.normalizeSpecKey(s.key);
        dynamicKeysSet.add(normKey);
      });
    });
    const dynamicKeys = Array.from(dynamicKeysSet);

    // 2. Створюємо Excel Workbook & Worksheet
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TradeScout Analytics';
    workbook.created = new Date();

    const worksheet = workbook.addWorksheet('Товари Rozetka', {
      views: [{ state: 'frozen', ySplit: 1, showGridLines: true }]
    });

    // 3. Формуємо опис колонок
    const columns: Partial<ExcelJS.Column>[] = [
      { header: 'Назва товару', key: 'name', width: 40 },
      { header: 'Ціна без знижки (грн)', key: 'oldPrice', width: 22 },
      { header: 'Ціна зі знижкою (грн)', key: 'price', width: 22 },
      { header: 'Знижка (%)', key: 'discount', width: 14 },
      { header: 'Рейтинг', key: 'rating', width: 12 },
      { header: 'Відгуки', key: 'reviews', width: 12 },
      { header: 'Наявність', key: 'inStock', width: 16 },
      { header: 'Продавець', key: 'seller', width: 20 },
      { header: 'Категорія', key: 'category', width: 22 },
    ];

    dynamicKeys.forEach((k, idx) => {
      columns.push({ header: k, key: `spec_${idx}`, width: 22 });
    });

    columns.push(
      { header: 'Опис товару', key: 'description', width: 45 },
      { header: 'Посилання', key: 'link', width: 16 }
    );

    worksheet.columns = columns;

    // 4. Стилізуємо заголовок (Row 1)
    const headerRow = worksheet.getRow(1);
    headerRow.height = 30;
    headerRow.eachCell((cell) => {
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF0F172A' } // Dark Slate Navy #0F172A
      };
      cell.font = {
        name: 'Segoe UI',
        size: 10.5,
        bold: true,
        color: { argb: 'FFFFFFFF' }
      };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      cell.border = {
        top: { style: 'thin', color: { argb: 'FF334155' } },
        left: { style: 'thin', color: { argb: 'FF334155' } },
        bottom: { style: 'medium', color: { argb: 'FF3B82F6' } },
        right: { style: 'thin', color: { argb: 'FF334155' } }
      };
    });

    // 5. Додаємо та стилізуємо дані
    this.filteredProducts.forEach((p, index) => {
      const specsMap: Record<string, string> = {};
      this.getSpecsArray(p).forEach(s => {
        const normKey = this.normalizeSpecKey(s.key);
        specsMap[normKey] = s.val;
      });

      const inStock = p.inStock !== false;
      const inStockText = inStock ? 'В наявності' : 'Немає';
      const rowData: Record<string, any> = {
        name: p.name || '',
        oldPrice: p.oldPrice || p.price || 0,
        price: p.price || 0,
        discount: p.discount ? `${p.discount}%` : '0%',
        rating: p.rating ? Number(p.rating) : 0,
        reviews: p.reviews ? Number(p.reviews) : 0,
        inStock: inStockText,
        seller: p.seller || 'Rozetka',
        category: p.category || ''
      };

      dynamicKeys.forEach((k, idx) => {
        rowData[`spec_${idx}`] = specsMap[k] || '—';
      });

      rowData['description'] = p.description || '';
      rowData['link'] = p.link ? { text: 'Відкрити 🔗', hyperlink: p.link } : '';

      const row = worksheet.addRow(rowData);
      row.height = 22;

      const isEven = index % 2 === 0;
      const bgArgb = isEven ? 'FFFFFFFF' : 'FFF8FAFC'; // Zebra striping

      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF1E293B' } };
        cell.alignment = { vertical: 'middle' };
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
          right: { style: 'thin', color: { argb: 'FFE2E8F0' } }
        };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: bgArgb }
        };

        // Спеціальні стилі для колонок
        if (colNumber === 1) { // Назва
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
          cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF0F172A' } };
        } else if (colNumber === 2) { // Стара ціна
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFmt = '#,##0 "грн"';
          cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF64748B' } };
        } else if (colNumber === 3) { // Ціна зі знижкою
          cell.alignment = { vertical: 'middle', horizontal: 'right' };
          cell.numFmt = '#,##0 "грн"';
          cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FF059669' } }; // Emerald Green
        } else if (colNumber === 4) { // Знижка
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          if (p.discount && p.discount > 0) {
            cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFDC2626' } }; // Red
          }
        } else if (colNumber === 5) { // Рейтинг
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: 'FFD97706' } }; // Amber
        } else if (colNumber === 6) { // Відгуки
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          cell.numFmt = '#,##0';
        } else if (colNumber === 7) { // Наявність
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          cell.font = {
            name: 'Segoe UI',
            size: 10,
            bold: true,
            color: { argb: inStock ? 'FF10B981' : 'FFEF4444' }
          };
        } else if (colNumber === 8) { // Продавець
          cell.alignment = { vertical: 'middle', horizontal: 'left' };
          cell.font = { name: 'Segoe UI', size: 10, bold: (p.seller === 'Rozetka'), color: { argb: 'FF1E293B' } };
        } else if (colNumber === columns.length) { // Посилання
          cell.alignment = { vertical: 'middle', horizontal: 'center' };
          cell.font = { name: 'Segoe UI', size: 10, underline: true, color: { argb: 'FF2563EB' } };
        }
      });
    });

    // 6. Вмикаємо AutoFilter на всі колонки
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length }
    };

    // 7. Автопідбір ширини колонок за вмістом
    worksheet.columns.forEach((col) => {
      let maxLen = col.header ? String(col.header).length : 12;
      col.eachCell?.({ includeEmpty: false }, (cell) => {
        const cellVal = cell.value ? (typeof cell.value === 'object' && 'text' in cell.value ? cell.value.text : String(cell.value)) : '';
        if (cellVal.length > maxLen) {
          maxLen = cellVal.length;
        }
      });
      col.width = Math.min(Math.max(maxLen + 3, 14), 55);
    });

    // 8. Генеруємо та завантажуємо нативний .xlsx файл
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `TradeScout_Master_Export_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }


  getSpecsArray(product: any): { key: string, val: string }[] {
    if (!product) return [];
    
    // Спробуємо зчитати зі структурованого об'єкта
    if (product.detailedSpecsMap && Object.keys(product.detailedSpecsMap).length > 0) {
      return Object.entries(product.detailedSpecsMap).map(([key, val]) => ({
        key: String(key),
        val: String(val)
      }));
    }

    // Резервний варіант з розбором specs рядка
    const specsStr = product.specs;
    if (!specsStr) return [];
    return specsStr.split(';').map((part: string) => {
      const idx = part.indexOf(':');
      if (idx !== -1) {
        return { key: part.slice(0, idx).trim(), val: part.slice(idx + 1).trim() };
      }
      return { key: 'Характеристика', val: part.trim() };
    }).filter((item: any) => item.val.length > 0);
  }
}
