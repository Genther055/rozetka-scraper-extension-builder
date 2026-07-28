const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const inputWebhook = document.getElementById('webhook-url');
const statusText = document.getElementById('status-text');
const countText = document.getElementById('count-text');

// Restore state
chrome.storage.local.get(['isRunning', 'webhookUrl', 'totalScraped', 'statusMsg'], (state) => {
    if (state.webhookUrl) {
        inputWebhook.value = state.webhookUrl;
    } else {
        inputWebhook.value = 'http://localhost:5678/webhook/rozetka-trigger';
    }

    if (state.isRunning) {
        btnStart.disabled = true;
        btnStop.disabled = false;
        inputWebhook.disabled = true;
        statusText.innerText = state.statusMsg || 'Статус: Скрейпінг активний';
        countText.innerText = `Зібрано товарів: ${state.totalScraped || 0}`;
    } else {
        btnStart.disabled = false;
        btnStop.disabled = true;
        inputWebhook.disabled = false;
        if (state.totalScraped) {
            statusText.innerText = 'Статус: Збір завершено успішно!';
            countText.innerText = `Зібрано товарів: ${state.totalScraped}`;
        } else {
            statusText.innerText = 'Статус: Очікування запуску';
            countText.innerText = 'Зібрано товарів: 0';
        }
    }
});

btnStart.addEventListener('click', async () => {
    const webhookUrl = inputWebhook.value.trim();
    if (!webhookUrl) {
        statusText.innerText = 'Помилка: Вкажіть URL!';
        return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabUrl = tab?.url || tab?.pendingUrl || '';
    if (!tab || !tabUrl || !tabUrl.includes('rozetka.com.ua')) {
        statusText.innerText = 'Помилка: Відкрийте каталог Rozetka!';
        return;
    }

    btnStart.disabled = true;
    btnStop.disabled = false;
    inputWebhook.disabled = true;

    await chrome.storage.local.set({
        isRunning: true,
        webhookUrl: webhookUrl,
        totalScraped: 0,
        statusMsg: 'Статус: Запуск скрапінгу...'
    });

    statusText.innerText = 'Статус: Запуск скрапінгу...';
    countText.innerText = 'Зібрано товарів: 0';

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

btnStop.addEventListener('click', async () => {
    await chrome.storage.local.set({ isRunning: false });
    btnStart.disabled = false;
    btnStop.disabled = true;
    inputWebhook.disabled = false;
    statusText.innerText = 'Статус: Скрейпінг зупинено.';
});

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'progress') {
        const actionStr = `Статус: ${message.statusMsg || 'Сканування...'}`;
        chrome.storage.local.set({
            totalScraped: message.total,
            statusMsg: actionStr
        });
        statusText.innerText = actionStr;
        countText.innerText = `Зібрано товарів: ${message.total}`;
    } else if (message.action === 'finished') {
        btnStart.disabled = false;
        btnStop.disabled = true;
        inputWebhook.disabled = false;
        chrome.storage.local.set({ isRunning: false });
        statusText.innerText = `Статус: Успішно зібрано ${message.total} товарів!`;
        countText.innerText = `Зібрано товарів: ${message.total}`;
    } else if (message.action === 'error') {
        btnStart.disabled = false;
        btnStop.disabled = true;
        inputWebhook.disabled = false;
        chrome.storage.local.set({ isRunning: false });
        statusText.innerText = `Помилка: ${message.message}`;
    }
});
