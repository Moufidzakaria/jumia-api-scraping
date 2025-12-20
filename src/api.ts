import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';
import 'dotenv/config';

const app = express();
const PORT = Number(process.env.PORT) || 8080;

// ===== MIDDLEWARES =====
app.use(express.json());
app.use(cors());
app.use(helmet());
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

// ===== SCHEMA =====
const productSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true },
    title: String,
    price: String,
    image: String,
    url: { type: String, unique: true },
    sourcePage: String,
    createdAt: Date,
  },
  { timestamps: true }
);
const Product = mongoose.models.Product || mongoose.model('Product', productSchema);

// ===== API KEY =====
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === '/health') return next(); // Health check مفتوح
  if (req.header('x-api-key') !== process.env.MY_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ===== ROUTES =====
app.get('/health', (_req, res) => res.send('OK'));

app.get('/produit', async (_req, res) => {
  const products = await Product.find().sort({ createdAt: -1 }).limit(100);
  res.json(products);
});

app.get('/produit/:id', async (req, res) => {
  const product = await Product.findOne({ id: req.params.id });
  if (!product) return res.status(404).json({ error: 'Produit non trouvé' });
  res.json(product);
});

app.get('/produit/price/:price', async (req, res) => {
  const products = await Product.find({ price: new RegExp(req.params.price, 'i') });
  res.json(products);
});

// ===== START SERVER =====
async function startServer() {
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI manquant');

    // Connexion MongoDB Atlas
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB connecté');

    // Connexion Redis (optionnel)
    if (process.env.REDIS_URL) {
      const redis = new Redis(process.env.REDIS_URL);
      redis.on('connect', () => console.log('✅ Redis connecté'));
      redis.on('error', (err) => console.error('❌ Redis error (ignored):', err.message));
    }

    app.listen(PORT, '0.0.0.0', () => console.log(`🚀 API running on port ${PORT}`));
  } catch (err: any) {
    console.error('❌ Startup error:', err.message);
    process.exit(1);
  }
}

startServer();
