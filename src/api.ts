import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';
import compression from 'compression';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT ? Number(process.env.PORT) : 4001;

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

// ===== Redis =====
const redis = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;
if (redis) {
  redis.on('connect', () => console.log('✅ Redis connecté'));
  redis.on('error', (err) => console.error('❌ Redis error (ignored):', err.message));
}

// ===== MongoDB Schema =====
const productSchema = new mongoose.Schema({
  id: { type: String, unique: true },
  title: String,
  price: String,
  image: String,
  url: { type: String, unique: true },
  sourcePage: String,
  createdAt: Date,
}, { timestamps: true });

const Product = mongoose.models.Product || mongoose.model('Product', productSchema);

// ===== RapidAPI Key + Plan + Quota Middleware =====
app.use(async (req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/ping') return next();

  const rapidApiKey = req.headers['x-rapidapi-key'] as string;
  if (!rapidApiKey) return res.status(401).json({ error: 'Unauthorized - RapidAPI only' });

  // Mapping des clés vers Plans
  const planMapping: Record<string, string> = {
    'key_basic': 'BASIC',
    'key_pro': 'PRO',
    'key_ultra': 'ULTRA',
    'key_mega': 'MEGA'
  };
  const plan = planMapping[rapidApiKey];
  if (!plan) return res.status(403).json({ error: 'Invalid RapidAPI key' });

  (req as any).plan = plan;

  // Quota par Plan
  const planQuota: Record<string, number> = {
    BASIC: 500,
    PRO: 5000,
    ULTRA: 30000,
    MEGA: 100000,
  };

  if (redis) {
    const countStr = await redis.get(`quota:${rapidApiKey}`);
    const count: number = countStr ? parseInt(countStr, 10) : 0;

    if (count >= planQuota[plan]) {
      return res.status(429).json({ error: `Quota exceeded for ${plan} plan` });
    }

    await redis.incr(`quota:${rapidApiKey}`);
    await redis.expire(`quota:${rapidApiKey}`, 30 * 24 * 60 * 60); // reset chaque 30 jours
  }

  next();
});

// ===== Routes =====
app.get('/ping', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

// GET /produit avec cache + transformation plan
app.get('/produit', async (_req, res) => {
  try {
    const plan = (_req as any).plan;
    const cacheKey = `produits:list:${plan}`;
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const products = await Product.find().sort({ createdAt: -1 }).limit(100);

    const transformed = products.map(p => {
      let obj: any = { id: p.id, title: p.title };
      if (plan !== 'BASIC') { obj.price = p.price; obj.image = p.image; obj.url = p.url; }
      if (plan === 'MEGA') obj.sourcePage = p.sourcePage;
      obj.plan = plan;
      return obj;
    });

    if (redis) await redis.setex(cacheKey, 60, JSON.stringify(transformed));

    res.json(transformed);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /produit/:id
app.get('/produit/:id', async (req, res) => {
  try {
    const plan = (req as any).plan;
    const cacheKey = `produit:${req.params.id}:${plan}`;
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const product = await Product.findOne({ id: req.params.id });
    if (!product) return res.status(404).json({ error: 'Produit non trouvé' });

    let obj: any = { id: product.id, title: product.title };
    if (plan !== 'BASIC') { obj.price = product.price; obj.image = product.image; obj.url = product.url; }
    if (plan === 'MEGA') obj.sourcePage = product.sourcePage;
    obj.plan = plan;

    if (redis) await redis.setex(cacheKey, 120, JSON.stringify(obj));

    res.json(obj);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /produit/search/:name
app.get('/produit/search/:name', async (req, res) => {
  try {
    const plan = (req as any).plan;
    const nameQuery = req.params.name.toLowerCase();
    const cacheKey = `produit:search:${nameQuery}:${plan}`;

    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const products = await Product.find({ title: { $regex: nameQuery, $options: 'i' } })
      .sort({ createdAt: -1 }).limit(50);

    const transformed = products.map(p => {
      let obj: any = { id: p.id, title: p.title };
      if (plan !== 'BASIC') { obj.price = p.price; obj.image = p.image; obj.url = p.url; }
      if (plan === 'MEGA') obj.sourcePage = p.sourcePage;
      obj.plan = plan;
      return obj;
    });

    if (redis) await redis.setex(cacheKey, 60, JSON.stringify(transformed));
    res.json(transformed);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /produit/price/:price
app.get('/produit/price/:price', async (req, res) => {
  try {
    const plan = (req as any).plan;
    const priceParam = Number(req.params.price);
    if (isNaN(priceParam)) return res.status(400).json({ error: 'Price doit être un nombre valide' });

    const cacheKey = `produit:price:${priceParam}:${plan}`;
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const products = await Product.find({ price: priceParam }).sort({ createdAt: -1 }).limit(50);

    const transformed = products.map(p => {
      let obj: any = { id: p.id, title: p.title };
      if (plan !== 'BASIC') { obj.price = p.price; obj.image = p.image; obj.url = p.url; }
      if (plan === 'MEGA') obj.sourcePage = p.sourcePage;
      obj.plan = plan;
      return obj;
    });

    if (redis) await redis.setex(cacheKey, 60, JSON.stringify(transformed));
    res.json(transformed);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /produit/search/:name/price/:price
app.get('/produit/search/:name/price/:price', async (req, res) => {
  try {
    const plan = (req as any).plan;
    const nameQuery = req.params.name.toLowerCase();
    const priceParam = Number(req.params.price);
    if (isNaN(priceParam)) return res.status(400).json({ error: 'Price doit être un nombre valide' });

    const cacheKey = `produit:searchprice:${nameQuery}:${priceParam}:${plan}`;
    if (redis) {
      const cached = await redis.get(cacheKey);
      if (cached) return res.json(JSON.parse(cached));
    }

    const products = await Product.find({
      title: { $regex: nameQuery, $options: 'i' },
      price: priceParam
    }).sort({ createdAt: -1 }).limit(50);

    const transformed = products.map(p => {
      let obj: any = { id: p.id, title: p.title };
      if (plan !== 'BASIC') { obj.price = p.price; obj.image = p.image; obj.url = p.url; }
      if (plan === 'MEGA') obj.sourcePage = p.sourcePage;
      obj.plan = plan;
      return obj;
    });

    if (redis) await redis.setex(cacheKey, 60, JSON.stringify(transformed));
    res.json(transformed);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Start Server =====
async function startServer() {
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI manquant');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connecté');
    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 API running on port ${PORT}`));
  } catch (err: any) {
    console.error('❌ Startup error:', err.message);
    process.exit(1);
  }
}

startServer();
