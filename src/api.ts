import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'crypto';
import 'dotenv/config';
import { PlaywrightCrawler } from 'crawlee';
import Redis from 'ioredis';

// ================== INIT ==================
const app = express();
const PORT = process.env.PORT || 4000;
app.use(express.json());

// ====== SECURITE ======
app.use(cors());
app.use(helmet());
app.use(rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60
}));

// ================== DB ==================
await mongoose.connect(process.env.MONGO_URI as string);
console.log('✅ MongoDB connecté');

// ================== REDIS ==================
const redis = new Redis(process.env.REDIS_URL);
redis.on('connect', () => console.log('✅ Redis connecté'));
redis.on('error', (err) => console.error('❌ Redis error:', err));

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

// ================== API Key Middleware ==================
app.use((req, res, next) => {
  const apiKey = req.header('x-api-key');
  if (apiKey !== process.env.MY_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ================== ROUTES ==================

// GET all products
app.get('/produit', async (req, res) => {
  try {
    const products = await Product.find().sort({ createdAt: -1 });
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET product by ID
app.get('/produit/:id', async (req, res) => {
  try {
    const product = await Product.findOne({ id: req.params.id });
    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// GET products by price
app.get('/produit/price/:price', async (req, res) => {
  try {
    const price = req.params.price;
    const products = await Product.find({ price: new RegExp(price, 'i') });
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
app.post('/scraping', async (req, res) => {
  try {
    // Vérifier cache Redis
    const cache = await redis.get('products');
    if (cache) {
      return res.json({
        message: 'Données depuis le cache Redis',
        total: JSON.parse(cache).length,
        products: JSON.parse(cache),
      });
    }

    const urls = Array.from({ length: 7 }, (_, i) =>
      `https://www.jumia.ma/catalog/?q=pc+portable+hp&page=${i + 1}`
    );

    const results: any[] = [];

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
            image: item.querySelector('img')?.getAttribute('data-src') ||
                   item.querySelector('img')?.getAttribute('src'),
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
            {
              $set: {
                title: product.title,
                price: product.price,
                image: product.image,
                sourcePage: product.sourcePage,
              },
              $setOnInsert: {
                id: product.id,
                createdAt: product.createdAt,
              },
            },
            { upsert: true }
          );

          results.push(product);
        }

        log.info(`✅ ${products.length} produits traités`);
      },
    });

    await crawler.run(urls);

    // Stocker dans Redis pour 1h (3600s)
    await redis.set('products', JSON.stringify(results), 'EX', 3600);

    res.json({ message: 'Scraping terminé et sauvegardé dans Redis', total: results.length, products: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur lors du scraping' });
  }
});

// ================== START SERVER ==================
app.listen(PORT, () => console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`));
