# 設計說明：Claude 為主、Codex 為輔的多 agent 工作流

## 你目前的用法與痛點

- 你在 Claude session 裡用插件叫 Codex，把 Codex 當成「agent 的 agent」。
- 痛點一：Codex 的工作藏在 Claude 的工具呼叫裡，看不到它做了什麼，也沒辦法直接接手。
- 痛點二：Claude 額度（5 小時 / 每週）用完時，工作就卡住，要自己手動整理脈絡再丟給 Codex。

設計目標是讓 **Claude 當主要的指揮者**，Codex 在兩種角色之間無縫切換：

1. **平時**：Claude 的子 agent（第二意見、平行實作、大量機械性修改）
2. **Claude 沒額度時**：暫時的主力，額度恢復後再交回 Claude

## 一、Codex 當子 agent

### 為什麼用 MCP，不用 shell 插件

Codex CLI 內建 `codex mcp-server`，提供兩個工具：

- `codex`：開一個新的 Codex session（可指定 prompt、cwd、sandbox、approval policy）
- `codex-reply`：用 conversation id 繼續同一個 Codex session

跟「在 Bash 裡跑 `codex exec`」的插件比起來：

| | shell 插件 | MCP (`codex mcp-server`) |
| --- | --- | --- |
| 多輪對話 | 通常每次都是新 session | `codex-reply` 可以接著問、要求修正 |
| 權限控制 | 靠 Bash 權限 | Claude 的 MCP 權限規則，可個別允許 `mcp__codex__codex` |
| 可見性 | 只看得到最後的輸出 | Codex 照常寫 rollout 檔，本程式可以列出並開啟 |

本程式在帳號選單提供一鍵安裝：

```bash
claude mcp add --scope user codex -- codex mcp-server
```

裝在 user scope，所以所有專案、所有新 session 都能用；若有多個 Claude 帳號，對每個帳號各按一次（每個帳號有自己的設定目錄）。

### 讓子 agent 看得見、接得手

Codex 被 MCP 呼叫時仍會把紀錄寫到 `~/.codex/sessions/...`，裡面帶著專案 `cwd` 和 `source`。
本程式依 `cwd` 把它列在該專案的 Codex 分頁，`source` 是 `mcp`/`exec` 時標上「子 agent」。
點一下就用 `codex resume <id>` 在窗格中打開，可以看完整過程，必要時直接跟它對話、接手。

### 建議的分工規則（放進專案的 CLAUDE.md）

```markdown
## 何時交給 Codex（mcp__codex__codex）
- 完成一個功能後，請 Codex 做一次獨立的 code review，把它的意見整理後再決定要不要採納
- 大量、規則明確的機械性修改（改名、遷移 API、補型別），切成獨立的小任務交給 Codex，自己負責驗收
- 卡關超過兩次嘗試的 bug，請 Codex 提出另一種假設
- 交代任務時一定要附上：目標、相關檔案路徑、驗收方式（要跑的測試指令）
- Codex 回來後一定要自己跑測試驗證，不要直接相信它的結論
```

### 共用專案規則：一份來源

Claude 讀 `CLAUDE.md`，Codex 讀 `AGENTS.md`。建議把共同規則寫在 `AGENTS.md`，
在 `CLAUDE.md` 用 Claude Code 的 import 語法引用它：

```markdown
@AGENTS.md

## 只給 Claude 的額外規則
...
```

這樣兩邊（包括接手時）遵守的是同一份規則。

## 二、額度用完時的無縫接軌

### 偵測

兩個訊號，任一個成立就觸發：

1. **終端機輸出**：窗格輸出出現 “usage limit reached”、“5-hour limit reached” 之類的訊息（`LIMIT_PATTERNS`）
2. **額度 API**：儀表板每 2 分鐘更新一次，目前帳號的 5 小時額度到 100% 時跳出提醒

觸發後依設定「詢問我 / 自動接手 / 不處理」處理，並依「優先順序」排列選項。

### 分層 fallback

```
Claude 帳號 A 用完
   │
   ├─(1) 還有其他 Claude 帳號有額度？ ── 是 ──▶ 同一格以帳號 B 執行 `claude --resume <同一個 session>`
   │                                            （session 歷史透過 symlink 共用，對話 100% 延續）
   │
   └─(2) 否 ──▶ 產生交接文件 ──▶ 同一格啟動 Codex，prompt 要它先讀交接文件
                                      │
                                      └─ Claude 額度恢復 ──▶ ⇄「交給 Claude 接手」，同樣流程反向
```

**第 1 層最好**：同一個 session 換帳號繼續，零資訊損失。做法是每個帳號一個 `CLAUDE_CONFIG_DIR`，
其 `projects/` 用 symlink 指回預設的 `~/.claude/projects`，所以任何帳號都 `--resume` 得到同一份對話。

**第 2 層是跨模型交接**。不嘗試把 Claude 的對話紀錄「翻譯」成 Codex 格式，原因：

- 兩邊的工具呼叫格式、系統提示都不同，直接轉換只會得到一堆 Codex 看不懂的東西
- 真正共享的狀態其實是 **工作目錄與 git**，對話只是用來理解「目標」和「做到哪」

所以交接文件（`.multi-agent/handoffs/<時間>-claude-to-codex.md`）只放接手需要的東西：

- 原始目標（第一個使用者需求）
- 待辦清單的最後狀態（來自 `TodoWrite`）
- 這個 session 改過的檔案（來自 Edit / Write / apply_patch）
- 目前分支、`git status`、`git diff --stat`
- 最近 12 則對話（使用者與 agent 的文字，不含工具輸出）

接手的 prompt 要求對方先讀文件、用 git 確認實際狀態、回報理解的進度，再繼續。
目錄自動加進 `.git/info/exclude`，不會污染 repo。

### 為什麼換帳號續跑時要「重開」程式

Claude Code 在程式啟動時決定帳號與憑證，執行中的程式沒辦法換帳號。
所以換帳號 = 結束該窗格的程式，用新的 `CLAUDE_CONFIG_DIR` 重新 `--resume`。
對使用者來說窗格、名稱、位置都不變，只是帳號標籤換了。

## 三、帳號系統

- 一個 profile = `{ 名稱, CLAUDE_CONFIG_DIR, CODEX_HOME? }`，預設帳號就是原本的 `~/.claude`，不需要任何遷移。
- 登入直接用官方的 `claude auth login` / `codex login`，在小終端機裡跑，不經手密碼或 token。
- 額度讀取只「讀」各帳號既有的 OAuth token，不寫入也不更新它（更新交給 Claude Code 本身）。
- 每個窗格記住自己用哪個帳號；還原 session 時也用原本的帳號。

## 四、之後可以加的

- **context 快滿提醒**：context > 80% 時在窗格上建議 `/compact` 或開新 session 並附交接文件
- **等待輸入通知**：用 Claude Code 的 `Notification` / `Stop` hook 把「哪個 session 在等你」回報給本程式，在窗格標題閃爍
- **子 agent 即時檢視**：Claude 呼叫 Codex 時自動在空的窗格打開那個 Codex session，即時看它的輸出
- **依額度自動選帳號**：新開 session 時自動挑額度最多的帳號
