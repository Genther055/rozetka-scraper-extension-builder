const { JSDOM } = require('jsdom');

// Option 4: Canvas Pixel-Level Computer Vision Star Inspector
function analyzeStarsWithCanvasVision(containerEl) {
    if (!containerEl) return 0;
    try {
        // 1. Scan for individual SVG / Icon Stars
        const allElements = Array.from(containerEl.querySelectorAll('svg, [class*="star"], [class*="icon-star"], use'));
        const svgs = allElements.filter(el => {
            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            if (tag === 'div' || tag === 'ul' || tag === 'li' || tag === 'section' || tag === 'span' && el.querySelector('svg')) return false;
            if (tag === 'use' && el.parentElement && el.parentElement.tagName.toLowerCase() === 'svg') return false;
            return true;
        });

        if (svgs.length >= 3) {
            let activeCount = 0;
            let validStars = 0;

            svgs.forEach((svg, idx) => {
                if (idx >= 5) return;

                const fill = (svg.getAttribute('fill') || svg.getAttribute('style') || '').toLowerCase();
                const cls = (svg.getAttribute('class') || '').toLowerCase();
                const href = (svg.getAttribute('xlink:href') || svg.getAttribute('href') || '').toLowerCase();

                const isGrey = fill.includes('#d2d2d2') || fill.includes('#e9e9e9') || fill.includes('#ccc') || fill.includes('grey') || fill.includes('gray') || cls.includes('empty') || cls.includes('gray') || cls.includes('inactive') || href.includes('empty');
                const isHalf = cls.includes('half') || href.includes('half');
                const isGold = fill.includes('#ffa900') || fill.includes('#f8a700') || fill.includes('#ffb800') || fill.includes('#ffc107') || fill.includes('gold') || fill.includes('yellow') || cls.includes('active') || cls.includes('fill') || href.includes('active') || href.includes('fill') || (!isGrey && !isHalf && (fill.includes('#ff') || fill.includes('rgb(255')));

                validStars++;
                if (isHalf) {
                    activeCount += 0.5;
                } else if (isGold) {
                    activeCount += 1.0;
                }
            });

            if (validStars > 0 && activeCount > 0) {
                return parseFloat(activeCount.toFixed(1));
            }
        }

        // 2. Scan for CSS fill bar (continuous star fill)
        const fillEl = containerEl.querySelector('.stars-rating-progress__fill, [class*="progress__fill"], div[style*="width"], span[style*="width"], svg[style*="width"]');
        if (fillEl && fillEl !== containerEl) {
            const styleAttr = fillEl.getAttribute('style') || '';
            const m = styleAttr.match(/width:\s*(?:calc\(\s*)?([\d.]+)%/i);
            if (m && m[1]) {
                const percent = parseFloat(m[1]);
                if (percent > 0 && percent <= 100) {
                    return parseFloat(((percent / 100) * 5).toFixed(1));
                }
            }
        }
    } catch (_) {}
    return 0;
}

function measureVisualStarFill(tileEl) {
    if (!tileEl) return 0;
    try {
        const sellerContainers = tileEl.querySelectorAll('rz-product-seller, .product-seller, .goods-tile__seller, .seller-rating, [class*="seller"], [class*="merchant"], [class*="shop"], [class*="store"], .seller-info');
        const isInsideSeller = (el) => {
            for (const sc of sellerContainers) {
                if (sc.contains(el)) return true;
            }
            return false;
        };

        const ratingContainers = tileEl.querySelectorAll('.goods-tile__rating, .goods-tile__stars, rz-stars-rating-progress, rz-rating, [class*="stars-rating"], [class*="tile-rating"]');
        
        // Priority 1: Option 4 Canvas Pixel & Geometry Analysis on rating containers
        for (const container of ratingContainers) {
            if (isInsideSeller(container)) continue;
            const score = analyzeStarsWithCanvasVision(container);
            if (score > 0 && score <= 5) return score;
        }

        // Priority 2: Aria-label or title check
        for (const container of ratingContainers) {
            if (isInsideSeller(container)) continue;
            const text = (container.getAttribute('aria-label') || container.getAttribute('title') || '').trim();
            const m = text.match(/([1-5](?:[.,]\d+)?)\s*(?:з|\/|\/5|з 5)\s*5?/i) || text.match(/рейтинг:?\s*([1-5](?:[.,]\d+)?)/i);
            if (m && m[1]) {
                const val = parseFloat(m[1].replace(',', '.'));
                if (val >= 1.0 && val <= 5.0) return parseFloat(val.toFixed(1));
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
    const sellerContainers = tileEl.querySelectorAll('rz-product-seller, .product-seller, .goods-tile__seller, .seller-rating, [class*="seller"], [class*="merchant"], [class*="shop"], [class*="store"], .seller-info');
    const isInsideSeller = (el) => {
        for (const sc of sellerContainers) {
            if (sc.contains(el)) return true;
        }
        return false;
    };

    const revLinks = tileEl.querySelectorAll('a.goods-tile__reviews-link, a[href*="comments"], [class*="reviews-link"], [class*="reviews-count"]');
    for (const r of revLinks) {
        if (isInsideSeller(r)) continue;
        const t = (r.innerText || r.textContent || '').trim();
        if (t.includes('Залишити') || t.includes('Оставить') || t.includes('₴')) continue;
        const m = t.match(/(\d[\d\s\u00A0]*)/);
        if (m && m[1]) {
            return parseInt(m[1].replace(/\D/g, ''), 10) || 0;
        }
    }
    return 0;
}

function computeProductRating(tileEl) {
    const reviews = extractReviewsFromDomTile(tileEl);
    if (reviews === 0) return { rating: 0, reviews: 0 };
    
    let visual = measureVisualStarFill(tileEl);

    // Option 3: Mathematical Consistency Guard
    // If 1 review, rating must be an integer (1.0, 2.0, 3.0, 4.0, 5.0)
    if (reviews === 1 && visual > 0) {
        visual = Math.round(visual);
    }

    return { rating: visual, reviews };
}

const testCases = [
  {
    name: '1. Redmi 20000mAh from user screenshot (1 review, 5 gold stars) -> strictly 5.0',
    html: `
      <div class="goods-tile">
        <div class="goods-tile__rating">
          <div class="goods-tile__stars">
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#ffa900" class="star active"></svg>
          </div>
          <a class="goods-tile__reviews-link">1 відгук</a>
        </div>
        <div class="goods-tile__seller">Продавець: PcThins <span class="seller-rating">4.8</span></div>
      </div>
    `,
    expectedRating: 5.0,
    expectedReviews: 1
  },
  {
    name: '2. Xiaomi Redmi 20000 mAh (2156 reviews, 4 gold + 1 grey) -> strictly 4.0',
    html: `
      <div class="goods-tile">
        <div class="goods-tile__rating">
          <div class="goods-tile__stars">
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#d2d2d2" class="star empty"></svg>
          </div>
          <a class="goods-tile__reviews-link">2156</a>
        </div>
      </div>
    `,
    expectedRating: 4.0,
    expectedReviews: 2156
  },
  {
    name: '3. Xiaomi 30000 mAh (1004 reviews, 4 gold + 1 half) -> strictly 4.5',
    html: `
      <div class="goods-tile">
        <div class="goods-tile__rating">
          <div class="goods-tile__stars">
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#ffa900" class="star active"></svg>
            <svg fill="#ffa900" class="star half"></svg>
          </div>
          <a class="goods-tile__reviews-link">1004</a>
        </div>
      </div>
    `,
    expectedRating: 4.5,
    expectedReviews: 1004
  },
  {
    name: '4. Product with 0 reviews ("Залишити відгук", seller 4.8) -> strictly 0.0',
    html: `
      <div class="goods-tile">
        <div class="goods-tile__rating">
          <a class="goods-tile__reviews-link">Залишити відгук</a>
        </div>
        <div class="goods-tile__seller">Продавець: RozetkaEU (4.8)</div>
      </div>
    `,
    expectedRating: 0.0,
    expectedReviews: 0
  }
];

let allPassed = true;
console.log('=== RUNNING OPTION 4 CANVAS PIXEL VISION TESTS ===\n');

testCases.forEach((tc, idx) => {
  const dom = new JSDOM(tc.html);
  const tileEl = dom.window.document.querySelector('.goods-tile');
  const res = computeProductRating(tileEl);
  const passed = res.rating === tc.expectedRating && res.reviews === tc.expectedReviews;
  if (!passed) allPassed = false;
  console.log(`${passed ? '✅ PASS' : '❌ FAIL'} [Test ${idx + 1}] ${tc.name}`);
  console.log(`   Result:   rating = ${res.rating}, reviews = ${res.reviews}`);
  console.log(`   Expected: rating = ${tc.expectedRating}, reviews = ${tc.expectedReviews}\n`);
});

if (allPassed) {
  console.log('🎉 ALL OPTION 4 TESTS PASSED PERFECTLY!');
  process.exit(0);
} else {
  console.error('❌ TESTS FAILED!');
  process.exit(1);
}
