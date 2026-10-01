# 設計說明：Claude 為主、Codex 為輔

## 出發點

原本的用法是在 Claude session 裡用插件叫 Codex。這樣 Codex 做了什麼只看得到最後一段輸出，想接手也接不了。另外，Claude 的 5 小時或每週額度用完時，要在每個開著的視窗各打一次 `/login` 換帳號才能繼續。

這個程式讓 Claude 負責主要工作，Codex 當 Claude 的子 agent；額度用完時換同一個工具的另一個帳號續跑，不交給另一個工具。

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

### 為什麼平常要在每個視窗打 /login

- Claude Code 在啟動時讀登入資訊，之後放在記憶體裡用；執行中的程式換不了帳號。
- 同一個設定資料夾（`~/.claude`）只有一份登入資訊。在一個視窗 `/login` 會覆蓋它，但其他視窗手上還是舊的 token，要重新啟動或自己重新登入才會換。
- 所以「一台電腦不能同時開兩個帳號」只在共用同一個設定資料夾時成立。每個帳號一個 `CLAUDE_CONFIG_DIR`（macOS 的 Keychain 項目名稱也會帶上資料夾的 hash），不同帳號就可以同時跑。Codex 同理，每個帳號一個 `CODEX_HOME`。

### 偵測

兩種來源，都要有額度數字佐證才自動處理：

1. 窗格輸出出現額度用完的文字（`LIMIT_PATTERNS`），例如 Claude Code 目前的 `You've hit your session limit · resets 3pm`、`You've hit your weekly limit`，舊版的 `usage limit reached`，Codex 的 `You've hit your usage limit`。fast mode 的「fast limit」不算。
2. 每 2 分鐘的額度檢查：Claude 用 OAuth usage 端點，加上窗格 statusline 回報的 `rate_limits`；Codex 用 session 紀錄裡的 `rate_limits`。5 小時或每週視窗到 99% 以上就算用完。

只有文字、額度數字顯示還有額度時，當成誤判（例如畫面上剛好在看這段程式碼），重新開始偵測。讀不到額度時不自動換，改成詢問。剛開啟 20 秒內的窗格會重播舊對話，裡面可能有舊的額度訊息，這段時間只認額度數字。

### 換帳號接力

```
帳號 A 用完（有窗格在用）
   │
   ├─ 選剩餘額度最多、已登入、沒用完的帳號 B
   │
   ├─ 被額度打斷的窗格、閒置的窗格 ─▶ 結束程式（等它真的結束）─▶ 用 B `--resume` 同一個 session
   │                                    被打斷的窗格另外附一句「繼續」
   │
   ├─ 還在工作的窗格 ─▶ 等它停下來（3 秒沒有輸出，或也撞到額度）再換；等待期間 B 也用完就改選別的
   │
   └─ 之後新開的 session 改用 B
```

- 範圍是所有專案裡用帳號 A 的窗格，不只畫面上這一個。
- 「詢問我」時，上方出現一列提示，一個按鈕換掉全部；「自動換帳號」時直接執行。
- 沒有其他還有額度的帳號時，只提示 A 什麼時候重置，不會在兩個用完的帳號之間來回換。
- 先等舊程式結束才用新帳號續跑：同一個 session 由兩個程序同時寫，紀錄會分岔。
- 在帳號選單手動切換帳號時，也可以選擇把開著的窗格一起換過去，流程相同。

換帳號續跑不會損失對話內容：同一個工具的帳號共用 session 歷史（Claude 的 `projects/`、Codex 的 `sessions/` 以 symlink 指回預設資料夾）。

### 共用資料夾涵蓋不到的設定

Claude 的 `.claude.json` 存著登入身分，不能整個共用；但資料夾信任、user / local scope 的 MCP server、已允許的工具、首次使用設定也在裡面。新帳號少了這些，續跑時會先跳出主題設定或「信任這個資料夾嗎？」，自動送出的「繼續」就卡住了，也會少了 MCP 工具。所以開 Claude 窗格前，程式把預設帳號的這幾項補進目標帳號，只補缺的，不覆蓋目標帳號自己的設定。

### 交接文件而不是轉換對話紀錄

窗格的 `⇄` 可以手動把工作交給另一個工具。程式不把 Claude 的對話紀錄轉成 Codex 的格式：兩邊的工具呼叫與系統提示格式不同，轉過去也讀不懂；兩個 agent 真正共用的狀態是工作目錄和 git。

所以交接文件（`.multi-agent/handoffs/<時間>-claude-to-codex.md`）只放接手需要的內容：

- 原始需求（第一個使用者訊息）
- 待辦清單的最後狀態（來自 `TodoWrite`）
- 這個 session 改過的檔案（來自 Edit、Write、apply_patch）
- 目前分支、`git status`、`git diff --stat`
- 最近 12 則對話，只有文字，不含工具輸出

接手的 prompt 要對方先讀文件，用 git 確認程式碼現況，簡短回報進度和下一步，然後繼續。文件會依介面語言寫成中文或英文。這個資料夾會加進 `.git/info/exclude`，不會出現在 `git status`。換到不共用歷史的帳號時，也用交接文件開新 session。

## 帳號

- Claude 帳號是 `{ 名稱, CLAUDE_CONFIG_DIR }`，Codex 帳號是 `{ 名稱, CODEX_HOME }`，兩份清單、兩個目前帳號，互不影響。預設帳號就是原本的 `~/.claude` 與 `~/.codex`。
- 窗格記得自己用哪個帳號（Claude 窗格是 Claude 帳號，Codex 窗格是 Codex 帳號），還原時沿用。Claude 窗格與 shell 另外帶上目前的 Codex 帳號，讓 Claude 叫出來的 Codex、shell 裡打的 `codex` 用同一個帳號。
- 舊版的 Codex 登入掛在 Claude 帳號底下（`profile.codexHome`），升級時搬成同 id 的 Codex 帳號，舊的 Codex 窗格紀錄照樣對得上。
- 登入用官方的 `claude auth login` 與 `codex login`，在小終端機裡執行，程式不經手密碼。瀏覽器沒有自動完成時，授權碼可以貼在小終端機下方的欄位。
- 讀額度時只讀取各帳號現有的 OAuth token，不寫入、不刷新。刷新交給 Claude Code 自己。

## 之後可以做的

- context 超過 80% 時，在窗格上建議 `/compact`，或開新 session 並附上交接文件。
- 用 Claude Code 的 `Notification` 與 `Stop` hook 回報哪個 session 在等輸入，在窗格標題上提示。
- Claude 呼叫 Codex 時，自動在空窗格打開那個 Codex session。
- 額度恢復後，把窗格換回原本的帳號。
