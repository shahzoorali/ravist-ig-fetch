const express = require('express');
const router  = express.Router();

router.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'instagram-scraper-service',
    timestamp: new Date().toISOString(),
    endpoints: {
      scrape_post_POST: 'POST /api/instagram/post  — body: { url }',
      scrape_post_GET:  'GET  /api/instagram/post?url=<encoded>',
    },
    auth: process.env.SERVICE_API_KEY
      ? 'enabled (X-API-Key header required)'
      : 'disabled (localhost open access)',
  });
});

module.exports = router;
