// Background Service Worker for TradeScout Multi-Tab Extension v3.5 Pro
console.log('TradeScout Background Service Worker v3.5 Pro initialized.');

const LOCAL_DASHBOARD_API = 'http://localhost:4000/api/products';
const LOCAL_IP_API = 'http://127.0.0.1:4000/api/products';

const stoppedTabs = new Set();

// Helper to get or set tab sessions from storage
async function getTabSessions() {
    return new Promise(resolve => {
        chrome.storage.local.get(['tabSessions'], res => {
            resolve(res.tabSessions || {});
        });
    });
}

async function updateTabSession(tabId, patch) {
    if (!tabId) return {};
    const sessions = await getTabSessions();
    const current = sessions[tabId] || {};
    sessions[tabId] = { ...current, ...patch, lastUpdated: Date.now() };
    await new Promise(resolve => {
        chrome.storage.local.set({ tabSessions: sessions }, resolve);
    });
    return sessions[tabId];
}

async function removeTabSession(tabId) {
    if (!tabId) return;
    const sessions = await getTabSessions();
    if (sessions[tabId]) {
        delete sessions[tabId];
        await new Promise(resolve => {
            chrome.storage.local.set({ tabSessions: sessions }, resolve);
        });
    }
}

// Clean up sessions on startup or install
chrome.runtime.onInstalled.addListener(async () => {
    stoppedTabs.clear();
    await chrome.storage.local.set({ tabSessions: {} });
});

chrome.runtime.onStartup.addListener(async () => {
    stoppedTabs.clear();
    await chrome.storage.local.set({ tabSessions: {} });
});

// Clean up sessions when a tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
    stoppedTabs.delete(tabId);
    await removeTabSession(tabId);
});

// Clean up sessions when a tab navigates (unless it was actively running an automated multi-page scrape)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading' && tab.url && tab.url.includes('rozetka.com.ua')) {
        const sessions = await getTabSessions();
        if (sessions[tabId] && !sessions[tabId].isRunning) {
            sessions[tabId].isRunning = false;
            sessions[tabId].percentProgress = 0;
            sessions[tabId].statusMsg = 'Готова до запуску';
            await new Promise(resolve => {
                chrome.storage.local.set({ tabSessions: sessions }, resolve);
            });
        }
    }
});

// Helper to query all open Rozetka tabs with live status verification
async function getAllRozetkaTabs() {
    const tabs = await chrome.tabs.query({ url: "*://*.rozetka.com.ua/*" });
    const sessions = await getTabSessions();
    const openTabIds = new Set(tabs.map(t => t.id));
    
    // Prune stale sessions for closed tabs
    for (const id in sessions) {
        if (!openTabIds.has(Number(id))) {
            delete sessions[id];
        }
    }

    // Ping each tab for ground-truth live state
    const pingPromises = tabs.map(t => {
        return new Promise(resolve => {
            chrome.tabs.sendMessage(t.id, { action: 'PING_TAB_STATUS' }, (res) => {
                const err = chrome.runtime.lastError;
                if (!err && res) {
                    sessions[t.id] = {
                        ...(sessions[t.id] || {}),
                        isRunning: !!res.isRunning,
                        totalScraped: res.totalScraped || 0,
                        estimatedTotal: res.estimatedTotal || 0,
                        percent: res.percent || 0,
                        page: res.page || 1,
                        sessionTitle: res.sessionTitle || t.title || 'Каталог Rozetka',
                        category: res.category || 'Товари'
                    };
                }
                resolve();
            });
        });
    });

    await Promise.all(pingPromises);
    await new Promise(resolve => {
        chrome.storage.local.set({ tabSessions: sessions }, resolve);
    });

    return tabs.map(t => {
        const session = sessions[t.id] || null;
        let cleanTitle = (session && session.sessionTitle) ? session.sessionTitle : (t.title ? t.title.split(/[-–—|]/)[0].replace(/купити|в києві|україна|ціни|rozetka/gi, '').trim() : 'Каталог Rozetka');
        if (!cleanTitle) cleanTitle = 'Каталог Rozetka';
        return {
            id: t.id,
            title: cleanTitle,
            url: t.url,
            active: t.active,
            session: session
        };
    });
}

// Helper to safely start scraping on a given tab
async function startScrapingTab(tabId, webhookUrl) {
    stoppedTabs.delete(tabId);
    const now = Date.now();
    const sessionId = `session_${tabId}_${now}`;

    return new Promise(resolve => {
        chrome.tabs.sendMessage(tabId, {
            action: 'START_TAB_SCRAPE',
            tabId: tabId,
            webhookUrl: webhookUrl,
            sessionId: sessionId
        }, (res) => {
            const err = chrome.runtime.lastError;
            if (err) {
                // If content script was not connected yet, inject main-world bridge then content script and retry
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['main-world.js'],
                    world: 'MAIN'
                }).catch(() => {});

                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content.js']
                }, () => {
                    const _ = chrome.runtime.lastError;
                    setTimeout(() => {
                        chrome.tabs.sendMessage(tabId, {
                            action: 'START_TAB_SCRAPE',
                            tabId: tabId,
                            webhookUrl: webhookUrl,
                            sessionId: sessionId
                        }, (r) => {
                            const __ = chrome.runtime.lastError;
                            if (__) {
                                chrome.scripting.executeScript({
                                    target: { tabId: tabId },
                                    func: (tId, wUrl) => {
                                        if (window.__tradeScoutStartScrape) {
                                            window.__tradeScoutStartScrape(tId, wUrl);
                                        }
                                    },
                                    args: [tabId, webhookUrl]
                                }).catch(() => {});
                            }
                            resolve(r || { success: true });
                        });
                    }, 150);
                });
            } else {
                resolve(res || { success: true });
            }
        });
    });
}

// Helper to safely stop scraping on a given tab
async function stopScrapingTab(tabId) {
    stoppedTabs.add(tabId);
    await updateTabSession(tabId, {
        isRunning: false,
        percentProgress: 0,
        statusMsg: 'Скрейпінг зупинено.'
    });
    notifyServerScrapingStatus({
        tabId,
        sessionId: `session_${tabId}`,
        status: 'stopped',
        percent: 0,
        statusMsg: 'Збір зупинено користувачем'
    });
    return new Promise(resolve => {
        chrome.tabs.sendMessage(tabId, { action: 'STOP_TAB_SCRAPE' }, () => {
            const _ = chrome.runtime.lastError;
            // Direct fail-safe script to guarantee immediate halting
            chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: () => {
                    try {
                        window.__tradeScoutIsScrapingActive = false;
                        if (window.__tradeScoutStopScrape) window.__tradeScoutStopScrape();
                    } catch (_) {}
                }
            }).catch(() => {});
            resolve({ success: true });
        });
    });
}

const STATUS_TARGETS = [
    'https://rozetka-scraper-extension-builder.onrender.com/api/scraping-status',
    'http://localhost:4000/api/scraping-status',
    'http://127.0.0.1:4000/api/scraping-status'
];

async function broadcastTaskProgressToDashboard(taskData) {
    if (!taskData) return;
    try {
        chrome.tabs.query({ url: ["*://*.vercel.app/*", "*://localhost/*", "*://127.0.0.1/*", "*://*.onrender.com/*"] }, (dashboardTabs) => {
            if (dashboardTabs && dashboardTabs.length > 0) {
                dashboardTabs.forEach(dTab => {
                    chrome.scripting.executeScript({
                        target: { tabId: dTab.id },
                        func: (t) => {
                            try {
                                window.dispatchEvent(new CustomEvent('tradescout_task_progress', { detail: t }));
                            } catch (_) {}
                        },
                        args: [taskData]
                    }).catch(() => {});
                });
            }
        });
    } catch (_) {}
}

async function notifyServerScrapingStatus(taskData) {
    if (!taskData) return;
    broadcastTaskProgressToDashboard(taskData);
    for (const url of STATUS_TARGETS) {
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(taskData)
        }).catch(() => {});
    }
}

// Main Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = message.tabId || (sender && sender.tab ? sender.tab.id : null);

    // 0. Screen capture for ML Vision Engine
    if (message.action === 'CAPTURE_TAB_VIEWPORT') {
        const targetWindowId = sender && sender.tab ? sender.tab.windowId : null;
        chrome.tabs.captureVisibleTab(targetWindowId, { format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) {
                sendResponse({ success: false, error: chrome.runtime.lastError?.message });
            } else {
                sendResponse({ success: true, dataUrl });
            }
        });
        return true;
    }

    // 0.0 Query genuine tab context
    if (message.action === 'GET_TAB_CONTEXT') {
        const trueTabId = (sender && sender.tab ? sender.tab.id : null) || tabId;
        sendResponse({ success: true, tabId: trueTabId });
        return true;
    }

    // 0. Tab reports it is idle on load
    if (message.action === 'tabIdle') {
        const targetTabId = (sender && sender.tab ? sender.tab.id : null) || tabId;
        if (targetTabId && !stoppedTabs.has(targetTabId)) {
            updateTabSession(targetTabId, {
                isRunning: false,
                percentProgress: 0,
                statusMsg: 'Готова до запуску',
                sessionTitle: message.sessionTitle || 'Каталог Rozetka',
                category: message.category || 'Товари'
            });
        }
        sendResponse({ success: true });
        return true;
    }

    // 0.1 Check if tab is actively allowed to run/resume
    if (message.action === 'CHECK_TAB_CAN_RUN') {
        const targetTabId = (sender && sender.tab ? sender.tab.id : null) || tabId;
        if (!targetTabId || stoppedTabs.has(targetTabId)) {
            sendResponse({ canRun: false, reason: 'stopped', tabId: targetTabId });
            return true;
        }
        getTabSessions().then(sessions => {
            const sess = sessions[targetTabId];
            if (sess && sess.isRunning) {
                sendResponse({ canRun: true, session: sess, tabId: targetTabId });
            } else {
                sendResponse({ canRun: false, reason: 'not_running', tabId: targetTabId });
            }
        });
        return true;
    }

    // 1. Progress updates from a specific tab's content script
    if (message.action === 'tabProgress' && tabId) {
        if (stoppedTabs.has(tabId)) {
            sendResponse({ success: false, stopped: true });
            return true;
        }

        updateTabSession(tabId, {
            isRunning: true,
            totalScraped: message.total || 0,
            currentPage: message.page || 1,
            statusMsg: message.statusMsg || 'Скрейпінг активний...',
            percentProgress: message.percent || 0,
            syncedCount: message.syncedCount || 0,
            estimatedTotal: message.estimatedTotal || 0,
            sessionTitle: message.sessionTitle || 'Каталог Rozetka',
            category: message.category || 'Товари',
            sessionId: message.sessionId || `session_${tabId}`,
            startTime: message.startTime || Date.now()
        });

        notifyServerScrapingStatus({
            tabId,
            sessionId: message.sessionId || `session_${tabId}`,
            sessionTitle: message.sessionTitle || 'Каталог Rozetka',
            category: message.category || 'Товари',
            status: 'scraping',
            pageIndex: message.page || 1,
            currentCount: message.total || 0,
            estimatedTotal: message.estimatedTotal || 0,
            percent: message.percent || 0,
            statusMsg: message.statusMsg || '',
            startTime: message.startTime || Date.now()
        });

        sendResponse({ success: true });
        return true;
    }

    // 2. Tab stopped by user
    if (message.action === 'tabStopped' && tabId) {
        stoppedTabs.add(tabId);
        updateTabSession(tabId, {
            isRunning: false,
            totalScraped: message.total || 0,
            percentProgress: 0,
            statusMsg: 'Скрейпінг зупинено.',
            sessionTitle: message.sessionTitle || 'Каталог Rozetka',
            category: message.category || 'Товари'
        });

        notifyServerScrapingStatus({
            tabId,
            sessionId: message.sessionId || `session_${tabId}`,
            sessionTitle: message.sessionTitle || 'Каталог Rozetka',
            category: message.category || 'Товари',
            status: 'stopped',
            pageIndex: 1,
            currentCount: message.total || 0,
            estimatedTotal: message.estimatedTotal || 0,
            percent: 0,
            statusMsg: 'Скрейпінг зупинено.'
        });

        sendResponse({ success: true });
        return true;
    }

    // 3. Tab scraping completed
    if (message.action === 'tabFinished' && tabId) {
        stoppedTabs.delete(tabId);
        updateTabSession(tabId, {
            isRunning: false,
            totalScraped: message.total || 0,
            percentProgress: 100,
            statusMsg: `Збір завершено! (${message.total} товарів)`,
            syncedCount: message.syncedCount || message.total,
            estimatedTotal: message.estimatedTotal || message.total,
            sessionTitle: message.sessionTitle || 'Каталог Rozetka',
            category: message.category || 'Товари',
            finishedAt: Date.now()
        });

        notifyServerScrapingStatus({
            tabId,
            sessionId: message.sessionId || `session_${tabId}`,
            sessionTitle: message.sessionTitle || 'Каталог Rozetka',
            category: message.category || 'Товари',
            status: 'completed',
            pageIndex: message.page || 1,
            currentCount: message.total || 0,
            estimatedTotal: message.estimatedTotal || message.total,
            percent: 100,
            statusMsg: `Збір завершено! (${message.total} товарів)`
        });

        sendResponse({ success: true });
        return true;
    }

    // 4. Tab error
    if (message.action === 'tabError' && tabId) {
        updateTabSession(tabId, {
            isRunning: false,
            statusMsg: `Помилка: ${message.message || 'Збій скрейпінгу'}`
        });

        notifyServerScrapingStatus({
            tabId,
            sessionId: `session_${tabId}`,
            status: 'error',
            percent: 0,
            statusMsg: `Помилка: ${message.message || 'Збій скрейпінгу'}`
        });

        sendResponse({ success: true });
        return true;
    }

    // 5. Send Webhook payload to server
    if (message.action === 'sendWebhook') {
        const { webhookUrl, payload } = message;
        const itemCount = payload?.products?.length || 0;
        console.log(`TradeScout Background: Tab ${tabId} sending ${itemCount} products for "${payload.sessionTitle || 'Каталог'}"...`);

        const RENDER_CLOUD_API = 'https://rozetka-scraper-extension-builder.onrender.com/api/products';
        const primaryUrl = webhookUrl || RENDER_CLOUD_API;

        try {
            chrome.tabs.query({ url: ["*://*.vercel.app/*", "*://localhost/*", "*://127.0.0.1/*", "*://*.onrender.com/*"] }, (dashboardTabs) => {
                if (dashboardTabs && dashboardTabs.length > 0) {
                    dashboardTabs.forEach(dTab => {
                        chrome.scripting.executeScript({
                            target: { tabId: dTab.id },
                            func: (prods) => {
                                try {
                                    if (prods && prods.length > 0) {
                                        window.dispatchEvent(new CustomEvent('tradescout_products_updated', { detail: prods }));
                                    }
                                } catch (_) {}
                            },
                            args: [payload.products]
                        }).catch(() => {});
                    });
                }
            });
        } catch (_) {}

        // Primary cloud post with fast timeout
        (async () => {
            let serverInfo = null;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 8000);
                const res = await fetch(primaryUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (res.ok) {
                    serverInfo = await res.json();
                }
            } catch (err) {
                console.warn('[TradeScout Background Webhook Primary Error]', err);
            }

            // Also post to fallback cloud URL if primary differed
            if (primaryUrl !== RENDER_CLOUD_API) {
                fetch(RENDER_CLOUD_API, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(() => {});
            }

            // Localhost non-blocking attempt (no retry, 1s timeout)
            fetch(LOCAL_DASHBOARD_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(1000)
            }).catch(() => {});

            sendResponse({ success: true, serverInfo });
        })();

        return true;
    }

    // 5.1 Batch Fetch Product Details from Rozetka Common API (Zero-CORS in Service Worker)
    if (message.action === 'FETCH_PRODUCT_DETAILS') {
        const { productIds } = message;
        if (!Array.isArray(productIds) || productIds.length === 0) {
            sendResponse({ success: false, data: [] });
            return true;
        }

        (async () => {
            const allResults = [];
            const chunkPromises = [];

            for (let i = 0; i < productIds.length; i += 60) {
                const chunk = productIds.slice(i, i + 60);
                const idsChunk = chunk.join(',');
                const endpoints = [
                    `https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=${idsChunk}`,
                    `https://rozetka.com.ua/ua/api/product/details?country=UA&lang=ua&ids=${idsChunk}`,
                    `https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ru&ids=${idsChunk}`
                ];

                chunkPromises.push((async () => {
                    for (const apiUrl of endpoints) {
                        try {
                            const res = await fetch(apiUrl, {
                                headers: {
                                    'Accept': 'application/json, text/plain, */*',
                                    'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8'
                                }
                            });
                            if (res.ok) {
                                const json = await res.json();
                                if (Array.isArray(json?.data) && json.data.length > 0) {
                                    return json.data;
                                }
                            }
                        } catch (err) {}
                    }
                    return [];
                })());
            }

            const results = await Promise.all(chunkPromises);
            for (const chunkData of results) {
                if (Array.isArray(chunkData)) allResults.push(...chunkData);
            }
            sendResponse({ success: true, data: allResults });
        })();

        return true;
    }

    // 6. Query all open Rozetka tabs
    if (message.action === 'GET_ALL_ROZETKA_TABS') {
        getAllRozetkaTabs().then(tabs => {
            sendResponse({ success: true, tabs });
        });
        return true;
    }

    // 7. Start scraping on ALL open Rozetka tabs in parallel with staggered launch
    if (message.action === 'START_ALL_TABS') {
        const { webhookUrl } = message;
        stoppedTabs.clear();
        getAllRozetkaTabs().then(async (tabs) => {
            for (const t of tabs) {
                startScrapingTab(t.id, webhookUrl);
                await new Promise(r => setTimeout(r, 200));
            }
            sendResponse({ success: true, launchedCount: tabs.length });
        });
        return true;
    }

    // 8. Stop scraping on ALL tabs
    if (message.action === 'STOP_ALL_TABS') {
        getAllRozetkaTabs().then(async (tabs) => {
            tabs.forEach(t => stoppedTabs.add(t.id));
            const promises = tabs.map(t => stopScrapingTab(t.id));
            await Promise.all(promises);
            await new Promise(resolve => {
                chrome.storage.local.set({ tabSessions: {} }, resolve);
            });
            sendResponse({ success: true, stoppedCount: tabs.length });
        });
        return true;
    }

    // 9. Start/Stop single tab via tabId
    if (message.action === 'START_SINGLE_TAB' && message.targetTabId) {
        stoppedTabs.delete(message.targetTabId);
        startScrapingTab(message.targetTabId, message.webhookUrl).then(res => {
            sendResponse(res);
        });
        return true;
    }

    if (message.action === 'STOP_SINGLE_TAB' && message.targetTabId) {
        stoppedTabs.add(message.targetTabId);
        stopScrapingTab(message.targetTabId).then(res => {
            sendResponse(res);
        });
        return true;
    }

    // 10. Reset all cached sessions
    if (message.action === 'RESET_ALL_SESSIONS') {
        stoppedTabs.clear();
        chrome.storage.local.set({ tabSessions: {} }, () => {
            sendResponse({ success: true });
        });
        return true;
    }
});
