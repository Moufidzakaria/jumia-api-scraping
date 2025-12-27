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
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

/* ✅ REQUIRED FOR Fly.io + RapidAPI */
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

/* ================== REDIS (SAFE) ================== */
let redis: Redis | null = null;

if (process.env.REDIS_URL) {
  try {
    redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      retryStrategy: times => Math.min(times * 50, 2000),
    });

    redis.on('connect', () => console.log('✅ Redis connected'));
    redis.on('error', err => {
      console.warn('⚠️ Redis error:', err.message);
      redis = null;
    });

    redis.connect().catch(() => {
      redis = null;
    });
  } catch {
    redis = null;
  }
}

/* ================== MONGODB ================== */
const productSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    price: { type: String, required: true },
    priceNumber: { type: Number, required: true, index: true },
    image: String,
    url: { type: String, unique: true },
    sourcePage: String,
    category: { type: String, default: 'Autre', index: true },
  },
  { timestamps: true, versionKey: false }
);

productSchema.index({ title: 'text' });
productSchema.index({ createdAt: -1 });

const Product =
  mongoose.models.Product || mongoose.model('Product', productSchema);

/* ================== UTILS ================== */
function parsePrice(price: string): number {
  return Number(price.replace(/[^\d]/g, ''));
}

async function getCachedOrDb(
  key: string,
  fn: () => Promise<any>,
  ttl = 60
) {
  try {
    if (redis) {
      const cached = await redis.get(key);
      if (cached) return JSON.parse(cached);
    }

    const data = await fn();

    if (redis && data) {
      await redis.setex(key, ttl, JSON.stringify(data));
    }

    return data;
  } catch {
    return fn();
  }
}

/* ================== RAPIDAPI PLAN ================== */
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.path === '/ping') return next();
  const plan =
    ((req.headers['x-rapidapi-subscription'] as string) || 'BASIC').toUpperCase();
  (req as any).plan = plan;
  next();
});

/* ================== TRANSFORM ================== */
const transformProduct = (p: any, plan: string) => ({
  id: p.id,
  title: p.title,
  ...(plan !== 'BASIC' && {
    price: p.price,
    image: p.image,
    url: p.url,
    category: p.category,
  }),
  ...(plan === 'MEGA' && { sourcePage: p.sourcePage }),
});

/* ================== ROUTES ================== */
app.get('/ping', (_req, res) =>
  res.json({ status: 'ok', uptime: process.uptime() })
);

/* 🔐 ADMIN INSERT (protected by secret key) */
app.post('/produit', async (req: Request, res: Response) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY)
    return res.status(401).json({ error: 'unauthorized' });

  try {
    const { id, title, price, image, url, sourcePage, category } = req.body;

    if (!id || !title || !price)
      return res.status(400).json({ error: 'missing fields' });

    const priceNumber = parsePrice(price);
    if (!priceNumber)
      return res.status(400).json({ error: 'invalid price' });

    await Product.updateOne(
      { id },
      {
        $set: {
          title,
          price,
          priceNumber,
          image,
          url,
          sourcePage,
          category: category || 'Autre',
        },
      },
      { upsert: true }
    );

    res.status(201).json({ success: true });
  } catch {
    res.status(500).json({ error: 'server error' });
  }
});

/* 🔹 LATEST PRODUCTS */
app.get('/produit', async (req: Request, res: Response) => {
  const plan = (req as any).plan;
  const limit = plan === 'BASIC' ? 20 : plan === 'PRO' ? 50 : 100;

  const data = await getCachedOrDb(
    `latest:${plan}`,
    () => Product.find().sort({ createdAt: -1 }).limit(limit).lean(),
    60
  );

  res.json(data.map((p: any) => transformProduct(p, plan)));
});

/* 🔹 PRODUCT BY ID */
app.get('/produit/:id', async (req: Request, res: Response) => {
  const plan = (req as any).plan;

  const product = await getCachedOrDb(
    `p:${req.params.id}:${plan}`,
    () => Product.findOne({ id: req.params.id }).lean(),
    300
  );

  if (!product) return res.status(404).json({ error: 'not found' });
  res.json(transformProduct(product, plan));
});

/* 🔹 SEARCH */
app.get('/produit/search/:name', async (req: Request, res: Response) => {
  const plan = (req as any).plan;
  const limit = plan === 'BASIC' ? 20 : 50;

  const data = await getCachedOrDb(
    `search:${req.params.name}:${plan}`,
    () =>
      Product.find({ $text: { $search: req.params.name } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
    60
  );

  res.json(data.map((p: any) => transformProduct(p, plan)));
});
app.get('/produit/price-range', async (req: Request, res: Response) => {
  const plan = (req as any).plan || 'BASIC';
  const min = parseFloat(req.query.min as string);
  const max = parseFloat(req.query.max as string);

  if (isNaN(min) || isNaN(max) || min > max)
    return res.status(400).json({ error: 'invalid range' });

  const limit = plan === 'BASIC' ? 20 : plan === 'PRO' ? 50 : 100;
  const cacheKey = `range:${min}-${max}:${plan}`;

  try {
    const data = await getCachedOrDb(cacheKey, async () =>
      Product.find({ priceNumber: { $gte: min, $lte: max } })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean()
    , 120);

    res.json(data.map((p: any) => transformProduct(p, plan)));
  } catch (err: any) {
    console.error('Error /price-range:', err.message);
    res.status(500).json({ error: 'server error' });
  }
});
app.get('/produit/categories', async (req: Request, res: Response) => {
  const plan = (req as any).plan || 'BASIC';
  const cacheKey = `categories:${plan}`;

  try {
    let categories: string[] = [];

    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json({ categories: JSON.parse(cached) });
    }

    categories = (await Product.distinct('category')).filter(Boolean);

    // Limite selon plan
    const limit = plan === 'BASIC' ? 20 : plan === 'PRO' ? 50 : 100;
    categories = categories.slice(0, limit);

    if (redis) await redis.setex(cacheKey, 600, JSON.stringify(categories));

    res.json({ categories });
  } catch (err: any) {
    console.error('Error /categories:', err.message);
    res.status(500).json({ error: 'server error' });
  }
});


/* ================== START ================== */
(async () => {
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI missing');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connected');

    app.listen(PORT, '0.0.0.0', () =>
      console.log(`🚀 API running on port ${PORT}`)
    );
  } catch (err: any) {
    console.error('❌ Startup error:', err.message);
    process.exit(1);
  }
})();
