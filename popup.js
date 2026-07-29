// Елементи інтерфейсу
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const inputWebhook = document.getElementById('webhook-url');
const statusText = document.getElementById('status-text');
const countText = document.getElementById('count-text');
const timerText = document.getElementById('timer-text');
const percentText = document.getElementById('percent-text');
const progressFill = document.getElementById('progress-fill');

let timerInterval = null;
let startTime = null;

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

// Оновлення повзунка прогресу та відсотків
function updateProgress(percent, count, actionMsg, totalEstimated) {
    const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
    progressFill.style.width = `${safePercent}%`;
    percentText.innerText = `${safePercent}%`;
    
    if (count !== undefined) {
        if (totalEstimated && totalEstimated > 0) {
            countText.innerText = `Товарів: ${count} з ${totalEstimated}`;
        } else {
            countText.innerText = `Товарів: ${count}`;
        }
    }
    if (actionMsg) {
        statusText.innerText = actionMsg;
    }
}

// Відновлення стану з chrome.storage
chrome.storage.local.get(['isRunning', 'webhookUrl', 'totalScraped', 'currentPage', 'startTime', 'statusMsg', 'percentProgress'], (state) => {
    if (state.webhookUrl) {
        inputWebhook.value = state.webhookUrl;
    } else {
        inputWebhook.value = 'https://rozetka-scraper-extension-builder.onrender.com/api/products';
    }

    if (state.isRunning) {
        btnStart.disabled = true;
        btnStop.disabled = false;
        inputWebhook.disabled = true;
        startTimer(state.startTime);
        updateProgress(state.percentProgress || 10, state.totalScraped || 0, state.statusMsg || 'Скрейпінг активний...', 155);
    } else {
        btnStart.disabled = false;
        btnStop.disabled = true;
        inputWebhook.disabled = false;
        stopTimer();
        if (state.totalScraped) {
            updateProgress(100, state.totalScraped, 'Збір завершено успішно!', state.totalScraped);
        } else {
            updateProgress(0, 0, 'Очікування запуску...', 0);
        }
    }
});

// Запуск
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

    btnStart.disabled = true;
    btnStop.disabled = false;
    inputWebhook.disabled = true;

    const now = Date.now();
    await chrome.storage.local.set({
        isRunning: true,
        webhookUrl: webhookUrl,
        totalScraped: 0,
        currentPage: 1,
        startTime: now,
        statusMsg: 'Запуск скрапінгу на сторінці...',
        percentProgress: 5
    });

    startTimer(now);
    updateProgress(5, 0, 'Запуск скрапінгу на сторінці...', 155);

    // Прямий запуск content.js без необхідності перезавантаження сторінки
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

// Зупинка
btnStop.addEventListener('click', async () => {
    await chrome.storage.local.set({ isRunning: false });
    btnStart.disabled = false;
    btnStop.disabled = true;
    inputWebhook.disabled = false;
    stopTimer();
    updateProgress(0, 0, 'Скрейпінг зупинено.', 0);
});

// Слухач повідомлень від content.js
chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'progress') {
        const estimatedTotal = message.estimatedTotal || 155;
        const percent = Math.min(99, (message.total / estimatedTotal) * 100);
        const actionStr = message.statusMsg || `Сканування сторінки ${message.page}...`;
        
        chrome.storage.local.set({
            totalScraped: message.total,
            currentPage: message.page,
            statusMsg: actionStr,
            percentProgress: percent
        });
        
        updateProgress(percent, message.total, actionStr, estimatedTotal);
    } else if (message.action === 'status') {
        statusText.innerText = message.statusMsg;
        if (message.percent !== undefined) {
            updateProgress(message.percent, message.total, message.statusMsg, message.estimatedTotal || 155);
        }
    } else if (message.action === 'finished') {
        stopTimer();
        btnStart.disabled = false;
        btnStop.disabled = true;
        inputWebhook.disabled = false;
        
        chrome.storage.local.set({ isRunning: false });
        updateProgress(100, message.total, `Успішно зібрано ${message.total} товарів!`, message.total);
    } else if (message.action === 'error') {
        stopTimer();
        btnStart.disabled = false;
        btnStop.disabled = true;
        inputWebhook.disabled = false;
        
        chrome.storage.local.set({ isRunning: false });
        statusText.innerText = `Помилка: ${message.message}`;
    }
});
