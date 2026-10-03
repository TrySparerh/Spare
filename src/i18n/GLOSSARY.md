# Spare glossary: English → 简体中文 (zh-CN) → 繁體中文 (zh-TW)

The Chinese terms Spare uses, so a concept reads the same in every window, page and error
message. A concept listed here always takes the listed term, never a synonym. When a change
introduces a new term, add it to the section it belongs to in the same change.

- **zh-CN** is Simplified Chinese written for mainland China, Singapore and Malaysia.
- **zh-TW** is Traditional Chinese written **in Taiwan vocabulary** (Taiwan, Hong Kong, Macau).
  It is not zh-CN run through a character converter. 网络 is **網路** (not 網絡), 默认 is **預設**,
  账户 is **帳戶**, 设置 is **設定**, 信息 is **資訊/訊息**, 数据 is **資料**. The section
  [Taiwan vocabulary traps](#13-taiwan-vocabulary-traps) lists the common ones.

---

## 1. Never translate

Copy these exactly as they appear in English:

| Keep as-is | Notes |
|---|---|
| **Spare** | The brand. Always `Spare`, never 备用 / 備用 / 闲置 / 零钱. When English writes `SPARE` (caps) for the protocol, Chinese writes `Spare`. Pixel titles that uppercase it in CSS still say SPARE. |
| **$SPARE** | The token, with the `$`. Say "$SPARE 代币 / 代幣" when a noun is needed. |
| USDG, ETH, WETH, USDC | Token symbols. |
| SPY, NVDA, AAPL, TSLA, QQQ, SGOV | Tickers (and any other ticker). |
| Robinhood Chain | Never 罗宾汉链. "Robinhood Chain 主网 / 主網" is fine. "Robinhood app", "Robinhood Wallet" stay English too. |
| Uniswap, Uniswap v4, Chainlink, Permit2, MCP, Blockscout, MetaMask, Phantom, WalletConnect, Reown, MoonPay, Across, Relay, Stargate, LayerZero, Arbitrum, Base, Ethereum, Spline, X, Telegram | Product and company names. |
| Contract, function and event names | `SweepExecutor`, `RuleRegistry`, `CashPark`, `AssetRegistry`, `StockRouter`, `FeeVault`, `exit()`, `claim(token)`, `setRule`, `Accrued`… Wrap them in `<code>` where the English does. |
| Addresses, tx hashes, block numbers, chain id 4663, URLs, `@TrySpareRH`, code samples, CLI commands, JSON, env var names | |
| Numbers and money | `$5.00`, `0.25%`, `1,234.56`, `2×`, `24/5`. Keep `$` amounts in dollars and keep the English digit grouping. Never convert to 万 / 萬. |
| ERC-20, ERC-1271, ERC-8056, OFT, RPC, API, ABI, L1, EVM, bps (when shown as a unit label) | Standards and acronyms. |
| S1, S2, S3, S4 | Season labels (see "Season" below for the long form). |

---

## 2. Tone and style

**Voice.** Concise, modern fintech Chinese: friendly and direct, never stiff, bureaucratic or
"machine-translated". Write the sentence a Chinese product team would write, not a word-for-word
mirror of the English. Short beats complete: drop filler like 您可以 / 我们将会 when the meaning
holds without it.

**Pronoun.** App UI uses **你** in both zh-CN and zh-TW (the Spare voice is casual, as in
Apple/Google zh-TW UI). Legal pages (Terms, Privacy) and the Docs risk section use **您**.

**ALL-CAPS pixel labels** (chips, badges, eyebrows: `NOT CONNECTED`, `ON-CHAIN`, `SWEPT THIS EPOCH`).
Chinese has no case, so the "shouty" register comes from brevity: use a 2–4 character label
(未连接, 链上, 本期已买入). Don't add brackets, 「」 or ！ to imitate caps, and don't
letter-space it yourself (the CSS already does). Tickers and acronyms inside stay uppercase.
Keep the English square brackets where the English has them (BIOS `[OK]` → `[OK]`,
`[FAIL]` → `[失败]`).

**Length.** Chinese is denser; aim for the same visual width as the English or less. Buttons
and chips ≤ 6 characters where possible. If a label must be long, shorten it rather than let
it truncate.

**Punctuation.**
- Inside Chinese sentences use full-width punctuation: `，。：；！？`.
- Quotes: zh-CN `“ ”` (nested `‘ ’`); zh-TW `「 」` (nested `『 』`).
- Parentheses: full-width `（ ）` when the content contains Chinese; half-width `( )` around
  content that is only Latin/numbers/code, e.g. `2 只待命 (QQQ, SGOV)`.
- English em dash ` — `: rewrite with `，` or `：`, or use `——` (two em dashes, no spaces) in
  prose. Never leave a spaced English dash in a Chinese sentence.
- Ellipsis for "loading" states: one `…` (U+2026): `读取中…` / `讀取中…`.
- Keep the pixel-UI separators exactly: ` · ` (middle dot with spaces), `→`, `↗`, `▸`, `×`, `≈`, `≥`.
- A label followed by a value takes a full-width colon: `每周上限：$25.00`.
- No full stop at the end of buttons, chips, titles or single-line labels.
- A tagline of short phrases joins them with ` · ` (消费 · 凑整 · 持有).

**Spacing between Chinese and Latin/numbers.** Put one half-width space between a Chinese
character and a Latin letter or digit: `绑定 3 个钱包`, `Spare 余额`, `USDG 付款`, `第 12 期`.
No space between a number and `%`, `×`, `$` or a unit symbol (`0.25%`, `2×`, `$5`), and no space
next to full-width punctuation (`余额：$5`, not `余额： $5`).

**Numbers, time and dates.**
- Digits stay half-width Arabic. Money stays `$1,234.56`; token amounts `0.0003 ETH`.
- Measure words: stocks **只** (zh-CN) / **檔** (zh-TW); wallets **个 / 個**; payments and
  transactions **笔 / 筆**; times **次**.
- Durations: `45 秒`, `3 分钟 / 3 分鐘`, `1 小时 24 分 / 1 小時 24 分`, `2 天`.
  "X ago" → `X 前` (`1 小时 24 分前`). "in X" → `X 后 / X 後`.
- Dates and times: use `formatDate()` / `formatDateTime()` from `@/i18n` (gives `2026年10月1日`).
  US market times keep "ET": `周日 20:00 至周五 20:00 (ET)` / `週日 20:00 至週五 20:00 (ET)`.
- Weekdays: zh-CN 周一…周日; zh-TW 週一…週日.
- Compact durations in a stat tile are unspaced, because the pixel font's spaces are 1em wide:
  `24小时00分`, `9分06秒` / `24小時00分`, `9分06秒`. Never 时 alone (24时00分 reads as a time of day).

**Plurals.** Chinese has none: `{{count}} 个钱包` covers 1 and 5. If the English needs
`wallet` / `wallets`, use two English keys (see README) and give both the same Chinese.

**Errors.** Say what happened, then what to do, without blaming the user:
`签名与该地址不匹配，未保存任何内容。` "Nothing saved / nothing was sent" →
`未保存任何内容` / `未儲存任何內容`, `未发送任何交易` / `未送出任何交易`.

---

## 3. The core idea: round-ups and spare change

| English | zh-CN | zh-TW | Notes |
|---|---|---|---|
| round-up (the feature) / round up (verb) | 凑整 | 湊整 | "Each payment rounds up" → 每笔付款都会凑整 / 每筆付款都會湊整 |
| round-ups (what you set up / collect) | 凑整 | 湊整 | "Set up round-ups" → 设置凑整 / 設定湊整 |
| a round-up (one captured amount) | 一笔凑整 | 一筆湊整 | |
| Turbo round-ups | 加倍凑整 | 加倍湊整 | |
| spare change; "the spare" | 零钱 | 零錢 | lower-case "spare" is the money, not the brand |
| spare captured | 凑整零钱 | 湊整零錢 | |
| round-up rule | 凑整规则 | 湊整規則 | |
| round to $1 / $5 / $10; "Round up to" | 凑整至 $1 / $5 / $10；凑整至 | 湊整至 $1 / $5 / $10；湊整至 | |
| boundary (next $1/$5/$10) | 凑整档位 | 湊整級距 | "Next $5 boundary" → 下一个 $5 档位 / 下一個 $5 級距 |
| boundary delta | 凑整差额 | 湊整差額 | |
| multiplier; 1× to 5× | 倍数；1× 至 5× | 倍數；1× 至 5× | |
| weekly cap | 每周上限 | 每週上限 | |
| rolling 7 days; per rolling 7 days | 滚动 7 天；每滚动 7 天 | 滾動 7 天；每滾動 7 天 | |
| accrue / accrual | 计入 | 計入 | "nothing accrues" → 不会计入任何零钱 / 不會計入任何零錢 |
| pull (contract takes USDG); pulled last 7 days | 扣款；近 7 天已扣款 | 扣款；近 7 天已扣款 | |
| remaining (cap room) | 剩余额度 | 剩餘額度 | |
| payment | 付款 | 付款 | "a payment is an outgoing USDG transfer" |
| worked example | 计算示例 | 試算範例 | |
| From payments to stocks | 从付款到股票 | 從付款到股票 | tagline |
| Your coffee just bought you SPY | 你的咖啡，刚帮你买了 SPY | 你的咖啡，剛幫你買了 SPY | OG title |
| collect / collection (round-ups); collected | 收取；已收取 | 收取；已收取 | "Round-ups collected" → 已收取凑整 / 已收取湊整. Never 归集 / 歸集 (reads as fund sweeping). The contract taking USDG is still 扣款; when a line already has 收取手续费, use 扣取凑整 for the round-ups |
| ROUND-UPS ON / OFF | 凑整已开启 / 凑整已关闭 | 湊整已開啟 / 湊整已關閉 | "ON · NO WALLET" → 已开启 · 无钱包 / 已開啟 · 無錢包 |

## 4. Wallets and accounts

| English | zh-CN | zh-TW | Notes |
|---|---|---|---|
| wallet | 钱包 | 錢包 | |
| connect wallet / Connect Wallet | 连接钱包 | 連接錢包 | |
| wallet connected / CONNECTED | 钱包已连接 / 已连接 | 錢包已連接 / 已連接 | |
| NOT CONNECTED | 未连接 | 未連接 | |
| disconnect (wallet) | 断开连接 | 中斷連線 | "Disconnect Wallet" → 断开钱包连接 / 中斷錢包連線 |
| link (a wallet) / Link Wallet | 绑定 / 绑定钱包 | 綁定 / 綁定錢包 | on-chain link to an account |
| linked wallet; LINKED | 已绑定的钱包；已绑定 | 已綁定的錢包；已綁定 | |
| unlink | 解绑 | 解除綁定 | |
| NOT LINKED | 未绑定 | 未綁定 | |
| spending wallet | 消费钱包 | 消費錢包 | the wallet you pay from |
| investing wallet | 投资钱包 | 投資錢包 | the wallet that becomes the account |
| investing account; account; your Spare account | 投资账户；账户；你的 Spare 账户 | 投資帳戶；帳戶；你的 Spare 帳戶 | |
| authorize / Authorize round-ups | 授权 / 授权凑整 | 授權 / 授權湊整 | |
| AUTHORIZED / NOT AUTHORIZED | 已授权 / 未授权 | 已授權 / 未授權 | |
| approval (ERC-20 approve); Permit2 approval | 授权；Permit2 授权 | 授權；Permit2 授權 | "Approve USDG to Permit2" → 授权 USDG 给 Permit2 / 授權 USDG 給 Permit2 |
| allowance | 授权额度 | 授權額度 | |
| revoke | 撤销授权 | 撤銷授權 | |
| unlimited | 无限额 | 無上限 | |
| consent; pull consent | 授权同意；扣款授权 | 授權同意；扣款授權 | |
| sign (verb) / signature | 签名 / 签名 | 簽署 / 簽章 | "Sign the link message" → 签署绑定消息 / 簽署綁定訊息 |
| nonce | nonce | nonce | keep |
| smart wallet | 智能钱包 | 智慧錢包 | |
| address; contract address (CA) | 地址；合约地址 | 地址；合約地址 | |
| copy address; Copied | 复制地址；已复制 | 複製地址；已複製 | |
| receive; send here | 收款；转入此地址 | 收款；轉入此地址 | |
| sign in / Sign in with your wallet | 登录 / 用钱包登录 | 登入 / 使用錢包登入 | |
| continue as guest | 以访客身份继续 | 以訪客身分繼續 | TW 身分, not 身份 |
| Choose your wallet / Select Wallet | 选择钱包 | 選擇錢包 | |
| install; open app | 安装；打开应用 | 安裝；開啟 App | |
| LOW ALLOWANCE · PARTIAL · EXPIRED (consent badges) | 额度不足 · 部分授权 · 已过期 | 額度不足 · 部分授權 · 已過期 | |

## 5. Parking, sweeps and the engine

| English | zh-CN | zh-TW | Notes |
|---|---|---|---|
| park (verb); parked; parked spare | 暂存；已暂存；暂存零钱 | 暫存；已暫存；暫存零錢 | |
| the park / CashPark | 暂存区 / CashPark | 暫存區 / CashPark | contract name stays |
| pending (accrued, not yet parked) | 待入账 | 待入帳 | "Pending USDG" → 待入账 USDG / 待入帳 USDG |
| pending (a transaction) | 待确认 | 待確認 | |
| sweep (noun/verb: keeper buys stocks) | 自动买入（短：买入） | 自動買進（短：買進） | TW 買進, not 買入 |
| swept; SWEPT THIS EPOCH | 已买入；本期已买入 | 已買進；本期已買進 | |
| sweep threshold; auto-buy threshold | 买入门槛；自动买入门槛 | 買進門檻；自動買進門檻 | |
| threshold | 门槛 | 門檻 | |
| sweep engine | 自动买入引擎 | 自動買進引擎 | |
| sweep preview | 买入预览 | 買進預覽 | |
| live sweeps; sweep log | 实时买入；买入记录 | 即時買進；買進紀錄 | |
| epoch; epoch #12; next epoch in | 周期；第 12 期；距下一周期 | 週期；第 12 期；距下一週期 | |
| keeper | 执行器 | 執行器 | the off-chain bot; first mention in Docs may add "(keeper)". "Spare's automated operator" → Spare 的自动化执行程序 / Spare 的自動化執行程式, never 运营方 / 營運方 |
| operator; paused by operator | 运营方；已被运营方暂停 | 營運方；已被營運方暫停 | the company that can pause Spare, never the keeper bot |
| engine | 引擎 | 引擎 | |
| leg (one stock's share of a sweep) | 成分 | 成分 | |
| deferred | 顺延 | 順延 | "retried next epoch" → 顺延至下一周期重试 / 順延至下一週期重試 |
| safe-settled | 安全结算 | 安全結算 | explain once: 以 USDG 交付 |
| delivered (tokens arrive in wallet) | 已到账 | 已入帳 | |
| delivery held; claimable | 待领取；可领取 | 待領取；可領取 | |
| claim | 领取 | 領取 | |
| exit; Exit — withdraw all | 退出；退出：全部提取 | 退出；退出：全部提領 | |
| withdraw | 提取 | 提領 | |
| redeem; in kind | 赎回；以实物 | 贖回；以實物 | |
| yield; no yield | 收益；无收益 | 收益；無收益 | |
| treasuries (SGOV park) | 美国国债 | 美國公債 | |
| screening; cleared | 合规筛查；已通过筛查 | 合規審查；已通過審查 | |
| eligible (account may be swept) | 符合条件 | 符合條件 | |
| window (a block range the keeper scans) | 区间 | 區間 | 窗口 / 視窗 only for an app window |

## 6. Stocks and markets

| English | zh-CN | zh-TW | Notes |
|---|---|---|---|
| tokenized stocks; stock token | 代币化股票；股票代币 | 代幣化股票；股票代幣 | |
| not a share | 并非股份 | 並非股份 | |
| issuer | 发行方 | 發行方 | |
| stock mix; your mix | 股票组合；你的组合 | 股票組合；你的組合 | |
| default mix | 默认组合 | 預設組合 | |
| own mix; elect a mix | 自选组合；选定组合 | 自選組合；選定組合 | |
| weight; weights total 100% | 权重；权重合计 100% | 權重；權重合計 100% | |
| universe; stock universe | 股票池 | 股票池 | |
| active / standby (stocks) | 启用 / 待命 | 啟用 / 待命 | never 备用 / 備用 for standby |
| ELIGIBLE / INACTIVE (stock) | 可选 / 未启用 | 可選 / 未啟用 | |
| delisted / deactivated | 已下架 | 已下架 | |
| oracle | 预言机 | 預言機 | |
| price feed; stock feeds | 价格源；股票价格源 | 價格來源；股票價格來源 | |
| stale (price) | 已过时 | 已過時 | |
| heartbeat | 心跳间隔 | 心跳間隔 | |
| oracle band | 预言机价格区间 | 預言機價格區間 | |
| activation bar (the fill a standby asset must reach before it is turned on) | 启用门槛 | 啟用門檻 | |
| ETF; ETFs & funds (asset type filter) | ETF；ETF 与基金 | ETF；ETF 與基金 | the short tag next to a fund's ticker is 基金 |
| ticker (search / sort by) | 代码 | 代號 | "Search ticker or name" → 搜索代码或名称 / 搜尋代號或名稱 |
| ~1 day change | 约 1 日涨跌 | 約 1 日漲跌 | the move between Chainlink prints about a day apart |
| search; sort; filter; show N more | 搜索；排序；筛选；再显示 N 只 | 搜尋；排序；篩選；再顯示 N 檔 | |
| Stock A / Stock B (placeholder names in examples) | 股票 A / 股票 B | 股票 A / 股票 B | never a real ticker in an example |
| market closed; market open | 休市；开盘 | 休市；開盤 | |
| session; US-equities 24/5 session | 交易时段；美股 24/5 交易时段 | 交易時段；美股 24/5 交易時段 | |
| last close | 上次收盘价 | 上次收盤價 | |
| premium / discount; gap | 溢价 / 折价；价差 | 溢價 / 折價；價差 | |
| depth; DEEP / OK / THIN | 深度；深 / 中 / 浅 | 深度；深 / 中 / 淺 | |
| holdings; positions | 持仓；持仓数 | 持股；持股數 | |
| price; value; total value | 价格；价值；总价值 | 價格；價值；總價值 | |
| not investment advice | 不构成投资建议 | 不構成投資建議 | |
| not offered to US persons | 不向美国人士提供 | 不提供給美國人士 | |
| registry; asset registry; registered | 注册表；资产注册表；已注册 | 註冊表；資產註冊表；已註冊 | never 登记表 / 登錄表 |
| BAD ANSWER (oracle) | 数据异常 | 資料異常 | |
| MIXED (market: some feeds fresh, some not) | 状态不一 | 狀態不一 | |

## 7. Fund Wallet, swaps and fees

| English | zh-CN | zh-TW | Notes |
|---|---|---|---|
| fund (a wallet); top up | 充值 | 儲值 | |
| swap | 兑换 | 兌換 | "Swap ETH → USDG" → 兑换 ETH → USDG / 兌換 ETH → USDG |
| you pay / you receive | 支付 / 收到 | 支付 / 收到 | |
| balance; Max | 余额；最大 | 餘額；最大 | |
| quote; quoting… | 报价；报价中… | 報價；報價中… | |
| QUOTE LIVE / QUOTE STALE | 报价有效 / 报价已过时 | 報價有效 / 報價已過時 | |
| slippage | 滑点 | 滑價 | |
| minimum received | 最少收到 | 最少可收到 | |
| price impact | 价格影响 | 價格影響 | |
| deadline | 截止时间 | 截止時間 | |
| route; pool; pinned pool | 路由；流动性池；指定流动性池 | 路由；流動性池；指定流動性池 | |
| router | 路由合约 | 路由合約 | |
| liquidity provider | 流动性提供者 | 流動性提供者 | |
| gas; gas price; ETH for gas | Gas；Gas 价格；用于支付 Gas 的 ETH | Gas；Gas 價格；用來支付 Gas 的 ETH | keep "Gas" in Latin |
| network fee | 网络费用 | 網路費用 | |
| fee; Spare fee; pool fee | 手续费；Spare 手续费；流动性池手续费 | 手續費；Spare 手續費；流動性池手續費 | |
| bps | 基点 | 基點 | |
| FeeVault (what it is) | 手续费金库 | 手續費金庫 | name stays FeeVault |
| bridge; canonical bridge | 跨链桥；官方跨链桥 | 跨鏈橋；官方跨鏈橋 | |
| buy; fiat | 购买；法币 | 購買；法幣 | |
| exchange (CEX) | 交易所 | 交易所 | |
| deposit / withdrawal (exchange) | 充值 / 提现 | 入金 / 出金 | |
| readiness; READY TO ROUND UP | 准备情况；可以开始凑整 | 準備狀態；可以開始湊整 | |
| Step zero | 第 0 步 | 第 0 步 | |
| swap blocked (price guard) | 已阻止兑换 | 已阻止兌換 | |

## 8. Chain and protocol

| English | zh-CN | zh-TW | Notes |
|---|---|---|---|
| on-chain; ON-CHAIN | 链上 | 鏈上 | |
| chain; mainnet; testnet | 链；主网；测试网 | 鏈；主網；測試網 | |
| block; block #123 | 区块；区块 #123 | 區塊；區塊 #123 | |
| transaction | 交易 | 交易 | "send a transaction" → 发送交易 / 送出交易 |
| contract; smart contract; deployed | 合约；智能合约；已部署 | 合約；智慧合約；已部署 | |
| bytecode | 字节码 | 位元組碼 | |
| explorer; View on Blockscout | 区块浏览器；在 Blockscout 查看 | 區塊鏈瀏覽器；在 Blockscout 檢視 | |
| owner key; admin key | 所有者密钥；管理员密钥 | 擁有者金鑰；管理員金鑰 | |
| multisig; timelock | 多签；时间锁 | 多簽；時間鎖 | |
| audit; fork-tested | 审计；主网分叉测试 | 審計；主網分叉測試 | |
| buyback; burn | 回购；销毁 | 回購；銷毀 | |
| flywheel | 飞轮 | 飛輪 | |
| Season 1 (S1) | 第一季 (S1) | 第一季 (S1) | |
| roadmap; whitepaper | 路线图；白皮书 | 路線圖；白皮書 | |
| private path; shielded pool; shielded | 隐私通道；隐私池；隐私保护 | 隱私通道；隱私池；隱私保護 | |
| viewing key | 查看密钥 | 檢視金鑰 | |
| stealth address; commitment; solvency proof; custodian | 隐身地址；承诺；偿付能力证明；托管方 | 隱身地址；承諾；償付能力證明；託管方 | |
| AI agent | AI 智能体 | AI 代理 | |
| pauser · attestor (roles) | 暂停方 · 认证方 | 暫停方 · 認證方 | owner is 所有者 / 擁有者 (see "owner key") |
| revert / reverted (transaction) | 回滚；交易已回滚 | 回滾；交易已回滾 | never 回復 (reads as "restored" or "replied" in Taiwan) |
| hook (Uniswap v4 pool hook); hooked / no hook | hook；带 hook / 无 hook | hook；帶 hook / 無 hook | keep the Latin word, lowercase |
| tick spacing | tick 间距 | tick 間距 | |
| UI multiplier | UI 乘数 | UI 乘數 | `uiMultiplier` itself stays code |
| sequencer; SEQ DOWN | 排序器；排序器故障 | 排序器；排序器停擺 | |
| boost; boost partner | 加码；加码合作方 | 加碼；加碼合作夥伴 | never 助推 |

## 9. Desktop, apps and Start menu

These live in `locales/*/shell.json` under `appNames` (read them as `shell:appNames.<id>`).

| English | zh-CN | zh-TW |
|---|---|---|
| Fund Wallet | 钱包充值 | 錢包儲值 |
| Spare Balance | Spare 余额 | Spare 餘額 |
| Link Wallet | 绑定钱包 | 綁定錢包 |
| Round-Up Rules | 凑整规则 | 湊整規則 |
| Stock Mix | 股票组合 | 股票組合 |
| Auto-Invest | 自动投资 | 自動投資 |
| Activity | 账户动态 | 帳戶動態 |
| Viewing Key | 查看密钥 | 檢視金鑰 |
| Stock Desk | 股票看盘 | 股票看盤 |
| After Hours | 盘后交易 | 盤後交易 |
| Portfolio X-Ray | 持仓透视 | 持股透視 |
| My Spare | 我的 Spare | 我的 Spare |
| About Spare | 关于 Spare | 關於 Spare |
| Task Manager | 任务管理器 | 工作管理員 |
| Recycle Bin | 回收站 | 資源回收筒 |
| Docs | 文档 | 說明文件 |
| Roadmap | 路线图 | 路線圖 |
| Start | 开始 | 開始 |
| Programs · Markets · Resources · System · Easter Eggs | 程序 · 市场 · 资源 · 系统 · 彩蛋 | 程式集 · 市場 · 資源 · 系統 · 彩蛋 |
| Web · More pages · Fewer pages | 网页 · 更多页面 · 收起 | 網頁 · 更多頁面 · 收合 |
| Shut Down… | 关机… | 關機… |
| File · Edit · View · Tools · Help (menu bar) | 文件 · 编辑 · 查看 · 工具 · 帮助 | 檔案 · 編輯 · 檢視 · 工具 · 說明 |
| Minimize · Maximize · Restore · Close | 最小化 · 最大化 · 还原 · 关闭 | 最小化 · 最大化 · 還原 · 關閉 |
| Zoom | 缩放 | 縮放 |
| Welcome to Spare | 欢迎来到 Spare | 歡迎來到 Spare |
| Opening Spare… / Enter Spare ▸ | 正在打开 Spare… / 进入 Spare ▸ | 正在開啟 Spare… / 進入 Spare ▸ |
| Recycle Bin is empty | 回收站为空 | 資源回收筒是空的 |
| Empty Recycle Bin · Restore All | 清空回收站 · 全部还原 | 清理資源回收筒 · 全部還原 |

## 10. Public pages

| English (tab / route label) | zh-CN | zh-TW |
|---|---|---|
| Docs | 文档 | 說明文件 |
| Universe / Stock Universe | 股票池 | 股票池 |
| Dispatch / Live Sweeps | 实时买入 | 即時買進 |
| Data Layer | 数据层 | 資料層 |
| DevTools | 开发者工具 | 開發人員工具 |
| MCP | MCP | MCP |
| Roadmap | 路线图 | 路線圖 |
| Whitepaper | 白皮书 | 白皮書 |
| Buyback | 回购 | 回購 |
| Flywheel | 飞轮 | 飛輪 |
| Privacy | 隐私政策 | 隱私權政策 |
| Terms | 使用条款 | 使用條款 |
| Risks | 风险 | 風險 |
| FAQ | 常见问题 | 常見問題 |

## 11. BIOS self-test

Row labels (left column):

| English | zh-CN | zh-TW |
|---|---|---|
| Spare · power-on self-test | Spare · 开机自检 | Spare · 開機自我檢測 |
| System | 系统 | 系統 |
| Chain | 链 | 鏈 |
| Contracts | 合约 | 合約 |
| Engine | 引擎 | 引擎 |
| Oracles | 预言机 | 預言機 |
| Universe | 股票池 | 股票池 |
| Park | 暂存 | 暫存 |
| Spare API | Spare API | Spare API |
| Keeper | 执行器 | 執行器 |

Bracket tags: `[OK]` stays `[OK]`; `[FAIL]` 失败 / 失敗; `[WAIT]` 等待; `[DEGRADED]` 降级 / 降級;
`[PAUSED]` 暂停 / 暫停; `[IDLE]` 空闲 / 閒置; `[STANDBY]` 待命. Header badge: CHECKING 检测中 /
檢測中; ATTENTION 注意; READY 就绪 / 就緒. Pending row text: `checking` → 检测中 / 檢測中.

Sample rows (style reference, interpolate the live values):

| English | zh-CN | zh-TW |
|---|---|---|
| Spare 1.0 · Season 1 · Robinhood Chain mainnet | Spare 1.0 · 第一季 · Robinhood Chain 主网 | Spare 1.0 · 第一季 · Robinhood Chain 主網 |
| Robinhood Chain · id 4663 · block #77,706,925 | Robinhood Chain · id 4663 · 区块 #77,706,925 | Robinhood Chain · id 4663 · 區塊 #77,706,925 |
| [OK] Spare deployed · SweepExecutor 0x908F…47Ab | [OK] Spare 已部署 · SweepExecutor 0x908F…47Ab | [OK] Spare 已部署 · SweepExecutor 0x908F…47Ab |
| [OK] running · fee 0.25% · sweep at $5.00 | [OK] 运行中 · 手续费 0.25% · 满 $5.00 买入 | [OK] 運作中 · 手續費 0.25% · 滿 $5.00 買進 |
| [OK] 4/4 stock feeds live · SPY NVDA AAPL TSLA | [OK] 4/4 股票价格源正常 · SPY NVDA AAPL TSLA | [OK] 4/4 股票價格來源正常 · SPY NVDA AAPL TSLA |
| [WAIT] market closed · last close 3h ago — sweeps wait | [等待] 休市 · 上次收盘 3 小时前，买入暂缓 | [等待] 休市 · 上次收盤 3 小時前，買進暫緩 |
| 4 active · 2 standby (QQQ, SGOV) | 4 只启用 · 2 只待命 (QQQ, SGOV) | 4 檔啟用 · 2 檔待命 (QQQ, SGOV) |
| USDG · exit always open | USDG · 随时可退出 | USDG · 隨時可退出 |
| [DEGRADED] offline — on-chain app still works | [降级] 离线，链上功能仍可用 | [降級] 離線，鏈上功能仍可使用 |
| [OK] online · Spare MCP 7 tools | [OK] 在线 · Spare MCP 7 个工具 | [OK] 線上 · Spare MCP 7 個工具 |
| [OK] last round-up 1h 24m ago · last sweep none yet | [OK] 上次凑整 1 小时 24 分前 · 尚无买入 | [OK] 上次湊整 1 小時 24 分前 · 尚無買進 |
| skipped — RPC unreachable | 已跳过：RPC 无法连接 | 已略過：RPC 無法連線 |
| [ PRESS ENTER ] / [ TAP TO ENTER ] | [ 按 ENTER 进入 ] / [ 点按进入 ] | [ 按 ENTER 進入 ] / [ 輕觸進入 ] |

## 12. Status words and common UI

These live in `shell.json` under `common` (read them as `shell:common.<key>`).

| English | zh-CN | zh-TW | Notes |
|---|---|---|---|
| OK | OK | OK | |
| LIVE (engine/system running) | 运行中 | 運作中 | `common.live` |
| LIVE (real-time data, ticker) | 实时 | 即時 | `common.liveData` |
| SOON | 即将推出 | 即將推出 | `$SPARE · SOON` |
| ONLINE / OFFLINE | 在线 / 离线 | 線上 / 離線 | |
| STANDBY | 待命 | 待命 | |
| READY | 就绪 | 就緒 | |
| PAUSED / ON / OFF | 已暂停 / 已开启 / 已关闭 | 已暫停 / 已開啟 / 已關閉 | |
| EXAMPLE | 示例 | 範例 | |
| READING… / Loading… | 读取中… / 加载中… | 讀取中… / 載入中… | |
| NOT BUILT | 尚未开发 | 尚未開發 | |
| not live yet | 尚未上线 | 尚未上線 | |
| Save · Cancel · Confirm · Close | 保存 · 取消 · 确认 · 关闭 | 儲存 · 取消 · 確認 · 關閉 | |
| Submit · Discard · Add · Remove · Edit | 提交 · 放弃 · 添加 · 移除 · 编辑 | 送出 · 捨棄 · 新增 · 移除 · 編輯 | |
| Revert edits | 撤销修改 | 復原變更 | |
| Try again / Retry · Refresh | 重试 · 刷新 | 重試 · 重新整理 | |
| Copy · Copied | 复制 · 已复制 | 複製 · 已複製 | |
| Settings | 设置 | 設定 | |
| Learn more · Open ↗ | 了解更多 · 打开 ↗ | 了解更多 · 開啟 ↗ | |
| All | 全部 | 全部 | |
| Wallet · Hide wallets (connect gate) | 钱包 · 收起钱包列表 | 錢包 · 收合錢包清單 | `common.wallet`, `common.hideWallets` |
| or use the wallet pill in the system tray. | 或使用系统托盘里的钱包按钮。 | 或使用系統匣中的錢包按鈕。 | `common.walletPillHint`; system tray = 系统托盘 / 系統匣 |
| Address (browser address bar) | 地址 | 網址 | |

Activity event labels (`SpareActivityApp`; keep the event name itself in tooltips/code):

| Event | zh-CN | zh-TW |
|---|---|---|
| Accrued · AccrualSkipped | 已计入 · 未计入 | 已計入 · 未計入 |
| Credited (into the park) | 已存入暂存区 | 已存入暫存區 |
| AccountSwept | 已买入 | 已買進 |
| Delivered · DeliveryHeld | 已到账 · 待领取 | 已入帳 · 待領取 |
| Deferred · SafeSettled | 已顺延 · 已安全结算 | 已順延 · 已安全結算 |
| WithdrawnForSweep · Returned | 转出买入 · 已退回 | 轉出買進 · 已退回 |
| Claimed · Exited · ExitUnitsKept | 已领取 · 已退出 · 以份额退出 | 已領取 · 已退出 · 以份額退出 |
| Linked · Unlinked | 已绑定 · 已解绑 | 已綁定 · 已解除綁定 |
| Round-ups · Sweeps · Claims & exits | 凑整 · 买入 · 领取与退出 | 湊整 · 買進 · 領取與退出 |

Legal notice for Chinese legal pages (`pages-a:legal.englishGoverns`, shown only when the page
is not in English):

- zh-CN: 本页中文译文仅供参考。如中文译文与英文版本有任何不一致，以英文版本为准。
- zh-TW: 本頁中文譯文僅供參考。中文譯文與英文版本如有任何歧異，以英文版本為準。

## 13. Taiwan vocabulary traps

zh-TW must use the right-hand column. A character converter gets every one of these wrong.

| zh-CN | zh-TW | | zh-CN | zh-TW |
|---|---|---|---|---|
| 网络 | 網路 | | 默认 | 預設 |
| 账户 / 账号 | 帳戶 / 帳號 | | 设置 | 設定 |
| 信息 / 消息 | 資訊 / 訊息 | | 数据 | 資料 |
| 软件 / 硬件 | 軟體 / 硬體 | | 程序 (app) | 程式 |
| 文件 (file) | 檔案 | | 文档 (docs) | 文件 / 說明文件 |
| 服务器 | 伺服器 | | 用户 | 使用者 |
| 支持 | 支援 | | 视频 | 影片 |
| 菜单 | 選單 | | 窗口 | 視窗 |
| 屏幕 | 螢幕 | | 鼠标 | 滑鼠 |
| 点击 | 點選 / 按一下 | | 打开 | 開啟 |
| 登录 / 注销 | 登入 / 登出 | | 保存 | 儲存 |
| 加载 | 載入 | | 复制 / 粘贴 | 複製 / 貼上 |
| 添加 | 新增 | | 提交 | 送出 |
| 搜索 | 搜尋 | | 刷新 | 重新整理 |
| 智能 | 智慧 | | 二维码 | QR Code |
| 实时 | 即時 | | 运行 | 運作 |
| 充值 | 儲值 | | 提现 | 提領 / 出金 |
| 滑点 | 滑價 | | 买入 | 買進 |
| 质量 | 品質 | | 项目 | 專案 / 項目 |
| 社区 | 社群 | | 插件 / 扩展 | 外掛 / 擴充功能 |
| 身份 | 身分 | | 国债 | 公債 |
| 密钥 | 金鑰 | | 签名 (signature) | 簽章 |
| 只 (stocks) | 檔 | | 周 | 週 |
