async function test() {
  const url = 'https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=611141153,612499823,517691374';
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://rozetka.com.ua/',
    'Origin': 'https://rozetka.com.ua'
  };
  try {
    const res = await fetch(url, { headers });
    console.log('Status:', res.status);
    const text = await res.text();
    console.log('Response text (first 500 chars):', text.slice(0, 500));
  } catch(e) {
    console.log('Error:', e.message);
  }
}
test();
