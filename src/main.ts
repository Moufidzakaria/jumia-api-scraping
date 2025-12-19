import { PlaywrightCrawler } from 'crawlee';
import mongoose from 'mongoose';
import fs from 'fs';
import { randomUUID } from 'crypto';
import 'dotenv/config';

// ================== DB ==================
await mongoose.connect(process.env.MONGO_URI as string);
console.log('✅ MongoDB connecté');

// ================== URLS ==================
const urls = Array.from({ length: 7 }, (_, i) =>
  `https://www.jumia.ma/catalog/?q=pc+portable+hp&page=${i + 1}`
);

// ================== SCHEMA ==================
const productSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  title: String,
  price: String,
  image: String,
  url: { type: String, unique: true },
  sourcePage: String,
  createdAt: Date,
}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);
const results: any[] = [];

// ================== CRAWLER ==================
const crawler = new PlaywrightCrawler({
  maxRequestsPerCrawl: urls.length,
  launchContext: { launchOptions: { headless: true } },
  async requestHandler({ page, request, log }) {
    log.info(`Scraping ${request.url}`);
    await page.waitForSelector('article.prd', { timeout: 20000 });

    const productsFromPage = await page.$$eval('article.prd', items =>
      items.map(item => ({
        title: item.querySelector('h3.name')?.textContent?.trim(),
        price: item.querySelector('div.prc')?.textContent?.trim(),
        image: item.querySelector('img')?.getAttribute('data-src') || item.querySelector('img')?.getAttribute('src'),
        url: item.querySelector('a.core')?.href,
        sourcePage: location.href,
      }))
    );

    const products = productsFromPage.map(p => ({
      ...p,
      id: randomUUID(),
      createdAt: new Date(),
    }));

    for (const product of products) {
      if (!product.url) continue;

      await Product.updateOne(
        { url: product.url },
        { $set: { title: product.title, price: product.price, image: product.image, sourcePage: product.sourcePage },
          $setOnInsert: { id: product.id, createdAt: product.createdAt } },
        { upsert: true }
      );

      results.push(product);
    }

    log.info(`✅ ${products.length} produits traités`);
  },
});

// ================== RUN ==================
await crawler.run(urls);

// ================== SAVE JSON ==================
fs.writeFileSync('products.json', JSON.stringify(results, null, 2), 'utf-8');
console.log('📦 products.json généré avec succès');

process.exit(0);
