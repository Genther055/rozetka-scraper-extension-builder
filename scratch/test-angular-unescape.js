// Angular TransferState escaping test
const sampleAngularTransferState = `
&q;goods&q;:[{&q;id&q;:611141153,&q;title&q;:&q;Sigma mobile X-power&q;,&q;seller&q;:{&q;id&q;:123,&q;title&q;:&q;Мій компʼютер&q;},&q;sellers_count&q;:4},
{&q;id&q;:620223395,&q;title&q;:&q;Sigma power&q;,&q;seller&q;:{&q;id&q;:456,&q;title&q;:&q;TutTehno&q;}},
{&q;id&q;:623552327,&q;title&q;:&q;Sigma charger&q;,&q;seller&q;:{&q;id&q;:789,&q;title&q;:&q;THANOS&q;}}]
`;

function unescapeAngularState(str) {
    if (!str) return '';
    return str
        .replace(/&q;/g, '"')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&a;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&l;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&g;/g, '>')
        .replace(/&s;/g, "'");
}

console.log('Original parse without unescape:');
try {
    JSON.parse(sampleAngularTransferState);
    console.log('Parse success');
} catch(e) {
    console.log('Parse failed as expected:', e.message);
}

console.log('\nWith Angular unescape:');
const unescaped = unescapeAngularState(sampleAngularTransferState);
try {
    const parsed = JSON.parse('{' + unescaped + '}');
    console.log('Parse success! Goods count:', parsed.goods.length);
    parsed.goods.forEach(g => console.log(`Product ${g.id} -> Seller: "${g.seller.title}"`));
} catch(e) {
    console.log('Parse failed:', e.message);
}
