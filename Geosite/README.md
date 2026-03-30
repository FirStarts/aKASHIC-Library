# GeoSite — デプロイ手順

## 構成
- frontend/ → Vercel（静的HTML）
- backend/  → Railway（Node.js APIサーバー）

## デプロイ手順

### 1. GitHubにリポジトリを作成
```
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_NAME/geosite.git
git push -u origin main
```

### 2. バックエンド（Railway）
1. https://railway.app にアクセス → GitHubでログイン
2. "New Project" → "Deploy from GitHub repo" → backend/ フォルダを選択
3. Variables タブで環境変数を追加:
   - ANTHROPIC_API_KEY = sk-ant-xxxx
4. デプロイ完了後、発行されたURLをコピー（例: geosite-api-production.up.railway.app）

### 3. フロントエンド（Vercel）
1. https://vercel.com にアクセス → GitHubでログイン
2. "New Project" → frontend/ フォルダを選択
3. frontend/index.html 内の YOUR_RAILWAY_URL を手順2のURLに書き換え
4. デプロイ → 発行されたURLを共有

## ローカルテスト
```
# バックエンド
cd backend
npm install
ANTHROPIC_API_KEY=sk-ant-xxxx node server.js

# フロントエンド（別ターミナル）
cd frontend
npx serve .
```
