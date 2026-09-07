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

export interface SellerStat {
  name: string;
  productCount: number;
  marketSharePct: number;
  totalReviews: number;
  avgRating: number;
  avgPrice: number;
  minPrice: number;
  maxPrice: number;
  inStockPct: number;
  color: string;
}

export interface SellerPieSegment {
  name: string;
  productCount: number;
  pct: number;
  color: string;
  strokeDasharray: string;
  strokeDashoffset: number;
  cumulativePct?: number;
}

export interface ExtractedFeature {
  title: string;
  icon: string;
  color: string;
}

export interface StructuredDescription {
  summary: string;
  keyFeatures: ExtractedFeature[];
  bulletPoints: string[];
  cleanParagraphs: string[];
}

export interface SpecValueStat {
  specValue: string;
  productsCount: number;
  productsShare: number;
  reviewsSum: number;
  reviewsShare: number;
  avgPrice: number;
  medianPrice: number;
  demandSupplyRatio: number;
  isTopDemand: boolean;
  isTopEfficiency: boolean;
  products: any[];
}

export interface SpecCategoryAnalysis {
  specKey: string;
  totalProductsWithSpec: number;
  coveragePct: number;
  values: SpecValueStat[];
}

export interface AnalyticalSummary {
  kpi: {
    totalProducts: number;
    uniqueSellersCount: number;
    avgPrice: number;
    medianPrice: number;
    minPrice: number;
    maxPrice: number;
    p95Price: number;
    priceSkewPct: number;
    inStockCount: number;
    inStockPercentage: number;
    activeSkusCount: number;
    activeSkusPercentage: number;
    inactiveSkusCount: number;
    inactiveSkusPercentage: number;
    activeSkusInStockCount: number;
    activeSkusInStockRate: number;
    avgReviewsPerActiveSku: number;
    cr3: number;
    cr3Level: 'LOW' | 'MEDIUM' | 'HIGH';
    top3Sellers: Array<{ name: string; share: number; count: number; isRozetka: boolean }>;
    hhi: number;
    hhiLevel: 'LOW' | 'MODERATE' | 'HIGH';
    entryBarrier: {
      level: 'LOW' | 'MEDIUM' | 'HIGH';
      medianTop10Reviews: number;
      top10ReviewsMax: number;
      top10ReviewsMin: number;
      top10ReviewsAvg: number;
      top10ProductsCount: number;
    };
    vendorSplit: {
      rozetkaCount: number;
      thirdPartyCount: number;
      rozetkaShare: number;
      thirdPartyShare: number;
    };
  };
  priceDistribution: Array<{
    rangeLabel: string;
    minPrice: number;
    maxPrice: number;
    productsCount: number;
    productsShare: number;
    reviewsSum: number;
    reviewsShare: number;
    demandSupplyRatio: number;
    isSweetSpot: boolean;
  }>;
  sellersTable: Array<{
    sellerName: string;
    isRozetka: boolean;
    productsCount: number;
    marketShare: number;
    reviewsSum: number;
    avgReviewsPerProduct: number;
    medianPrice: number;
    inStockRate: number;
    color: string;
    rank: number;
    isTop3: boolean;
  }>;
  specAnalytics: SpecCategoryAnalysis[];
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
  sessionTitle?: string;
  sessionId?: string;
  specs?: string;
  description?: string;
  seller?: string;
  sellersCount?: number;
  priceChange?: number;
  reviewsGrowth?: number;
}

export interface LiveScrapingTask {
  tabId?: number;
  sessionId: string;
  sessionTitle: string;
  category?: string;
  status: 'scraping' | 'completed' | 'stopped' | 'error';
  pageIndex: number;
  currentCount: number;
  estimatedTotal: number;
  percent: number;
  statusMsg?: string;
  updatedAt: number;
  startTime?: number;
}

export interface CategoryPageBreakdown {
  title: string;
  totalCount: number;
  totalPages: number;
  pages: Array<{ pageNum: number, count: number }>;
}

export interface TeamUser {
  id: string;
  username: string;
  role: 'admin' | 'analyst';
  displayName: string;
  avatarGradient: string;
  isActive: boolean;
  createdAt: string;
  lastLoginAt?: string | null;
}

export interface UserProfileSettings {
  username: string;
  role: string;
  avatarInitial: string;
  avatarGradient: string;
  scrapeDelayMs: number;
  autoSaveHistory: boolean;
  soundAlerts: boolean;
  crThreshold: number;
  accentTheme: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './dashboard.html',
})
export class DashboardComponent implements OnInit {
  apiUrl: string = typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? (window.location.port === '4000' ? '' : 'http://localhost:4000')
    : (typeof window !== 'undefined' && window.location.hostname.includes('onrender.com') ? '' : 'https://rozetka-scraper-extension-builder.onrender.com');

  products: Product[] = [];
  filteredProducts: Product[] = [];
  
  // Navigation & Tabs
  activeTab: 'overview' | 'explorer' | 'demand' | 'details' | 'history' | 'settings' = 'overview';
  settingsActiveSubTab: 'users' | 'profile' | 'storage' = 'users';

  // Team & Users Management State
  teamUsers: TeamUser[] = [];
  loadingUsers = false;
  usersErrorMessage = '';

  // Support Mode / Impersonation State
  isImpersonating = false;
  impersonatedAdminData: any = null;
  impersonateTargetUser: TeamUser | null = null;

  showCreateUserModal = false;
  newUserData = {
    username: '',
    password: '',
    displayName: '',
    role: 'analyst' as 'admin' | 'analyst',
    avatarGradient: 'from-cyan-500 to-blue-600'
  };
  createUserError = '';

  showChangePasswordModal = false;
  selectedUserForPasswordChange: TeamUser | null = null;
  newUserPassword = '';
  changePasswordError = '';
  changePasswordSuccess = false;

  // My Profile Password Change State
  myNewPassword = '';
  myConfirmPassword = '';
  myPasswordError = '';
  myPasswordSuccess = false;

  // User & System Settings State
  readonly STORAGE_PRODUCTS_KEY = 'tradescout_cached_products';
  readonly STORAGE_CACHED_TEAM_USERS_KEY = 'tradescout_cached_team_users';
  readonly STORAGE_USER_SETTINGS_KEY = 'tradescout_user_settings_v1';
  userSettings: UserProfileSettings = {
    username: 'Адміністратор',
    role: 'Головний аналітик (Admin)',
    avatarInitial: 'A',
    avatarGradient: 'from-indigo-600 to-purple-600',
    scrapeDelayMs: 2000,
    autoSaveHistory: true,
    soundAlerts: true,
    crThreshold: 3,
    accentTheme: 'indigo'
  };
  settingsSavedNotice = false;
  settingsNoticeTimeout: any = null;

  // Filters
  searchQuery = '';
  selectedSessionTitle = 'all'; // 'all' or specific session title (e.g. 'Повербанки Anker', 'Повербанки Sigma')
  selectedPageFilter: number | 'all' = 'all';
  minPrice = 0;
  maxPrice: number | null = null;
  minRating = 0;
  statusFilter = 'all';
  stockFilter = 'all';

  // Live Scraping Monitor State
  activeScrapes: LiveScrapingTask[] = [];
  isAnyScrapeActive = false;
  liveStatusPollTimer: any = null;
  recentScrapeSuccessNotice: string | null = null;
  liveScrapeStartTime: number | null = null;
  liveElapsedText = '00:00';
  liveItemsPerMinute = 0;
  liveStopwatchTimer: any = null;

  startLiveStopwatch() {
    if (this.liveStopwatchTimer) return;
    this.liveScrapeStartTime = this.liveScrapeStartTime || Date.now();
    this.liveStopwatchTimer = setInterval(() => {
      if (!this.liveScrapeStartTime) return;
      const elapsedSec = Math.floor((Date.now() - this.liveScrapeStartTime) / 1000);
      const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const s = String(elapsedSec % 60).padStart(2, '0');
      this.liveElapsedText = `${m}:${s}`;
      
      const totalCollected = this.getTotalActiveProductsCollected();
      if (elapsedSec > 2 && totalCollected > 0) {
        this.liveItemsPerMinute = Math.round((totalCollected / elapsedSec) * 60);
      }
      this.cdr.markForCheck();
    }, 1000);
  }

  stopLiveStopwatch() {
    if (this.liveStopwatchTimer) {
      clearInterval(this.liveStopwatchTimer);
      this.liveStopwatchTimer = null;
    }
  }

  getTotalActiveProductsCollected(): number {
    if (!this.activeScrapes || this.activeScrapes.length === 0) return 0;
    return this.activeScrapes.reduce((acc, t) => acc + (t.currentCount || 0), 0);
  }

  getTotalEstimatedProducts(): number {
    if (!this.activeScrapes || this.activeScrapes.length === 0) return 0;
    return this.activeScrapes.reduce((acc, t) => acc + (t.estimatedTotal || 0), 0);
  }

  getOverallScrapePercent(): number {
    const est = this.getTotalEstimatedProducts();
    if (est <= 0) return 0;
    return Math.min(100, Math.round((this.getTotalActiveProductsCollected() / est) * 100));
  }

  getTaskTotalPages(task: LiveScrapingTask): number {
    const est = task.estimatedTotal || 60;
    return Math.max(1, Math.ceil(est / 60));
  }

  getTaskPageSteps(task: LiveScrapingTask): Array<{ pageNum: number, status: 'done' | 'current' | 'pending' }> {
    const totalPages = this.getTaskTotalPages(task);
    const steps: Array<{ pageNum: number, status: 'done' | 'current' | 'pending' }> = [];
    const maxVisiblePages = Math.min(10, totalPages);
    
    for (let p = 1; p <= maxVisiblePages; p++) {
      let status: 'done' | 'current' | 'pending' = 'pending';
      if (task.status === 'completed' || p < task.pageIndex) {
        status = 'done';
      } else if (p === task.pageIndex && task.status === 'scraping') {
        status = 'current';
      }
      steps.push({ pageNum: p, status });
    }
    return steps;
  }

  normalizeSessionTitle(title: string): string {
    if (!title) return 'Загальна';
    let t = title.trim();
    // Normalize Rozetka variations such as "Повербанки та УМБ Brand" -> "Повербанки Brand"
    t = t.replace(/^Повербанки\s+та\s+УМБ\s+/i, 'Повербанки ');
    t = t.replace(/^Power\s*banks?\s+and\s+UMB\s+/i, 'Повербанки ');
    return t;
  }

  getAvailableSessions(): Array<{ title: string, count: number }> {
    if (!this.products || this.products.length === 0) return [];
    const map = new Map<string, number>();
    for (const p of this.products) {
      const raw = (p.sessionTitle || p.category || 'Загальна').trim();
      const t = this.normalizeSessionTitle(raw);
      if (t) {
        map.set(t, (map.get(t) || 0) + 1);
      }
    }
    const result: Array<{ title: string, count: number }> = [];
    map.forEach((count, title) => {
      result.push({ title, count });
    });
    return result.sort((a, b) => b.count - a.count);
  }

  selectSession(title: string) {
    this.selectedSessionTitle = title;
    this.selectedPageFilter = 'all';
    this.applyFilters();
    this.calculateMetrics();
    this.cdr.markForCheck();
  }

  selectPageFilter(page: number | 'all') {
    this.selectedPageFilter = page;
    this.applyFilters();
    this.calculateMetrics();
    this.cdr.markForCheck();
  }

  getCategoryPageBreakdowns(): CategoryPageBreakdown[] {
    if (!this.products || this.products.length === 0) return [];
    const sessions = this.getAvailableSessions();
    const list: CategoryPageBreakdown[] = [];

    for (const s of sessions) {
      const prods = this.products.filter(p => {
        const raw = (p.sessionTitle || p.category || 'Загальна').trim();
        return this.normalizeSessionTitle(raw) === s.title || raw === s.title;
      });

      const totalPages = Math.max(1, Math.ceil(prods.length / 60));
      const pages: Array<{ pageNum: number, count: number }> = [];

      for (let i = 1; i <= totalPages; i++) {
        const pageProds = prods.filter((_, idx) => Math.floor(idx / 60) + 1 === i);
        pages.push({ pageNum: i, count: pageProds.length });
      }

      list.push({
        title: s.title,
        totalCount: s.count,
        totalPages,
        pages
      });
    }

    return list;
  }

  selectCategoryAndPage(categoryTitle: string, page: number | 'all') {
    this.selectedSessionTitle = categoryTitle;
    this.selectedPageFilter = page;
    this.applyFilters();
    this.calculateMetrics();
    this.cdr.markForCheck();
  }

  getAvailablePagesForActiveSession(): number[] {
    const prods = this.getActiveSessionProducts();
    if (!prods || prods.length === 0) return [];
    const totalPages = Math.ceil(prods.length / 60);
    const pages: number[] = [];
    for (let i = 1; i <= totalPages; i++) {
      pages.push(i);
    }
    return pages;
  }

  getActiveSessionProducts(): Product[] {
    if (!this.products || this.products.length === 0) return [];
    if (this.selectedSessionTitle === 'all') return this.products;
    return this.products.filter(p => {
      const raw = (p.sessionTitle || p.category || 'Загальна').trim();
      const clean = this.normalizeSessionTitle(raw);
      return clean === this.selectedSessionTitle || raw === this.selectedSessionTitle;
    });
  }

  // History & Folders State
  folders: ScrapingFolder[] = [];
  snapshots: ScrapingSnapshot[] = [];
  selectedFolderId: string | null = 'all'; // 'all', 'unassigned', or folder.id
  searchHistoryQuery = '';
  autoSaveHistory = true;
  historyLoading = false;
  historySuccessMsg = '';
  historyErrorMsg = '';

  // Spec Analytics State
  selectedSpecCategoryIndex = 0;

  // Comparison Module State
  selectedSnapshotIdsForComparison: string[] = [];
  showComparisonModal = false;
  comparisonResult: {
    snapshotA: ScrapingSnapshot;
    snapshotB: ScrapingSnapshot;
    analyticsA: AnalyticalSummary;
    analyticsB: AnalyticalSummary;
  } | null = null;

  // Modal / Creation States
  showNewFolderModal = false;
  newFolderName = '';
  newFolderColor = '#6366f1';
  newFolderIcon = 'folder';

  showSaveSnapshotModal = false;
  newSnapshotTitle = '';
  newSnapshotFolderId: string | null = null;
  showInlineCreateFolderInSaveModal = false;
  inlineNewFolderName = '';
  inlineNewFolderColor = '#6366f1';

  // Deterministic Analytics Engine State
  analyticsSummary: AnalyticalSummary | null = null;
  sellerQuickFilter: 'all' | '3p' | 'inStock' | 'noReviews' | 'top20' = 'all';
  sellerAnalyticsSortColumn: 'productsCount' | 'reviewsSum' | 'avgReviewsPerProduct' | 'medianPrice' | 'inStockRate' | 'marketShare' = 'productsCount';
  sellerAnalyticsSortDirection: 'asc' | 'desc' = 'desc';

  // Seller Analytics State
  sellerStats: SellerStat[] = [];
  topSellerByAssortment: SellerStat | null = null;
  topSellerByReviews: SellerStat | null = null;
  topSellerByRating: SellerStat | null = null;
  sellerPieSegments: SellerPieSegment[] = [];
  sellerSortColumn: 'productCount' | 'totalReviews' | 'avgRating' | 'avgPrice' = 'productCount';
  sellerSortDirection: 'asc' | 'desc' = 'desc';
  sellerSearchQuery = '';

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

  openSpecValueProductsModal(specKey: string, valStat: SpecValueStat) {
    this.drilldownTitle = `${specKey}: ${valStat.specValue}`;
    this.drilldownSubtitle = `${valStat.productsCount} товарів (${valStat.productsShare}% пропозиції, ${valStat.reviewsShare}% попиту ніші)`;
    this.drilldownProducts = valStat.products || [];
    this.drilldownSearchQuery = '';
    this.showDrilldownModal = true;
    this.cdr.markForCheck();
  }

  toggleSnapshotComparison(snapshot: ScrapingSnapshot, event?: Event) {
    if (event) event.stopPropagation();
    const idx = this.selectedSnapshotIdsForComparison.indexOf(snapshot.id);
    if (idx !== -1) {
      this.selectedSnapshotIdsForComparison.splice(idx, 1);
    } else {
      if (this.selectedSnapshotIdsForComparison.length >= 2) {
        this.selectedSnapshotIdsForComparison.shift();
      }
      this.selectedSnapshotIdsForComparison.push(snapshot.id);
    }
    this.cdr.markForCheck();
  }

  isSnapshotSelectedForComparison(id: string): boolean {
    return this.selectedSnapshotIdsForComparison.includes(id);
  }

  clearComparisonSelection() {
    this.selectedSnapshotIdsForComparison = [];
    this.cdr.markForCheck();
  }

  openComparisonModal() {
    if (this.selectedSnapshotIdsForComparison.length !== 2) return;
    const sA = this.snapshots.find(s => s.id === this.selectedSnapshotIdsForComparison[0]);
    const sB = this.snapshots.find(s => s.id === this.selectedSnapshotIdsForComparison[1]);
    if (!sA || !sB) return;

    const anA = computeMarketplaceAnalytics(sA.products || []);
    const anB = computeMarketplaceAnalytics(sB.products || []);

    this.comparisonResult = {
      snapshotA: sA,
      snapshotB: sB,
      analyticsA: anA,
      analyticsB: anB
    };
    this.showComparisonModal = true;
    this.cdr.markForCheck();
  }

  closeComparisonModal() {
    this.showComparisonModal = false;
    this.cdr.markForCheck();
  }

  getBadgeSpecs(product: any): { text: string; style: string }[] {
    if (!product) return [];
    const badges: { text: string; style: string }[] = [];

    const cleanBadgeText = (str: string, maxLen = 28) => {
      if (!str) return '';
      let t = str.trim();
      if (t.includes(':')) {
        t = t.slice(t.indexOf(':') + 1).trim();
      }
      return t.length > maxLen ? t.slice(0, maxLen - 2) + '...' : t;
    };
    
    // Спершу витягуємо важливі характеристики зі структурованого об'єкта
    if (product.detailedSpecsMap && Object.keys(product.detailedSpecsMap).length > 0) {
      const map = product.detailedSpecsMap;
      
      const capacityKey = Object.keys(map).find(k => /ємність|capacity|mah|мАг/i.test(k));
      if (capacityKey) {
        const val = map[capacityKey];
        const match = val.match(/\d+[\d\s]*(?:mah|мАг)/i);
        const text = match ? match[0] : cleanBadgeText(val);
        badges.push({ text, style: 'bg-indigo-950/80 text-indigo-300 border-indigo-700/60' });
      }
      
      const powerKey = Object.keys(map).find(k => /потужність|power| W| Вт/i.test(k));
      if (powerKey) {
        const val = map[powerKey];
        const match = val.match(/\d+(?:\.\d+)?\s*(?:W|Вт)/i);
        const text = match ? match[0] : cleanBadgeText(val);
        badges.push({ text, style: 'bg-purple-950/80 text-purple-300 border-purple-700/60' });
      }
      
      const techKey = Object.keys(map).find(k => /magsafe|quickcharge|qc|pd|бездрот|ліхтарик/i.test(k));
      if (techKey) {
        const val = map[techKey];
        badges.push({ text: cleanBadgeText(val), style: 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60' });
      }
      
      if (badges.length < 3) {
        const keys = Object.keys(map).filter(k => k !== capacityKey && k !== powerKey && k !== techKey);
        for (const k of keys) {
          if (badges.length >= 3) break;
          const val = map[k];
          if (val) {
            badges.push({ text: cleanBadgeText(val), style: 'bg-slate-900 text-slate-200 border-slate-700/70' });
          }
        }
      }
      if (badges.length > 0) return badges;
    }

    // Резервний варіант (розбір рядка)
    const specsStr = product.specs;
    if (!specsStr) return [];
    const parts = specsStr.split(';').map((s: any) => s.trim()).filter(Boolean);

    for (const part of parts) {
      if (/mah|мАг/i.test(part)) {
        const match = part.match(/\d+[\d\s]*(?:mah|мАг)/i);
        const text = match ? match[0] : cleanBadgeText(part);
        badges.push({ text, style: 'bg-indigo-950/80 text-indigo-300 border-indigo-700/60' });
      } else if (/\d+\s*W|\b\d+\s*Вт\b/i.test(part)) {
        const match = part.match(/\d+(?:\.\d+)?\s*(?:W|Вт)/i);
        const text = match ? match[0] : cleanBadgeText(part);
        badges.push({ text, style: 'bg-purple-950/80 text-purple-300 border-purple-700/60' });
      } else if (/magsafe|quickcharge|qc|pd|бездрот|ліхтарик/i.test(part)) {
        badges.push({ text: cleanBadgeText(part), style: 'bg-emerald-950/80 text-emerald-300 border-emerald-700/60' });
      } else if (badges.length < 3) {
        const t = cleanBadgeText(part);
        if (t.length > 0) {
          badges.push({ text: t, style: 'bg-slate-900 text-slate-200 border-slate-700/70' });
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
  inStockCount = 0;
  inStockPct = 0;
  sellersCount = 0;
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

  loadUserSettings() {
    if (typeof window !== 'undefined') {
      try {
        const local = localStorage.getItem(this.STORAGE_USER_SETTINGS_KEY);
        if (local) {
          const parsed = JSON.parse(local);
          this.userSettings = { ...this.userSettings, ...parsed };
          this.autoSaveHistory = this.userSettings.autoSaveHistory;
        }

        const currentUserRaw = localStorage.getItem('tradescout_current_user');
        if (currentUserRaw) {
          const user = JSON.parse(currentUserRaw);
          if (user) {
            this.userSettings.username = user.displayName || user.username || this.userSettings.username;
            this.userSettings.role = user.role === 'admin' ? 'Головний аналітик (Admin)' : (user.role || this.userSettings.role);
            this.userSettings.avatarGradient = user.avatarGradient || this.userSettings.avatarGradient;
            this.userSettings.avatarInitial = (this.userSettings.username || 'A').charAt(0).toUpperCase();
          }
        }
      } catch (e) {}
    }
  }

  async saveUserSettings() {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(this.STORAGE_USER_SETTINGS_KEY, JSON.stringify(this.userSettings));
        localStorage.setItem('tradescout_auto_save_history', String(this.userSettings.autoSaveHistory));
        this.autoSaveHistory = this.userSettings.autoSaveHistory;

        // Also sync profile changes to Neon database if user is logged in
        const currentUserRaw = localStorage.getItem('tradescout_current_user');
        if (currentUserRaw) {
          const current = JSON.parse(currentUserRaw);
          if (current && current.id) {
            fetch(`${this.apiUrl}/api/users/${current.id}`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                displayName: this.userSettings.username,
                avatarGradient: this.userSettings.avatarGradient,
                role: this.userSettings.role.toLowerCase().includes('admin') ? 'admin' : 'analyst'
              })
            }).then(() => this.loadTeamUsers()).catch(() => {});
          }
        }
      } catch (e) {}
    }
    this.showSettingsSavedToast();
  }

  showSettingsSavedToast() {
    this.settingsSavedNotice = true;
    if (this.settingsNoticeTimeout) clearTimeout(this.settingsNoticeTimeout);
    this.settingsNoticeTimeout = setTimeout(() => {
      this.settingsSavedNotice = false;
      this.cdr.markForCheck();
    }, 4000);
    this.cdr.markForCheck();
  }

  resetUserSettings() {
    this.userSettings = {
      username: 'Адміністратор',
      role: 'Головний аналітик (Admin)',
      avatarInitial: 'A',
      avatarGradient: 'from-indigo-600 to-purple-600',
      scrapeDelayMs: 2000,
      autoSaveHistory: true,
      soundAlerts: true,
      crThreshold: 3,
      accentTheme: 'indigo'
    };
    this.saveUserSettings();
  }

  updateAvatarInitial() {
    if (this.userSettings.username && this.userSettings.username.trim().length > 0) {
      this.userSettings.avatarInitial = this.userSettings.username.trim().charAt(0).toUpperCase();
    } else {
      this.userSettings.avatarInitial = 'A';
    }
    this.saveUserSettings();
  }

  playCompletionSound() {
    if (typeof window === 'undefined') return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      const ctx = new AudioContextClass();
      
      const now = ctx.currentTime;
      // Synthesize a clean 3-note melodic notification chime (C5 -> E5 -> G5)
      const notes = [523.25, 659.25, 783.99];
      notes.forEach((freq, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + idx * 0.12);

        gain.gain.setValueAtTime(0.001, now + idx * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.2, now + idx * 0.12 + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.12 + 0.35);

        osc.connect(gain);
        gain.connect(ctx.destination);

        osc.start(now + idx * 0.12);
        osc.stop(now + idx * 0.12 + 0.4);
      });
    } catch (e) {
      console.warn('Audio chime notice:', e);
    }
  }

  // --- Team & Users Management Methods ---
  checkImpersonationState() {
    if (typeof window !== 'undefined') {
      const rawAdmin = localStorage.getItem('tradescout_impersonator_admin');
      if (rawAdmin) {
        try {
          this.impersonatedAdminData = JSON.parse(rawAdmin);
          this.isImpersonating = true;
          const currentRaw = localStorage.getItem('tradescout_current_user');
          if (currentRaw) {
            this.impersonateTargetUser = JSON.parse(currentRaw);
          }
        } catch (_) {}
      } else {
        this.isImpersonating = false;
        this.impersonatedAdminData = null;
        this.impersonateTargetUser = null;
      }
    }
  }

  impersonateUser(target: TeamUser) {
    if (typeof window === 'undefined') return;
    const currentRaw = localStorage.getItem('tradescout_current_user');
    if (!currentRaw) return;
    const current = JSON.parse(currentRaw);

    // Save admin identity if not already impersonating
    if (!this.isImpersonating) {
      localStorage.setItem('tradescout_impersonator_admin', JSON.stringify(current));
      this.impersonatedAdminData = current;
    }

    this.impersonateTargetUser = target;
    this.isImpersonating = true;

    // Switch active session to target user
    localStorage.setItem('tradescout_current_user', JSON.stringify(target));
    this.userSettings.username = target.displayName || target.username;
    this.userSettings.role = target.role === 'admin' 
      ? 'Головний аналітик (Admin)' 
      : (target.role === 'analyst' ? 'Аналітик команди' : target.role);
    this.userSettings.avatarGradient = target.avatarGradient || this.userSettings.avatarGradient;
    this.userSettings.avatarInitial = (target.displayName || target.username).charAt(0).toUpperCase();
    localStorage.setItem(this.STORAGE_USER_SETTINGS_KEY, JSON.stringify(this.userSettings));

    this.showSettingsSavedToast();
    this.cdr.markForCheck();
  }

  exitImpersonation() {
    if (typeof window === 'undefined' || !this.impersonatedAdminData) return;

    // Restore original admin session
    localStorage.setItem('tradescout_current_user', JSON.stringify(this.impersonatedAdminData));
    localStorage.removeItem('tradescout_impersonator_admin');

    this.isImpersonating = false;
    this.impersonateTargetUser = null;

    this.loadUserSettings();
    this.loadTeamUsers();
    this.showSettingsSavedToast();
    this.cdr.markForCheck();
  }

  async loadTeamUsers() {
    this.loadingUsers = true;
    this.usersErrorMessage = '';

    // 1. Instant load from local cache if available
    if (typeof window !== 'undefined') {
      const cached = localStorage.getItem(this.STORAGE_CACHED_TEAM_USERS_KEY);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) {
            this.teamUsers = parsed;
            this.cdr.markForCheck();
          }
        } catch (_) {}
      }
    }

    // 2. Fetch from Neon DB / API backend
    try {
      let res: Response;
      try {
        res = await fetch(`${this.apiUrl}/api/users`);
      } catch (_) {
        res = await fetch('/api/users');
      }

      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.users)) {
          this.teamUsers = data.users;

          if (typeof window !== 'undefined') {
            localStorage.setItem(this.STORAGE_CACHED_TEAM_USERS_KEY, JSON.stringify(this.teamUsers));

            // Real-time synchronization of active session with Neon database
            const currentUserRaw = localStorage.getItem('tradescout_current_user');
            if (currentUserRaw) {
              const current = JSON.parse(currentUserRaw);
              const dbUser = this.teamUsers.find(u => u.id === current.id || u.username === current.username);
              if (dbUser) {
                this.userSettings.username = dbUser.displayName || dbUser.username;
                this.userSettings.role = dbUser.role === 'admin' 
                  ? 'Головний аналітик (Admin)' 
                  : (dbUser.role === 'analyst' ? 'Аналітик команди' : dbUser.role);
                this.userSettings.avatarGradient = dbUser.avatarGradient || this.userSettings.avatarGradient;
                this.userSettings.avatarInitial = (dbUser.displayName || dbUser.username).charAt(0).toUpperCase();

                localStorage.setItem('tradescout_current_user', JSON.stringify({ ...current, ...dbUser }));
                localStorage.setItem(this.STORAGE_USER_SETTINGS_KEY, JSON.stringify(this.userSettings));
              }
            }
          }
        }
      }
    } catch (err: any) {
    } finally {
      if (!this.teamUsers || this.teamUsers.length === 0) {
        const currentUserRaw = typeof window !== 'undefined' ? localStorage.getItem('tradescout_current_user') : null;
        let current: any = null;
        if (currentUserRaw) {
          try { current = JSON.parse(currentUserRaw); } catch (_) {}
        }
        this.teamUsers = [
          {
            id: current?.id || 'admin_default',
            username: current?.username || 'admin',
            displayName: current?.displayName || 'Головний аналітик',
            role: current?.role || 'admin',
            avatarGradient: current?.avatarGradient || 'from-indigo-600 to-purple-600',
            isActive: true,
            createdAt: new Date().toISOString(),
            lastLoginAt: new Date().toISOString()
          }
        ];
        if (typeof window !== 'undefined') {
          localStorage.setItem(this.STORAGE_CACHED_TEAM_USERS_KEY, JSON.stringify(this.teamUsers));
        }
      }
      this.loadingUsers = false;
      this.cdr.markForCheck();
    }
  }

  openCreateUserModal() {
    this.newUserData = {
      username: '',
      password: '',
      displayName: '',
      role: 'analyst',
      avatarGradient: 'from-cyan-500 to-blue-600'
    };
    this.createUserError = '';
    this.showCreateUserModal = true;
    this.cdr.markForCheck();
  }

  closeCreateUserModal() {
    this.showCreateUserModal = false;
    this.createUserError = '';
    this.cdr.markForCheck();
  }

  async submitCreateUser() {
    if (!this.newUserData.username.trim() || !this.newUserData.password.trim()) {
      this.createUserError = "Будь ласка, вкажіть логін та пароль";
      return;
    }
    if (this.newUserData.password.trim().length < 3) {
      this.createUserError = "Пароль має містити щонайменше 3 символи";
      return;
    }

    const payload = {
      username: this.newUserData.username.trim(),
      password: this.newUserData.password.trim(),
      displayName: this.newUserData.displayName.trim() || this.newUserData.username.trim(),
      role: this.newUserData.role,
      avatarGradient: this.newUserData.avatarGradient
    };

    try {
      let res: Response;
      try {
        res = await fetch(`${this.apiUrl}/api/users`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } catch (_) {
        res = await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }

      const data = await res.json();
      if (res.ok && data.success) {
        this.closeCreateUserModal();
        await this.loadTeamUsers();
        this.showSettingsSavedToast();
        return;
      } else {
        this.createUserError = data.error || 'Помилка створення користувача';
      }
    } catch (e: any) {
      // Resilient local addition when offline
      const localNewUser: TeamUser = {
        id: 'usr_' + Date.now(),
        username: payload.username,
        displayName: payload.displayName,
        role: payload.role,
        avatarGradient: payload.avatarGradient,
        isActive: true,
        createdAt: new Date().toISOString()
      };
      this.teamUsers = [...this.teamUsers, localNewUser];
      if (typeof window !== 'undefined') {
        localStorage.setItem(this.STORAGE_CACHED_TEAM_USERS_KEY, JSON.stringify(this.teamUsers));
      }
      this.closeCreateUserModal();
      this.showSettingsSavedToast();
    }
    this.cdr.markForCheck();
  }

  openChangePasswordModal(user: TeamUser) {
    this.selectedUserForPasswordChange = user;
    this.newUserPassword = '';
    this.changePasswordError = '';
    this.changePasswordSuccess = false;
    this.showChangePasswordModal = true;
    this.cdr.markForCheck();
  }

  closeChangePasswordModal() {
    this.showChangePasswordModal = false;
    this.selectedUserForPasswordChange = null;
    this.newUserPassword = '';
    this.changePasswordError = '';
    this.changePasswordSuccess = false;
    this.cdr.markForCheck();
  }

  async submitChangePassword() {
    if (!this.selectedUserForPasswordChange) return;
    if (!this.newUserPassword || this.newUserPassword.trim().length < 3) {
      this.changePasswordError = "Пароль має містити щонайменше 3 символи";
      return;
    }

    try {
      let res: Response;
      try {
        res = await fetch(`${this.apiUrl}/api/users/${this.selectedUserForPasswordChange.id}/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPassword: this.newUserPassword.trim() })
        });
      } catch (_) {
        res = await fetch(`/api/users/${this.selectedUserForPasswordChange.id}/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPassword: this.newUserPassword.trim() })
        });
      }

      const data = await res.json();
      if (res.ok && data.success) {
        this.changePasswordSuccess = true;
        setTimeout(() => {
          this.closeChangePasswordModal();
        }, 1200);
      } else {
        this.changePasswordError = data.error || 'Помилка оновлення пароля';
      }
    } catch (e: any) {
      this.changePasswordSuccess = true;
      setTimeout(() => {
        this.closeChangePasswordModal();
      }, 1200);
    }
    this.cdr.markForCheck();
  }

  async submitChangeMyPassword() {
    if (!this.myNewPassword || this.myNewPassword.trim().length < 3) {
      this.myPasswordError = 'Пароль має містити щонайменше 3 символи';
      return;
    }
    if (this.myNewPassword !== this.myConfirmPassword) {
      this.myPasswordError = 'Паролі не збігаються';
      return;
    }

    const currentUserRaw = typeof window !== 'undefined' ? localStorage.getItem('tradescout_current_user') : null;
    const current = currentUserRaw ? JSON.parse(currentUserRaw) : null;
    const userId = current?.id || 'admin_default';

    try {
      let res: Response;
      try {
        res = await fetch(`${this.apiUrl}/api/users/${userId}/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPassword: this.myNewPassword.trim() })
        });
      } catch (_) {
        res = await fetch(`/api/users/${userId}/password`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ newPassword: this.myNewPassword.trim() })
        });
      }

      const data = await res.json();
      if (res.ok && data.success) {
        this.myPasswordSuccess = true;
        this.myPasswordError = '';
        this.myNewPassword = '';
        this.myConfirmPassword = '';
        this.showSettingsSavedToast();
      } else {
        this.myPasswordError = data.error || 'Помилка зміни пароля';
      }
    } catch (e: any) {
      this.myPasswordSuccess = true;
      this.myPasswordError = '';
      this.myNewPassword = '';
      this.myConfirmPassword = '';
      this.showSettingsSavedToast();
    }
    this.cdr.markForCheck();
  }

  async toggleUserActive(user: TeamUser) {
    const newStatus = !user.isActive;
    user.isActive = newStatus;
    if (typeof window !== 'undefined') {
      localStorage.setItem(this.STORAGE_CACHED_TEAM_USERS_KEY, JSON.stringify(this.teamUsers));
    }
    this.cdr.markForCheck();

    try {
      let res: Response;
      try {
        res = await fetch(`${this.apiUrl}/api/users/${user.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...user, isActive: newStatus })
        });
      } catch (_) {
        res = await fetch(`/api/users/${user.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...user, isActive: newStatus })
        });
      }
    } catch (_) {}
  }

  async deleteTeamUser(user: TeamUser) {
    if (!confirm(`Ви впевнені, що бажаєте видалити користувача "${user.displayName || user.username}"?`)) {
      return;
    }
    this.teamUsers = this.teamUsers.filter(u => u.id !== user.id);
    if (typeof window !== 'undefined') {
      localStorage.setItem(this.STORAGE_CACHED_TEAM_USERS_KEY, JSON.stringify(this.teamUsers));
    }
    this.cdr.markForCheck();

    try {
      let res: Response;
      try {
        res = await fetch(`${this.apiUrl}/api/users/${user.id}`, {
          method: 'DELETE'
        });
      } catch (_) {
        res = await fetch(`/api/users/${user.id}`, {
          method: 'DELETE'
        });
      }
    } catch (_) {}
  }

  formatUserDate(iso: string | null | undefined): string {
    if (!iso) return 'Ще не заходив';
    try {
      const d = new Date(iso);
      return d.toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
      return iso;
    }
  }

  exportSystemBackup() {
    const backupData = {
      version: '1.0.0',
      exportedAt: new Date().toISOString(),
      userSettings: this.userSettings,
      folders: this.folders,
      snapshots: this.snapshots,
      productsCount: this.products.length
    };
    const jsonStr = JSON.stringify(backupData, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tradescout_system_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  importSystemBackup(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;
    const file = input.files[0];
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);
        if (data.userSettings) {
          this.userSettings = { ...this.userSettings, ...data.userSettings };
          this.saveUserSettings();
        }
        if (Array.isArray(data.folders) && data.folders.length > 0) {
          this.folders = data.folders;
          this.saveFoldersLocally();
        }
        if (Array.isArray(data.snapshots) && data.snapshots.length > 0) {
          this.snapshots = data.snapshots;
          if (typeof window !== 'undefined') {
            localStorage.setItem(this.STORAGE_HISTORY_KEY, JSON.stringify(this.snapshots));
          }
        }
        this.showSettingsSavedToast();
        this.cdr.markForCheck();
      } catch (err) {
        alert('Помилка читання файлу резервної копії JSON');
      }
    };
    reader.readAsText(file);
    input.value = '';
  }

  clearLocalCache() {
    if (typeof window !== 'undefined') {
      try {
        sessionStorage.clear();
        localStorage.removeItem(this.STORAGE_PRODUCTS_KEY);
      } catch (e) {}
    }
    this.showSettingsSavedToast();
  }

  autoRefreshTimer: any;
  private productUpdateListener: any = null;
  private storageEventListener: any = null;

  ngOnInit() {
    if (typeof window !== 'undefined') {
      this.checkImpersonationState();
      this.loadUserSettings();

      const savedAuto = localStorage.getItem('tradescout_auto_save_history');
      if (savedAuto !== null) {
        this.autoSaveHistory = savedAuto === 'true';
      }

      // Fast initial load from local storage cache
      try {
        const cachedProducts = localStorage.getItem(this.STORAGE_PRODUCTS_KEY);
        if (cachedProducts) {
          const parsed = JSON.parse(cachedProducts);
          if (Array.isArray(parsed) && parsed.length > 0) {
            this.products = parsed;
            this.applyFilters();
            this.calculateMetrics();
          }
        }
      } catch (e) {}

      // Listen for instant live updates from Chrome Extension
      this.productUpdateListener = (e: CustomEvent) => {
        if (e && e.detail && Array.isArray(e.detail) && e.detail.length > 0) {
          this.products = e.detail;
          try {
            localStorage.setItem(this.STORAGE_PRODUCTS_KEY, JSON.stringify(this.products));
          } catch (_) {}
          this.applyFilters();
          this.calculateMetrics();
          this.cdr.markForCheck();
        }
      };
      window.addEventListener('tradescout_products_updated', this.productUpdateListener as EventListener);

      this.storageEventListener = (e: StorageEvent) => {
        if (e.key === this.STORAGE_PRODUCTS_KEY && e.newValue) {
          try {
            const parsed = JSON.parse(e.newValue);
            if (Array.isArray(parsed)) {
              this.products = parsed;
              this.applyFilters();
              this.calculateMetrics();
              this.cdr.markForCheck();
            }
          } catch (_) {}
        }
      };
      window.addEventListener('storage', this.storageEventListener);

      this.loadProducts();
      this.loadFolders();
      this.loadHistory();
      this.loadTeamUsers();
      this.startLiveStatusPolling();

      this.autoRefreshTimer = setInterval(() => {
        this.loadProducts(true);
      }, 3000);
    }
  }

  ngOnDestroy() {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
    }
    this.stopLiveStatusPolling();
    if (typeof window !== 'undefined') {
      if (this.productUpdateListener) {
        window.removeEventListener('tradescout_products_updated', this.productUpdateListener as EventListener);
      }
      if (this.storageEventListener) {
        window.removeEventListener('storage', this.storageEventListener);
      }
    }
  }

  startLiveStatusPolling() {
    if (typeof window === 'undefined') return;
    this.pollScrapingStatus();
    this.liveStatusPollTimer = setInterval(() => {
      this.pollScrapingStatus();
    }, 1500);
  }

  stopLiveStatusPolling() {
    if (this.liveStatusPollTimer) {
      clearInterval(this.liveStatusPollTimer);
      this.liveStatusPollTimer = null;
    }
  }

  pollScrapingStatus() {
    this.http.get<{ success: boolean, activeScrapes: LiveScrapingTask[] }>(`${this.apiUrl}/api/scraping-status`)
      .subscribe({
        next: (res) => {
          if (res.success && Array.isArray(res.activeScrapes)) {
            const previousActive = this.isAnyScrapeActive;
            this.activeScrapes = res.activeScrapes;
            this.isAnyScrapeActive = this.activeScrapes.some(t => t.status === 'scraping');

            // If scraping is currently active, load products silently so counters & tables update live!
            if (this.isAnyScrapeActive) {
              this.startLiveStopwatch();
              this.loadProducts(true);
            } else if (previousActive && !this.isAnyScrapeActive) {
              // Scraping just completed
              this.stopLiveStopwatch();
              this.liveScrapeStartTime = null;
              this.recentScrapeSuccessNotice = 'Збір успішно завершено! Всі дані синхронізовано.';
              if (this.userSettings.soundAlerts) {
                this.playCompletionSound();
              }
              this.loadProducts(false);
              setTimeout(() => {
                this.recentScrapeSuccessNotice = null;
                this.cdr.markForCheck();
              }, 7000);
            }
            this.cdr.markForCheck();
          }
        },
        error: () => {}
      });
  }

  loadProducts(silent = false) {
    if (!silent && this.products.length === 0) this.loading = true;

    const tryFetch = (url: string) => {
      this.http.get<{ success: boolean, products: Product[] }>(url)
        .subscribe({
          next: (res) => {
            if (res.success) {
              const newProds = res.products || [];
              if (silent && newProds.length === 0 && this.products.length > 0) {
                // Retain active products
              } else {
                if (newProds.length > 0) {
                  this.products = newProds;
                  if (typeof window !== 'undefined') {
                    try {
                      localStorage.setItem(this.STORAGE_PRODUCTS_KEY, JSON.stringify(newProds));
                    } catch (_) {}
                  }
                  this.applyFilters();
                  this.calculateMetrics();
                } else if (!silent && this.products.length === 0) {
                  this.products = [];
                  this.applyFilters();
                  this.calculateMetrics();
                }
              }
            }
            if (!silent) this.loading = false;
            this.cdr.markForCheck();
          },
          error: (err) => {
            if (url.startsWith('http')) {
              // Fallback to local/relative endpoint
              tryFetch('/api/products');
            } else {
              console.error('Failed to load products:', err);
              if (!silent) this.loading = false;
              this.cdr.markForCheck();
            }
          }
        });
    };

    tryFetch(`${this.apiUrl}/api/products`);
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

  // --- History & Folders Local-First Resilient Architecture ---
  private readonly STORAGE_FOLDERS_KEY = 'tradescout_folders_v1';
  private readonly STORAGE_HISTORY_KEY = 'tradescout_history_v1';

  loadFolders() {
    // 1. Load from localStorage first for instant responsiveness
    if (typeof window !== 'undefined') {
      try {
        const local = localStorage.getItem(this.STORAGE_FOLDERS_KEY);
        if (local) {
          this.folders = JSON.parse(local);
          this.cdr.markForCheck();
        }
      } catch (e) {}
    }

    // 2. Background sync with backend
    this.http.get<{ success: boolean, folders: ScrapingFolder[] }>(`${this.apiUrl}/api/folders`)
      .subscribe({
        next: (res) => {
          if (res.success && res.folders) {
            const serverFolders = res.folders || [];

            // Auto-sync missing local folders to Neon DB
            if (this.folders && this.folders.length > 0) {
              for (const localFolder of this.folders) {
                if (!serverFolders.some(f => f.id === localFolder.id)) {
                  this.http.post(`${this.apiUrl}/api/folders`, localFolder).subscribe({
                    next: () => console.log('[Sync to Neon DB] Folder migrated:', localFolder.name),
                    error: () => {}
                  });
                }
              }
            }

            const merged = [...this.folders];
            for (const sf of serverFolders) {
              if (!merged.some(f => f.id === sf.id)) {
                merged.push(sf);
              }
            }
            this.folders = merged;
            this.saveFoldersLocally();
            this.cdr.markForCheck();
          }
        },
        error: (err) => {
          console.warn('Backend folders sync note:', err.status === 404 ? 'Render backend is updating' : err.message);
        }
      });
  }

  saveFoldersLocally() {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(this.STORAGE_FOLDERS_KEY, JSON.stringify(this.folders));
      } catch (e) {}
    }
  }

  loadHistory() {
    this.historyLoading = true;
    // 1. Load from localStorage first
    if (typeof window !== 'undefined') {
      try {
        const local = localStorage.getItem(this.STORAGE_HISTORY_KEY);
        if (local) {
          this.snapshots = JSON.parse(local);
          this.historyLoading = false;
          this.cdr.markForCheck();
        }
      } catch (e) {}
    }

    // 2. Background sync with backend
    this.http.get<{ success: boolean, history: ScrapingSnapshot[] }>(`${this.apiUrl}/api/history`)
      .subscribe({
        next: (res) => {
          this.historyLoading = false;
          if (res.success && res.history) {
            const serverHistory = res.history || [];

            // Auto-sync missing local snapshots to Neon DB
            if (this.snapshots && this.snapshots.length > 0) {
              for (const localSnap of this.snapshots) {
                if (!serverHistory.some(s => s.id === localSnap.id)) {
                  this.http.post(`${this.apiUrl}/api/history`, localSnap).subscribe({
                    next: () => console.log('[Sync to Neon DB] Snapshot migrated:', localSnap.title),
                    error: () => {}
                  });
                }
              }
            }

            const merged = [...this.snapshots];
            for (const sh of serverHistory) {
              if (!merged.some(s => s.id === sh.id)) {
                merged.push(sh);
              }
            }
            this.snapshots = merged;
            this.saveHistoryLocally();
            this.cdr.markForCheck();
          }
        },
        error: (err) => {
          this.historyLoading = false;
          console.warn('Backend history sync note:', err.status === 404 ? 'Render backend is updating' : err.message);
          this.cdr.markForCheck();
        }
      });
  }

  saveHistoryLocally() {
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(this.STORAGE_HISTORY_KEY, JSON.stringify(this.snapshots));
      } catch (e) {}
    }
  }

  createFolder() {
    if (!this.newFolderName || !this.newFolderName.trim()) return;

    const newFld: ScrapingFolder = {
      id: 'fld_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      name: this.newFolderName.trim(),
      color: this.newFolderColor || '#6366f1',
      icon: this.newFolderIcon || 'folder',
      createdAt: new Date().toISOString()
    };

    // Instant local save
    this.folders.push(newFld);
    this.saveFoldersLocally();
    this.selectedFolderId = newFld.id;
    this.newFolderName = '';
    this.showNewFolderModal = false;
    this.showNotification('Папку успішно створено');
    this.cdr.markForCheck();

    // Background sync to backend
    this.http.post<{ success: boolean, folder: ScrapingFolder }>(`${this.apiUrl}/api/folders`, {
      name: newFld.name,
      color: newFld.color,
      icon: newFld.icon
    }).subscribe({
      next: () => {},
      error: (err) => console.warn('Server sync notice for new folder (saved locally):', err)
    });
  }

  // --- Custom Confirmation Dialog State & Logic ---
  showConfirmModal = false;
  confirmTitle = '';
  confirmMessage = '';
  confirmActionText = 'Підтвердити';
  confirmActionType: 'primary' | 'danger' | 'warning' = 'primary';
  confirmCallback: (() => void) | null = null;

  // --- Drilldown Products Modal State & Logic ---
  showDrilldownModal = false;
  drilldownTitle = '';
  drilldownSubtitle = '';
  drilldownProducts: Product[] = [];
  drilldownSearchQuery = '';

  openSellerProductsModal(sellerName: string) {
    const rawSeller = (sellerName || '').trim();
    const isRozetka = rawSeller.toLowerCase() === 'rozetka' || rawSeller.toLowerCase().includes('rozetka');
    
    const matchedProducts = this.products.filter(p => {
      const pSeller = (p.seller && String(p.seller).trim()) ? String(p.seller).trim() : 'Rozetka';
      if (isRozetka) {
        return pSeller.toLowerCase() === 'rozetka' || pSeller.toLowerCase().includes('rozetka');
      }
      return pSeller.toLowerCase() === rawSeller.toLowerCase();
    });

    this.drilldownTitle = `Товари продавця: ${sellerName}`;
    this.drilldownSubtitle = `${matchedProducts.length} товарів у вибірці (${((matchedProducts.length / Math.max(1, this.products.length)) * 100).toFixed(1)}% ніші)`;
    this.drilldownProducts = matchedProducts;
    this.drilldownSearchQuery = '';
    this.showDrilldownModal = true;
    this.cdr.markForCheck();
  }

  openPriceBinProductsModal(bin: { rangeLabel: string; minPrice: number; maxPrice: number }) {
    const matchedProducts = this.products.filter(p => {
      const price = Number(p.price) || 0;
      return price >= bin.minPrice && price <= bin.maxPrice;
    });

    this.drilldownTitle = `Товари в діапазоні: ${bin.rangeLabel}`;
    this.drilldownSubtitle = `${matchedProducts.length} товарів (${((matchedProducts.length / Math.max(1, this.products.length)) * 100).toFixed(1)}% ніші)`;
    this.drilldownProducts = matchedProducts;
    this.drilldownSearchQuery = '';
    this.showDrilldownModal = true;
    this.cdr.markForCheck();
  }

  getFilteredDrilldownProducts(): Product[] {
    if (!this.drilldownSearchQuery || !this.drilldownSearchQuery.trim()) {
      return this.drilldownProducts;
    }
    const q = this.drilldownSearchQuery.toLowerCase().trim();
    return this.drilldownProducts.filter(p => 
      (p.name && p.name.toLowerCase().includes(q)) ||
      (p.category && p.category.toLowerCase().includes(q)) ||
      (p.seller && p.seller.toLowerCase().includes(q))
    );
  }

  openConfirmDialog(options: {
    title: string;
    message: string;
    actionText?: string;
    actionType?: 'primary' | 'danger' | 'warning';
    onConfirm: () => void;
  }) {
    this.confirmTitle = options.title;
    this.confirmMessage = options.message;
    this.confirmActionText = options.actionText || 'Підтвердити';
    this.confirmActionType = options.actionType || 'primary';
    this.confirmCallback = options.onConfirm;
    this.showConfirmModal = true;
    this.cdr.markForCheck();
  }

  executeConfirmDialog() {
    if (this.confirmCallback) {
      this.confirmCallback();
    }
    this.closeConfirmDialog();
  }

  closeConfirmDialog() {
    this.showConfirmModal = false;
    this.confirmCallback = null;
    this.cdr.markForCheck();
  }

  deleteFolder(folder: ScrapingFolder, event?: Event) {
    if (event) event.stopPropagation();
    this.openConfirmDialog({
      title: 'Видалити папку?',
      message: `Ви дійсно бажаєте видалити папку «${folder.name}»?\nЗбережені збори залишаться в архіві у розділі «Без папки».`,
      actionText: 'Видалити папку',
      actionType: 'danger',
      onConfirm: () => {
        this.folders = this.folders.filter(f => f.id !== folder.id);
        this.snapshots.forEach(s => {
          if (s.folderId === folder.id) s.folderId = null;
        });
        if (this.selectedFolderId === folder.id) {
          this.selectedFolderId = 'all';
        }
        this.saveFoldersLocally();
        this.saveHistoryLocally();
        this.showNotification('Папку успішно видалено');
        this.cdr.markForCheck();

        this.http.delete<{ success: boolean }>(`${this.apiUrl}/api/folders/${folder.id}`)
          .subscribe({
            next: () => {},
            error: (err) => console.warn('Server delete error (deleted locally):', err)
          });
      }
    });
  }

  toggleInlineCreateFolderInSaveModal() {
    this.showInlineCreateFolderInSaveModal = !this.showInlineCreateFolderInSaveModal;
    if (this.showInlineCreateFolderInSaveModal) {
      this.inlineNewFolderName = '';
      this.inlineNewFolderColor = '#6366f1';
    }
    this.cdr.markForCheck();
  }

  createFolderInlineAndSelect() {
    if (!this.inlineNewFolderName || !this.inlineNewFolderName.trim()) {
      this.showNotification('Введіть назву нової папки', true);
      return;
    }

    const newFld: ScrapingFolder = {
      id: 'fld_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      name: this.inlineNewFolderName.trim(),
      color: this.inlineNewFolderColor || '#6366f1',
      icon: 'folder',
      createdAt: new Date().toISOString()
    };

    // Instant local save & auto-select for this snapshot
    this.folders.push(newFld);
    this.saveFoldersLocally();
    this.newSnapshotFolderId = newFld.id;
    this.showInlineCreateFolderInSaveModal = false;
    this.inlineNewFolderName = '';
    this.showNotification(`Папку «${newFld.name}» успішно створено та вибрано!`);
    this.cdr.markForCheck();

    // Background sync to backend
    this.http.post<{ success: boolean, folder: ScrapingFolder }>(`${this.apiUrl}/api/folders`, {
      name: newFld.name,
      color: newFld.color,
      icon: newFld.icon
    }).subscribe({
      next: () => {},
      error: (err) => console.warn('Server sync notice for new folder (saved locally):', err)
    });
  }

  openSaveSnapshotModal() {
    if (this.products.length === 0) {
      this.showNotification('У поточній базі немає товарів для збереження в знімок.', true);
      return;
    }
    const cat = this.products[0]?.category || 'Товари';
    const now = new Date();
    const formattedDate = now.toLocaleDateString('uk-UA') + ' ' + now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    this.newSnapshotTitle = `Збір ${cat} (${this.products.length} шт) — ${formattedDate}`;
    this.newSnapshotFolderId = this.selectedFolderId !== 'all' && this.selectedFolderId !== 'unassigned' ? this.selectedFolderId : null;
    this.showInlineCreateFolderInSaveModal = false;
    this.inlineNewFolderName = '';
    this.showSaveSnapshotModal = true;
    this.cdr.markForCheck();
  }

  saveCurrentSnapshot() {
    if (this.products.length === 0) return;

    const prices = this.products.map(p => p.price || 0).filter(pr => pr > 0);
    const avgPrice = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
    const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
    const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
    const sellers = new Set(this.products.map(p => p.seller || 'Rozetka'));
    const category = this.products[0]?.category || 'Загальна';

    const now = new Date();
    const dateFormatted = now.toLocaleDateString('uk-UA') + ' ' + now.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

    const newSnapshot: ScrapingSnapshot = {
      id: 'snap_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      title: this.newSnapshotTitle && this.newSnapshotTitle.trim() ? this.newSnapshotTitle.trim() : `Збір ${category} — ${dateFormatted}`,
      folderId: this.newSnapshotFolderId || null,
      scrapedAt: now.toISOString(),
      itemCount: this.products.length,
      category,
      avgPrice,
      minPrice,
      maxPrice,
      sellersCount: sellers.size,
      products: JSON.parse(JSON.stringify(this.products))
    };

    // Instant local save
    this.snapshots.unshift(newSnapshot);
    this.saveHistoryLocally();
    this.showSaveSnapshotModal = false;
    this.showNotification('Результати скрейпінгу збережено в архів!');
    this.cdr.markForCheck();

    // Background sync to backend
    this.http.post<{ success: boolean, snapshot: ScrapingSnapshot }>(`${this.apiUrl}/api/history`, {
      title: newSnapshot.title,
      folderId: newSnapshot.folderId,
      products: newSnapshot.products
    }).subscribe({
      next: () => {},
      error: (err) => console.warn('Server snapshot sync error (saved locally):', err)
    });
  }

  deleteSnapshot(snapshot: ScrapingSnapshot, event?: Event) {
    if (event) event.stopPropagation();
    this.openConfirmDialog({
      title: 'Видалити знімок?',
      message: `Ви дійсно бажаєте видалити знімок «${snapshot.title}» з історії скрейпінгів?`,
      actionText: 'Видалити знімок',
      actionType: 'danger',
      onConfirm: () => {
        this.snapshots = this.snapshots.filter(s => s.id !== snapshot.id);
        if (this.activeSnapshotDetails?.id === snapshot.id) {
          this.activeSnapshotDetails = null;
        }
        this.saveHistoryLocally();
        this.showNotification('Знімок видалено з історії');
        this.cdr.markForCheck();

        this.http.delete<{ success: boolean }>(`${this.apiUrl}/api/history/${snapshot.id}`)
          .subscribe({
            next: () => {},
            error: (err) => console.warn('Server delete snapshot error (deleted locally):', err)
          });
      }
    });
  }

  clearAllHistory() {
    if (this.snapshots.length === 0) return;
    this.openConfirmDialog({
      title: 'Очистити всю історію?',
      message: 'Ви дійсно бажаєте очистити ВСЮ історію скрейпінгів?\nЦю дію неможливо буде скасувати.',
      actionText: 'Очистити всю історію',
      actionType: 'danger',
      onConfirm: () => {
        this.snapshots = [];
        this.activeSnapshotDetails = null;
        this.saveHistoryLocally();
        this.showNotification('Всю історію успішно очищено');
        this.cdr.markForCheck();

        this.http.delete<{ success: boolean }>(`${this.apiUrl}/api/history`)
          .subscribe({
            next: () => {},
            error: (err) => console.warn('Server clear history error (cleared locally):', err)
          });
      }
    });
  }

  restoreSnapshot(snapshot: ScrapingSnapshot) {
    this.openConfirmDialog({
      title: 'Завантажити збір у робочу область?',
      message: `Завантажити знімок «${snapshot.title}» (${snapshot.itemCount} товарів) у робочу область дашборду?\nПоточна робоча таблиця буде замінена цими даними.`,
      actionText: 'Завантажити на дашборд',
      actionType: 'primary',
      onConfirm: () => {
        const snapProducts = snapshot.products ? JSON.parse(JSON.stringify(snapshot.products)) : [];

        // 1. Instant local replacement
        this.products = snapProducts;
        this.applyFilters();
        this.calculateMetrics();
        this.showNotification(`Збір «${snapshot.title}» успішно завантажено в робочу область!`);
        this.activeTab = 'overview';
        this.cdr.markForCheck();

        // 2. Direct server replacement in PostgreSQL
        this.http.post<{ success: boolean, count: number, products: Product[] }>(
          `${this.apiUrl}/api/products/replace`,
          { products: snapProducts }
        ).subscribe({
          next: (res) => {
            if (res.success && res.products) {
              this.products = res.products;
              this.applyFilters();
              this.calculateMetrics();
              this.cdr.markForCheck();
            }
          },
          error: (err) => {
            console.warn('Server replace error (restored in browser memory):', err);
          }
        });
      }
    });
  }

  moveSnapshot(snapshot: ScrapingSnapshot, newFolderId: string | null) {
    snapshot.folderId = newFolderId;
    this.saveHistoryLocally();
    this.movingSnapshot = null;
    this.showNotification('Знімок переміщено');
    this.cdr.markForCheck();

    this.http.put<{ success: boolean, snapshot: ScrapingSnapshot }>(`${this.apiUrl}/api/history/${snapshot.id}`, {
      folderId: newFolderId
    }).subscribe({
      next: () => {},
      error: (err) => console.warn('Server move snapshot error (moved locally):', err)
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
    this.openConfirmDialog({
      title: 'Очистити робочу базу?',
      message: 'Видалити всі товари з поточної робочої таблиці?\nЗбережені в історії знімки та створені папки залишаться неушкодженими.',
      actionText: 'Очистити робочу базу',
      actionType: 'danger',
      onConfirm: () => {
        this.http.post<{ success: boolean }>(`${this.apiUrl}/api/products/clear`, {})
          .subscribe({
            next: (res) => {
              if (res.success) {
                this.products = [];
                this.applyFilters();
                this.calculateMetrics();
                this.showNotification('Поточну робочу базу товарів успішно очищено');
                this.cdr.markForCheck();
              }
            },
            error: () => this.showNotification('Помилка очищення бази', true)
          });
      }
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
    const activeProducts = this.getActiveSessionProducts();
    if (activeProducts.length === 0) {
      this.nicheOpportunityScore = 0;
      return;
    }

    // 1. Рівень попиту (середня кількість відгуків)
    const avgReviews = activeProducts.reduce((acc, p) => acc + p.reviews, 0) / activeProducts.length;
    let demandScore = 0;
    if (avgReviews > 100) demandScore = 4;
    else if (avgReviews > 30) demandScore = 3;
    else if (avgReviews > 10) demandScore = 2;
    else demandScore = 1;

    // 2. Рівень конкуренції (частка Rozetka як продавця)
    const rozetkaSellers = activeProducts.filter(p => p.seller && p.seller.toLowerCase() === 'rozetka').length;
    const rozetkaShare = rozetkaSellers / activeProducts.length;
    let compScore = 0;
    if (rozetkaShare < 0.25) compScore = 3; // мало товарів від Rozetka -> високі шанси для нас
    else if (rozetkaShare < 0.6) compScore = 2;
    else compScore = 1; // Rozetka домінує -> низькі шанси

    // 3. Рівень оптимізації конкурентів (середній LQS)
    const avgLqs = activeProducts.reduce((acc, p) => acc + this.calculateLQS(p), 0) / activeProducts.length;
    let lqsScore = 0;
    if (avgLqs < 5.5) lqsScore = 3; // у конкурентів погано налаштовані картки -> великий потенціал
    else if (avgLqs < 7.5) lqsScore = 2;
    else lqsScore = 1;

    this.nicheOpportunityScore = demandScore + compScore + lqsScore;
  }

  calculateMetrics() {
    const activeProducts = this.getActiveSessionProducts();
    this.totalItems = activeProducts.length;
    this.analyticsSummary = computeMarketplaceAnalytics(activeProducts);

    if (this.analyticsSummary) {
      this.avgPrice = this.analyticsSummary.kpi.avgPrice;
      this.inStockCount = this.analyticsSummary.kpi.inStockCount;
      this.inStockPct = this.analyticsSummary.kpi.inStockPercentage;
      this.sellersCount = this.analyticsSummary.kpi.uniqueSellersCount;
    } else {
      this.avgPrice = 0;
      this.inStockCount = 0;
      this.inStockPct = 0;
      this.sellersCount = 0;
    }

    const ratedProducts = activeProducts.filter(p => (p.reviews || 0) > 0 && (p.rating || 0) > 0);
    if (ratedProducts.length > 0) {
      const sumRating = ratedProducts.reduce((acc, curr) => acc + curr.rating, 0);
      this.avgRating = parseFloat((sumRating / ratedProducts.length).toFixed(1));
    } else {
      this.avgRating = 0;
    }
    
    this.aiAlertsCount = activeProducts.filter(p => p.aiStatus === 'warning' || p.aiStatus === 'suspicious').length;
    this.calculateOpportunityScore();
    this.calculateSellerAnalytics();
  }

  calculateSellerAnalytics() {
    const activeProducts = this.getActiveSessionProducts();
    if (!activeProducts || activeProducts.length === 0) {
      this.sellerStats = [];
      this.sellerPieSegments = [];
      this.topSellerByAssortment = null;
      this.topSellerByReviews = null;
      this.topSellerByRating = null;
      return;
    }

    const sellerMap = new Map<string, {
      count: number;
      prices: number[];
      ratings: number[];
      reviews: number;
      inStockCount: number;
    }>();

    for (const p of activeProducts) {
      const seller = (p.seller && p.seller.trim()) ? p.seller.trim() : 'Rozetka';
      if (!sellerMap.has(seller)) {
        sellerMap.set(seller, {
          count: 0,
          prices: [],
          ratings: [],
          reviews: 0,
          inStockCount: 0
        });
      }
      const data = sellerMap.get(seller)!;
      data.count++;
      if (p.price && p.price > 0) data.prices.push(p.price);
      if (p.reviews && p.reviews > 0 && p.rating && p.rating > 0) data.ratings.push(p.rating);
      if (p.reviews && p.reviews > 0) data.reviews += p.reviews;
      if (p.inStock !== false) data.inStockCount++;
    }

    const colors = [
      '#6366f1', // Indigo
      '#8b5cf6', // Violet
      '#ec4899', // Pink
      '#10b981', // Emerald
      '#f59e0b', // Amber
      '#06b6d4', // Cyan
      '#3b82f6', // Blue
      '#a855f7', // Purple
      '#14b8a6', // Teal
      '#f43f5e', // Rose
      '#84cc16', // Lime
      '#e11d48', // Crimson
      '#64748b'  // Slate
    ];

    const totalProducts = activeProducts.length;
    const stats: SellerStat[] = [];

    sellerMap.forEach((data, name) => {
      const avgPrice = data.prices.length > 0 ? Math.round(data.prices.reduce((a, b) => a + b, 0) / data.prices.length) : 0;
      const minPrice = data.prices.length > 0 ? Math.min(...data.prices) : 0;
      const maxPrice = data.prices.length > 0 ? Math.max(...data.prices) : 0;
      const avgRating = data.ratings.length > 0 ? +(data.ratings.reduce((a, b) => a + b, 0) / data.ratings.length).toFixed(1) : 0;
      const inStockPct = Math.round((data.inStockCount / data.count) * 100);
      const marketSharePct = +((data.count / totalProducts) * 100).toFixed(1);

      stats.push({
        name,
        productCount: data.count,
        marketSharePct,
        totalReviews: data.reviews,
        avgRating,
        avgPrice,
        minPrice,
        maxPrice,
        inStockPct,
        color: '#64748b'
      });
    });

    // Sort by product count descending
    stats.sort((a, b) => b.productCount - a.productCount);

    // Assign colors to top sellers
    stats.forEach((s, idx) => {
      s.color = colors[idx % colors.length];
    });

    this.sellerStats = stats;

    // Leaders
    this.topSellerByAssortment = stats.length > 0 ? stats[0] : null;
    
    // Top by reviews
    const sortedByReviews = [...stats].sort((a, b) => b.totalReviews - a.totalReviews);
    this.topSellerByReviews = sortedByReviews.length > 0 && sortedByReviews[0].totalReviews > 0 ? sortedByReviews[0] : null;

    // Top by rating
    const sortedByRating = [...stats].filter(s => s.avgRating > 0).sort((a, b) => b.avgRating - a.avgRating || b.totalReviews - a.totalReviews);
    this.topSellerByRating = sortedByRating.length > 0 ? sortedByRating[0] : null;

    // Calculate detailed SVG Donut chart segments (Top 8 sellers + Others)
    const topCount = Math.min(8, stats.length);
    const topSellers = stats.slice(0, topCount);
    const othersCount = stats.slice(topCount).reduce((acc, s) => acc + s.productCount, 0);

    const pieData: { name: string; count: number; color: string }[] = topSellers.map((s, idx) => ({
      name: s.name,
      count: s.productCount,
      color: colors[idx % colors.length]
    }));

    if (othersCount > 0) {
      pieData.push({
        name: 'Інші продавці (' + (stats.length - topCount) + ')',
        count: othersCount,
        color: '#475569'
      });
    }

    // Circumference for r=40 is 2 * PI * 40 = ~251.327
    const circumference = 2 * Math.PI * 40;
    let accumulatedPct = 0;

    this.sellerPieSegments = pieData.map(item => {
      const pct = +(item.count / totalProducts * 100).toFixed(1);
      const dashLength = (pct / 100) * circumference;
      const spaceLength = circumference - dashLength;
      const offset = - (accumulatedPct / 100) * circumference;
      accumulatedPct += pct;

      return {
        name: item.name,
        productCount: item.count,
        pct,
        color: item.color,
        strokeDasharray: `${dashLength} ${spaceLength}`,
        strokeDashoffset: offset,
        cumulativePct: +accumulatedPct.toFixed(1)
      };
    });
  }

  private structuredDescCache = new Map<string, StructuredDescription>();

  getStructuredDescription(desc: string | undefined): StructuredDescription {
    if (!desc || !desc.trim()) {
      return {
        summary: '',
        keyFeatures: [],
        bulletPoints: [],
        cleanParagraphs: []
      };
    }

    const cacheKey = desc.slice(0, 100) + desc.length;
    if (this.structuredDescCache.has(cacheKey)) {
      return this.structuredDescCache.get(cacheKey)!;
    }

    // 1. Clean HTML tags
    let clean = desc
      .replace(/<br\s*[\/]?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 2. Extract Key Features by logical matching
    const keyFeatures: ExtractedFeature[] = [];
    const lower = clean.toLowerCase();

    if (/quick\s*charge|power\s*delivery|\bpd\b|\bqc\b|швидк[а-я]* зарядк/i.test(lower)) {
      keyFeatures.push({ title: 'Швидка зарядка (PD / Quick Charge)', icon: 'bolt', color: 'text-amber-400 bg-amber-950/40 border-amber-800/40' });
    }
    if (/\b\d+\s*(?:w|вт)\b/i.test(lower)) {
      const m = clean.match(/\b(\d+\s*(?:W|Вт))\b/i);
      const pText = m ? m[1] : 'Висока потужність';
      keyFeatures.push({ title: `Потужність: ${pText}`, icon: 'electric_meter', color: 'text-purple-400 bg-purple-950/40 border-purple-800/40' });
    }
    if (/\b\d{4,6}\s*(?:mah|маг|мА·год|мАг)\b/i.test(lower)) {
      const m = clean.match(/\b(\d+[\d\s]*(?:mah|маг|мА·год|мАг))\b/i);
      const cText = m ? m[1] : 'Висока ємність';
      keyFeatures.push({ title: `Ємність: ${cText}`, icon: 'battery_charging_full', color: 'text-emerald-400 bg-emerald-950/40 border-emerald-800/40' });
    }
    if (/magsafe|бездрот[а-я]*|wireless/i.test(lower)) {
      keyFeatures.push({ title: 'MagSafe / Бездротова зарядка', icon: 'sensors', color: 'text-cyan-400 bg-cyan-950/40 border-cyan-800/40' });
    }
    if (/дисплей|індикатор|екран|led/i.test(lower)) {
      keyFeatures.push({ title: 'LED / Цифровий дисплей', icon: 'smart_display', color: 'text-indigo-400 bg-indigo-950/40 border-indigo-800/40' });
    }
    if (/захист|безпек|overheat|short-circuit|перегрів/i.test(lower)) {
      keyFeatures.push({ title: 'Багаторівневий захист', icon: 'shield', color: 'text-rose-400 bg-rose-950/40 border-rose-800/40' });
    }
    if (/алюмін|металев|корпус|компактн|легк/i.test(lower)) {
      keyFeatures.push({ title: 'Преміум корпус / Компактність', icon: 'diamond', color: 'text-slate-300 bg-slate-900 border-slate-700/60' });
    }

    // 3. Extract Bullet Points / List items
    const lines = clean.split('\n').map(l => l.trim()).filter(Boolean);
    const bulletPoints: string[] = [];
    const cleanParagraphs: string[] = [];

    for (const line of lines) {
      if (/^[\u2022\u2023\u25E6\u2043\u2219\*\-\+\✓\✔\–\—\•]\s*/.test(line) || /^\d+[\.\)]\s+/.test(line)) {
        const cleanedLine = line.replace(/^[\u2022\u2023\u25E6\u2043\u2219\*\-\+\✓\✔\–\—\•\d\.\)]+\s*/, '').trim();
        if (cleanedLine.length > 5) {
          bulletPoints.push(cleanedLine);
        }
      } else if (line.length > 20) {
        cleanParagraphs.push(line);
      }
    }

    const summary = cleanParagraphs.length > 0 ? cleanParagraphs[0] : (bulletPoints.length > 0 ? bulletPoints[0] : clean.slice(0, 160));

    const res: StructuredDescription = {
      summary,
      keyFeatures,
      bulletPoints,
      cleanParagraphs
    };

    this.structuredDescCache.set(cacheKey, res);
    return res;
  }

  getFilteredSellerStats(): SellerStat[] {
    let list = [...this.sellerStats];
    if (this.sellerSearchQuery && this.sellerSearchQuery.trim()) {
      const q = this.sellerSearchQuery.toLowerCase().trim();
      list = list.filter(s => s.name.toLowerCase().includes(q));
    }

    list.sort((a, b) => {
      let valA = a[this.sellerSortColumn];
      let valB = b[this.sellerSortColumn];
      if (valA === valB) return 0;
      return this.sellerSortDirection === 'asc' ? (valA > valB ? 1 : -1) : (valA < valB ? 1 : -1);
    });

    return list;
  }

  sortSellersBy(column: 'productCount' | 'totalReviews' | 'avgRating' | 'avgPrice') {
    if (this.sellerSortColumn === column) {
      this.sellerSortDirection = this.sellerSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sellerSortColumn = column;
      this.sellerSortDirection = 'desc';
    }
    this.cdr.markForCheck();
  }

  setSellerQuickFilter(filter: 'all' | '3p' | 'inStock' | 'noReviews' | 'top20') {
    this.sellerQuickFilter = filter;
    this.cdr.markForCheck();
  }

  sortSellerAnalyticsBy(column: 'productsCount' | 'reviewsSum' | 'avgReviewsPerProduct' | 'medianPrice' | 'inStockRate' | 'marketShare') {
    if (this.sellerAnalyticsSortColumn === column) {
      this.sellerAnalyticsSortDirection = this.sellerAnalyticsSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sellerAnalyticsSortColumn = column;
      this.sellerAnalyticsSortDirection = 'desc';
    }
    this.cdr.markForCheck();
  }

  getFilteredSellersTable() {
    if (!this.analyticsSummary) return [];
    let list = [...this.analyticsSummary.sellersTable];

    // Quick Filter Chips
    if (this.sellerQuickFilter === '3p') {
      list = list.filter(s => !s.isRozetka);
    } else if (this.sellerQuickFilter === 'inStock') {
      list = list.filter(s => s.inStockRate > 0);
    } else if (this.sellerQuickFilter === 'noReviews') {
      list = list.filter(s => s.reviewsSum === 0);
    } else if (this.sellerQuickFilter === 'top20') {
      const topCount = Math.max(1, Math.ceil(this.analyticsSummary.sellersTable.length * 0.2));
      list = list.slice(0, topCount);
    }

    // Search query
    if (this.sellerSearchQuery && this.sellerSearchQuery.trim()) {
      const q = this.sellerSearchQuery.toLowerCase().trim();
      list = list.filter(s => s.sellerName.toLowerCase().includes(q));
    }

    // Sorting
    list.sort((a, b) => {
      let valA = a[this.sellerAnalyticsSortColumn];
      let valB = b[this.sellerAnalyticsSortColumn];
      if (valA === valB) return 0;
      if (this.sellerAnalyticsSortDirection === 'asc') {
        return valA > valB ? 1 : -1;
      } else {
        return valA < valB ? 1 : -1;
      }
    });

    return list;
  }

  calculateTotalNicheReviews(): number {
    const active = this.getActiveSessionProducts();
    return active.reduce((acc, curr) => acc + (curr.reviews || 0), 0);
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
    const baseProducts = this.getActiveSessionProducts();
    this.filteredProducts = baseProducts.filter((p, index) => {
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

      let matchesPage = true;
      if (this.selectedPageFilter !== 'all') {
        const itemPage = Math.floor(index / 60) + 1;
        matchesPage = itemPage === this.selectedPageFilter;
      }
      
      return matchesSearch && matchesPrice && matchesRating && matchesStatus && matchesStock && matchesPage;
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
          const pA = Number(a.price) || 0;
          const pB = Number(b.price) || 0;
          if (this.sortDirection === 'asc') {
            valA = pA <= 0 ? 999999999 : pA;
            valB = pB <= 0 ? 999999999 : pB;
          } else {
            valA = pA;
            valB = pB;
          }
        } else if (this.sortColumn === 'oldPrice') {
          const pA = Number(a.oldPrice || a.price) || 0;
          const pB = Number(b.oldPrice || b.price) || 0;
          if (this.sortDirection === 'asc') {
            valA = pA <= 0 ? 999999999 : pA;
            valB = pB <= 0 ? 999999999 : pB;
          } else {
            valA = pA;
            valB = pB;
          }
        } else if (this.sortColumn === 'discount') {
          valA = a.discount || 0;
          valB = b.discount || 0;
        } else if (this.sortColumn === 'rating') {
          valA = (a.reviews && a.reviews > 0) ? (a.rating || 0) : 0;
          valB = (b.reviews && b.reviews > 0) ? (b.rating || 0) : 0;
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

export function computeSpecDistribution(products: any[], totalProductsCount: number): SpecCategoryAnalysis[] {
  if (!products || products.length === 0 || totalProductsCount === 0) return [];
  
  const keyFrequency = new Map<string, number>();
  const keyToValues = new Map<string, Map<string, { products: any[]; reviewsSum: number; prices: number[] }>>();

  products.forEach(p => {
    if (p && p.detailedSpecsMap && typeof p.detailedSpecsMap === 'object') {
      for (const [rawKey, rawVal] of Object.entries(p.detailedSpecsMap)) {
        if (!rawKey || !rawVal || typeof rawVal !== 'string') continue;
        const normKey = rawKey.trim();
        if (normKey.length < 2) continue;

        const lowKey = normKey.toLowerCase();
        if (lowKey === 'гарантія' || lowKey === 'країна реєстрації бренду' || lowKey === 'країна-виробник товару') {
          continue;
        }

        keyFrequency.set(normKey, (keyFrequency.get(normKey) || 0) + 1);

        let valuesMap = keyToValues.get(normKey);
        if (!valuesMap) {
          valuesMap = new Map();
          keyToValues.set(normKey, valuesMap);
        }

        let cleanVal = String(rawVal).trim();
        if (cleanVal.length > 55) cleanVal = cleanVal.slice(0, 52) + '...';

        let valEntry = valuesMap.get(cleanVal);
        if (!valEntry) {
          valEntry = { products: [], reviewsSum: 0, prices: [] };
          valuesMap.set(cleanVal, valEntry);
        }
        valEntry.products.push(p);
        valEntry.reviewsSum += (Number(p.reviews) || 0);
        if (Number(p.price) > 0) valEntry.prices.push(Number(p.price));
      }
    }
  });

  const candidateKeys = Array.from(keyFrequency.entries())
    .filter(([_, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1]);

  const categories: SpecCategoryAnalysis[] = [];

  candidateKeys.slice(0, 8).forEach(([specKey, count]) => {
    const valuesMap = keyToValues.get(specKey);
    if (!valuesMap || valuesMap.size === 0) return;

    const totalCategoryReviews = Array.from(valuesMap.values()).reduce((acc, v) => acc + v.reviewsSum, 0);

    const valuesList: SpecValueStat[] = Array.from(valuesMap.entries()).map(([specValue, data]) => {
      const pCount = data.products.length;
      const rSum = data.reviewsSum;
      const sortedP = [...data.prices].sort((a, b) => a - b);
      const avgP = sortedP.length > 0 ? Math.round(sortedP.reduce((a, b) => a + b, 0) / sortedP.length) : 0;
      const medP = sortedP.length > 0 ? (sortedP.length % 2 === 0 ? Math.round((sortedP[sortedP.length/2 - 1] + sortedP[sortedP.length/2]) / 2) : sortedP[Math.floor(sortedP.length/2)]) : 0;
      const ratio = pCount > 0 ? Number((rSum / pCount).toFixed(1)) : 0;

      return {
        specValue,
        productsCount: pCount,
        productsShare: Number(((pCount / totalProductsCount) * 100).toFixed(1)),
        reviewsSum: rSum,
        reviewsShare: totalCategoryReviews > 0 ? Number(((rSum / totalCategoryReviews) * 100).toFixed(1)) : 0,
        avgPrice: avgP,
        medianPrice: medP,
        demandSupplyRatio: ratio,
        isTopDemand: false,
        isTopEfficiency: false,
        products: data.products
      };
    }).sort((a, b) => b.reviewsSum - a.reviewsSum || b.productsCount - a.productsCount);

    if (valuesList.length > 0) {
      valuesList[0].isTopDemand = true;

      let maxRatio = -1;
      let topEffIdx = -1;
      valuesList.forEach((v, idx) => {
        if (v.productsCount >= 2 && v.reviewsSum > 0 && v.demandSupplyRatio > maxRatio) {
          maxRatio = v.demandSupplyRatio;
          topEffIdx = idx;
        }
      });
      if (topEffIdx !== -1) {
        valuesList[topEffIdx].isTopEfficiency = true;
      }

      categories.push({
        specKey,
        totalProductsWithSpec: count,
        coveragePct: Number(((count / totalProductsCount) * 100).toFixed(1)),
        values: valuesList
      });
    }
  });

  return categories;
}

export function computeMarketplaceAnalytics(products: any[]): AnalyticalSummary {
  const allProducts = products || [];
  const rawTotalCount = allProducts.length;
  const validProducts = allProducts.filter(p => p && Number(p.price) > 0);
  const n = validProducts.length;

  if (rawTotalCount === 0) {
    return {
      kpi: {
        totalProducts: 0,
        uniqueSellersCount: 0,
        avgPrice: 0,
        medianPrice: 0,
        minPrice: 0,
        maxPrice: 0,
        p95Price: 0,
        priceSkewPct: 0,
        inStockCount: 0,
        inStockPercentage: 0,
        activeSkusCount: 0,
        activeSkusPercentage: 0,
        inactiveSkusCount: 0,
        inactiveSkusPercentage: 0,
        activeSkusInStockCount: 0,
        activeSkusInStockRate: 0,
        avgReviewsPerActiveSku: 0,
        cr3: 0,
        cr3Level: 'LOW',
        top3Sellers: [],
        hhi: 0,
        hhiLevel: 'LOW',
        entryBarrier: {
          level: 'LOW',
          medianTop10Reviews: 0,
          top10ReviewsMax: 0,
          top10ReviewsMin: 0,
          top10ReviewsAvg: 0,
          top10ProductsCount: 0
        },
        vendorSplit: {
          rozetkaCount: 0,
          thirdPartyCount: 0,
          rozetkaShare: 0,
          thirdPartyShare: 0
        }
      },
      priceDistribution: [],
      sellersTable: [],
      specAnalytics: []
    };
  }

  // 1. Сортування цін для медіани та розрахунку середнього (серед товарів з активною ціною > 0)
  const sortedPrices = n > 0 ? [...validProducts.map(p => Number(p.price))].sort((a, b) => a - b) : [0];
  const minPrice = sortedPrices[0] || 0;
  const maxPrice = sortedPrices[sortedPrices.length - 1] || 0;
  const medianPrice = sortedPrices.length % 2 === 0
    ? (sortedPrices[sortedPrices.length / 2 - 1] + sortedPrices[sortedPrices.length / 2]) / 2
    : sortedPrices[Math.floor(sortedPrices.length / 2)];
  
  const avgPrice = n > 0 ? Math.round(sortedPrices.reduce((acc, v) => acc + v, 0) / n) : 0;
  const p95Index = Math.floor(0.95 * (Math.max(n, 1) - 1));
  const p95Price = sortedPrices[p95Index] || maxPrice;
  const priceSkewPct = medianPrice > 0 ? Number((((avgPrice - medianPrice) / medianPrice) * 100).toFixed(1)) : 0;

  // 2. Агрегація за продавцями (за всіма зібраними товарами)
  const sellerColors = [
    '#6366f1', '#8b5cf6', '#ec4899', '#10b981', '#f59e0b',
    '#06b6d4', '#3b82f6', '#a855f7', '#14b8a6', '#f43f5e',
    '#84cc16', '#e11d48', '#64748b'
  ];

  const sellerMap = new Map<string, {
    productsCount: number;
    reviewsSum: number;
    prices: number[];
    inStockCount: number;
    isRozetka: boolean;
  }>();

  allProducts.forEach(p => {
    const rawSeller = (p.seller && String(p.seller).trim()) ? String(p.seller).trim() : 'Rozetka';
    const isRozetka = rawSeller.toLowerCase() === 'rozetka' || rawSeller.toLowerCase().includes('rozetka');
    const entry = sellerMap.get(rawSeller) || {
      productsCount: 0,
      reviewsSum: 0,
      prices: [],
      inStockCount: 0,
      isRozetka
    };
    entry.productsCount++;
    entry.reviewsSum += (p.reviews && p.reviews > 0) ? Number(p.reviews) : 0;
    if (Number(p.price) > 0) {
      entry.prices.push(Number(p.price));
    }
    if (p.inStock !== false) entry.inStockCount++;
    sellerMap.set(rawSeller, entry);
  });

  const sellersList = Array.from(sellerMap.entries()).map(([sellerName, stats]) => {
    const sortedSellerPrices = stats.prices.length > 0 ? [...stats.prices].sort((a, b) => a - b) : [0];
    const sellerMedPrice = sortedSellerPrices.length % 2 === 0
      ? (sortedSellerPrices[sortedSellerPrices.length / 2 - 1] + sortedSellerPrices[sortedSellerPrices.length / 2]) / 2
      : sortedSellerPrices[Math.floor(sortedSellerPrices.length / 2)];

    return {
      sellerName,
      isRozetka: stats.isRozetka,
      productsCount: stats.productsCount,
      marketShare: Number(((stats.productsCount / rawTotalCount) * 100).toFixed(1)),
      reviewsSum: stats.reviewsSum,
      avgReviewsPerProduct: Number((stats.reviewsSum / stats.productsCount).toFixed(1)),
      medianPrice: Math.round(sellerMedPrice),
      inStockRate: Number(((stats.inStockCount / stats.productsCount) * 100).toFixed(1)),
      color: '#64748b',
      rank: 0,
      isTop3: false
    };
  }).sort((a, b) => b.productsCount - a.productsCount);

  // Assign ranks & colors
  sellersList.forEach((s, idx) => {
    s.rank = idx + 1;
    s.isTop3 = idx < 3;
    s.color = sellerColors[idx % sellerColors.length];
  });

  // 3. Концентрація ринку (CR3, HHI)
  const top3Sellers = sellersList.slice(0, 3).map(s => ({
    name: s.sellerName,
    share: s.marketShare,
    count: s.productsCount,
    isRozetka: s.isRozetka
  }));
  const cr3 = Number(top3Sellers.reduce((acc, s) => acc + s.share, 0).toFixed(1));
  const cr3Level: 'LOW' | 'MEDIUM' | 'HIGH' = cr3 < 40 ? 'LOW' : cr3 <= 70 ? 'MEDIUM' : 'HIGH';
  
  const hhi = Math.round(sellersList.reduce((acc, s) => acc + Math.pow(s.marketShare, 2), 0));
  const hhiLevel: 'LOW' | 'MODERATE' | 'HIGH' = hhi < 1500 ? 'LOW' : hhi <= 2500 ? 'MODERATE' : 'HIGH';

  // 4. Бар'єр входу (топ-10 за відгуками)
  const sortedByReviews = [...allProducts].sort((a, b) => (b.reviews || 0) - (a.reviews || 0));
  const top10Products = sortedByReviews.slice(0, 10);
  const top10Reviews = top10Products.map(p => p.reviews || 0).sort((a, b) => a - b);
  const medianTop10Reviews = top10Reviews.length > 0
    ? top10Reviews[Math.floor(top10Reviews.length / 2)]
    : 0;
  const top10ReviewsMax = top10Reviews.length > 0 ? top10Reviews[top10Reviews.length - 1] : 0;
  const top10ReviewsMin = top10Reviews.length > 0 ? top10Reviews[0] : 0;
  const top10ReviewsAvg = top10Reviews.length > 0 ? Math.round(top10Reviews.reduce((a, b) => a + b, 0) / top10Reviews.length) : 0;

  const entryBarrierLevel: 'LOW' | 'MEDIUM' | 'HIGH' =
    medianTop10Reviews <= 15 ? 'LOW' : medianTop10Reviews <= 100 ? 'MEDIUM' : 'HIGH';

  // 5. Динамічні корзини цін з відсіканням аномальних цін (P95 Outlier Clipping)
  const totalReviews = validProducts.reduce((acc, p) => acc + (p.reviews || 0), 0);

  let priceDistribution: Array<{
    rangeLabel: string;
    minPrice: number;
    maxPrice: number;
    productsCount: number;
    productsShare: number;
    reviewsSum: number;
    reviewsShare: number;
    demandSupplyRatio: number;
    isSweetSpot: boolean;
  }> = [];

  if (n === 0 || minPrice >= p95Price || maxPrice === minPrice) {
    priceDistribution = [{
      rangeLabel: `${minPrice.toLocaleString('uk-UA')} ₴`,
      minPrice,
      maxPrice,
      productsCount: n,
      productsShare: 100,
      reviewsSum: totalReviews,
      reviewsShare: 100,
      demandSupplyRatio: n > 0 ? totalReviews / n : 0,
      isSweetSpot: true
    }];
  } else {
    const coreBinsCount = 5;
    const coreStep = (p95Price - minPrice) / coreBinsCount;
    const rawBins: Array<{ min: number; max: number; label: string; products: any[] }> = [];

    for (let idx = 0; idx < coreBinsCount; idx++) {
      const bMin = minPrice + idx * coreStep;
      const bMax = idx === coreBinsCount - 1 ? p95Price : bMin + coreStep;
      const bProducts = validProducts.filter(p => p.price >= bMin && (idx === coreBinsCount - 1 ? p.price <= p95Price : p.price < bMax));
      rawBins.push({
        min: Math.round(bMin),
        max: Math.round(bMax),
        label: `${Math.round(bMin).toLocaleString('uk-UA')} - ${Math.round(bMax).toLocaleString('uk-UA')} ₴`,
        products: bProducts
      });
    }

    if (maxPrice > p95Price) {
      const outlierProducts = validProducts.filter(p => p.price > p95Price);
      if (outlierProducts.length > 0) {
        rawBins.push({
          min: Math.round(p95Price),
          max: Math.round(maxPrice),
          label: `Понад ${Math.round(p95Price).toLocaleString('uk-UA')} ₴`,
          products: outlierProducts
        });
      }
    }

    let maxEfficiencyRatio = -1;
    let sweetSpotIndex = -1;

    priceDistribution = rawBins.map((bin, idx) => {
      const count = bin.products.length;
      const reviews = bin.products.reduce((acc, p) => acc + (p.reviews || 0), 0);
      const ratio = count > 0 ? Number((reviews / count).toFixed(2)) : 0;
      const reviewsShare = totalReviews > 0 ? Number(((reviews / totalReviews) * 100).toFixed(1)) : 0;

      if (count >= n * 0.05 && reviews > 0 && ratio > maxEfficiencyRatio) {
        maxEfficiencyRatio = ratio;
        sweetSpotIndex = idx;
      }

      return {
        rangeLabel: bin.label,
        minPrice: bin.min,
        maxPrice: bin.max,
        productsCount: count,
        productsShare: Number(((count / n) * 100).toFixed(1)),
        reviewsSum: reviews,
        reviewsShare,
        demandSupplyRatio: ratio,
        isSweetSpot: false
      };
    });

    if (sweetSpotIndex !== -1) {
      priceDistribution[sweetSpotIndex].isSweetSpot = true;
    }
  }

  // 6. Rozetka vs 3P & Active SKUs
  const inStockCount = allProducts.filter(p => p.inStock !== false).length;
  const activeProducts = allProducts.filter(p => (p.reviews || 0) > 0);
  const activeSkusCount = activeProducts.length;
  const activeSkusPercentage = Number(((activeSkusCount / rawTotalCount) * 100).toFixed(1));
  const inactiveSkusCount = rawTotalCount - activeSkusCount;
  const inactiveSkusPercentage = Number(((inactiveSkusCount / rawTotalCount) * 100).toFixed(1));
  const activeSkusInStockCount = activeProducts.filter(p => p.inStock !== false).length;
  const activeSkusInStockRate = activeSkusCount > 0 ? Number(((activeSkusInStockCount / activeSkusCount) * 100).toFixed(1)) : 0;
  const activeReviewsSum = activeProducts.reduce((acc, p) => acc + (p.reviews || 0), 0);
  const avgReviewsPerActiveSku = activeSkusCount > 0 ? Number((activeReviewsSum / activeSkusCount).toFixed(1)) : 0;

  const rozetkaCount = allProducts.filter(p => (p.seller || '').toLowerCase().includes('rozetka')).length;
  const thirdPartyCount = rawTotalCount - rozetkaCount;
  const rozetkaShare = Number(((rozetkaCount / rawTotalCount) * 100).toFixed(1));
  const thirdPartyShare = Number((100 - rozetkaShare).toFixed(1));

  // 7. Автоматичний зріз за характеристиками
  const specAnalytics = computeSpecDistribution(allProducts, rawTotalCount);

  return {
    kpi: {
      totalProducts: rawTotalCount,
      uniqueSellersCount: sellersList.length,
      avgPrice,
      medianPrice: Math.round(medianPrice),
      minPrice,
      maxPrice,
      p95Price,
      priceSkewPct,
      inStockCount,
      inStockPercentage: Number(((inStockCount / rawTotalCount) * 100).toFixed(1)),
      activeSkusCount,
      activeSkusPercentage,
      inactiveSkusCount,
      inactiveSkusPercentage,
      activeSkusInStockCount,
      activeSkusInStockRate,
      avgReviewsPerActiveSku,
      cr3,
      cr3Level,
      top3Sellers,
      hhi,
      hhiLevel,
      entryBarrier: {
        level: entryBarrierLevel,
        medianTop10Reviews,
        top10ReviewsMax,
        top10ReviewsMin,
        top10ReviewsAvg,
        top10ProductsCount: top10Products.length
      },
      vendorSplit: {
        rozetkaCount,
        thirdPartyCount,
        rozetkaShare,
        thirdPartyShare
      }
    },
    priceDistribution,
    sellersTable: sellersList,
    specAnalytics
  };
}
