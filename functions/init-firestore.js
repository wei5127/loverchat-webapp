/**
 * Firestore 初始化 Migration Script
 * 用來建立新資料庫結構、超級管理員、以及更新現有用戶資料
 * 
 * 使用方式：node init-firestore.js
 * 需要 Firebase Admin SDK service account key
 * 
 * 注意：此 script會產生密碼並只顯示一次，請妥善保管！
 */
const admin = require('firebase-admin');
const crypto = require('crypto');

// ====== 設定 ======
const SUPER_ADMIN_EMAIL = 'wei512712@gmail.com';
const SUPER_ADMIN_UID = 'super_admin_' + Buffer.from(SUPER_ADMIN_EMAIL).to('base64').slice(0, 16);
const PROJECT_ID = 'loverchat-88cb3';

// 初始化 Firebase Admin
const serviceAccount = require('./service-account-key.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: PROJECT_ID
});

const db = admin.firestore();
const auth = admin.auth();

//產生高強度密碼
function generateStrongPassword(length = 24) {
  const uppercase = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lowercase = 'abcdefghjkmnpqrstuvwxyz';
  const numbers = '23456789';
  const symbols = '!@#$%&*';
  const allChars = uppercase + lowercase + numbers + symbols;
  
  const randomBytes = crypto.randomBytes(length);
  let password = '';
  
  // 確保每種字元都至少有一個
  password += uppercase[randomBytes[0] % uppercase.length];
  password += lowercase[randomBytes[1] % lowercase.length];
  password += numbers[randomBytes[2] % numbers.length];
  password += symbols[randomBytes[3] % symbols.length];
  
  // 剩餘字元隨機填充
  for (let i = 4; i < length; i++) {
    password += allChars[randomBytes[i] % allChars.length];
  }
  
  // 打亂順序
  return password.split('').sort(() => randomBytes[length + i] - randomBytes[i]).join('');
}

async function initFirestore() {
  console.log('╔════════════════════════════════════════════╗');
  console.log('║人生練習場 - Firestore 初始化 Migration ║');
 console.log('╚════════════════════════════════════════════╝\n');
  console.log('🚀 開始初始化...\n');

  // 1. 產生超級管理員密碼（只顯示一次！）
  console.log('🔑產生超級管理員備用密碼...');
  const superAdminPassword = generateStrongPassword(20);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('⚠️  重要：以下密碼只會顯示這一次！');
  console.log(' 請立即複製並妥善保管！');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(`   超級管理員 Email: ${SUPER_ADMIN_EMAIL}`);
  console.log(`   備用密碼: ${superAdminPassword}`);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  
  // 2. 在 Firebase Auth 中建立超級管理員（使用 email/password）
  console.log('👤 在 Firebase Auth 中建立超級管理員帳號...');
  try {
    // 檢查是否已存在
    try {
      const existingUser = await auth.getUserByEmail(SUPER_ADMIN_EMAIL);
      console.log(`帳號已存在，UID: ${existingUser.uid}`);
      
      // 更新超級管理員的自訂宣告
      await auth.setCustomUserClaims(existingUser.uid, {
        role: 'super_admin',
        isSuperAdmin: true
      });
      console.log('   ✅ 已更新自訂宣告 (custom claims)');
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        // 建立新帳號
        const userRecord = await auth.createUser({
          email: SUPER_ADMIN_EMAIL,
          emailVerified: true,
          password: superAdminPassword,
          displayName: 'Super Admin',
          disabled: false
        });
        console.log(`   ✅ Auth 帳號建立成功，UID: ${userRecord.uid}`);
        
        //設定自訂宣告
        await auth.setCustomUserClaims(userRecord.uid, {
          role: 'super_admin',
          isSuperAdmin: true
        });
        console.log('   ✅ 已設定自訂宣告 (custom claims)');
      } else {
        throw e;
      }
    }
  } catch (e) {
    console.log(`   ⚠️ Auth 操作失敗: ${e.message}`);
    console.log('  請手動在 Firebase Console > Authentication 建立帳號');
  }
  console.log('');

  // 3. 建立超級管理員 Firestore 資料
  console.log('📝 建立超級管理員 Firestore 資料...');
  const superAdminData = {
    uid: SUPER_ADMIN_UID,
    email: SUPER_ADMIN_EMAIL,
    role: 'super_admin',
    plan: 'vip_pro_lifetime',
    dailyLimit: -1,
    messagesUsedToday: 0,
    lastMessageDate: null,
    subscriptionStatus: 'active',
    stripeCustomerId: null,
    subscriptionId: null,
    disabled: false,
    lastActive: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    isSuperAdmin: true,
    adminNote: 'System super admin - auto created by init-firestore.js'
  };

  await db.collection('users').doc(SUPER_ADMIN_UID).set(superAdminData, { merge: true });
  console.log(`✅ 超級管理員資料建立完成 (UID: ${SUPER_ADMIN_UID})`);
  console.log('');

  // 4. 更新現有用戶：新增 role 和 disabled 欄位
  console.log('🔄 更新現有用戶資料（新增 role / disabled 欄位）...');
  const usersSnapshot = await db.collection('users').get();
  let updatedCount = 0;
  
  for (const userDoc of usersSnapshot.docs) {
    const data = userDoc.data();
    if (data.role === undefined || data.disabled === undefined) {
      await userDoc.ref.update({
        role: data.role || (data.plan?.startsWith('vip_') ? 'user' : 'user'),
        disabled: data.disabled !== undefined ? data.disabled : false,
        lastActive: data.lastActive || admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      updatedCount++;
    }
  }
  console.log(`✅ 更新了 ${updatedCount} 個現有用戶資料`);
  console.log('');

  // 5. 建立 analytics_events 集合結構
  console.log('📊 建立 analytics_events 集合結構...');
  await db.collection('_init').doc('analytics_schema').set({
    type: 'analytics_events',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  console.log('✅ analytics_events 集合結構建立完成\n');

  // 6. 建立 audit_logs 集合結構
  console.log('📋 建立 audit_logs 集合結構...');
  await db.collection('_init').doc('audit_schema').set({
    type: 'audit_logs',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  console.log('✅ audit_logs 集合結構建立完成\n');

  // 7. 建立 usage_logs 集合結構（用於記錄每日用量）
  console.log('📈 建立 usage_logs 集合結構...');
  await db.collection('_init').doc('usage_logs_schema').set({
    type: 'usage_logs',
    schema: {
      logId: 'string',
      userId: 'string',
      date: 'string (YYYY-MM-DD)',
      messagesUsed: 'number',
      messagesLimit: 'number',
      plan: 'string',
      createdAt: 'timestamp'
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  console.log('✅ usage_logs 集合結構建立完成\n');

  // 8. 建立 payments 集合示範結構
 console.log('💳 建立 payments 集合結構...');
  await db.collection('_init').doc('payments_schema').set({
    type: 'payments',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  console.log('✅ payments 集合結構建立完成\n');

  // 9. 建立 subscriptions 集合示範結構
  console.log('📦 建立 subscriptions 集合結構...');
  await db.collection('_init').doc('subscriptions_schema').set({
    type: 'subscriptions',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  console.log('✅ subscriptions 集合結構建立完成\n');

  // 10. 建立 settings 集合
  console.log('⚙️ 建立 settings 集合...');
  await db.collection('settings').doc('system').set({
    featureFlags: {
      registrationEnabled: true,
      googleLoginEnabled: true,
      maintenanceMode: false
    },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  console.log('✅ settings 集合建立完成\n');

  console.log('╔════════════════════════════════════════════╗');
  console.log('║ ✅ Firestore 初始化完成！             ║');
 console.log('╚════════════════════════════════════════════╝');
  console.log('');
  console.log('📌 超級管理員登入資訊：');
  console.log(`   Email: ${SUPER_ADMIN_EMAIL}`);
  console.log(`   備用密碼: ${superAdminPassword}`);
  console.log('');
  console.log('📌 建議後續操作：');
  console.log('   1. 前往 Firebase Console > Authentication > Users');
  console.log('      確認 super_admin 帳號已建立且 role為 super_admin');
  console.log('   2. 設定 Google OAuth（如果還沒有）');
  console.log('   3. 部署 Cloud Functions: firebase deploy --only functions');
  console.log('   4. 部署 Firestore Rules: firebase deploy --only firestore');
  console.log('   5. 部署 Hosting: firebase deploy --only hosting');
  console.log('   6. 前往 /admin/login.html 測試登入');
  console.log('');
  console.log('🔑 Google OAuth 設定說明：');
  console.log('   如果要使用 Google 登入，請在 Google Cloud Console 建立 OAuth Client ID，');
  console.log('   然後在 Firebase Console > Authentication > Sign-in method 啟用 Google。');
  console.log('   super_admin (wei512712@gmail.com) 登入後會自動擁有超級管理員權限。');
  console.log('');
}

initFirestore().catch(e => {
  console.error('❌ 初始化失敗:', e);
  process.exit(1);
});