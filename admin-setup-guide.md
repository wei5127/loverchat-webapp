# 管理後台完整設定與使用指南

## 📋 已建立的所有檔案

### Admin 前端頁面 (`public/admin/`)
| 檔案 | 說明 |
|------|------|
| `login.html` | 管理員登入頁（Google OAuth） |
| `dashboard.html` | 儀表板（統計總覽） |
| `users.html` | 會員管理列表 |
| `user-detail.html` | 單一會員詳細資料頁 |
| `payments.html` | 付款記錄 |
| `analytics.html` | 流量分析 |
| `audit-logs.html` | 操作日誌 |
| `settings.html` | 系統設定（僅 super_admin） |
| `css/admin.css` | 統一後台樣式 |
| `js/admin-auth.js` | 認證 module |
| `js/admin-shared.js` | 共享 sidebar injector |

### Cloud Functions (`functions/`)
| 檔案 | 說明 |
|------|------|
| `admin-api.js` | 所有 Admin API 函數 |
| `init-firestore.js` | 資料庫 Migration |
| `index.js` | 主函數（含更新過的 stripeWebhook） |

### 其他
| 檔案 | 說明 |
|------|------|
| `firestore.rules` | Firestore 安全規則（已更新） |
| `admin-setup-guide.md` | 本檔案 |

---

##🚀 第一次設定（完整步驟）

### Step 1: 確認 Firebase Service Account Key

```bash
cd ~/Desktop/chatbot-webapp/functions
# 如果還沒有 service account key，下載：
# Firebase Console > Project Settings > Service Accounts > Generate new private key
# 將檔案命名為 service-account-key.json 放在 functions/ 目錄下
```

### Step 2: 執行 Firestore Migration

```bash
cd ~/Desktop/chatbot-webapp/functions
node init-firestore.js
```

**這個指令會：**
1. 🔑 產生超級管理員備用密碼（**只顯示一次，請立刻複製！**）
2. 👤 在 Firebase Auth 中建立 super_admin 帳號
3. 📝 在 Firestore 建立超級管理員資料（role: super_admin）
4. 🔄 為所有現有用戶新增 role / disabled 欄位
5. 📊/📋/📈/💳/📦/⚙️ 建立所有新集合結構

**預期輸出：**
```
╔════════════════════════════════════════════╗
║人生練習場 - Firestore 初始化 Migration ║
╚════════════════════════════════════════════╝

🔑 產生超級管理員備用密碼...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  重要：以下密碼只會顯示這一次！
 請立即複製並妥善保管！
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   超級管理員 Email: wei512712@gmail.com
   備用密碼: XxYz1234!@#$%^&*....
```

### Step 3: 部署 Cloud Functions

```bash
cd ~/Desktop/chatbot-webapp
firebase deploy --only functions
```

**部署的函數：**
- `adminCheckAuth` - 驗證 admin 權限（含 auto-binding）
- `adminGetDashboardStats` - 儀表板統計
- `adminGetUsers` - 會員列表
- `adminGetUser` - 會員詳細
- `adminUpdateUser` - 更新會員資料
- `adminToggleUserStatus` - 停權/啟用
- `adminGetPayments` - 付款記錄
- `adminGetAnalytics` - 流量分析
- `adminGetAuditLogs` - 操作日誌
- `adminGetSettings` - 取得設定
- `adminUpdateSettings` - 更新設定
- `adminStripeWebhook` - Stripe Webhook（增強版）
- `onUserCreated` - 新用戶觸發器（自動設定 super_admin）

### Step 4: 部署 Firestore Rules

```bash
cd ~/Desktop/chatbot-webapp
firebase deploy --only firestore
```

### Step 5: 部署 Hosting

```bash
cd ~/Desktop/chatbot-webapp
firebase deploy --only hosting
```

### Step 6: 測試登入

1. 前往 `https://life-practice.com/admin/login.html`
2. 點擊「以 Google 帳號登入」
3. 使用 `wei512712@gmail.com` Google 帳號登入
4. 應該直接進入儀表板，顯示「⭐ 超級管理員」

---

## 🔐 超級管理員帳號

| 欄位 | 值 |
|------|-----|
| Email | `wei512712@gmail.com` |
| UID | `super_admin_' + base64(email)[:16]` |
| Role | `super_admin` |
| Plan | `vip_pro_lifetime` |
| 登入方式 | **Google OAuth**（主要）|
| 備用密碼 | 由 `init-firestore.js` 產生，**只顯示一次** |

**重要：**
- Google OAuth 登入時，系統會自動檢查 email，自動綁定 super_admin 權限
- 備用密碼用於 Firebase Console 緊急登入或 email/password 備援

---

## 👥 角色權限架構

| 角色 | 權限 |
|------|------|
| `user` | 一般會員，**無法**進入後台 |
| `admin` | 管理員，可看統計、會員、付款、操作紀錄 |
| `super_admin` | 超級管理員，擁有全部權限，包含系統設定 |

---

## 📊 後台功能總覽

###儀表板 (`/admin/dashboard.html`)
- 總會員數 / 今日新會員 / 本月新會員
- 今日收入 / 本月收入 / 累積收入
- 成功付款數 / 失敗付款數
- 方案分布圖
- 最近操作紀錄

### 會員管理 (`/admin/users.html`)
- 會員列表（可搜尋、篩選方案/角色/狀態）
- 分頁顯示（每頁 20 筆）
- 快速停權/啟用
- 連結到會員詳細頁

### 會員詳細 (`/admin/user-detail.html?uid=xxx`)
- 基本資料編輯（方案、角色、每日限制等）
- 訂閱資訊檢視
- 付款記錄
-對此會員的操作紀錄

### 付款記錄 (`/admin/payments.html`)
- 所有付款明細
- 可依狀態/方案/日期篩選
- Stripe 交易 ID連結

### 流量分析 (`/admin/analytics.html`)
- 訪客數、瀏覽量、登入次數
- 事件類型分布
- 熱門頁面

### 操作日誌 (`/admin/audit-logs.html`)
- 所有管理員操作紀錄
- 可依動作類型/目標類型篩選
- 記錄舊值→新值

### 系統設定 (`/admin/settings.html`) - 僅 super_admin
- 功能開關（註冊、Google登入、維護模式）
- API 設定狀態顯示
- 危險操作（重置 guest 帳號等）

---

## 🗄️ 資料庫 Collections

| Collection | 說明 |
|------------|------|
| `users/{uid}` | 會員資料（含 role, plan, disabled 等新欄位）|
| `payments/{paymentId}` | Stripe 付款記錄 |
| `subscriptions/{subId}` | Stripe 訂閱記錄 |
| `audit_logs/{logId}` | 管理員操作紀錄 |
| `analytics_events/{eventId}` | 流量事件 |
| `usage_logs/{logId}` | 每日用量記錄 |
| `settings/system` | 系統設定 |

---

## ⚠️ Stripe Webhook 注意事項

**部署後必須更新 Stripe Webhook URL：**

1. 前往 [Stripe Dashboard](https://dashboard.stripe.com/webhooks)
2. 找到現有的 webhook endpoint
3. 將 URL 改為：
   ```
   https://us-central1-loverchat-88cb3.cloudfunctions.net/adminStripeWebhook
   ```
4. 確保 webhook 事件包含：`checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`

---

## 🔧 常見問題

### Q: 出現 "permission-denied"
A: 執行 `firebase deploy --only firestore` 確認規則已部署

### Q: Google登入無反應
A: 確認 Firebase Console > Authentication > Sign-in method > Google 已啟用

### Q: 非 super_admin 帳號無法進入
A: 這是正確的！只有 `user` 和 `admin` 可以進入後台，`user` 無法進入

### Q: 想修改會員方案
A: 在會員詳細頁，選擇方案後儲存。Audit log 會記錄所有變更

### Q: 想停用某個會員
A: 在會員列表點擊「🚫 停權」按鈕，該會員將無法登入

---

## 📁 程式碼変更摘要

### 新增
- `public/admin/*` - 所有後台頁面
- `functions/admin-api.js` - Admin Cloud Functions
- `functions/init-firestore.js` - Migration Script
- `firestore.rules` - 新增 admin 集合規則

### 修改
- `functions/index.js` - 新增 admin-api require
- `firestore.rules` - 新增 `isAdmin()`/`isSuperAdmin()`，調整 users 規則

### 不受影響
- `index.html` - 主網站聊天功能
- `account.html` / `dashboard.html` -會員中心
- `pricing.html` / `vip.html` - 方案頁面
- Stripe webhook 逻辑（已整合到 admin-api.js）