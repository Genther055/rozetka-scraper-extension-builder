function extractSellerFromHtml(title, metaDescription, metaOgDescription) {
    const texts = [title, metaDescription, metaOgDescription].filter(Boolean);
    for (const t of texts) {
        const decoded = t
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&#39;/g, "'")
            .replace(/&#34;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ');

        const m = decoded.match(/(?:від\s+продавця|от\s+продавца|продавець|продавец|seller)\s*:\s*([^|–—<\r\n]+)/i);
        if (m && m[1]) {
            const seller = m[1].trim();
            if (seller) return seller;
        }
    }
    return '';
}

const sampleTitle = "Повербанк 10000 mah 22.5W Remzona зі швидкою зарядкою PD 22.5 W Quick Charge 3.0 Fast Charge УМБ для телефона айфона роутера планшета великий хороший портативний Extrinity Metal 10X LED дисплей портативний – фото, відгуки, характеристики в інтернет-магазині ROZETKA від продавця: Berem&amp;Store";
const sampleMeta = "Повербанк 10000 mah 22.5W Remzona зі швидкою зарядкою PD 22.5 W Quick Charge 3.0 Fast Charge УМБ для телефона айфона роутера планшета великий хороший портативний Extrinity Metal 10X LED дисплей портативний в інтернет-магазині ROZETKA від продавця: Berem&amp;Store | Безкоштовна доставка";

console.log("From Title:", extractSellerFromHtml(sampleTitle, '', ''));
console.log("From Meta:", extractSellerFromHtml('', sampleMeta, ''));
