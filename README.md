# #Jevカノ — 顔が先に動いて、言葉はあとから来る

判断特化モデル **Jev**（TypeSafe AI）が「本音」を 0.2〜0.5 秒で決め、その本音で顔と一言が先に出る。
**Claude** はその本音を受け取って台詞を書き、**Gemini 3.8 Flash TTS** が本音の色で読む。
時間差はあっても、顔・一言・言葉・声は同じ本音でそろう。相手は、地味でおとなしい、箱入りの読書好き。仲良くなると振る舞いが変わる。

```
台詞 or 絵に触れる（髪・おでこ・頬・肩・襟元）
   ├─ 反射  Jev    … 本音(Choice) / 好感度の動き(Score) / 嫌がる(Noul) / 話題(Choice) を 1 パスで → 顔・一言（約 0.2〜0.5 秒）
   ├─ 一言          … 場面 × 本音 × 強さ（Jev の確率で 3 段階）の固定の一言。音声は同梱 → 即
   ├─ 言葉  Claude  … 本音と相槌を渡して、その続きの台詞を書く → 数秒
   └─ 声    Gemini  … 台詞を「本音 × 場面 × 強さ × 親しさ」の声色で読む（ストリーミング。言葉から約 1 秒）
```

## まず遊ぶ（鍵なし）

**https://ozaki-taisuke.github.io/jev-kano/** — 入口（GitHub Pages。案内から公開版 https://jev-kano-64632361989.asia-northeast1.run.app/ へ自動で移動）。鍵は要らない。1 人 10 分 30 手・全体で 1 日約 40 ゲームの上限つき。眠っていると最初の 1 回だけ数秒待つ。手元で動かすなら下の「インストールと起動」。

## 遊び方

- 目標: 片付けが終わる（10 手）までに親しさ 70 で、彼女の方から「明日、一番前にいてほしい」と言わせる。100 でパーフェクト。
- 失敗: 親しさ 40 未満。嫌がることを 2 回続ける、または襟元に 2 回で帰られる。
- 寄り道: 本・料理・明日のステージ・サークルの話で話題が開き、彼女の方から続けるようになる。
- 仲良くなると彼女から問いかけてくる。軽く流す・茶化す・上辺の褒めは傷つく。誠実なら大きく進む。
- 同じ触れ方でも状況で意味が変わる（弱音のあとの肩は「心配」）。
- はじまりは 4 つ（片付け・停電・差し入れ・楽譜）。パーフェクトで 5 つ目（当日のステージ袖）が開く。

数字（時間・判定名・好感度の数値）は普段は出ない。`?debug=1` か「？」の中のデバッグで出る。

## 画面

- 恋愛 ADV の型: 背景の絵の上に立ち絵、下にメッセージ窓（名前札・直前のあなたの台詞・彼女の台詞）、候補の台詞と入力欄。これまでの会話は「ログ」で。
- 始まりはト書き（状況）→ クリックで彼女の第一声。第一声は、それだけで「今なにが起きているか」が分かる文にしてある。
- 立ち絵は、顔の絵の背景を Gemini の編集で一様な緑にしておき（`public/faces/green/`）、画面側で緑を透明にして背景に重ねる。緑の絵が無ければ枠付きの絵、絵が無ければ SVG。
- 背景は `public/bg/clubroom.jpg`（人物なし・文字なし）。停電・ステージ袖は同じ絵に CSS の色調で。
- 内容は全年齢の範囲（触れる場所は髪・おでこ・頬・肩・襟元。襟元は「触れるべきでない場所」として怒られる）。

## インストールと起動

必要なもの: **Node.js 20 以上**（`node -v` で確認）と、鍵が 1〜3 つ。

1. 取ってくる

   ```bash
   git clone https://github.com/ozaki-taisuke/jev-kano.git
   cd jev-kano
   npm install
   ```

2. 鍵を書く。`.env.example` を `.env` にコピーして、値を入れる（`.env` は Git 管理外）

   ```bash
   cp .env.example .env        # Windows のコマンドプロンプトなら: copy .env.example .env
   ```

   | 環境変数 | 要る？ | 何に | 取るところ |
   |:--|:-:|:--|:--|
   | `ANTHROPIC_API_KEY` | **必須** | 台詞（Claude）。`LLM_MODEL` で変更（既定 `claude-opus-5`） | https://console.anthropic.com/ |
   | `TYPESAFE_API_KEY` | 反射に | Jev（`jev-latest`）。無ければ「LLM だけ」モード（顔が言葉と一緒に出る） | https://typesafe.ai/ |
   | `GEMINI_API_KEY`（`GOOGLE_API_KEY` でも可） | 声に | Gemini TTS。無ければ字幕モード（同梱の一言・冒頭・結末は鳴る） | https://aistudio.google.com/ |

3. 起動して、ブラウザで開く

   ```bash
   npm start                   # http://127.0.0.1:8792/
   ```

   `npm test` で、鍵なしでも起動・画面・設定・拒否が期待どおりかを確かめられる。

### 声について（大事）

- 彼女の声は Gemini の Voice design で作った `voice_…` の ID で、**作った Google のプロジェクトの鍵でしか使えない**（公式に共有の仕組みがない）。あなたの鍵で動かすと、サーバーが「見つからない」を受けて**既製の声 `Leda` に自動で切り替え**、以後はその声で読む（起動ログに 1 行出る）。同梱の一言・冒頭・結末（29 本）は作者の声のまま鳴る。
- 自分の声を作るなら `node design_voice.mjs --preset` で候補を作って試聴し、気に入った `voice_…` を `.env` の `TTS_VOICE` に。既製の名前（`Leda`・`Kore` など）も指定できる。切り替え先は `TTS_FALLBACK_VOICE`。
- **声の中継**: 手元で動かす人が Gemini の鍵なしで彼女の声のまま読みたいときは、`.env` に `VOICE_RELAY_URL=https://jev-kano-64632361989.asia-northeast1.run.app` を書く（あなたの鍵は Jev と Claude だけ。公開版と同じ回数上限を分け合う）。

### URL を開けば遊べる形で置く（Render・無料枠）

自分の PC を公開せずに「誰でも URL で遊べる」形にするなら、Render の無料枠が一番手数が少ない（カード不要）。リポジトリに設計図 `render.yaml` がある。

1. https://render.com に GitHub でサインイン → **New → Blueprint** → このリポジトリ（fork でもよい）を選ぶ
2. 聞かれる 3 つの鍵（`TYPESAFE_API_KEY`・`ANTHROPIC_API_KEY`・`GEMINI_API_KEY`）を入れる。`TTS_VOICE` は自分の声か既製の名前に（作者の声 ID は作者の鍵でしか鳴らない）
3. Deploy → `https://jev-kano-xxxx.onrender.com` が遊べる URL

守り: `PUBLIC=1` で 1 人（IP）10 分 30 手・全体 1 日 400 手（≒ 40 ゲーム。数えるのは言葉の生成だけで、先読みの反射と声は数えない）。数字は Dashboard の環境変数で変えられる。費用は置いた人の 3 つの鍵の分（Claude が本体。Opus で 1 ゲーム 30〜60 円、`LLM_MODEL=claude-sonnet-5` なら半分以下）。無料枠は 15 分無操作で眠り、次の最初の 1 回だけ 30〜60 秒待つ。

### 中継サーバーを自分で立てる（作者向け・同じことをしたい人向け）

同じコードを `VOICE_RELAY=1` で起動すると、声の口（`/api/voice/stream`・`/api/sfx/*`・`/api/fixed`）だけを公開する中継サーバーになる。Jev・Claude・画面は出さない。鍵は Gemini だけ持てばよい。

```bash
# 手元で試す（別の端末で）
VOICE_RELAY=1 PORT=8794 GEMINI_API_KEY=... TTS_VOICE=voice_... node server.mjs
# 遊ぶ側
VOICE_RELAY_URL=http://127.0.0.1:8794 npm start
```

Cloud Run に置くなら（gcloud を入れて、課金が有効なプロジェクトで）:

```bash
gcloud run deploy jev-kano-voice --source . --region asia-northeast1 --allow-unauthenticated \
  --set-env-vars VOICE_RELAY=1,GEMINI_API_KEY=（鍵）,TTS_VOICE=voice_...,RELAY_DAILY_CAP=3000
```

出てきた URL を配る。守り: 1 人（IP）10 分 `RELAY_PER_IP_10MIN`（既定 40）・全体 1 日 `RELAY_DAILY_CAP`（既定 3,000）・文は 200 字まで・`RELAY_TOKEN` を両側に書けば合言葉つき。費用は Gemini TTS の分だけ（Tier 2 なら 1 日 100 回の壁は無い）。

### 実験を本番と分けて置く（stg）

- 本体を変えない実験は、別の頁として同じサーバーに置く。いまあるのは `/rig`（簡易リグ: 「表情の状態 → 描画」の層を挟み、反射の顔を一瞬出してから取り繕う・息づかい・赤面の残り。本番の差し替えと左右に並べて同じ入力で比較する）。手元なら http://127.0.0.1:8792/rig 。
- 外から比較したいときは、Cloud Run に**別のサービス名**で置く（本番と同じ鍵・上限は小さく）。鍵の置き場は `.env` の 1 か所だけ。deploy のときだけ `.env` から YAML を作って gcloud に渡し、終わったら消す（`deploy.mjs`）。リポジトリの root で:

  ```bash
  npm run deploy:stg                # jev-kano-stg（1 人 10 分 30 手・1 日 100 手）
  node deploy.mjs --dry-run         # 渡す変数の名前と gcloud の行を見るだけ
  node deploy.mjs --service jev-kano --cap 400   # 本番を置き直す
  ```

  `.env` のうち手元専用（`PORT`・`HOST`・`REFLEX_GALGE_OUT`）は渡さない（Cloud Run は `PORT` を自分で決めるので、渡すと落ちる）。`--model claude-sonnet-5` で実験だけ安いモデルに。本番（`jev-kano`）は触らない。眠っている間の費用はどちらもほぼ 0。実験をやめたら `gcloud run services delete jev-kano-stg --region asia-northeast1`。

### つまずいたら

- **ポート 8792 が使われている** → `.env` に `PORT=8793` など。
- **声が出ない・「上限」と出る** → Gemini は無料枠で 1 日 10 回、Tier 1 で 1 日 100 回（モデルごと）。上限に当たるとサーバーが戻る時刻まで呼ばず、画面は字幕モード。Tier 2（累計 $100 の支払い＋3 日）で壁が消える。
- **言葉が出ない** → `ANTHROPIC_API_KEY` を確認。Claude が使えないときは本音に合う予備の台詞で続く。
- **顔が SVG のまま** → `public/faces/` の画像が読めていない。`git clone` し直す。

### 枠と縮退

- Gemini の TTS は無料枠で 1 分 3 回・1 日 10 回、有料 Tier 1 でも **1 日 100 回**（モデルごと）。Tier 2 は累計 100 ドルの支払い＋3 日。
- 上限や障害のときも黙って止まらない: 声は Flash → Lite → （設定でオンなら）ブラウザの合成音声、一言は同梱の音声、言葉は Claude が使えなければ本音に合う予備の台詞。見出しに状態を出す。
- 一言と冒頭・結末の音声は「文・声・指示」のハッシュで一度だけ作り、`npm run sfx:bundle` で `public/sfx/` に同梱する（鍵が無くても鳴る）。

## 声質を作る・顔を作る

```bash
node design_voice.mjs --preset            # 声質の候補を作って試聴 WAV → voice_… の ID
node design_voice.mjs --audition voice_xxx "台詞"
node make_faces.mjs --base                # 基準画 1 枚 → 表情 4 枚（同じ人物のまま編集）
node make_faces.mjs --from making/faces/xxx.jpg
node make_cutout.mjs --all                # 顔の絵の背景を緑に（立ち絵用。public/faces/green/）
node make_bg.mjs                          # 背景の絵（部室・夕方）→ public/bg/clubroom.jpg。--id wings でステージ袖
```

- かわいさの大半は声質と絵で決まる。プロンプトで直すのは調子だけ。
- 未成年を思わせる説明は安全ポリシーで弾かれる。年齢は 20 代で書く。
- 顔は `public/faces/{calm,joy,shy,puzzled,upset}.jpg` と強い版 `*_strong.jpg`。SVG は画像が無いときの代替。

## 測る

```bash
node bench.mjs --model claude-haiku-4-5 --runs 3
node bench.mjs --model claude-opus-5 --runs 3
```

台詞 30 本を同じ基準で Jev と LLM に独立に判定させ、応答時間・揺れ・一致率・費用を出す。
各ターンの計測は `_out/turns.jsonl`（入力した台詞も残る。自分で遊ぶ前提）。

## 制作記録

`MAKING.md` と `making/`（声質の候補と見本、顔 v1〜v6、背景の候補、ボツと理由、上限や安全ポリシーで分かったこと）。

## 送る先と残るもの

- 台詞は判定のため TypeSafe AI と Anthropic に、声を出すときは Google に送られる（打っている途中の先読みは既定でオフ。`?peek=1` のときだけ書きかけの文も Jev に送られる）。
  TypeSafe AI の入力データの保持・学習利用の方針は 2026-09 時点で公式ドキュメントに記載が見当たらない。
- ローカルの `_out/` 以外にはこのプログラムは何も残さない。見たはじまりや設定はブラウザに残る。
- 人物も場面もすべて架空。
