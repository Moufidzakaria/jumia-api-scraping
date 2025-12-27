import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';
import compression from 'compression';
import 'dotenv/config';

/* ================== TYPES ================== */
interface ProductDoc {
  id: string;
  title: string;
  image?: string;
  url?: string;
  category?: string;
  price?: string;
  priceNumber?: number;
}

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
    title: { type: String, index: true },
    price: String,
    priceNumber: { type: Number, index: true },
    image: String,
    url: String,
    category: { type: String, index: true },
  },
  { timestamps: true, versionKey: false }
);

productSchema.index({ title: 'text' });

const Product =
  mongoose.models.Product ||
  mongoose.model<ProductDoc>('Product', productSchema);

/* ================== UTILS ================== */
const parsePrice = (price: string) =>
  Number(price.replace(/[^\d]/g, ''));

async function cache<T>(key: string, fn: () => Promise<T>, ttl = 60): Promise<T> {
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

  const planHeader =
    (req.headers['x-rapidapi-subscription'] as string) ||
    (req.headers['x-rapidapi-plan'] as string);

  const plan = (planHeader || 'PRO').toUpperCase();
  (req as any).plan = plan;

  next();
});

/* ================== TRANSFORM ================== */
const transformProduct = (p: ProductDoc, plan: string) => {
  if (plan === 'BASIC') {
    return {
      id: p.id,
      title: p.title,
    };
  }

  // ✅ PRO (DEFAULT)
  return {
    id: p.id,
    title: p.title,
    image: p.image,
    url: p.url,
    category: p.category,
  };
};

/* ================== ROUTES ================== */
app.get('/ping', (_req, res) =>
  res.json({ status: 'ok' })
);

/* 🔐 INSERT DATA (ADMIN) */
app.post('/produit', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { id, title, price, image, url, category } = req.body;

  if (!id || !title) {
    return res.status(400).json({ error: 'missing fields' });
  }

  await Product.updateOne(
    { id },
    {
      $set: {
        title,
        price,
        priceNumber: price ? parsePrice(price) : undefined,
        image,
        url,
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
    () =>
      Product.find()
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean<ProductDoc[]>(),
    60
  );

  res.json(data.map(p => transformProduct(p, plan)));
});

/* 🔹 SEARCH */
app.get('/produit/search/:name', async (req, res) => {
  const plan = (req as any).plan;

  const data = await cache(
    `search:${req.params.name}:${plan}`,
    () =>
      Product.find({ $text: { $search: req.params.name } })
        .limit(50)
        .lean<ProductDoc[]>(),
    60
  );

  res.json(data.map(p => transformProduct(p, plan)));
});

/* 🔹 PRICE RANGE */
app.get('/produit/price-range', async (req, res) => {
  const plan = (req as any).plan;
  const min = Number(req.query.min || 0);
  const max = Number(req.query.max || 999999);

  const data = await cache(
    `price:${min}-${max}:${plan}`,
    () =>
      Product.find({
        priceNumber: { $gte: min, $lte: max },
      })
        .limit(plan === 'BASIC' ? 20 : 100)
        .lean<ProductDoc[]>(),
    120
  );

  res.json(data.map(p => transformProduct(p, plan)));
});

/* 🔹 CATEGORIES */
app.get('/produit/categories', async (_req, res) => {
  const categories = await Product.aggregate([
    { $match: { category: { $ne: null } } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  res.json({ categories });
});

/* 🔹 BY ID (TOUJOURS EN DERNIER) */
app.get('/produit/:id', async (req, res) => {
  const plan = (req as any).plan;

  const product = await cache(
    `id:${req.params.id}:${plan}`,
    () =>
      Product.findOne({ id: req.params.id }).lean<ProductDoc>(),
    300
  );

  if (!product) return res.status(404).json({ error: 'not found' });

  res.json(transformProduct(product, plan));
});

/* ================== START ================== */
(async () => {
  await mongoose.connect(process.env.MONGO_URI as string);
  app.listen(PORT, '0.0.0.0', () =>
    console.log(`🚀 API running on port ${PORT}`)
  );
})();
