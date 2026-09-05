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
            sessionId: message.sessionId || `session_${tabId}`
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

        // Send to local dashboard and specified webhook (e.g. Render / n8n)
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
                    // Backoff before retry
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

    // 5. Query all active sessions count
    if (message.action === 'getAllSessions') {
        getTabSessions().then(sessions => {
            sendResponse({ success: true, sessions });
        });
        return true;
    }
});
