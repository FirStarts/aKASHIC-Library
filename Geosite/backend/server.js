// GeoSite — バックエンドサーバー v2
// Phase 2: ニュース件数拡張 / キャッシュ改善 / 実RSSニュース取得

const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(cors({ origin: true }));
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// ── キャッシュ（トピック別・ソース別）─────────────────────
const cache = {};
const CACHE_TTL_MS = 60 * 60 * 1000; // 1時間

function getCache(key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) { delete cache[key]; return null; }
  return entry;
}
function setCache(key, data) {
  cache[key] = { data, fetchedAt: Date.now() };
}

// ── RSSソース定義 ──────────────────────────────────────────
const RSS_SOURCES = {
  nhk:     { url: 'https://www3.nhk.or.jp/nhkworld/en/news/feeds/', label: 'NHK World' },
  reuters: { url: 'https://feeds.reuters.com/reuters/topNews',       label: 'Reuters' },
  bbc:     { url: 'https://feeds.bbci.co.uk/news/world/rss.xml',    label: 'BBC News' },
};

// ── ヘルスチェック ─────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), cache_keys: Object.keys(cache) });
});

// ── RSSフェッチ（サーバーサイドなのでCORSなし）────────────
async function fetchRSS(source) {
  const src = RSS_SOURCES[source];
  if (!src) throw new Error('不明なRSSソース: ' + source);

  const res = await fetch(src.url, {
    headers: { 'User-Agent': 'GeoSite/1.0' },
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`RSS取得失敗 (${res.status}): ${src.url}`);

  const text = await res.text();

  // 簡易XMLパース（Node.js標準のDOMParserは非対応のため正規表現で抽出）
  const items = [];
  const itemMatches = text.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const m of itemMatches) {
    const block = m[1];
    const get = (tag) => {
      const r = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return r ? (r[1] || r[2] || '').trim() : '';
    };
    const title = get('title');
    const desc  = get('description').replace(/<[^>]+>/g, '').slice(0, 200);
    const link  = get('link') || get('guid');
    const pub   = get('pubDate');
    if (title) items.push({ title, description: desc, link, pubDate: pub, source: src.label });
    if (items.length >= 15) break;
  }
  return items;
}

// ── Claude API呼び出し ─────────────────────────────────────
async function callClaude(prompt, maxTokens = 4000) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(30000)
  });

  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `API error ${r.status}`);
  if (data.stop_reason === 'max_tokens') console.warn('[warn] truncated by max_tokens');

  return data.content.map(b => b.text || '').join('');
}

// ── JSONパース（堅牢版）────────────────────────────────────
function safeParseJSON(raw) {
  const cleaned = raw.replace(/```json|```/g, '').trim();
  // 配列の開始〜終了を抜き出す（前後のゴミを除去）
  const start = cleaned.indexOf('[');
  const end   = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('JSON配列が見つかりません: ' + cleaned.slice(0, 100));
  return JSON.parse(cleaned.slice(start, end + 1));
}

// ── カテゴリ拡張リスト ─────────────────────────────────────
const CATEGORIES = '紛争/技術/環境/経済/社会/文化/科学/災害/スポーツ/宇宙/医療/その他';

// ── エンドポイント: AI生成ニュース ────────────────────────
// GET /api/news?topic=気候変動&count=20&refresh=1
app.get('/api/news', async (req, res) => {
  const topic   = req.query.topic   || '世界の最新ニュース';
  const count   = Math.min(parseInt(req.query.count) || 20, 30); // 最大30件
  const refresh = req.query.refresh === '1'; // キャッシュ強制更新
  const cacheKey = `ai:${topic}:${count}`;

  if (!refresh) {
    const hit = getCache(cacheKey);
    if (hit) return res.json({ source: 'cache', age_min: Math.floor((Date.now() - hit.fetchedAt) / 60000), news: hit.data });
  }

  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY未設定' });

  try {
    const prompt = `「${topic}」に関連する最新ニュースを${count}件、JSON配列のみで返してください。前置き・コードブロック不要。

[{"title":"タイトル（日本語・35字以内）","summary":"要約（日本語・80字以内）","location":"地名（日本語）","lat":緯度,"lng":経度,"date":"2025-03-30","category":"${CATEGORIES} のいずれか","related":["関連語1","関連語2","関連語3"],"year":2025}]`;

    const raw  = await callClaude(prompt, 5000);
    const news = safeParseJSON(raw);

    setCache(cacheKey, news);
    res.json({ source: 'api', count: news.length, news });

  } catch (e) {
    console.error('[/api/news error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── エンドポイント: RSSニュース + Claude地理タグ付け ───────
// GET /api/rss?source=nhk&refresh=1
app.get('/api/rss', async (req, res) => {
  const source  = req.query.source || 'nhk';
  const refresh = req.query.refresh === '1';
  const cacheKey = `rss:${source}`;

  if (!refresh) {
    const hit = getCache(cacheKey);
    if (hit) return res.json({ source: 'cache', age_min: Math.floor((Date.now() - hit.fetchedAt) / 60000), news: hit.data });
  }

  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY未設定' });

  try {
    // 1. RSSを取得
    const articles = await fetchRSS(source);
    if (!articles.length) return res.status(502).json({ error: 'RSS記事が取得できませんでした' });

    // 2. Claudeで地理タグ付け
    const prompt = `以下のニュース記事リストに地理情報・カテゴリ・日本語要約を付与してください。
JSON配列のみ返してください。前置き・コードブロック不要。

記事:
${articles.map((a, i) => `[${i}] ${a.title}\n${a.description}`).join('\n\n')}

[{"index":0,"title_ja":"日本語タイトル（35字以内）","summary":"日本語要約（80字以内）","location":"地名（日本語）","lat":緯度,"lng":経度,"category":"${CATEGORIES} のいずれか","related":["関連語1","関連語2","関連語3"],"year":2025}]`;

    const raw    = await callClaude(prompt, 5000);
    const tagged = safeParseJSON(raw);

    // 3. 元記事データとマージ
    const news = tagged.map((t, i) => {
      const orig = articles[t.index ?? i] || {};
      return {
        title:    t.title_ja || orig.title,
        summary:  t.summary,
        location: t.location,
        lat:      t.lat,
        lng:      t.lng,
        category: t.category,
        related:  t.related,
        year:     t.year || 2025,
        date:     orig.pubDate ? new Date(orig.pubDate).toLocaleDateString('ja-JP') : '',
        link:     orig.link || '',
        source:   orig.source || RSS_SOURCES[source]?.label || source,
      };
    }).filter(n => n.lat && n.lng); // 座標なしは除外

    setCache(cacheKey, news);
    res.json({ source: 'api', rss_source: RSS_SOURCES[source]?.label, count: news.length, news });

  } catch (e) {
    console.error('[/api/rss error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`GeoSite API v2 running on port ${PORT}`);
  console.log('Endpoints: GET /health  /api/news  /api/rss');
});
