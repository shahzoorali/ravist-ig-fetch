require('dotenv').config();

const express = require('express');
const morgan  = require('morgan');

const postRoutes    = require('./routes/post.routes');
const healthRoutes  = require('./routes/health.routes');
const { errorHandler } = require('./middleware/error.middleware');
const { authMiddleware } = require('./middleware/auth.middleware');
const rateLimiter   = require('./middleware/rateLimiter.middleware');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(morgan('dev'));
app.use(express.json());
app.use(rateLimiter);

// ── Routes ──────────────────────────────────────────────────────────────────
app.use('/health', healthRoutes);
app.use('/api/instagram', authMiddleware, postRoutes);

// ── Global error handler ────────────────────────────────────────────────────
app.use(errorHandler);

// ── Boot ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀  Instagram Scraper Service running on http://localhost:${PORT}`);
  console.log(`📋  Health check  →  GET  http://localhost:${PORT}/health`);
  console.log(`📸  Scrape post   →  POST http://localhost:${PORT}/api/instagram/post\n`);
});

module.exports = app;
