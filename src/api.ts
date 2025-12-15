import express from 'express';
import fs from 'fs';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import cors from 'cors';

const MONGO_URI = 'mongodb://127.0.0.1:27017/jumia_api'; // بدلها بالـ URI ديالك

// 🔹 Connect to MongoDB
await mongoose.connect(MONGO_URI);
console.log('✅ MongoDB connected');

// 🔹 Create Product model
const productSchema = new mongoose.Schema({
  title: String,
  price: String,
  image: String,
  url: String,
  sourcePage: String,
}, { timestamps: true });

const Product = mongoose.model('Product', productSchema);

// 🔹 Import products.json to MongoDB (once)
const productsCount = await Product.countDocuments();
if (productsCount === 0) {
  const products = JSON.parse(fs.readFileSync('./products.json', 'utf-8'));
  await Product.insertMany(products);
  console.log(`✅ Imported ${products.length} products to MongoDB`);
} else {
  console.log('ℹ️ Products already exist in MongoDB, skipping import');
}

// 🔹 Express setup
const app = express();
app.use(cors());
app.use(express.json());

// 🛡️ Rate limit
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
});
app.use(limiter);

// ✅ /products endpoint with search, pagination, all
app.get('/products', async (req, res) => {
  const { q, page = 1, limit = 20 } = req.query;

  const filter: any = {};
  if (q) filter.title = { $regex: q, $options: 'i' };

  // "all" option
  if (limit === 'all') {
    const data = await Product.find(filter);
    return res.json({ total: data.length, data });
  }

  const data = await Product.find(filter)
    .skip((Number(page) - 1) * Number(limit))
    .limit(Number(limit));

  const total = await Product.countDocuments(filter);

  res.json({
    total,
    page: Number(page),
    limit: limit === 'all' ? total : Number(limit),
    data,
  });
});

app.use((req, res, next) => {
  const apiKey = req.headers['x-rapidapi-key'];
  if (!apiKey || apiKey !== process.env.MY_KEY) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  next();
});


// 🚀 Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 API running on http://localhost:${PORT}`);
});
