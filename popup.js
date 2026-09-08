// TradeScout Popup Script v3.0 (Parallel Multi-Tab Control Center)
const btnMasterStart = document.getElementById('btn-master-start');
const btnMasterStop = document.getElementById('btn-master-stop');
const allTabsCountEl = document.getElementById('all-tabs-count');

const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const inputWebhook = document.getElementById('webhook-url');
const statusText = document.getElementById('status-text');
const timerText = document.getElementById('timer-text');
const countText = document.getElementById('count-text');
const percentText = document.getElementById('percent-text');
const progressFill = document.getElementById('progress-fill');
const tabTitleEl = document.getElementById('tab-title');
const tabBadgeEl = document.getElementById('tab-badge');

const tabsListContainer = document.getElementById('tabs-list-container');
const tabsFoundCountEl = document.getElementById('tabs-found-count');
const btnRefreshTabs = document.getElementById('btn-refresh-tabs');
const btnResetAll = document.getElementById('btn-reset-all');

let activeTabId = null;
let timerInterval = null;
let startTime = null;

function startTimer(savedStartTime) {
    if (timerInterval) clearInterval(timerInterval);
    startTime = savedStartTime || Date.now();
    
    timerInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const secs = String(elapsedSec % 60).padStart(2, '0');
        timerText.innerText = `Час: ${mins}:${secs}`;
    }, 1000);
}

function stopTimer(resetToZero = false) {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    if (resetToZero) {
        timerText.innerText = 'Час: 00:00';
    }
}

function updateProgress(percent, count, actionMsg, estimatedTotal) {
    const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
    progressFill.style.width = `${safePercent}%`;
    percentText.innerText = `${safePercent}%`;
    if (estimatedTotal && estimatedTotal > 0) {
        countText.innerText = `${count || 0} / ${estimatedTotal} товарів`;
    } else {
        countText.innerText = `${count || 0} товарів`;
    }
    
    if (actionMsg) {
        statusText.innerText = actionMsg;
    }
}

// Render the full list of open Rozetka tabs
async function refreshTabsList() {
    chrome.runtime.sendMessage({ action: 'GET_ALL_ROZETKA_TABS' }, (res) => {
        const err = chrome.runtime.lastError;
        if (err || !res || !res.tabs) return;

        const tabs = res.tabs;
        tabsFoundCountEl.innerText = tabs.length;
        if (allTabsCountEl) allTabsCountEl.innerText = tabs.length;

        if (tabs.length === 0) {
            tabsListContainer.innerHTML = `
                <div style="font-size: 11px; color: #94a3b8; text-align: center; padding: 8px;">
                    Вкладок Rozetka не знайдено.<br>Відкрийте каталог Rozetka у новій вкладці!
                </div>
            `;
            return;
        }

        let html = '';
        tabs.forEach((t, idx) => {
            const isCurrent = t.id === activeTabId;
            const session = t.session;
            let statusText = '⚪ Готова до запуску';
            let statusClass = 'color: #94a3b8;';
            let isRunning = false;

            if (session) {
                if (session.isRunning) {
                    isRunning = true;
                    const est = (session.estimatedTotal && session.estimatedTotal > 0) ? ` / ${session.estimatedTotal}` : '';
                    statusText = `🟢 Збирається: ${session.totalScraped || 0}${est} тов. (${session.percentProgress || 0}%, стор. ${session.currentPage || 1})`;
                    statusClass = 'color: #34d399; font-weight: 700;';
                } else if (session.finishedAt) {
                    const est = (session.estimatedTotal && session.estimatedTotal > 0) ? ` з ${session.estimatedTotal}` : '';
                    statusText = `✓ Завершено (${session.totalScraped || 0}${est} тов.)`;
                    statusClass = 'color: #10b981; font-weight: 700;';
                }
            }

            html += `
                <div class="tab-item-row ${isCurrent ? 'is-active-tab' : ''}" data-tab-id="${t.id}">
                    <div class="tab-item-info">
                        <div class="tab-item-name" title="${t.title}">
                            <span>${idx + 1}.</span>
                            <span>${t.title}</span>
                            ${isCurrent ? '<span style="font-size: 9px; color: #38bdf8; font-weight: bold;">(Ця)</span>' : ''}
                        </div>
                        <div class="tab-item-status" style="${statusClass}">
                            ${statusText}
                        </div>
                    </div>
                    <div class="tab-item-actions">
                        ${isRunning ? 
                            `<button class="btn-tab-action btn-tab-stop" data-action="stop" data-tab-id="${t.id}" title="Зупинити цю вкладку">⏹</button>` :
                            `<button class="btn-tab-action btn-tab-start" data-action="start" data-tab-id="${t.id}" title="Запустити збір на цій вкладці">▶</button>`
                        }
                        ${!isCurrent ? `<button class="btn-tab-action" data-action="focus" data-tab-id="${t.id}" title="Перейти до вкладки">👁</button>` : ''}
                    </div>
                </div>
            `;
        });

        tabsListContainer.innerHTML = html;

        // Bind buttons in tabs list
        tabsListContainer.querySelectorAll('.btn-tab-action').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const action = btn.getAttribute('data-action');
                const targetTabId = parseInt(btn.getAttribute('data-tab-id'), 10);
                const webhookUrl = inputWebhook.value.trim();

                if (action === 'start') {
                    chrome.runtime.sendMessage({
                        action: 'START_SINGLE_TAB',
                        targetTabId: targetTabId,
                        webhookUrl: webhookUrl
                    }, () => {
                        setTimeout(refreshTabsList, 200);
                    });
                } else if (action === 'stop') {
                    if (targetTabId === activeTabId) {
                        btnStart.disabled = false;
                        btnStop.disabled = true;
                        tabBadgeEl.innerText = 'Готова до запуску';
                        tabBadgeEl.style.color = '#10b981';
                        stopTimer(true);
                        updateProgress(0, 0, 'Скрейпінг зупинено.');
                    }
                    chrome.runtime.sendMessage({
                        action: 'STOP_SINGLE_TAB',
                        targetTabId: targetTabId
                    }, () => {
                        setTimeout(refreshTabsList, 200);
                    });
                } else if (action === 'focus') {
                    chrome.tabs.update(targetTabId, { active: true });
                }
            });
        });
    });
}

// Initialize popup for active tab
async function initPopup() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
        activeTabId = tab.id;
        tabTitleEl.innerText = tab.title ? tab.title.split(/[-–—|]/)[0].replace(/купити|в києві|україна|ціни|rozetka/gi, '').trim() : 'Сторінка Rozetka';
    }

    // Default UI to clean idle state
    btnStart.disabled = false;
    btnStop.disabled = true;
    tabBadgeEl.innerText = 'Готова до запуску';
    tabBadgeEl.style.color = '#10b981';
    stopTimer(true);
    updateProgress(0, 0, 'Готова до запуску');

    chrome.storage.local.get(['webhookUrl'], (data) => {
        if (data.webhookUrl) {
            inputWebhook.value = data.webhookUrl;
        } else {
            inputWebhook.value = 'https://rozetka-scraper-extension-builder.onrender.com/api/products';
        }

        // Query active tab directly for live truth
        if (activeTabId) {
            chrome.tabs.sendMessage(activeTabId, { action: 'PING_TAB_STATUS' }, (res) => {
                const err = chrome.runtime.lastError;
                if (!err && res) {
                    if (res.sessionTitle) tabTitleEl.innerText = res.sessionTitle;
                    if (res.isRunning) {
                        btnStart.disabled = true;
                        btnStop.disabled = false;
                        tabBadgeEl.innerText = '● Збирається...';
                        tabBadgeEl.style.color = '#38bdf8';
                        const est = res.estimatedTotal || 0;
                        const pct = est > 0 ? Math.min(100, Math.round(((res.totalScraped || 0) / est) * 100)) : 5;
                        updateProgress(pct, res.totalScraped || 0, `Збір активний (${res.totalScraped || 0} тов.)`, est);
                        startTimer(res.startTime || Date.now());
                    } else if (res.totalScraped > 0) {
                        btnStart.disabled = false;
                        btnStop.disabled = true;
                        tabBadgeEl.innerText = '✓ Завершено';
                        tabBadgeEl.style.color = '#10b981';
                        stopTimer(false);
                        updateProgress(100, res.totalScraped, `Збір завершено (${res.totalScraped} тов.)`, res.estimatedTotal);
                    } else {
                        btnStart.disabled = false;
                        btnStop.disabled = true;
                        tabBadgeEl.innerText = 'Готова до запуску';
                        tabBadgeEl.style.color = '#10b981';
                        stopTimer(true);
                        updateProgress(0, 0, 'Готова до запуску');
                    }
                }
            });
        }

        refreshTabsList();
    });
}

// React to storage updates from background/content script
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.tabSessions) {
        const sessions = changes.tabSessions.newValue || {};
        refreshTabsList();

        const currentSession = sessions[activeTabId];
        if (currentSession && currentSession.isRunning === true && !currentSession.statusMsg?.includes('зупинено')) {
            btnStart.disabled = true;
            btnStop.disabled = false;
            tabBadgeEl.innerText = '● Збирається...';
            tabBadgeEl.style.color = '#38bdf8';
            if (!timerInterval && currentSession.startTime) {
                startTimer(currentSession.startTime);
            }
            updateProgress(currentSession.percentProgress || 5, currentSession.totalScraped || 0, currentSession.statusMsg, currentSession.estimatedTotal);
        } else {
            btnStart.disabled = false;
            btnStop.disabled = true;
            tabBadgeEl.innerText = (currentSession && currentSession.finishedAt) ? '✓ Завершено' : 'Готова до запуску';
            tabBadgeEl.style.color = '#10b981';
            stopTimer(!(currentSession && currentSession.finishedAt));
            if (currentSession && currentSession.finishedAt) {
                updateProgress(100, currentSession.totalScraped || 0, `Збір завершено! (${currentSession.totalScraped || 0} тов.)`, currentSession.estimatedTotal);
            } else {
                updateProgress(0, 0, (currentSession && currentSession.statusMsg) || 'Готова до запуску');
            }
        }
    }
});

// Master Start (All Tabs in parallel)
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
            btnMasterStart.innerHTML = `<span>⚡ Запустити всі відкриті вкладки (<span id="all-tabs-count">${tabsFoundCountEl.innerText}</span>)</span>`;
            initPopup();
        }, 600);
    });
});

// Master Stop (All Tabs)
btnMasterStop.addEventListener('click', async () => {
    btnStart.disabled = false;
    btnStop.disabled = true;
    tabBadgeEl.innerText = 'Готова до запуску';
    tabBadgeEl.style.color = '#10b981';
    stopTimer(true);
    updateProgress(0, 0, 'Всі вкладки зупинено.');

    chrome.runtime.sendMessage({ action: 'STOP_ALL_TABS' }, () => {
        setTimeout(() => {
            initPopup();
        }, 300);
    });
});

// Refresh button
btnRefreshTabs.addEventListener('click', () => {
    refreshTabsList();
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
            updateProgress(0, 0, 'Готова до запуску');
            refreshTabsList();
        });
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
    updateProgress(5, 0, 'Ініціалізація скрейпінгу...');

    chrome.runtime.sendMessage({
        action: 'START_SINGLE_TAB',
        targetTabId: tab.id,
        webhookUrl: webhookUrl
    }, () => {
        setTimeout(refreshTabsList, 300);
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
    updateProgress(0, 0, 'Скрейпінг зупинено.');

    chrome.runtime.sendMessage({
        action: 'STOP_SINGLE_TAB',
        targetTabId: activeTabId
    }, () => {
        setTimeout(refreshTabsList, 300);
    });
});

// Save Webhook input on change
inputWebhook.addEventListener('change', () => {
    const webhookUrl = inputWebhook.value.trim();
    if (webhookUrl) chrome.storage.local.set({ webhookUrl });
});

// Periodic lightweight refresh when popup is open
setInterval(refreshTabsList, 1500);

initPopup();