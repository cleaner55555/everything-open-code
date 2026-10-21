# トラブルシューティングガイド

ECC プラグインの一般的な問題と解決策。

## 目次

- [メモリとコンテキストの問題](#メモリとコンテキストの問題)
- [エージェントハーネスの障害](#エージェントハーネスの障害)
- [フックとワークフローのエラー](#フックとワークフローのエラー)
- [インストールとセットアップ](#インストールとセットアップ)
- [パフォーマンスの問題](#パフォーマンスの問題)
- [一般的なエラーメッセージ](#一般的なエラーメッセージ)
- [ヘルプを得る](#ヘルプを得る)

---

## メモリとコンテキストの問題

### コンテキストウィンドウのオーバーフロー

**症状：** 「Context too long」エラーまたは不完全なレスポンス

**原因：**
- トークン制限を超える大きなファイルのアップロード
- 蓄積された会話履歴
- 単一セッション内の複数の大きなツール出力

**解決策：**
```bash
# 1. 会話履歴をクリアして新しく開始
# OpenCode: 「New Chat」または Cmd/Ctrl+Shift+N

# 2. 分析前にファイルサイズを縮小
head -n 100 large-file.log > sample.log

# 3. 大きな出力にはストリーミングを使用
head -n 50 large-file.txt

# 4. タスクを小さなチャンクに分割
# 代わりに: 「50ファイルすべてを分析して」
# 使用: 「src/components/ ディレクトリのファイルを分析して」
```

### メモリ永続化の失敗

**症状：** エージェントが以前のコンテキストや観測を覚えていない

**原因：**
- 継続学習フックが無効化されている
- 観測ファイルが破損している
- プロジェクト検出の失敗

**解決策：**
```bash
# 観測が記録されているか確認
ls ~/.opencode/homunculus/projects/*/observations.jsonl

# 現在のプロジェクトのハッシュIDを検索
python3 - <<'PY'
import json, os
registry_path = os.path.expanduser("~/.opencode/homunculus/projects.json")
with open(registry_path) as f:
    registry = json.load(f)
for project_id, meta in registry.items():
    if meta.get("root") == os.getcwd():
        print(project_id)
        break
else:
    raise SystemExit("Project hash not found in ~/.opencode/homunculus/projects.json")
PY

# そのプロジェクトの最近の観測を表示
tail -20 ~/.opencode/homunculus/projects/<project-hash>/observations.jsonl

# 破損した観測ファイルを再作成前にバックアップ
mv ~/.opencode/homunculus/projects/<project-hash>/observations.jsonl \
  ~/.opencode/homunculus/projects/<project-hash>/observations.jsonl.bak.$(date +%Y%m%d-%H%M%S)

# フックが有効か確認
grep -r "observe" ~/.opencode/settings.json
```

---

## エージェントハーネスの障害

### エージェントが見つからない

**症状：** 「Agent not loaded」または「Unknown agent」エラー

**原因：**
- プラグインが正しくインストールされていない
- エージェントパスの設定ミス
- Marketplaceと手動インストールの不一致

**解決策：**
```bash
# プラグインのインストールを確認
ls ~/.opencode/plugins/cache/

# エージェントの存在を確認（Marketplaceインストール）
ls ~/.opencode/plugins/cache/*/agents/

# 手動インストールの場合、エージェントは以下に配置:
ls ~/.opencode/agents/  # カスタムエージェントのみ

# プラグインをリロード
# OpenCode → Settings → Extensions → Reload
```

### ワークフロー実行のハング

**症状：** エージェントが開始するが完了しない

**原因：**
- エージェントロジック内の無限ループ
- ユーザー入力でブロックされている
- API待ちのネットワークタイムアウト

**解決策：**
```bash
# 1. スタックしたプロセスを確認
ps aux | grep claude

# 2. デバッグモードを有効化
export CLAUDE_DEBUG=1

# 3. より短いタイムアウトを設定
export CLAUDE_TIMEOUT=30

# 4. ネットワーク接続を確認
curl -I https://api.anthropic.com
```

### ツール使用エラー

**症状：** 「Tool execution failed」またはパーミッション拒否

**原因：**
- 必要な依存関係の不足（npm、python等）
- ファイルパーミッションの不足
- パスが見つからない

**解決策：**
```bash
# 必要なツールがインストールされているか確認
which node python3 npm git

# フックスクリプトのパーミッションを修正
chmod +x ~/.opencode/plugins/cache/*/hooks/*.sh
chmod +x ~/.opencode/plugins/cache/*/skills/*/hooks/*.sh

# PATHに必要なバイナリが含まれているか確認
echo $PATH
```

---

## フックとワークフローのエラー

### フックが発火しない

**症状：** Pre/Postフックが実行されない

**原因：**
- フックがsettings.jsonに登録されていない
- 無効なフック構文
- フックスクリプトが実行可能でない

**解決策：**
```bash
# フックが登録されているか確認
grep -A 10 '"hooks"' ~/.opencode/settings.json

# フックファイルが存在し実行可能か確認
ls -la ~/.opencode/plugins/cache/*/hooks/

# フックを手動でテスト
bash ~/.opencode/plugins/cache/*/hooks/pre-bash.sh <<< '{"command":"echo test"}'

# フックを再登録（プラグイン使用時）
# OpenCode設定でプラグインを無効化してから再度有効化
```

### Python/Nodeバージョンの不一致

**症状：** 「python3 not found」または「node: command not found」

**原因：**
- Python/Nodeがインストールされていない
- PATHが設定されていない
- 間違ったPythonバージョン（Windows）

**解決策：**
```bash
# Python 3をインストール（不足している場合）
# macOS: brew install python3
# Ubuntu: sudo apt install python3
# Windows: python.orgからダウンロード

# Node.jsをインストール（不足している場合）
# macOS: brew install node
# Ubuntu: sudo apt install nodejs npm
# Windows: nodejs.orgからダウンロード

# インストールを確認
python3 --version
node --version
npm --version

# Windows: python3ではなくpythonが動作することを確認
python --version
```

### 開発サーバーブロッカーの誤検出

**症状：** フックが「dev」を含む正当なコマンドをブロックする

**原因：**
- ヒアドキュメントの内容がパターンマッチをトリガー
- 引数に「dev」を含む非開発コマンド

**解決策：**
```bash
# v1.8.0+で修正済み（PR #371）
# プラグインを最新バージョンにアップグレード

# 回避策: 開発サーバーをtmuxでラップ
tmux new-session -d -s dev "npm run dev"
tmux attach -t dev

# 必要に応じてフックを一時的に無効化
# ~/.opencode/settings.jsonを編集してpre-bashフックを削除
```

---

## インストールとセットアップ

### プラグインが読み込まれない

**症状：** インストール後にプラグイン機能が利用できない

**原因：**
- Marketplaceキャッシュが更新されていない
- OpenCodeバージョンの非互換性
- プラグインファイルの破損
- ローカルのClaude設定がワイプまたはリセットされた

**解決策：**
```bash
# まずECCがこのマシンについて認識している情報を確認
ecc list-installed
ecc doctor
ecc repair

# doctor/repairで不足ファイルを復元できない場合のみ再インストール

# 変更前にプラグインキャッシュを確認
ls -la ~/.opencode/plugins/cache/

# プラグインキャッシュを削除せずバックアップ
mv ~/.opencode/plugins/cache ~/.opencode/plugins/cache.backup.$(date +%Y%m%d-%H%M%S)
mkdir -p ~/.opencode/plugins/cache

# Marketplaceから再インストール
# OpenCode → Extensions → ECC → Uninstall
# その後Marketplaceから再インストール

# 問題がMarketplace/アカウントアクセスの場合、ECC Toolsのbilling/アカウントリカバリーを別途使用
# 再インストールをアカウントリカバリーの代替として使用しない

# OpenCodeバージョンを確認
claude --version
# OpenCode 2.0+が必要

# 手動インストール（Marketplaceが失敗する場合）
git clone https://github.com/affaan-m/ECC.git
cp -r ECC ~/.opencode/plugins/ecc
```

### パッケージマネージャー検出の失敗

**症状：** 間違ったパッケージマネージャーが使用される（pnpmの代わりにnpm）

**原因：**
- ロックファイルが存在しない
- OPENCODE_PACKAGE_MANAGERが設定されていない
- 複数のロックファイルが検出を混乱させている

**解決策：**
```bash
# 優先パッケージマネージャーをグローバルに設定
export OPENCODE_PACKAGE_MANAGER=pnpm
# ~/.bashrcまたは~/.zshrcに追加

# またはプロジェクトごとに設定
echo '{"packageManager": "pnpm"}' > .opencode/package-manager.json

# またはpackage.jsonフィールドを使用
npm pkg set packageManager="pnpm@8.15.0"

# 警告: ロックファイルの削除はインストールされた依存関係のバージョンを変更する可能性がある
# まずロックファイルをコミットまたはバックアップし、フレッシュインストールを実行してCIを再実行
# パッケージマネージャーを意図的に切り替える場合のみ実行
rm package-lock.json  # pnpm/yarn/bunを使用する場合
```

---

## パフォーマンスの問題

### レスポンスの遅延

**症状：** エージェントの応答に30秒以上かかる

**原因：**
- 大きな観測ファイル
- アクティブなフックが多すぎる
- APIへのネットワーク遅延

**解決策：**
```bash
# 大きな観測を削除せずアーカイブ
archive_dir="$HOME/.opencode/homunculus/archive/$(date +%Y%m%d)"
mkdir -p "$archive_dir"
find ~/.opencode/homunculus/projects -name "observations.jsonl" -size +10M -exec sh -c '
  for file do
    base=$(basename "$(dirname "$file")")
    gzip -c "$file" > "'"$archive_dir"'/${base}-observations.jsonl.gz"
    : > "$file"
  done
' sh {} +

# 未使用のフックを一時的に無効化
# ~/.opencode/settings.jsonを編集

# アクティブな観測ファイルを小さく保つ
# 大きなアーカイブは ~/.opencode/homunculus/archive/ に配置
```

### 高CPU使用率

**症状：** OpenCodeがCPUを100%消費

**原因：**
- 無限の観測ループ
- 大きなディレクトリのファイル監視
- フック内のメモリリーク

**解決策：**
```bash
# 暴走プロセスを確認
top -o cpu | grep claude

# 継続学習を一時的に無効化
touch ~/.opencode/homunculus/disabled

# OpenCodeを再起動
# Cmd/Ctrl+Q で終了後、再起動

# 観測ファイルのサイズを確認
du -sh ~/.opencode/homunculus/*/
```

---

## 一般的なエラーメッセージ

### "EACCES: permission denied"

```bash
# フックのパーミッションを修正
find ~/.opencode/plugins -name "*.sh" -exec chmod +x {} \;

# 観測ディレクトリのパーミッションを修正
chmod -R u+rwX,go+rX ~/.opencode/homunculus
```

### "MODULE_NOT_FOUND"

```bash
# プラグインの依存関係をインストール
# <version> は `claude plugin list` に表示されるバージョンに置き換えてください。例: 2.2.3
cd "$HOME/.opencode/plugins/cache/ecc/ecc/<version>"
npm install

# または手動インストールの場合
cd ~/.opencode/plugins/ecc
npm install
```

### "spawn UNKNOWN"

```bash
# Windows固有: スクリプトが正しい改行コードを使用していることを確認
# CRLFをLFに変換
find ~/.opencode/plugins -name "*.sh" -exec dos2unix {} \;

# またはdos2unixをインストール
# macOS: brew install dos2unix
# Ubuntu: sudo apt install dos2unix
```

---

## ヘルプを得る

問題が解決しない場合：

1. **GitHub Issuesを確認**: [github.com/affaan-m/ECC/issues](https://github.com/affaan-m/ECC/issues)
2. **デバッグログを有効化**:
   ```bash
   export CLAUDE_DEBUG=1
   export CLAUDE_LOG_LEVEL=debug
   ```
3. **診断情報を収集**:
   ```bash
   claude --version
   node --version
   python3 --version
   echo $OPENCODE_PACKAGE_MANAGER
   ls -la ~/.opencode/plugins/cache/
   ```
4. **Issueを作成**: デバッグログ、エラーメッセージ、診断情報を含めてください

---

## 関連ドキュメント

- [README.md](./README.md) - インストールと機能
- [CONTRIBUTING.md](./CONTRIBUTING.md) - 開発ガイドライン
- [docs/](./) - 詳細なドキュメント
- [examples/](./examples/) - 使用例
