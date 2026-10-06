// Test parsing LView / Angular context simulation
const mockLView = [
    null,
    {
        // Component instance
        goods: {
            id: 459482989,
            title: "Повербанк 10000 mah Remzona",
            seller: {
                id: 555,
                title: "Berem&Store"
            },
            sellers_count: 5,
            price: 899,
            old_price: 1299
        }
    },
    {
        tile: {
            id: 611141153,
            title: "Sigma mobile 20000",
            seller_title: "Мій компʼютер",
            sellers_count: 3
        }
    }
];

function extractFromAngularLView(lview) {
    const map = {};
    const visited = new Set();

    function traverse(node, depth = 0) {
        if (!node || typeof node !== 'object' || visited.has(node) || depth > 4) return;
        visited.add(node);

        const id = node.id || node.goods_id || node.goodsId || node.productId;
        if (id && (node.seller || node.seller_id || node.seller_title || node.sellers_count || node.title)) {
            let sellerName = '';
            if (node.seller) {
                sellerName = typeof node.seller === 'string' ? node.seller : (node.seller.title || node.seller.name || node.seller.title_translit || node.seller.seller_name || '');
            }
            if (!sellerName) {
                sellerName = node.seller_title || node.sellerName || node.seller_name || node.merchant_name || '';
            }
            let sCount = node.sellers_count || node.sellersCount || (node.other_sellers_count ? node.other_sellers_count + 1 : 1);
            map[String(id)] = {
                id: String(id),
                seller: sellerName,
                sellersCount: typeof sCount === 'number' ? sCount : 1
            };
        }

        if (Array.isArray(node)) {
            for (const item of node) traverse(item, depth + 1);
        } else {
            for (const k of Object.keys(node)) {
                if (typeof node[k] === 'object' && node[k] !== null) {
                    traverse(node[k], depth + 1);
                }
            }
        }
    }

    traverse(lview);
    return map;
}

const result = extractFromAngularLView(mockLView);
console.log("Extracted from LView:", result);
