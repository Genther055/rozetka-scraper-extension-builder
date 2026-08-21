// Елементи інтерфейсу
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const inputWebhook = document.getElementById('webhook-url');
const statusText = document.getElementById('status-text');
const timerText = document.getElementById('timer-text');
const percentText = document.getElementById('percent-text');
const progressFill = document.getElementById('progress-fill');

let timerInterval = null;
let startTime = null;
let currentTabId = null;

// Функція оновлення таймера
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

function updateProgress(percent, count, actionMsg, totalEstimated, syncedCount) {
    const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
    progressFill.style.width = `${safePercent}%`;
    percentText.innerText = `${safePercent}%`;
    
    if (actionMsg) {
        statusText.innerText = actionMsg;
    }

    const syncContainer = document.getElementById('sync-container');
    const syncText = document.getElementById('sync-text');
    if (syncContainer && syncText) {
        if (syncedCount !== undefined && syncedCount > 0) {
            syncContainer.style.display = 'flex';
            syncText.innerHTML = `Синхронізовано з платформою: <strong>${syncedCount}</strong> шт.`;
        } else {
            syncContainer.style.display = 'none';
        }
    }
}

// Автоматичне зчитування категорії з активної сторінки Rozetka
async function detectPageCategory() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes('rozetka.com.ua')) {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const el = document.querySelector('h1, .breadcrumbs__last');
                return el ? el.innerText.trim() : '';
            }
        }, (results) => {
            if (results && results[0] && results[0].result) {
                const detectedCategory = results[0].result;
                const tabInput = document.getElementById('tab-name-input');
                if (tabInput && !tabInput.value) {
                    tabInput.value = detectedCategory;
                }
            }
        });
    }
}

// Ініціалізація та відновлення стану для активної вкладки
async function initPopup() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    currentTabId = tab.id;

    const keys = [
        'webhookUrl',
        `isRunning_${currentTabId}`,
        `totalScraped_${currentTabId}`,
        `currentPage_${currentTabId}`,
        `startTime_${currentTabId}`,
        `statusMsg_${currentTabId}`,
        `percentProgress_${currentTabId}`,
        `syncedCount_${currentTabId}`,
        `targetDb_${currentTabId}`
    ];

    chrome.storage.local.get(keys, (state) => {
        const isRunning = state[`isRunning_${currentTabId}`] || false;
        const totalScraped = state[`totalScraped_${currentTabId}`] || 0;
        const currentPage = state[`currentPage_${currentTabId}`] || 1;
        const startTimeVal = state[`startTime_${currentTabId}`] || null;
        const statusMsg = state[`statusMsg_${currentTabId}`] || 'Очікування запуску...';
        const percentProgress = state[`percentProgress_${currentTabId}`] || 0;
        const syncedCount = state[`syncedCount_${currentTabId}`] || 0;
        const targetDb = state[`targetDb_${currentTabId}`] || '';

        if (state.webhookUrl) {
            inputWebhook.value = state.webhookUrl;
        } else {
            inputWebhook.value = 'https://rozetka-scraper-extension-builder.onrender.com/api/products';
        }

        const tabInput = document.getElementById('tab-name-input');
        if (targetDb && tabInput) {
            tabInput.value = targetDb;
        }

        if (isRunning) {
            btnStart.disabled = true;
            btnStop.disabled = false;
            inputWebhook.disabled = true;
            if (tabInput) tabInput.disabled = true;
            startTimer(startTimeVal);
            updateProgress(percentProgress, totalScraped, statusMsg, 155, syncedCount);
        } else {
            btnStart.disabled = false;
            btnStop.disabled = true;
            inputWebhook.disabled = false;
            if (tabInput) tabInput.disabled = false;
            stopTimer();
            if (totalScraped > 0) {
                updateProgress(100, totalScraped, 'Збір завершено успішно!', totalScraped, syncedCount || totalScraped);
            } else {
                updateProgress(0, 0, 'Очікування запуску...', 0, 0);
                detectPageCategory();
            }
        }
    });
}

// Запуск скрапінгу
btnStart.addEventListener('click', async () => {
    const webhookUrl = inputWebhook.value.trim();
    if (!webhookUrl) {
        statusText.innerText = 'Помилка: Вкажіть URL!';
        return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url.includes('rozetka.com.ua')) {
        statusText.innerText = 'Помилка: Відкрийте каталог Rozetka!';
        return;
    }
    currentTabId = tab.id;

    btnStart.disabled = true;
    btnStop.disabled = false;
    inputWebhook.disabled = true;
    const tabInput = document.getElementById('tab-name-input');
    if (tabInput) tabInput.disabled = true;

    const now = Date.now();
    let targetDb = tabInput ? tabInput.value.trim() : '';
    if (!targetDb) {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
                const el = document.querySelector('h1, .breadcrumbs__last');
                return el ? el.innerText.trim() : '';
            }
        });
        targetDb = (results && results[0] && results[0].result) ? results[0].result : 'Загальна';
    }

    const startState = {};
    startState['webhookUrl'] = webhookUrl;
    startState[`isRunning_${currentTabId}`] = true;
    startState[`targetDb_${currentTabId}`] = targetDb;
    startState[`totalScraped_${currentTabId}`] = 0;
    startState[`currentPage_${currentTabId}`] = 1;
    startState[`startTime_${currentTabId}`] = now;
    startState[`statusMsg_${currentTabId}`] = 'Запуск скрапінгу на сторінці...';
    startState[`percentProgress_${currentTabId}`] = 5;

    await chrome.storage.local.set(startState);

    startTimer(now);
    updateProgress(5, 0, 'Запуск скрапінгу на сторінці...', 155);

    // Прямий запуск контент-скрипта
    chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
    }, () => {
        if (chrome.runtime.lastError) {
            console.warn('Fallback reload required:', chrome.runtime.lastError.message);
            chrome.tabs.reload(tab.id);
        }
    });
});

// Зупинка скрапінгу
btnStop.addEventListener('click', async () => {
    if (!currentTabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) currentTabId = tab.id;
    }
    if (currentTabId) {
        const stopState = {};
        stopState[`isRunning_${currentTabId}`] = false;
        await chrome.storage.local.set(stopState);
    }
    btnStart.disabled = false;
    btnStop.disabled = true;
    inputWebhook.disabled = false;
    const tabInput = document.getElementById('tab-name-input');
    if (tabInput) tabInput.disabled = false;
    stopTimer();
    updateProgress(0, 0, 'Скрейпінг зупинено.', 0);
});

// Слухач повідомлень від контент-скриптів різних вкладок
chrome.runtime.onMessage.addListener((message, sender) => {
    const tabId = sender.tab ? sender.tab.id : currentTabId;
    if (!tabId) return;

    if (message.action === 'progress') {
        const estimatedTotal = message.estimatedTotal || 155;
        const percent = Math.min(99, (message.total / estimatedTotal) * 100);
        const actionStr = message.statusMsg || `Сканування сторінки ${message.page}...`;
        
        const updateState = {};
        updateState[`totalScraped_${tabId}`] = message.total;
        updateState[`currentPage_${tabId}`] = message.page;
        updateState[`statusMsg_${tabId}`] = actionStr;
        updateState[`percentProgress_${tabId}`] = percent;
        updateState[`syncedCount_${tabId}`] = message.syncedCount || 0;
        
        chrome.storage.local.set(updateState);
        
        if (tabId === currentTabId) {
            updateProgress(percent, message.total, actionStr, estimatedTotal, message.syncedCount || 0);
        }
    } else if (message.action === 'status') {
        if (message.percent !== undefined) {
            const updateState = {};
            updateState[`percentProgress_${tabId}`] = message.percent;
            updateState[`statusMsg_${tabId}`] = message.statusMsg;
            updateState[`syncedCount_${tabId}`] = message.syncedCount || 0;
            
            chrome.storage.local.set(updateState);
            
            if (tabId === currentTabId) {
                updateProgress(message.percent, message.total, message.statusMsg, message.estimatedTotal || 155, message.syncedCount || 0);
            }
        } else {
            if (tabId === currentTabId) {
                statusText.innerText = message.statusMsg;
            }
        }
    } else if (message.action === 'finished') {
        const updateState = {};
        updateState[`isRunning_${tabId}`] = false;
        updateState[`percentProgress_${tabId}`] = 100;
        updateState[`syncedCount_${tabId}`] = message.syncedCount || message.total;
        updateState[`totalScraped_${tabId}`] = message.total;
        
        chrome.storage.local.set(updateState);
        
        if (tabId === currentTabId) {
            stopTimer();
            btnStart.disabled = false;
            btnStop.disabled = true;
            inputWebhook.disabled = false;
            const tabInput = document.getElementById('tab-name-input');
            if (tabInput) tabInput.disabled = false;
            updateProgress(100, message.total, `Успішно зібрано ${message.total} товарів!`, message.total, message.syncedCount || message.total);
        }
    } else if (message.action === 'error') {
        const updateState = {};
        updateState[`isRunning_${tabId}`] = false;
        chrome.storage.local.set(updateState);
        
        if (tabId === currentTabId) {
            stopTimer();
            btnStart.disabled = false;
            btnStop.disabled = true;
            inputWebhook.disabled = false;
            const tabInput = document.getElementById('tab-name-input');
            if (tabInput) tabInput.disabled = false;
            statusText.innerText = `Помилка: ${message.message}`;
        }
    }
});

// Ініціалізація попапу при завантаженні сторінки
document.addEventListener('DOMContentLoaded', initPopup);
