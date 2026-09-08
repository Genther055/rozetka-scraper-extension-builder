// TradeScout Popup Script v3.5 Pro (Live Telemetry & Multi-Tab Control)
const btnMasterStart = document.getElementById('btn-master-start');
const btnMasterStop = document.getElementById('btn-master-stop');
const allTabsCountEl = document.getElementById('all-tabs-count');

const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const inputWebhook = document.getElementById('webhook-url');
const statusText = document.getElementById('status-text');
const timerText = document.getElementById('timer-text');
const countText = document.getElementById('count-text');
const pageText = document.getElementById('page-text');
const percentText = document.getElementById('percent-text');
const progressFill = document.getElementById('progress-fill');
const tabTitleEl = document.getElementById('tab-title');
const tabBadgeEl = document.getElementById('tab-badge');

const tabsFoundCountEl = document.getElementById('tabs-found-count');
const btnRefreshTabs = document.getElementById('btn-refresh-tabs');
const btnResetAll = document.getElementById('btn-reset-all');

let activeTabId = null;
let timerInterval = null;
let activeStartTime = null;

function formatTime(elapsedMs) {
    const elapsedSec = Math.max(0, Math.floor(elapsedMs / 1000));
    const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const secs = String(elapsedSec % 60).padStart(2, '0');
    return `${mins}:${secs}`;
}

function startTimer(savedStartTime) {
    if (timerInterval) clearInterval(timerInterval);
    activeStartTime = savedStartTime || Date.now();
    
    // Initial immediate render
    timerText.innerText = `⏱ ${formatTime(Date.now() - activeStartTime)}`;

    timerInterval = setInterval(() => {
        if (!activeStartTime) return;
        timerText.innerText = `⏱ ${formatTime(Date.now() - activeStartTime)}`;
    }, 1000);
}

function stopTimer(resetToZero = false) {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    if (resetToZero) {
        activeStartTime = null;
        timerText.innerText = '⏱ 00:00';
    }
}

function updateProgress(percent, count, actionMsg, estimatedTotal, pageNum) {
    const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
    progressFill.style.width = `${safePercent}%`;
    percentText.innerText = `${safePercent}%`;
    
    if (estimatedTotal && estimatedTotal > 0) {
        countText.innerText = `📦 ${count || 0} / ${estimatedTotal} тов.`;
    } else {
        countText.innerText = `📦 ${count || 0} товарів`;
    }

    if (pageNum) {
        pageText.innerText = `📄 Стор. ${pageNum}`;
    }
    
    if (actionMsg) {
        statusText.innerText = actionMsg;
    }
}

// Query active tab directly for live truth
function pollActiveTabStatus() {
    if (!activeTabId) return;

    chrome.tabs.sendMessage(activeTabId, { action: 'PING_TAB_STATUS' }, (res) => {
        const err = chrome.runtime.lastError;
        if (err || !res) return;

        if (res.sessionTitle) {
            tabTitleEl.innerText = res.sessionTitle;
        }

        if (res.isRunning) {
            btnStart.disabled = true;
            btnStop.disabled = false;
            tabBadgeEl.innerText = '● Збирається...';
            tabBadgeEl.style.color = '#38bdf8';
            
            const est = res.estimatedTotal || 0;
            const pct = res.percent !== undefined ? res.percent : (est > 0 ? Math.min(100, Math.round(((res.totalScraped || 0) / est) * 100)) : 5);
            
            updateProgress(pct, res.totalScraped || 0, res.statusMsg || `Збір: ${res.totalScraped || 0} тов.`, est, res.page || 1);
            
            if (!timerInterval && res.startTime) {
                startTimer(res.startTime);
            }
        } else {
            btnStart.disabled = false;
            btnStop.disabled = true;

            if (res.totalScraped > 0 && res.percent === 100) {
                tabBadgeEl.innerText = '✓ Завершено';
                tabBadgeEl.style.color = '#10b981';
                stopTimer(false);
                updateProgress(100, res.totalScraped, res.statusMsg || `Збір завершено (${res.totalScraped} товарів)`, res.estimatedTotal, res.page || 1);
            } else {
                tabBadgeEl.innerText = 'Готова до запуску';
                tabBadgeEl.style.color = '#10b981';
                stopTimer(true);
                updateProgress(0, 0, res.statusMsg || 'Готова до запуску', 0, 1);
            }
        }
    });
}

// Refresh total count of open Rozetka tabs
function refreshTabsCount() {
    chrome.runtime.sendMessage({ action: 'GET_ALL_ROZETKA_TABS' }, (res) => {
        const err = chrome.runtime.lastError;
        if (err || !res || !res.tabs) return;

        const count = res.tabs.length;
        if (tabsFoundCountEl) tabsFoundCountEl.innerText = count;
        if (allTabsCountEl) allTabsCountEl.innerText = count;
    });
}

// Initialize popup for active tab
async function initPopup() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tab && tab.url && tab.url.includes('rozetka.com.ua')) {
        activeTabId = tab.id;
        const cleanTitle = tab.title ? tab.title.split(/[-–—|]/)[0].replace(/купити|в києві|україна|ціни|rozetka/gi, '').trim() : 'Сторінка Rozetka';
        tabTitleEl.innerText = cleanTitle || 'Каталог Rozetka';
    } else {
        tabTitleEl.innerText = 'Відкрийте сторінку Rozetka!';
        tabBadgeEl.innerText = 'Не Rozetka';
        tabBadgeEl.style.color = '#f87171';
        btnStart.disabled = true;
        btnStop.disabled = true;
        statusText.innerText = 'Будь ласка, перейдіть на вкладку з каталогом Rozetka.';
        return;
    }

    // Default clean idle state
    btnStart.disabled = false;
    btnStop.disabled = true;
    tabBadgeEl.innerText = 'Готова до запуску';
    tabBadgeEl.style.color = '#10b981';
    stopTimer(true);
    updateProgress(0, 0, 'Готова до запуску', 0, 1);

    chrome.storage.local.get(['webhookUrl'], (data) => {
        if (data.webhookUrl) {
            inputWebhook.value = data.webhookUrl;
        } else {
            inputWebhook.value = 'https://rozetka-scraper-extension-builder.onrender.com/api/products';
        }

        pollActiveTabStatus();
        refreshTabsCount();
    });
}

// Start Scraping on THIS Active Tab
btnStart.addEventListener('click', async () => {
    const webhookUrl = inputWebhook.value.trim();
    if (!webhookUrl) {
        statusText.innerText = 'Помилка: Вкажіть URL сервера!';
        return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url || !tab.url.includes('rozetka.com.ua')) {
        statusText.innerText = 'Помилка: Відкрийте сторінку каталогу Rozetka!';
        return;
    }

    activeTabId = tab.id;
    btnStart.disabled = true;
    btnStop.disabled = false;
    tabBadgeEl.innerText = '● Запуск...';
    tabBadgeEl.style.color = '#38bdf8';

    const now = Date.now();
    chrome.storage.local.set({ webhookUrl });

    startTimer(now);
    updateProgress(5, 0, 'Ініціалізація збору...', 0, 1);

    chrome.runtime.sendMessage({
        action: 'START_SINGLE_TAB',
        targetTabId: tab.id,
        webhookUrl: webhookUrl
    }, () => {
        setTimeout(pollActiveTabStatus, 300);
    });
});

// Stop Scraping on THIS Active Tab
btnStop.addEventListener('click', async () => {
    if (!activeTabId) return;

    btnStart.disabled = false;
    btnStop.disabled = true;
    tabBadgeEl.innerText = 'Готова до запуску';
    tabBadgeEl.style.color = '#10b981';
    stopTimer(true);
    updateProgress(0, 0, 'Скрейпінг зупинено.', 0, 1);

    chrome.runtime.sendMessage({
        action: 'STOP_SINGLE_TAB',
        targetTabId: activeTabId
    }, () => {
        setTimeout(pollActiveTabStatus, 300);
    });
});

// Master Start (All open Rozetka tabs in parallel)
btnMasterStart.addEventListener('click', async () => {
    const webhookUrl = inputWebhook.value.trim();
    if (!webhookUrl) return;
    chrome.storage.local.set({ webhookUrl });

    btnMasterStart.disabled = true;
    btnMasterStart.innerText = '⚡ Запуск усіх вкладок...';

    chrome.runtime.sendMessage({
        action: 'START_ALL_TABS',
        webhookUrl: webhookUrl
    }, () => {
        setTimeout(() => {
            btnMasterStart.disabled = false;
            btnMasterStart.innerHTML = `<span>⚡ Запустити всі вкладки (<span id="all-tabs-count">${tabsFoundCountEl ? tabsFoundCountEl.innerText : '1'}</span>)</span>`;
            pollActiveTabStatus();
            refreshTabsCount();
        }, 500);
    });
});

// Master Stop (All Tabs)
btnMasterStop.addEventListener('click', async () => {
    btnStart.disabled = false;
    btnStop.disabled = true;
    tabBadgeEl.innerText = 'Готова до запуску';
    tabBadgeEl.style.color = '#10b981';
    stopTimer(true);
    updateProgress(0, 0, 'Всі вкладки зупинено.', 0, 1);

    chrome.runtime.sendMessage({ action: 'STOP_ALL_TABS' }, () => {
        setTimeout(() => {
            pollActiveTabStatus();
            refreshTabsCount();
        }, 300);
    });
});

// Reset all sessions & states button
if (btnResetAll) {
    btnResetAll.addEventListener('click', () => {
        chrome.runtime.sendMessage({ action: 'RESET_ALL_SESSIONS' }, () => {
            stopTimer(true);
            btnStart.disabled = false;
            btnStop.disabled = true;
            tabBadgeEl.innerText = 'Готова до запуску';
            tabBadgeEl.style.color = '#10b981';
            updateProgress(0, 0, 'Готова до запуску', 0, 1);
            refreshTabsCount();
            pollActiveTabStatus();
        });
    });
}

// Refresh tabs count button
if (btnRefreshTabs) {
    btnRefreshTabs.addEventListener('click', () => {
        refreshTabsCount();
        pollActiveTabStatus();
    });
}

// Save Webhook input on change
inputWebhook.addEventListener('change', () => {
    const webhookUrl = inputWebhook.value.trim();
    if (webhookUrl) chrome.storage.local.set({ webhookUrl });
});

// Real-time polling while popup is open
setInterval(pollActiveTabStatus, 500);
setInterval(refreshTabsCount, 2000);

initPopup();