const fs = require('fs');
const ids = JSON.parse(fs.readFileSync('scratch/product_ids.json', 'utf8'));

const js = `const ids = ${JSON.stringify(ids)};
(async function syncRozetkaSellers() {
  console.log("Отримую дані продавців для " + ids.length + " товарів з Rozetka API...");
  const sellerMap = {};
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) {
    chunks.push(ids.slice(i, i + 50));
  }
  let done = 0;
  await Promise.all(chunks.map(async (chunk) => {
    try {
      const url = "https://common-api.rozetka.com.ua/v1/api/product/details?country=UA&lang=ua&ids=" + chunk.join(",");
      const res = await fetch(url, { headers: { "Accept": "application/json" }, credentials: "include" });
      const json = await res.json();
      if (Array.isArray(json.data)) {
        json.data.forEach(p => {
          if (p && p.id) {
            const sTitle = p.seller?.title || p.seller?.name || (p.seller?.id === 5 ? "Rozetka" : "Rozetka");
            sellerMap[String(p.id)] = sTitle;
          }
        });
      }
    } catch(e) {}
    done += chunk.length;
    console.log("Оброблено:", Math.min(done, ids.length), "/", ids.length);
  }));

  console.log("===РЕЗУЛЬТАТ===");
  const out = JSON.stringify(sellerMap);
  console.log(out);
  try {
    if (typeof copy === "function") {
      copy(out);
      console.log("✅ Успішно скопійовано в буфер обміну! Просто вставте результат у чат (Ctrl + V).");
    } else {
      console.log("📋 Скопіюйте рядок вище та вставте його в чат.");
    }
  } catch(_) {
    console.log("📋 Скопіюйте рядок вище та вставте його в чат.");
  }
})();`;

fs.writeFileSync('scratch/console_sync_script.js', js);
console.log('Script generated successfully! Length:', js.length);
