const express = require('express');
const { scrapePost } = require('../services/instagram.service');

const router = express.Router();

/**
 * POST /api/instagram/post
 *
 * Body:
 *   { "url": "https://www.instagram.com/p/ABC123/" }
 *
 * Response:
 *   {
 *     "success": true,
 *     "data": {
 *       "id": "...",
 *       "shortcode": "ABC123",
 *       "type": "image" | "video",
 *       "caption": "...",
 *       "thumbnail_url": "https://...",
 *       "video_url": "https://...mp4" | null,
 *       "author": "username",
 *       "_source": "graphql" | "media_api" | "oembed_fallback"
 *     }
 *   }
 */
router.post('/post', async (req, res, next) => {
  try {
    const { url } = req.body;

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid "url" field in request body.',
        example: { url: 'https://www.instagram.com/p/ABC123def/' },
      });
    }

    if (!url.includes('instagram.com')) {
      return res.status(400).json({
        success: false,
        error: 'URL does not appear to be an Instagram URL.',
      });
    }

    const data = await scrapePost(url);

    return res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/instagram/post?url=<encoded_url>
 *
 * Convenience GET version — useful for quick browser/curl testing.
 */
router.get('/post', async (req, res, next) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing "url" query parameter.',
        example: '/api/instagram/post?url=https%3A%2F%2Fwww.instagram.com%2Fp%2FABC123%2F',
      });
    }

    const data = await scrapePost(decodeURIComponent(url));

    return res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
