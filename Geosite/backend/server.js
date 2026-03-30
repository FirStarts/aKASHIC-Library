// GeoSite — バックエンドサーバー
// Railway にデプロイして使用

const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(cors({ origin: true }));
app.use(express.json());

// ── Anthropic APIキーは環境変数から読む（コードに書かない）──
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── ニュース生成キャッシュ（メモリ、再起動でリセット）──────
let cache = { data: null, fetchedAt: null };
const CACHE_TTL_MS = 60 * 60 * 1000; // 1時間

// ── ヘルスチェック ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── ニュース取得エンドポイント ──────────────────────────────
// GET /api/news?topic=気候変動&lang=ja
app.get('/api/news', async (req, res) => {
  const topic = req.query.topic || '世界の最新ニュース';
  const cacheKey = topic;

  // キャッシュが有効なら返す
  if (cache.data && cache.topic === cacheKey) {
    const age = Date.now() - cache.fetchedAt;
    if (age < CACHE_TTL_MS) {
      return res.json({ source: 'cache', age_min: Math.floor(age/60000), news: cache.data });
    }
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません' });
  }

  try {
    const prompt = `あなたは世界ニュースを地図表示するシステムです。
「${topic}」に関連する最新ニュースを10件生成してください。
JSONのみ返してください（コードブロック・前置き不要）:
[
  {
    "title": "ニュースタイトル（日本語、簡潔に）",
    "summary": "3文程度の要約（日本語）",
    "location": "地名（日本語）",
    "lat": 緯度（数値）,
    "lng": 経度（数値）,
    "date": "2025-03-XX",
    "category": "紛争/技術/環境/経済/社会/文化/科学 のいずれか",
    "related": ["関連語1", "関連語2", "関連語3"],
    "year": 2025
  }
]`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.error?.message || 'API error' });

    const text = data.content.map(b => b.text || '').join('');
    const news = JSON.parse(text.replace(/```json|```/g, '').trim());

    // キャッシュ更新
    cache = { topic: cacheKey, data: news, fetchedAt: Date.now() };

    res.json({ source: 'api', news });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GeoSite API running on port ${PORT}`));
