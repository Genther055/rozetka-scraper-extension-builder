// Background Service Worker for TradeScout Multi-Tab Extension v3.0
console.log('TradeScout Background Service Worker v3.0 initialized.');

const LOCAL_DASHBOARD_API = 'http://localhost:4000/api/products';
const LOCAL_IP_API = 'http://127.0.0.1:4000/api/products';

// Helper to get or set tab sessions from storage
async function getTabSessions() {
    return new Promise(resolve => {
        chrome.storage.local.get(['tabSessions'], res => {
            resolve(res.tabSessions || {});
        });
    });
}

async function updateTabSession(tabId, patch) {
    const sessions = await getTabSessions();
    const current = sessions[tabId] || {};
    sessions[tabId] = { ...current, ...patch, lastUpdated: Date.now() };
    await new Promise(resolve => {
        chrome.storage.local.set({ tabSessions: sessions }, resolve);
    });
    return sessions[tabId];
}

async function removeTabSession(tabId) {
    const sessions = await getTabSessions();
    if (sessions[tabId]) {
        delete sessions[tabId];
        await new Promise(resolve => {
            chrome.storage.local.set({ tabSessions: sessions }, resolve);
        });
    }
}

// Listen for tab closures so we cleanly stop that tab's session without touching other tabs
chrome.tabs.onRemoved.addListener(async (tabId) => {
    console.log(`TradeScout Background: Tab ${tabId} was closed. Cleaning up session.`);
    await removeTabSession(tabId);
});

// Helper to query all open Rozetka tabs
async function getAllRozetkaTabs() {
    const tabs = await chrome.tabs.query({ url: "*://*.rozetka.com.ua/*" });
    const sessions = await getTabSessions();
    
    return tabs.map(t => {
        const session = sessions[t.id] || null;
        let cleanTitle = t.title ? t.title.split(/[-–—|]/)[0].replace(/купити|в києві|україна|ціни|rozetka/gi, '').trim() : 'Каталог Rozetka';
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
                // If content script was not connected yet, inject and retry
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
    return new Promise(resolve => {
        chrome.tabs.sendMessage(tabId, { action: 'STOP_TAB_SCRAPE' }, () => {
            const err = chrome.runtime.lastError;
            if (err) {
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    func: () => {
                        if (window.__tradeScoutStopScrape) window.__tradeScoutStopScrape();
                    }
                }, () => {
                    const _ = chrome.runtime.lastError;
                    resolve({ success: true });
                });
            } else {
                resolve({ success: true });
            }
        });
    });
}

// Main Message Router
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = message.tabId || (sender && sender.tab ? sender.tab.id : null);

    // 1. Progress updates from a specific tab's content script
    if (message.action === 'tabProgress' && tabId) {
        updateTabSession(tabId, {
            isRunning: true,
            totalScraped: message.total || 0,
            currentPage: message.page || 1,
            statusMsg: message.statusMsg || 'Скрейпінг активний...',
            percentProgress: message.percent || 0,
            syncedCount: message.syncedCount || 0,
            sessionTitle: message.sessionTitle || 'Каталог Rozetka',
            category: message.category || 'Товари',
            sessionId: message.sessionId || `session_${tabId}`,
            startTime: message.startTime || Date.now()
        });
        sendResponse({ success: true });
        return true;
    }

    // 2. Tab scraping completed
    if (message.action === 'tabFinished' && tabId) {
        updateTabSession(tabId, {
            isRunning: false,
            totalScraped: message.total || 0,
            percentProgress: 100,
            statusMsg: `Збір завершено! (${message.total} товарів)`,
            syncedCount: message.syncedCount || message.total,
            sessionTitle: message.sessionTitle || 'Каталог Rozetka',
            category: message.category || 'Товари',
            finishedAt: Date.now()
        });
        sendResponse({ success: true });
        return true;
    }

    // 3. Tab error
    if (message.action === 'tabError' && tabId) {
        updateTabSession(tabId, {
            isRunning: false,
            statusMsg: `Помилка: ${message.message || 'Збій скрапінгу'}`
        });
        sendResponse({ success: true });
        return true;
    }

    // 4. Send Webhook payload to server (with multi-tab session identification & auto-retry)
    if (message.action === 'sendWebhook') {
        const { webhookUrl, payload } = message;
        const itemCount = payload?.products?.length || 0;
        console.log(`TradeScout Background: Tab ${tabId} sending ${itemCount} products for "${payload.sessionTitle || 'Каталог'}"...`);

        const targets = [];
        if (webhookUrl) targets.push(webhookUrl);
        if (!targets.includes(LOCAL_DASHBOARD_API)) targets.push(LOCAL_DASHBOARD_API);
        if (!targets.includes(LOCAL_IP_API)) targets.push(LOCAL_IP_API);

        const postWithRetry = async (url, data, maxRetries = 3) => {
            for (let i = 0; i < maxRetries; i++) {
                try {
                    const res = await fetch(url, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(data)
                    });
                    if (res.ok) {
                        return await res.json();
                    }
                } catch (e) {
                    if (i < maxRetries - 1) {
                        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                    }
                }
            }
            return null;
        };

        const sendPromises = targets.map(url => postWithRetry(url, payload));

        Promise.all(sendPromises).then((results) => {
            const serverInfo = results.find(r => r && r.success) || null;
            sendResponse({ success: true, serverInfo });
        });

        return true; // async sendResponse
    }

    // 5. Query all open Rozetka tabs with live session statuses
    if (message.action === 'GET_ALL_ROZETKA_TABS') {
        getAllRozetkaTabs().then(tabs => {
            sendResponse({ success: true, tabs });
        });
        return true;
    }

    // 6. Start scraping on ALL open Rozetka tabs in parallel
    if (message.action === 'START_ALL_TABS') {
        const { webhookUrl } = message;
        getAllRozetkaTabs().then(async (tabs) => {
            const promises = tabs.map(t => startScrapingTab(t.id, webhookUrl));
            await Promise.all(promises);
            sendResponse({ success: true, launchedCount: tabs.length });
        });
        return true;
    }

    // 7. Stop scraping on ALL tabs
    if (message.action === 'STOP_ALL_TABS') {
        getAllRozetkaTabs().then(async (tabs) => {
            const promises = tabs.map(t => stopScrapingTab(t.id));
            await Promise.all(promises);
            sendResponse({ success: true, stoppedCount: tabs.length });
        });
        return true;
    }

    // 8. Start/Stop single tab via tabId
    if (message.action === 'START_SINGLE_TAB' && message.targetTabId) {
        startScrapingTab(message.targetTabId, message.webhookUrl).then(res => {
            sendResponse(res);
        });
        return true;
    }

    if (message.action === 'STOP_SINGLE_TAB' && message.targetTabId) {
        stopScrapingTab(message.targetTabId).then(res => {
            sendResponse(res);
        });
        return true;
    }
});
