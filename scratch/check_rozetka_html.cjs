const fetch = globalThis.fetch;

async function checkCatalog() {
  try {
    const res = await fetch('https://rozetka.com.ua/ua/power-bank/c4642484/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'uk-UA,uk;q=0.9'
      }
    });
    console.log('Status:', res.status);
    const text = await res.text();
    console.log('HTML Length:', text.length);
    const hasServerAppState = text.includes('serverApp-state');
    console.log('Has serverApp-state:', hasServerAppState);
    if (hasServerAppState) {
      const match = text.match(/<script id="serverApp-state"[^>]*>([\s\S]*?)<\/script>/);
      if (match) {
        console.log('serverApp-state length:', match[1].length);
        console.log('Sample snippet:', match[1].slice(0, 800));
      }
    }
  } catch (e) {
    console.error('Error:', e);
  }
}

checkCatalog();
