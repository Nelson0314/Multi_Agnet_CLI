# 設計說明：Claude 為主、Codex 為輔

## 出發點

原本的用法是在 Claude session 裡用插件叫 Codex。這樣有兩個問題：Codex 做了什麼只看得到最後一段輸出，想接手也接不了；Claude 的 5 小時或每週額度用完時，工作停在半路，要自己整理脈絡再貼給 Codex。

這個程式讓 Claude 負責主要工作，Codex 在兩個情況派上用場：平常當 Claude 的子 agent，Claude 沒額度時暫時接手。

## Codex 當子 agent

### 用 MCP 取代 shell 插件

Codex CLI 內建 `codex mcp-server`，提供兩個工具：`codex` 開新的 Codex session（可指定 prompt、cwd、sandbox、approval policy），`codex-reply` 用 conversation id 接著同一個 session 對話。

| | shell 插件（`codex exec`） | `codex mcp-server` |
| --- | --- | --- |
| 多輪對話 | 每次呼叫都是新 session | `codex-reply` 可以追問、要求修正 |
| 權限 | 跟著 Bash 權限走 | 可以只允許 `mcp__codex__codex` |
| 看得到過程 | 只有最後的輸出 | Codex 照常寫 rollout 檔，本程式可以列出來開 |

帳號選單有一鍵安裝，實際執行的是：

```bash
claude mcp add --scope user codex -- codex mcp-server
```

user scope 代表所有專案都能用。每個 Claude 帳號有自己的設定目錄，所以多帳號時要各裝一次。

### 看得到、接得手

MCP 叫出來的 Codex 一樣會寫 `~/.codex/sessions/...`，紀錄裡有專案的 `cwd` 和 `source`。本程式依 `cwd` 把它列在該專案的 Codex 分頁，`source` 是 `mcp` 或 `exec` 時標記「子 agent」。點開就是 `codex resume <id>`，可以看完整過程，也可以直接跟它對話。

### 建議寫進專案 CLAUDE.md 的分工規則

```markdown
## 什麼時候交給 Codex（mcp__codex__codex）
- 做完一個功能後，請 Codex 獨立 review，整理它的意見再決定採不採納。
- 規則明確的大量修改（改名、API 遷移、補型別），切成小任務交給 Codex，自己驗收。
- 同一個 bug 試了兩次還沒解決，請 Codex 提另一種假設。
- 交代任務時附上目標、相關檔案路徑、驗收用的測試指令。
- Codex 回報後自己跑測試確認，不要直接採信它的結論。
```

### 一份共用規則

Claude 讀 `CLAUDE.md`，Codex 讀 `AGENTS.md`。把共同規則寫在 `AGENTS.md`，在 `CLAUDE.md` 用 import 引用：

```markdown
@AGENTS.md

## 只給 Claude 的規則
...
```

兩邊接手時看的是同一份規則。

## 額度用完時

### 偵測

任一條件成立就觸發：

1. 窗格輸出出現 `usage limit reached`、`5-hour limit reached`、`You've hit your limit` 之類的文字（`LIMIT_PATTERNS`）。
2. 儀表板每 2 分鐘讀一次額度，目前帳號的 5 小時額度到 100%。

觸發後依設定詢問、自動執行或不處理。

### 順序

```
Claude 帳號 A 用完
   │
   ├─ 還有別的 Claude 帳號有額度 ─▶ 同一格用帳號 B 執行 claude --resume <同一個 session>
   │
   └─ 沒有 ─▶ 寫交接文件 ─▶ 同一格啟動 Codex，要它先讀文件
                                │
                                └─ Claude 額度恢復 ─▶ 從 Codex 交回 Claude，流程相同
```

換帳號續跑不會損失任何內容。每個帳號是一個 `CLAUDE_CONFIG_DIR`，它的 `projects/` 用 symlink 指回 `~/.claude/projects`，所以任何帳號都讀得到同一份對話紀錄。

Claude Code 在啟動時決定用哪個帳號，執行中的程式換不了帳號。換帳號的做法是結束窗格裡的程式，帶新的 `CLAUDE_CONFIG_DIR` 重新 `--resume`。窗格的位置和名稱不變，只有帳號標籤會換。

### 交接文件而不是轉換對話紀錄

跨模型交接時，程式不把 Claude 的對話紀錄轉成 Codex 的格式。兩邊的工具呼叫與系統提示格式不同，轉過去 Codex 也讀不懂；兩個 agent 真正共用的狀態是工作目錄和 git。

所以交接文件（`.multi-agent/handoffs/<時間>-claude-to-codex.md`）只放接手需要的內容：

- 原始需求（第一個使用者訊息）
- 待辦清單的最後狀態（來自 `TodoWrite`）
- 這個 session 改過的檔案（來自 Edit、Write、apply_patch）
- 目前分支、`git status`、`git diff --stat`
- 最近 12 則對話，只有文字，不含工具輸出

接手的 prompt 要對方先讀文件，用 git 確認程式碼現況，簡短回報進度和下一步，然後繼續。文件會依介面語言寫成中文或英文。這個資料夾會加進 `.git/info/exclude`，不會出現在 `git status`。

## 帳號

- 一個 profile 是 `{ 名稱, CLAUDE_CONFIG_DIR, CODEX_HOME（可選） }`。預設帳號就是原本的 `~/.claude`。
- 登入用官方的 `claude auth login` 與 `codex login`，在小終端機裡執行，程式不經手密碼。
- 讀額度時只讀取各帳號現有的 OAuth token，不寫入、不刷新。刷新交給 Claude Code 自己。
- 每個窗格記得自己用哪個帳號，還原時沿用。

## 之後可以做的

- context 超過 80% 時，在窗格上建議 `/compact`，或開新 session 並附上交接文件。
- 用 Claude Code 的 `Notification` 與 `Stop` hook 回報哪個 session 在等輸入，在窗格標題上提示。
- Claude 呼叫 Codex 時，自動在空窗格打開那個 Codex session。
- 新開 session 時自動選額度最多的帳號。
