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
    title: String,
    image: String,
    url: String,
    category: String,
  },
  { timestamps: true, versionKey: false }
);

productSchema.index({ title: 'text' });

const Product =
  mongoose.models.Product ||
  mongoose.model<ProductDoc>('Product', productSchema);

/* ================== UTILS ================== */
async function cache<T>(key: string, fn: () => Promise<T>, ttl = 60): Promise<T> {
  if (!redis) return fn();
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);
  const data = await fn();
  await redis.setex(key, ttl, JSON.stringify(data));
  return data;
}

/* ================== FORCE PLAN PRO ================== */
app.use((_req: Request, _res: Response, next: NextFunction) => {
  // On force PRO pour tous les endpoints RapidAPI
  (_req as any).plan = 'PRO';
  next();
});

/* ================== TRANSFORM ================== */
const transformProduct = (p: ProductDoc) => ({
  id: p.id,
  title: p.title,
  image: p.image,
  url: p.url,
  category: p.category,
});

/* ================== ROUTES ================== */
app.get('/ping', (_req, res) => res.json({ status: 'ok' }));

/* 🔐 INSERT DATA ADMIN */
app.post('/produit', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'unauthorized' });

  const { id, title, image, url, category } = req.body;
  if (!id || !title) return res.status(400).json({ error: 'missing fields' });

  await Product.updateOne(
    { id },
    { $set: { title, image, url, category } },
    { upsert: true }
  );

  res.json({ success: true });
});

/* 🔹 ALL PRODUCTS */
app.get('/produit', async (_req, res) => {
  const data = await cache('all:PRO', () =>
    Product.find().sort({ createdAt: -1 }).lean<ProductDoc[]>()
  );
  res.json(data.map(transformProduct));
});

/* 🔹 SEARCH */
app.get('/produit/search/:name', async (req, res) => {
  const data = await cache(`search:${req.params.name}:PRO`, () =>
    Product.find({ $text: { $search: req.params.name } })
      .limit(50)
      .lean<ProductDoc[]>()
  );
  res.json(data.map(transformProduct));
});

/* 🔹 BY ID */
app.get('/produit/:id', async (req, res) => {
  const product = await cache(`id:${req.params.id}:PRO`, () =>
    Product.findOne({ id: req.params.id }).lean<ProductDoc>()
  );

  if (!product) return res.status(404).json({ error: 'not found' });
  res.json(transformProduct(product));
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

/* ================== START ================== */
(async () => {
  await mongoose.connect(process.env.MONGO_URI as string);
  app.listen(PORT, '0.0.0.0', () =>
    console.log(`🚀 API running on port ${PORT}`)
  );
})();
