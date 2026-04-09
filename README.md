# Instagram Scraper Service

Self-hosted Express API that replaces the `instagram-scraper-stable-api` RapidAPI dependency.  
Supports **Posts (images)** and **Reels / Videos**. Returns: highest-res image URL, direct `.mp4` URL, caption, author.

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your .env
cp .env.example .env
# Edit .env — all fields are optional for localhost use

# 3. Start the server
npm run dev      # development (auto-reload)
npm start        # production
```

Server runs at: **http://localhost:3000**

---

## Environment Variables (`.env`)

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port to listen on (default: `3000`) |
| `SERVICE_API_KEY` | No | If set, all `/api/*` requests must include `X-API-Key: <value>` header |
| `INSTAGRAM_SESSION_ID` | No | Your Instagram `sessionid` cookie — boosts rate limits significantly |

### How to get your `sessionid` cookie
1. Log in to Instagram in your browser
2. Open DevTools → **Application** tab → **Cookies** → `https://www.instagram.com`
3. Copy the value of the `sessionid` cookie
4. Paste it into `.env` as `INSTAGRAM_SESSION_ID=<value>`

---

## API Reference

### Health Check
```
GET /health
```
Returns service status and available endpoints.

---

### Scrape Post or Reel — POST
```
POST /api/instagram/post
Content-Type: application/json

{
  "url": "https://www.instagram.com/p/ABC123def/"
}
```

### Scrape Post or Reel — GET (quick test)
```
GET /api/instagram/post?url=https%3A%2F%2Fwww.instagram.com%2Fp%2FABC123def%2F
```

### Response
```json
{
  "success": true,
  "data": {
    "id": "3412345678901234567",
    "shortcode": "ABC123def",
    "type": "video",
    "caption": "Check out this reel! #instagram",
    "thumbnail_url": "https://scontent.cdninstagram.com/.../thumbnail.jpg",
    "video_url": "https://scontent.cdninstagram.com/.../video.mp4",
    "author": "username",
    "_source": "graphql"
  }
}
```

| Field | Description |
|---|---|
| `type` | `"image"` or `"video"` |
| `thumbnail_url` | Highest-resolution image available |
| `video_url` | Direct `.mp4` URL (null for images) |
| `caption` | Post caption text |
| `author` | Instagram username |
| `_source` | Which strategy succeeded: `graphql`, `media_api`, or `oembed_fallback` |

### Error Response
```json
{
  "success": false,
  "error": "All scraper strategies failed",
  "details": [
    "graphql: Request failed with status code 401",
    "media_api: No media object in response",
    "oembed: ..."
  ]
}
```

---

## How It Works (Strategy Chain)

Mirrors the **Primary + Fallback** pattern from your original `instagram.service.js`:

```
Request
   │
   ├─ 1. GraphQL endpoint (/p/<shortcode>/?__a=1)
   │       ✓ Returns full data including video URL
   │       ✗ → falls through on 401/empty response
   │
   ├─ 2. Private Media API (/api/v1/media/<id>/info/)
   │       ✓ Mobile User-Agent, higher success on Reels
   │       ✗ → falls through on failure
   │
   └─ 3. oEmbed fallback (graph.facebook.com)
           ✓ Always works for public posts
           ✗ video_url will be null (Instagram hides it here)
```

---

## Integration with your existing `instagram.service.js`

Replace your RapidAPI calls with:

```javascript
const response = await fetch('http://localhost:3000/api/instagram/post', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    // Only needed if you set SERVICE_API_KEY in .env:
    'X-API-Key': process.env.INSTAGRAM_SCRAPER_SERVICE_KEY,
  },
  body: JSON.stringify({ url: instagramUrl }),
});

const { data } = await response.json();
// data.thumbnail_url  → highest-res image
// data.video_url      → direct .mp4 (null for images)
// data.caption        → post text
```

---

## Rate Limiting

- This service limits to **30 requests/minute** to protect your IP from Instagram blocks.
- For higher throughput, add a rotating proxy and set `INSTAGRAM_SESSION_ID`.
- Instagram soft-blocks IPs at ~200 unauthenticated requests/hour.
