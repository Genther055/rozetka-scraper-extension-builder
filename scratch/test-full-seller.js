const testRawNames = [
    'QINETIQ',
    'Qinetiq',
    'Продавець: Mini Shop',
    'Продавец: Mini Shop',
    'Доставка від продавця Smart Hub',
    'Відправник: Tech Store',
    'Remzona'
];

function cleanSellerName(raw) {
    if (!raw) return '';
    let text = String(raw).trim();
    text = text.replace(/^(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|магазин|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
    const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0 && !/^(?:продавець(?:\s+товару)?|продавец|seller|магазин|merchant|від\s+продавця|от\s+продавца)\s*:?$/i.test(l));
    if (lines.length === 0) return '';
    let name = lines[0];
    name = name.replace(/\s*\b\d(?:[.,]\d)?\s*\(\s*\d+%\s*\).*$/, '');
    name = name.replace(/\s*\(\s*\d+%\s*\).*$/, '');
    name = name.replace(/\s+\d(?:[.,]\d)?\s*★.*$/, '');
    name = name.replace(/^(?:продавець(?:\s+товару)?|продавец(?:\s+товара)?|seller|магазин|merchant|від\s+продавця|от\s+продавца|доставка\s+від(?:\s+продавця)?|доставка\s+от(?:\s+продавца)?|відправник|отправитель)\s*:?\s*/i, '');
    name = name.replace(/[>›»\s]+$/, '').trim();
    
    // Normalize all-caps names e.g. "QINETIQ" -> "Qinetiq"
    if (name.length > 3 && name === name.toUpperCase() && !/^\d+$/.test(name)) {
        name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
    }

    if (name.length >= 2 && name.length <= 80 && !/^\d+$/.test(name) && !/^(?:відгук|отзыв|купити|купить|додати|в кошик|немає|в наявності|новинка|акція|топ|скидка|знижка|уточнюйте|офіційний|официальный)/i.test(name)) {
        return name;
    }
    return '';
}

testRawNames.forEach(n => console.log(JSON.stringify(n), '->', JSON.stringify(cleanSellerName(n))));
