const fs = require('fs');

async function test() {
  const url = 'https://rozetka.com.ua/ua/power-banks/c387969/producer=sigma-mobile/';
  console.log('Fetching:', url);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    console.log('Status:', res.status);
    const html = await res.text();
    fs.writeFileSync('scratch/rozetka-sample.html', html);
    console.log('Saved scratch/rozetka-sample.html, length:', html.length);

    // Look for serverApp-state
    const mState = html.match(/<script id="serverApp-state"[^>]*>(.*?)<\/script>/s);
    if (mState) {
      console.log('serverApp-state found!');
      const stateContent = mState[1];
      fs.writeFileSync('scratch/serverApp-state.json', stateContent);
      console.log('Saved serverApp-state.json, length:', stateContent.length);
    }
  } catch (e) {
    console.log('Error:', e.message);
  }
}

test();
