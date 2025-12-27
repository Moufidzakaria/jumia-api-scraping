import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';
import compression from 'compression';
import 'dotenv/config';

/* ================== APP ================== */
const app = express();
const PORT = Number(process.env.PORT || 8080);

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(express.json({ limit: '1mb' }));
app.use(cors());
app.use(helmet());
app.use(compression());

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/* ================== REDIS ================== */
let redis: Redis | null = null;

if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    retryStrategy: t => Math.min(t * 50, 2000),
  });

  redis.on('error', () => (redis = null));
  redis.connect().catch(() => (redis = null));
}

/* ================== MONGODB ================== */
const productSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, index: true },
    title: String,
    price: String,
    priceNumber: { type: Number, index: true },
    image: String,
    url: String,
    sourcePage: String,
    category: { type: String, index: true },
  },
  { timestamps: true, versionKey: false }
);

productSchema.index({ title: 'text' });

const Product =
  mongoose.models.Product || mongoose.model('Product', productSchema);

/* ================== UTILS ================== */
const parsePrice = (price: string) =>
  Number(price.replace(/[^\d]/g, ''));

async function cache(key: string, fn: () => Promise<any>, ttl = 60) {
  if (!redis) return fn();
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);
  const data = await fn();
  await redis.setex(key, ttl, JSON.stringify(data));
  return data;
}

/* ================== RAPIDAPI PLAN ================== */
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.path === '/ping') return next();

  const plan =
    ((req.headers['x-rapidapi-subscription'] as string) ||
      'PRO').toUpperCase();

  (req as any).plan = plan;
  next();
});

/* ================== TRANSFORM (PRO = ALL DATA) ================== */
const transformProduct = (p: any, plan: string) => {
  if (plan === 'BASIC') {
    return { id: p.id, title: p.title };
  }

  return {
    id: p.id,
    title: p.title,
    price: p.price,
    image: p.image,
    url: p.url,
    category: p.category,
    ...(plan === 'MEGA' && { sourcePage: p.sourcePage }),
  };
};

/* ================== ROUTES ================== */
app.get('/ping', (_req, res) =>
  res.json({ status: 'ok' })
);

/* 🔐 INSERT DATA */
app.post('/produit', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'unauthorized' });

  const { id, title, price, image, url, sourcePage, category } = req.body;

  if (!id || !title || !price)
    return res.status(400).json({ error: 'missing fields' });

  await Product.updateOne(
    { id },
    {
      $set: {
        title,
        price,
        priceNumber: parsePrice(price),
        image,
        url,
        sourcePage,
        category,
      },
    },
    { upsert: true }
  );

  res.json({ success: true });
});

/* 🔹 ALL PRODUCTS */
app.get('/produit', async (req, res) => {
  const plan = (req as any).plan;
  const limit = plan === 'BASIC' ? 20 : 100;

  const data = await cache(
    `all:${plan}`,
    () => Product.find().sort({ createdAt: -1 }).limit(limit).lean(),
    60
  );

  res.json(data.map(p => transformProduct(p, plan)));
});

/* 🔹 BY ID (IMPORTANT FOR RAPIDAPI) */
app.get('/produit/:id', async (req, res) => {
  const plan = (req as any).plan;

  const product = await cache(
    `id:${req.params.id}:${plan}`,
    () => Product.findOne({ id: req.params.id }).lean(),
    300
  );

  if (!product) return res.status(404).json({ error: 'not found' });
  res.json(transformProduct(product, plan));
});

/* 🔹 SEARCH */
app.get('/produit/search/:name', async (req, res) => {
  const plan = (req as any).plan;

  const data = await cache(
    `search:${req.params.name}:${plan}`,
    () =>
      Product.find({ $text: { $search: req.params.name } })
        .limit(50)
        .lean(),
    60
  );

  res.json(data.map(p => transformProduct(p, plan)));
});

/* 🔹 PRICE RANGE */
app.get('/produit/price-range', async (req, res) => {
  const { min, max } = req.query;
  const plan = (req as any).plan;

  const data = await cache(
    `price:${min}-${max}:${plan}`,
    () =>
      Product.find({
        priceNumber: { $gte: Number(min), $lte: Number(max) },
      }).lean(),
    120
  );

  res.json(data.map(p => transformProduct(p, plan)));
});

/* 🔹 CATEGORIES */
app.get('/produit/categories', async (_req, res) => {
  const categories = await Product.aggregate([
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  res.json(categories);
});

/* ================== START ================== */
(async () => {
  await mongoose.connect(process.env.MONGO_URI!);
  app.listen(PORT, '0.0.0.0', () =>
    console.log(`🚀 API running on ${PORT}`)
  );
})();
