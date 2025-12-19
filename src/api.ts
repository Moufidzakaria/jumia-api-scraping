import express, { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 4001;

app.use(express.json());

// ====== SÉCURITÉ ======
app.use(cors());
app.use(helmet());
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));

// ================== START SERVER FUNCTION ==================
async function startServer() {
  // ================== DB ==================
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI manquant');
  await mongoose.connect(process.env.MONGO_URI);
  console.log('✅ MongoDB connecté');

  // ================== REDIS ==================
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL manquant');
  const redis = new Redis(process.env.REDIS_URL as string);
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

  // ================== API KEY MIDDLEWARE ==================
  app.use((req: Request, res: Response, next: NextFunction) => {
    const apiKey = req.header('x-api-key');
    if (apiKey !== process.env.MY_KEY) return res.status(401).json({ error: 'Unauthorized' });
    next();
  });

  // ================== ROUTES ==================
  app.get('/produit', async (req: Request, res: Response) => {
    try {
      const products = await Product.find().sort({ createdAt: -1 });
      res.json(products);
    } catch {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  app.get('/produit/:id', async (req: Request, res: Response) => {
    try {
      const product = await Product.findOne({ id: req.params.id });
      if (!product) return res.status(404).json({ error: 'Produit non trouvé' });
      res.json(product);
    } catch {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  app.get('/produit/price/:price', async (req: Request, res: Response) => {
    try {
      const price = req.params.price;
      const products = await Product.find({ price: new RegExp(price, 'i') });
      res.json(products);
    } catch {
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // ================== START SERVER ==================
  app.listen(PORT, () => console.log(`🚀 Serveur démarré sur http://localhost:${PORT}`));
}

startServer();
