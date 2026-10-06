const testCases = [
    "від продавця: Berem&amp;Store",
    "від продавця: Berem&Store",
    "от продавца: Мій компʼютер",
    "Продавець: TutTehno",
    "Продавець товару: THANOS",
    "Доставка від продавця: Qinetiq",
    "Мій компʼютер (24)",
    "TutTehno 4.8 ★ (150)",
    "THANOS (98% позитивних відгуків)",
    "ROZETKA",
    "rozetka.com.ua",
    "Rozetka (експрес-доставка)",
    "Berem &amp; Store",
    "ФОП Іванов І.І.",
    "ТОВ \"РОМАШКА\"",
    "Інші продавці (15)",
    "В наявності"
];

function cleanSellerName(raw) {
    if (!raw) return '';
    let text = String(raw).trim();
    text = text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#34;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\u00A0/g, ' ')
        .replace(/\u202F/g, ' ');

    text = text.replace(/^(?:інтернет-магазин|магазин|продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
    const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0 && !/^(?:інтернет-магазин|магазин|продавець(?:\s+товару)?|продавец|seller|merchant|від\s+продавця|от\s+продавца)\s*:?$/i.test(l));
    if (lines.length === 0) return '';
    let name = lines[0];

    name = name.replace(/\s*\([^)]*\).*$/, '');
    name = name.replace(/\s*\b\d+(?:[.,]\d+)?\s*(?:★|\%|\bтовар\w*|\bтов\w*).*$/, '');
    name = name.replace(/\s+\d+\s*$/, '');
    name = name.replace(/^(?:інтернет-магазин|магазин|продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
    name = name.replace(/^[>›»\s—–:-]+|[>›»\s—–:-]+$/, '').trim();

    if (name.length > 3 && name === name.toUpperCase() && !/^\d+$/.test(name) && !/^ФОП\b/i.test(name) && !/^ТОВ\b/i.test(name)) {
        name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    }

    if (/^rozetka\b/i.test(name) || /^розетка\b/i.test(name)) {
        return 'Rozetka';
    }

    if (name.length >= 2 && name.length <= 80 && !/^\d+$/.test(name) && !/^(?:відгук|отзыв|купити|купить|додати|в кошик|немає|в наявності|новинка|акція|топ|скидка|знижка|уточнюйте|офіційний|официальный|інші продавці|другие продавцы|всі продавці|все продавцы)/i.test(name)) {
        return name;
    }
    return '';
}

for (const tc of testCases) {
    console.log(`"${tc}" -> "${cleanSellerName(tc)}"`);
}
