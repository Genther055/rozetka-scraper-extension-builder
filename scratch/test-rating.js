const { JSDOM } = require('jsdom');

function measureVisualStarFill(tileEl) {
    if (!tileEl) return 0;
    try {
        // Exclude seller rating elements
        const sellerContainers = tileEl.querySelectorAll('rz-product-seller, .product-seller, .goods-tile__seller, .seller-rating, [class*="seller"], [class*="merchant"], [class*="shop"], [class*="store"], .seller-info');

        // 1. Aria-label or title check on product rating components only
        const ratingAriaNodes = tileEl.querySelectorAll('rz-stars-rating-progress [aria-label], .goods-tile__rating [aria-label], [data-testid*="rating"] [aria-label], rz-stars-rating-progress[aria-label]');
        for (const node of ratingAriaNodes) {
            let skip = false;
            for (const sc of sellerContainers) {
                if (sc.contains(node)) { skip = true; break; }
            }
            if (skip) continue;

            const text = (node.getAttribute('aria-label') || node.getAttribute('title') || '').trim();
            const m = text.match(/([1-5](?:[.,]\d+)?)\s*(?:з|\/|\/5|з 5)\s*5?/i) || text.match(/рейтинг:?\s*([1-5](?:[.,]\d+)?)/i);
            if (m && m[1]) {
                const val = parseFloat(m[1].replace(',', '.'));
                if (val >= 1.0 && val <= 5.0) return parseFloat(val.toFixed(1));
            }
        }

        // 2. Target progress star components strictly (the visual golden fill bar)
        const progressContainers = tileEl.querySelectorAll('rz-stars-rating-progress, .stars-rating-progress, [data-testid="stars-rating"]');
        for (const container of progressContainers) {
            let skip = false;
            for (const sc of sellerContainers) {
                if (sc.contains(container)) { skip = true; break; }
            }
            if (skip) continue;

            // Look for inner fill element (the golden active overlay)
            const fillEl = container.querySelector('.stars-rating-progress__fill, [class*="progress__fill"], div[style*="width"], span[style*="width"], svg[style*="width"]');
            if (!fillEl) continue; // NEVER fallback to container itself!

            // Method A: CSS style percentage width
            const styleAttr = fillEl.getAttribute('style') || '';
            const m = styleAttr.match(/width:\s*(?:calc\(\s*)?([\d.]+)%/i);
            if (m && m[1]) {
                const percent = parseFloat(m[1]);
                if (percent > 0 && percent <= 100) {
                    const calculatedRating = parseFloat(((percent / 100) * 5).toFixed(1));
                    if (calculatedRating >= 1.0 && calculatedRating <= 5.0) {
                        return calculatedRating;
                    }
                }
            }
        }

        // 3. Count individual active star icons
        const starTrack = tileEl.querySelector('rz-stars-rating-progress, .goods-tile__stars, .stars-rating');
        if (starTrack) {
            const activeStars = starTrack.querySelectorAll('.icon-star--active, .star--active, .star-active, [class*="star_active"], [class*="star--active"], [class*="star-fill"], svg[fill="#ffa900"], svg[fill="#f8a700"], svg[fill="#ffb800"]');
            if (activeStars.length > 0 && activeStars.length <= 5) {
                return parseFloat(activeStars.length.toFixed(1));
            }
        }
    } catch (_) {}
    return 0;
}

function extractReviewsFromDomTile(tileEl) {
    if (!tileEl) return 0;
    const tileRawText = (tileEl.innerText || tileEl.textContent || '');
    if (tileRawText.includes('Залишити відгук') || tileRawText.includes('Оставить отзыв')) {
        return 0;
    }
    const revEl = tileEl.querySelector('a.goods-tile__reviews-link, [class*="reviews-link"]');
    if (revEl) {
        const t = (revEl.innerText || revEl.textContent || '').trim();
        const m = t.match(/(\d[\d\s\u00A0]*)/);
        if (m && m[1]) {
            return parseInt(m[1].replace(/\D/g, ''), 10) || 0;
        }
    }
    return 0;
}

function resolveProductRating(tileEl, fallbackMarksRating = 0) {
    const reviews = extractReviewsFromDomTile(tileEl);
    if (reviews === 0) return { rating: 0, reviews: 0 };

    let visual = measureVisualStarFill(tileEl);
    if (visual > 0 && visual <= 5) {
        return { rating: visual, reviews };
    }
    if (fallbackMarksRating > 0 && fallbackMarksRating <= 5) {
        return { rating: fallbackMarksRating, reviews };
    }
    return { rating: 0, reviews };
}

// 10 Test Cases
const tests = [
  { name: '1. Tile with 0 reviews + seller 4.8', html: '<div class="goods-tile"><div class="goods-tile__rating"><a class="goods-tile__reviews-link">Залишити відгук</a></div><div class="goods-tile__seller">Продавець: RozetkaEU (4.8)</div></div>', expectedR: 0, expectedRev: 0 },
  { name: '2. Tile with 0 reviews, no rating block', html: '<div class="goods-tile"><div class="title">Xiaomi Power Bank</div></div>', expectedR: 0, expectedRev: 0 },
  { name: '3. Tile with 5 reviews, 4.2 stars (width: 84%)', html: '<div class="goods-tile"><div class="goods-tile__rating"><rz-stars-rating-progress><div class="stars-rating-progress"><span class="stars-rating-progress__fill" style="width: 84%;"></span></div></rz-stars-rating-progress><a class="goods-tile__reviews-link">5 відгуків</a></div></div>', expectedR: 4.2, expectedRev: 5 },
  { name: '4. Tile with 25 reviews, 5.0 stars (width: 100%)', html: '<div class="goods-tile"><div class="goods-tile__rating"><rz-stars-rating-progress><div class="stars-rating-progress"><span class="stars-rating-progress__fill" style="width: 100%;"></span></div></rz-stars-rating-progress><a class="goods-tile__reviews-link">25 відгуків</a></div></div>', expectedR: 5.0, expectedRev: 25 },
  { name: '5. Tile with 1 review, 3.0 stars (width: 60%)', html: '<div class="goods-tile"><div class="goods-tile__rating"><rz-stars-rating-progress><div class="stars-rating-progress"><span class="stars-rating-progress__fill" style="width: 60%;"></span></div></rz-stars-rating-progress><a class="goods-tile__reviews-link">1 відгук</a></div></div>', expectedR: 3.0, expectedRev: 1 },
  { name: '6. Tile with 14 reviews, aria-label 4.6', html: '<div class="goods-tile"><div class="goods-tile__rating"><rz-stars-rating-progress aria-label="Рейтинг 4.6 з 5"><div class="stars-rating-progress"></div></rz-stars-rating-progress><a class="goods-tile__reviews-link">14 відгуків</a></div></div>', expectedR: 4.6, expectedRev: 14 },
  { name: '7. Tile with 0 reviews + seller footer badge 4.8', html: '<div class="goods-tile"><a class="goods-tile__reviews-link">Залишити відгук</a><div class="seller-info"><span class="seller-rating" style="width: 96%;">4.8</span></div></div>', expectedR: 0, expectedRev: 0 },
  { name: '8. Tile with 8 reviews, genuine 4.8 stars (width: 96%)', html: '<div class="goods-tile"><div class="goods-tile__rating"><rz-stars-rating-progress><div class="stars-rating-progress"><span class="stars-rating-progress__fill" style="width: 96%;"></span></div></rz-stars-rating-progress><a class="goods-tile__reviews-link">8 відгуків</a></div></div>', expectedR: 4.8, expectedRev: 8 },
  { name: '9. Tile with 0 reviews and stub 4.8 in background', html: '<div class="goods-tile"><a class="goods-tile__reviews-link">Залишити відгук</a></div>', expectedR: 0, expectedRev: 0, fallbackMarks: 4.8 },
  { name: '10. Tile with 0 reviews and promo banner', html: '<div class="goods-tile"><div class="promo">Акція</div></div>', expectedR: 0, expectedRev: 0 }
];

let allPassed = true;
tests.forEach(t => {
  const dom = new JSDOM(t.html);
  const el = dom.window.document.querySelector('.goods-tile');
  const res = resolveProductRating(el, t.fallbackMarks || 0);
  const passed = res.rating === t.expectedR && res.reviews === t.expectedRev;
  if (!passed) allPassed = false;
  console.log((passed ? '✓ PASS' : '✗ FAIL') + ' ' + t.name + ' -> Result: { rating: ' + res.rating + ', reviews: ' + res.reviews + ' } | Expected: { rating: ' + t.expectedR + ', reviews: ' + t.expectedRev + ' }');
});

console.log('\nOverall Result:', allPassed ? 'ALL 10 TESTS PASSED PERFECTLY!' : 'SOME TESTS FAILED');
process.exit(allPassed ? 0 : 1);
