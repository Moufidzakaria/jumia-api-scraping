import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';
import compression from 'compression';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

// ===== MIDDLEWARES =====
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(compression());
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
}));

// ===== Redis (Fail-safe pour Fly.io) =====
let redis: Redis.Redis | null = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
  redis.on('connect', () => console.log('✅ Redis connecté'));
  redis.on('error', (err) => console.error('❌ Redis error:', err.message));
}

// ===== MongoDB Schema =====
const productSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  title: String,
  price: String,
  priceNumber: Number,
  image: String,
  url: { type: String, unique: true },
  sourcePage: String,
  category: String,
  createdAt: Date,
}, { timestamps: true });

productSchema.index({ title: 'text' });
productSchema.index({ category: 1 });
productSchema.index({ priceNumber: 1 });

const Product = mongoose.models.Product || mongoose.model('Product', productSchema);

// ===== RapidAPI Plan Detection =====
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.path === '/ping') return next();
  const subscription = req.headers['x-rapidapi-subscription'] as string;
  const plan = subscription ? subscription.toUpperCase() : 'BASIC';
  (req as any).plan = plan;
  next();
});

// ===== Routes =====
app.get('/ping', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

const transformProduct = (p: any, plan: string) => ({
  id: p.id,
  title: p.title,
  ...(plan !== 'BASIC' && { price: p.price, image: p.image, url: p.url, category: p.category }),
  ...(plan === 'MEGA' && { sourcePage: p.sourcePage }),
  plan
});

// 1. Latest Products
app.get('/produit', async (req: Request, res: Response) => {
  try {
    const plan = (req as any).plan;
    const cacheKey = `latest:${plan}`;

    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const products = await Product.find().sort({ createdAt: -1 })
      .limit(plan === 'BASIC' ? 20 : plan === 'PRO' ? 50 : 100);

    const transformed = products.map(p => transformProduct(p, plan));

    if (redis) await redis.setex(cacheKey, 60, JSON.stringify(transformed));

    res.json(transformed);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// 2. Product by ID
app.get('/produit/:id', async (req: Request, res: Response) => {
  try {
    const plan = (req as any).plan;
    const cacheKey = `produit:${req.params.id}:${plan}`;

    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const product = await Product.findOne({ id: req.params.id });
    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });

    const transformed = transformProduct(product, plan);

    if (redis) await redis.setex(cacheKey, 300, JSON.stringify(transformed));

    res.json(transformed);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. Search by Name
app.get('/produit/search/:name', async (req: Request, res: Response) => {
  try {
    const plan = (req as any).plan;
    const nameQuery = req.params.name.toLowerCase();
    const cacheKey = `search:${nameQuery}:${plan}`;

    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const products = await Product.find({ title: { $regex: nameQuery, $options: 'i' } })
      .sort({ createdAt: -1 })
      .limit(plan === 'BASIC' ? 20 : 50);

    const transformed = products.map(p => transformProduct(p, plan));

    if (redis) await redis.setex(cacheKey, 60, JSON.stringify(transformed));

    res.json(transformed);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// 4. Price Range
app.get('/produit/price-range', async (req: Request, res: Response) => {
  try {
    const plan = (req as any).plan;
    const min = Number(req.query.min);
    const max = Number(req.query.max);

    if (isNaN(min) || isNaN(max) || min < 0 || max < min)
      return res.status(400).json({ error: 'min et max doivent être valides' });

    const cacheKey = `price-range:${min}-${max}:${plan}`;
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const limit = plan === 'BASIC' ? 20 : plan === 'PRO' ? 50 : 100;
    const products = await Product.find({ priceNumber: { $gte: min, $lte: max } })
      .sort({ createdAt: -1 })
      .limit(limit);

    const transformed = products.map(p => transformProduct(p, plan));

    if (redis) await redis.setex(cacheKey, 120, JSON.stringify(transformed));

    res.json(transformed);
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// 5. Categories
app.get('/produit/categories', async (_req, res) => {
  try {
    const categories = await Product.distinct('category');
    res.json({ categories: categories.filter(c => c && c !== 'Autre') });
  } catch {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Start Server =====
async function startServer() {
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI manquant');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connecté');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 API running on port ${PORT} - Ready for RapidAPI`);
    });
  } catch (err: any) {
    console.error('❌ Startup error:', err.message);
    process.exit(1);
  }
}

startServer();
