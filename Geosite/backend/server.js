// GeoSite — バックエンドサーバー
// Railway にデプロイして使用

const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(cors({ origin: true }));
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

let cache = {};
const CACHE_TTL_MS = 60 * 60 * 1000; // 1時間

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/news', async (req, res) => {
  const topic = req.query.topic || '世界の最新ニュース';

  // キャッシュが有効なら返す
  if (cache[topic]) {
    const age = Date.now() - cache[topic].fetchedAt;
    if (age < CACHE_TTL_MS) {
      return res.json({ source: 'cache', age_min: Math.floor(age / 60000), news: cache[topic].data });
    }
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY が設定されていません' });
  }

  try {
    // ── プロンプト：簡潔なフォーマットに絞りトークン消費を削減 ──
    const prompt = `「${topic}」に関連する最新ニュースを10件、以下のJSON配列のみで返してください。前置き・コードブロック不要。

[{"title":"タイトル（日本語・30字以内）","summary":"要約（日本語・60字以内）","location":"地名（日本語）","lat":緯度,"lng":経度,"date":"2025-03-30","category":"紛争/技術/環境/経済/社会/文化/科学/その他","related":["関連語1","関連語2","関連語3"],"year":2025}]`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', // Haiku: 高速・低コスト・十分な品質
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await r.json();

    // APIエラー（クレジット不足・認証エラー等）
    if (!r.ok) {
      console.error('[API error]', data);
      return res.status(r.status).json({ error: data.error?.message || 'Anthropic API error' });
    }

    // トークン上限で途中打ち切りになっていないか確認
    if (data.stop_reason === 'max_tokens') {
      console.warn('[warn] Response was truncated by max_tokens');
    }

    const raw = data.content.map(b => b.text || '').join('');
    const cleaned = raw.replace(/```json|```/g, '').trim();

    // JSONパース（失敗時は生テキストをログに出して詳細なエラーを返す）
    let news;
    try {
      news = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('[parse error] raw text:', cleaned.slice(0, 500));
      return res.status(500).json({
        error: 'JSONパースに失敗しました。stop_reason: ' + data.stop_reason,
        raw_preview: cleaned.slice(0, 200)
      });
    }

    // キャッシュ更新
    cache[topic] = { data: news, fetchedAt: Date.now() };

    res.json({ source: 'api', news });

  } catch (e) {
    console.error('[server error]', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`GeoSite API running on port ${PORT}`));
