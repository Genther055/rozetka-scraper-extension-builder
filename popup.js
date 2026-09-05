// TradeScout Popup Script v3.0 (Multi-Tab Aware)
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
const parallelBadge = document.getElementById('parallel-badge');
const parallelCountEl = document.getElementById('parallel-count');

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

function stopTimer() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
}

function updateProgress(percent, count, actionMsg) {
    const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
    progressFill.style.width = `${safePercent}%`;
    percentText.innerText = `${safePercent}%`;
    countText.innerText = `${count || 0} товарів`;
    
    if (actionMsg) {
        statusText.innerText = actionMsg;
    }
}

function updateParallelBadge(allSessions) {
    if (!allSessions) return;
    const runningOtherTabs = Object.keys(allSessions).filter(id => {
        return String(id) !== String(activeTabId) && allSessions[id]?.isRunning;
    });

    if (runningOtherTabs.length > 0) {
        parallelBadge.style.display = 'flex';
        parallelCountEl.innerText = runningOtherTabs.length;
    } else {
        parallelBadge.style.display = 'none';
    }
}

// Initialize popup for active tab
async function initPopup() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    activeTabId = tab.id;

    // Set fallback title
    tabTitleEl.innerText = tab.title ? tab.title.split(/[-–—|]/)[0].trim() : 'Сторінка Rozetka';

    // 1. Load saved webhook URL
    chrome.storage.local.get(['webhookUrl', 'tabSessions'], (data) => {
        if (data.webhookUrl) {
            inputWebhook.value = data.webhookUrl;
        } else {
            inputWebhook.value = 'https://rozetka-scraper-extension-builder.onrender.com/api/products';
        }

        const sessions = data.tabSessions || {};
        const currentSession = sessions[activeTabId];

        updateParallelBadge(sessions);

        if (currentSession) {
            if (currentSession.sessionTitle) {
                tabTitleEl.innerText = currentSession.sessionTitle;
            }

            if (currentSession.isRunning) {
                btnStart.disabled = true;
                btnStop.disabled = false;
                tabBadgeEl.innerText = '● Збирається...';
                tabBadgeEl.style.color = '#38bdf8';
                startTimer(currentSession.startTime || Date.now());
                updateProgress(currentSession.percentProgress || 5, currentSession.totalScraped || 0, currentSession.statusMsg || 'Скрейпінг активний...');
            } else if (currentSession.finishedAt) {
                btnStart.disabled = false;
                btnStop.disabled = true;
                tabBadgeEl.innerText = '✓ Завершено';
                tabBadgeEl.style.color = '#10b981';
                stopTimer();
                updateProgress(100, currentSession.totalScraped || 0, `Збір завершено! (${currentSession.totalScraped || 0} тов.)`);
            } else {
                btnStart.disabled = false;
                btnStop.disabled = true;
                tabBadgeEl.innerText = 'Готова до запуску';
                tabBadgeEl.style.color = '#10b981';
                stopTimer();
                updateProgress(0, 0, 'Очікування запуску...');
            }
        }

        // Ping content script to verify alive status
        chrome.tabs.sendMessage(activeTabId, { action: 'PING_TAB_STATUS' }, (res) => {
            if (chrome.runtime.lastError) {
                // If content script was not connected, inject it now
                if (tab.url && tab.url.includes('rozetka.com.ua')) {
                    chrome.scripting.executeScript({
                        target: { tabId: activeTabId },
                        files: ['content.js']
                    }, () => {});
                }
                return;
            }
            if (res) {
                if (res.sessionTitle) tabTitleEl.innerText = res.sessionTitle;
                if (res.isRunning) {
                    btnStart.disabled = true;
                    btnStop.disabled = false;
                    tabBadgeEl.innerText = '● Збирається...';
                    tabBadgeEl.style.color = '#38bdf8';
                    updateProgress(Math.min(99, Math.round(((res.totalScraped || 0) / 300) * 100)), res.totalScraped || 0, `Збір активний (${res.totalScraped || 0} тов.)`);
                }
            }
        });
    });
}

// React to storage updates from background/content script
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.tabSessions) {
        const sessions = changes.tabSessions.newValue || {};
        updateParallelBadge(sessions);

        const currentSession = sessions[activeTabId];
        if (currentSession) {
            if (currentSession.sessionTitle) {
                tabTitleEl.innerText = currentSession.sessionTitle;
            }

            if (currentSession.isRunning) {
                btnStart.disabled = true;
                btnStop.disabled = false;
                tabBadgeEl.innerText = '● Збирається...';
                tabBadgeEl.style.color = '#38bdf8';
                if (!timerInterval) startTimer(currentSession.startTime || Date.now());
                updateProgress(currentSession.percentProgress || 5, currentSession.totalScraped || 0, currentSession.statusMsg);
            } else {
                btnStart.disabled = false;
                btnStop.disabled = true;
                tabBadgeEl.innerText = currentSession.finishedAt ? '✓ Завершено' : 'Зупинено';
                tabBadgeEl.style.color = currentSession.finishedAt ? '#10b981' : '#94a3b8';
                stopTimer();
                if (currentSession.finishedAt) {
                    updateProgress(100, currentSession.totalScraped || 0, `Збір завершено! (${currentSession.totalScraped || 0} тов.)`);
                } else {
                    updateProgress(0, currentSession.totalScraped || 0, currentSession.statusMsg || 'Скрейпінг зупинено.');
                }
            }
        }
    }
});

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

    const sendStart = () => {
        chrome.tabs.sendMessage(tab.id, {
            action: 'START_TAB_SCRAPE',
            tabId: tab.id,
            webhookUrl: webhookUrl,
            sessionId: `session_${tab.id}_${now}`
        }, (res) => {
            if (chrome.runtime.lastError) {
                chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    files: ['content.js']
                }, () => {
                    setTimeout(() => {
                        chrome.tabs.sendMessage(tab.id, {
                            action: 'START_TAB_SCRAPE',
                            tabId: tab.id,
                            webhookUrl: webhookUrl,
                            sessionId: `session_${tab.id}_${now}`
                        }, (r) => {
                            if (r && r.sessionTitle) tabTitleEl.innerText = r.sessionTitle;
                        });
                    }, 100);
                });
            } else if (res && res.sessionTitle) {
                tabTitleEl.innerText = res.sessionTitle;
            }
        });
    };

    sendStart();
});

// Stop Scraping on THIS Active Tab
btnStop.addEventListener('click', async () => {
    if (!activeTabId) return;

    chrome.tabs.sendMessage(activeTabId, { action: 'STOP_TAB_SCRAPE' }, () => {
        if (chrome.runtime.lastError) {
            chrome.scripting.executeScript({
                target: { tabId: activeTabId },
                func: () => {
                    if (window.__tradeScoutStopScrape) {
                        window.__tradeScoutStopScrape();
                    }
                }
            });
        }
    });

    btnStart.disabled = false;
    btnStop.disabled = true;
    tabBadgeEl.innerText = 'Зупинено';
    tabBadgeEl.style.color = '#94a3b8';
    stopTimer();
    updateProgress(0, 0, 'Скрейпінг цієї вкладки зупинено.');
});

initPopup();