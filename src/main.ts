import { PlaywrightCrawler } from 'crawlee';
import fs from 'fs';

const START_PAGE = 1;
const END_PAGE = 50;

const urls = [];
for (let page = START_PAGE; page <= END_PAGE; page++) {
  urls.push(
    `https://www.jumia.ma/catalog/?q=pc+portable+hp&page=${page}#catalog-listing`
  );
}

// Array باش نجمعو الداتا
const allProducts = [];

const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: 50,

  async requestHandler({ page, request, log }) {
    log.info(`Scraping ${request.url}`);

    await page.waitForTimeout(2000 + Math.random() * 3000);
    await page.waitForSelector('article.prd', { timeout: 15000 });

    const products = await page.$$eval('article.prd', items =>
      items.map(item => ({
        title: item.querySelector('h3.name')?.innerText || null,
        price: item.querySelector('div.prc')?.innerText || null,
        image:
          item.querySelector('img')?.getAttribute('data-src') ||
          item.querySelector('img')?.src ||
          null,
        url: item.querySelector('a.core')?.href || null,
      }))
    );

    for (const product of products) {
      allProducts.push({
        ...product,
        sourcePage: request.url,
      });
    }
  },
});

// Run crawler
await crawler.run(urls);

const ip = await page.evaluate(() => fetch('https://api.ipify.org/?format=json')
  .then(res => res.json())
);
console.log(`IP utilisée: ${ip.ip}`);


// 📝 كتابة fichier JSON
fs.writeFileSync(
  './products.json',
  JSON.stringify(allProducts, null, 2),
  'utf-8'
);

console.log(`✅ Saved ${allProducts.length} products to products.json`);
