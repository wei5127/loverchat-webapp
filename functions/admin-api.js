/**
 * Admin API Cloud Functions
 * 包含：登入驗證、儀表板統計、用戶管理、訂閱管理、Audit Logs、Analytics
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');

// 如果尚未初始化再初始化（避免重複初始化錯誤）
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// ============ HELPER FUNCTIONS ============

/**
 * 驗證 ID token 並取得用戶角色
 */
async function verifyAdmin(request) {
  const idToken = request.headers.authorization?.split('Bearer ')[1];
  if (!idToken) {
    throw new functions.https.HttpsError('unauthenticated', '未提供認證 token');
  }
  
  let decodedToken;
  try {
    decodedToken = await admin.auth().verifyIdToken(idToken);
  } catch (e) {
    throw new functions.https.HttpsError('unauthenticated', 'Token 無效或已過期');
  }
  
  const uid = decodedToken.uid;
  const userDoc = await db.collection('users').doc(uid).get();
  const userData = userDoc.data() || {};
  
  const role = userData.role || 'user';
  if (role !== 'admin' && role !== 'super_admin') {
    throw new functions.https.HttpsError('permission-denied', '需要 admin 權限');
  }
  
  return { uid, email: decodedToken.email, role, userData };
}

/**
 * 驗證 super_admin 權限
 */
async function verifySuperAdmin(request) {
  const { uid, email, role } = await verifyAdmin(request);
  if (role !== 'super_admin') {
    throw new functions.https.HttpsError('permission-denied', '需要 super_admin 權限');
  }
  return { uid, email, role };
}

/**
 * 寫入 Audit Log
 */
async function writeAuditLog(action, targetType, targetId, adminId, adminEmail, oldValue, newValue, context) {
  const logRef = db.collection('audit_logs').doc();
  await logRef.set({
    logId: logRef.id,
    action,
    targetType,
    targetId,
    adminId,
    adminEmail,
    oldValue: oldValue || null,
    newValue: newValue || null,
    ip: context?.ip || null,
    userAgent: context?.userAgent || null,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
}

// ============ PLAN DEFINITIONS (shared with main app) ============
const PLANS = {
  guest: { dailyLimit: 30, canCreateCharacter: false, canSaveChat: false, maxPrivateChars: 0, name: 'Guest', color: '#9CA3AF' },
  free: { dailyLimit: 30, canCreateCharacter: true, canSaveChat: true, maxPrivateChars: 3, name: 'Free', color: '#10B981' },
  vip_trial: { dailyLimit: -1, canCreateCharacter: true, canSaveChat: true, maxPrivateChars: 10, name: 'VIP Trial', color: '#6B7280' },
  vip_basic_monthly: { dailyLimit: -1, canCreateCharacter: true, canSaveChat: true, maxPrivateChars: 10, name: 'VIP Basic', color: '#3B82F6' },
  vip_basic_lifetime: { dailyLimit: -1, canCreateCharacter: true, canSaveChat: true, maxPrivateChars: -1, name: 'VIP Basic 終身', color: '#6366F1' },
  vip_pro_monthly: { dailyLimit: -1, canCreateCharacter: true, canSaveChat: true, maxPrivateChars: -1, name: 'VIP Pro', color: '#F59E0B' },
  vip_pro_lifetime: { dailyLimit: -1, canCreateCharacter: true, canSaveChat: true, maxPrivateChars: -1, name: 'VIP Pro 終身', color: '#8B5CF6' }
};

const VALID_ROLES = ['user', 'admin', 'super_admin'];
const VALID_PLANS = Object.keys(PLANS);

// ============ ADMIN AUTH ============

/**
 * 確認 admin 登入狀態
 * POST /admin/checkAuth
 */
exports.adminCheckAuth = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    return { authenticated: false, role: null };
  }
  
  const uid = context.auth.uid;
  const email = context.auth.token?.email || null;
  
  // 自動將 wei512712@gmail.com 綁定為 super_admin
  const SUPER_ADMIN_EMAIL = 'wei512712@gmail.com';
  
  const userDoc = await db.collection('users').doc(uid).get();
  const userData = userDoc.data() || {};
  
  // 如果是 super_admin email 但還沒有 role，立刻更新
  if (email === SUPER_ADMIN_EMAIL && userData.role !== 'super_admin') {
    await db.collection('users').doc(uid).set({
      uid,
      email,
      role: 'super_admin',
      isSuperAdmin: true,
      plan: 'vip_pro_lifetime',
      dailyLimit: -1,
      subscriptionStatus: 'active',
      disabled: false,
      lastActive: admin.firestore.FieldValue.serverTimestamp(),
      createdAt: userData.createdAt || admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return {
      authenticated: true,
      uid,
      email,
      role: 'super_admin',
      displayName: context.auth.token?.name || null,
      picture: context.auth.token?.picture || null,
      isAdmin: true,
      isSuperAdmin: true
    };
  }
  
  const role = userData.role || 'user';
  
  // 更新 lastActive
  await userDoc.ref.update({ lastActive: admin.firestore.FieldValue.serverTimestamp() }).catch(() => {});
  
  return {
    authenticated: true,
    uid,
    email,
    role,
    displayName: context.auth.token?.name || null,
    picture: context.auth.token?.picture || null,
    isAdmin: role === 'admin' || role === 'super_admin',
    isSuperAdmin: role === 'super_admin'
  };
});

// ============ ADMIN DASHBOARD ============

/**
 * 取得儀表板統計
 * POST /admin/getDashboardStats
 */
exports.adminGetDashboardStats = functions.https.onCall(async (data, context) => {
  const { uid: adminUid, email: adminEmail, role: adminRole } = await verifyAdmin(context.rawRequest);
  
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  
  // 平行取得多個統計
  const [
    totalUsersSnap,
    todayNewUsersSnap,
    monthNewUsersSnap,
    totalPaymentsSnap,
    todayPaymentsSnap,
    monthPaymentsSnap,
    failedPaymentsSnap,
    recentErrorsSnap,
    webhooksSnap
  ] = await Promise.all([
    db.collection('users').count().get(),
    db.collection('users').where('createdAt', '>=', todayStart).count().get(),
    db.collection('users').where('createdAt', '>=', monthStart).count().get(),
    db.collection('payments').where('status', '==', 'succeeded').get(),
    db.collection('payments').where('status', '==', 'succeeded').where('createdAt', '>=', todayStart).get(),
    db.collection('payments').where('status', '==', 'succeeded').where('createdAt', '>=', monthStart).get(),
    db.collection('payments').where('status', '==', 'failed').count().get(),
    db.collection('audit_logs').orderBy('createdAt', 'desc').limit(20).get(),
    db.collection('audit_logs').where('action', '==', 'webhook_received').orderBy('createdAt', 'desc').limit(20).get()
  ]);
  
  // 計算收入
  const calcRevenue = (docs) => {
    let total = 0;
    docs.forEach(doc => {
      const d = doc.data();
      if (d.amount) total += d.amount;
    });
    return total;
  };
  
  const totalRevenue = calcRevenue(totalPaymentsSnap.docs);
  const todayRevenue = calcRevenue(todayPaymentsSnap.docs);
  const monthRevenue = calcRevenue(monthPaymentsSnap.docs);
  
  // 方案統計
  const planStats = {};
  for (const planId of VALID_PLANS) {
    const snap = await db.collection('users').where('plan', '==', planId).count().get();
    planStats[planId] = snap.data().count;
  }
  
  // 取得最後 5 筆 audit logs
  const recentAuditLogs = recentErrorsSnap.docs.slice(0, 5).map(doc => ({
    logId: doc.id,
    action: doc.data().action,
    targetType: doc.data().targetType,
    adminEmail: doc.data().adminEmail,
    createdAt: doc.data().createdAt?.toDate?.()?.toISOString()
  }));
  
  return {
    users: {
      total: totalUsersSnap.data().count,
      todayNew: todayNewUsersSnap.data().count,
      monthNew: monthNewUsersSnap.data().count
    },
    revenue: {
      total: totalRevenue,
      today: todayRevenue,
      month: monthRevenue,
      currency: 'CAD'
    },
    payments: {
      successCount: totalPaymentsSnap.size,
      failedCount: failedPaymentsSnap.data().count
    },
    planStats,
    recentAuditLogs,
    adminRole
  };
});

// ============ USER MANAGEMENT ============

/**
 * 取得用戶列表（分頁）
 * POST /admin/getUsers
 */
exports.adminGetUsers = functions.https.onCall(async (data, context) => {
  await verifyAdmin(context.rawRequest);
  
  const { page = 1, limit = 20, search = '', planFilter = '', roleFilter = '', statusFilter = '' } = data;
  const offset = (page - 1) * limit;
  
  let query = db.collection('users').orderBy('createdAt', 'desc');
  
  // 搜尋過濾
  if (search) {
    query = query.where('email', '>=', search).where('email', '<=', search + '\uf8ff');
  }
  
  const totalSnap = await query.count().get();
  const usersSnap = await query.limit(limit).offset(offset).get();
  
  const users = usersSnap.docs.map(doc => {
    const d = doc.data();
    return {
      uid: doc.id,
      email: d.email || null,
      role: d.role || 'user',
      plan: d.plan || 'guest',
      planName: PLANS[d.plan]?.name || d.plan,
      planColor: PLANS[d.plan]?.color || '#9CA3AF',
      dailyLimit: d.dailyLimit ?? 30,
      messagesUsedToday: d.messagesUsedToday || 0,
      subscriptionStatus: d.subscriptionStatus || null,
      stripeCustomerId: d.stripeCustomerId || null,
      subscriptionId: d.subscriptionId || null,
      disabled: d.disabled || false,
      isAnonymous: d.isAnonymous || !d.email,
      createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
      lastActive: d.lastActive?.toDate?.()?.toISOString() || null,
      lastMessageDate: d.lastMessageDate || null
    };
  });
  
  return {
    users,
    total: totalSnap.data().count,
    page,
    limit,
    hasMore: offset + users.length < totalSnap.data().count
  };
});

/**
 * 取得單一用戶詳細資料
 * POST /admin/getUser
 */
exports.adminGetUser = functions.https.onCall(async (data, context) => {
  await verifyAdmin(context.rawRequest);
  
  const { uid } = data;
  if (!uid) throw new functions.https.HttpsError('invalid-argument', 'uid is required');
  
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) {
    throw new functions.https.HttpsError('not-found', 'User not found');
  }
  const d = userDoc.data();
  
  // 取得該用戶的付款記錄
  const paymentsSnap = await db.collection('payments')
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  
  // 取得該用戶的 audit logs (targetId = uid)
  const logsSnap = await db.collection('audit_logs')
    .where('targetId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  
  // 計算自訂角色數量
  let privateCharCount = 0;
  if (d.plan && PLANS[d.plan]?.maxPrivateChars !== 0) {
    try {
      const charsSnap = await db.collection('characters')
        .where('userId', '==', uid)
        .where('isPublic', '==', false)
        .count().get();
      privateCharCount = charsSnap.data().count || 0;
    } catch (e) { /* ignore if no index */ }
  }
  
  return {
    uid: userDoc.id,
    email: d.email || null,
    displayName: d.displayName || d.email?.split('@')[0] || null,
    role: d.role || 'user',
    plan: d.plan || 'guest',
    planName: PLANS[d.plan]?.name || d.plan,
    planColor: PLANS[d.plan]?.color || '#9CA3AF',
    dailyLimit: d.dailyLimit ?? 30,
    messagesUsedToday: d.messagesUsedToday || 0,
    messagesTotal: d.messagesTotal || 0,
    subscriptionStatus: d.subscriptionStatus || null,
    stripeCustomerId: d.stripeCustomerId || null,
    subscriptionId: d.subscriptionId || null,
    disabled: d.disabled || false,
    isAnonymous: d.isAnonymous || !d.email,
    createdAt: d.createdAt?.toDate?.()?.toISOString() || null,
    lastActive: d.lastActive?.toDate?.()?.toISOString() || null,
    lastMessageDate: d.lastMessageDate || null,
    canCreateCharacter: PLANS[d.plan]?.canCreateCharacter || false,
    maxPrivateChars: PLANS[d.plan]?.maxPrivateChars ?? 0,
    canSaveChat: PLANS[d.plan]?.canSaveChat || false,
    updatedAt: d.updatedAt?.toDate?.()?.toISOString() || null,
    payments: paymentsSnap.docs.map(doc => ({
      paymentId: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString()
    })),
    userAuditLogs: logsSnap.docs.map(doc => ({
      logId: doc.id,
      action: doc.data().action,
      targetType: doc.data().targetType,
      adminEmail: doc.data().adminEmail,
      oldValue: doc.data().oldValue,
      newValue: doc.data().newValue,
      createdAt: doc.data().createdAt?.toDate?.()?.toISOString()
    }))
  };
});

/**
 * 更新用戶資料（plan、role、disabled）
 * POST /admin/updateUser
 */
exports.adminUpdateUser = functions.https.onCall(async (data, context) => {
  const { uid: adminUid, email: adminEmail, role: adminRole } = await verifyAdmin(context.rawRequest);
  
  const { uid, updates } = data;
  if (!uid) throw new functions.https.HttpsError('invalid-argument', 'uid is required');
  
  // super_admin 才能修改 super_admin 或其他 admin
  const targetDoc = await db.collection('users').doc(uid).get();
  const targetData = targetDoc.data() || {};
  
  if (targetData.role === 'super_admin' && adminRole !== 'super_admin') {
    throw new functions.https.HttpsError('permission-denied', '無法修改 super_admin 的資料');
  }
  
  // 過濾允許更新的欄位
  const allowedUpdates = {};
  const oldValues = {};
  
  if (updates.plan !== undefined) {
    if (!VALID_PLANS.includes(updates.plan)) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid plan: ' + updates.plan);
    }
    oldValues.plan = targetData.plan;
    allowedUpdates.plan = updates.plan;
    allowedUpdates.dailyLimit = PLANS[updates.plan].dailyLimit;
    allowedUpdates.subscriptionStatus = updates.plan.startsWith('vip_') ? 'active' : 'none';
  }
  
  if (updates.role !== undefined) {
    if (!VALID_ROLES.includes(updates.role)) {
      throw new functions.https.HttpsError('invalid-argument', 'Invalid role: ' + updates.role);
    }
    // 只有 super_admin 能設定 role
    if (adminRole !== 'super_admin') {
      throw new functions.https.HttpsError('permission-denied', '只有 super_admin 能修改角色');
    }
    oldValues.role = targetData.role;
    allowedUpdates.role = updates.role;
  }
  
  if (updates.disabled !== undefined) {
    oldValues.disabled = targetData.disabled;
    allowedUpdates.disabled = !!updates.disabled;
  }
  
  if (updates.dailyLimit !== undefined) {
    oldValues.dailyLimit = targetData.dailyLimit;
    allowedUpdates.dailyLimit = parseInt(updates.dailyLimit, 10);
  }
  
  if (updates.canCreateCharacter !== undefined) {
    oldValues.canCreateCharacter = targetData.canCreateCharacter;
    allowedUpdates.canCreateCharacter = !!updates.canCreateCharacter;
  }
  
  if (updates.maxPrivateChars !== undefined) {
    oldValues.maxPrivateChars = targetData.maxPrivateChars;
    allowedUpdates.maxPrivateChars = parseInt(updates.maxPrivateChars, 10);
  }
  
  allowedUpdates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  
  await targetDoc.ref.update(allowedUpdates);
  
  // 寫入 audit log
  await writeAuditLog(
    'user_update',
    'user',
    uid,
    adminUid,
    adminEmail,
    oldValues,
    allowedUpdates,
    { ip: context.rawRequest.ip, userAgent: context.rawRequest.headers['user-agent'] }
  );
  
  return { success: true, updatedFields: Object.keys(allowedUpdates) };
});

/**
 * 啟用/停用帳號
 * POST /admin/toggleUserStatus
 */
exports.adminToggleUserStatus = functions.https.onCall(async (data, context) => {
  const { uid: adminUid, email: adminEmail, role: adminRole } = await verifyAdmin(context.rawRequest);
  
  const { targetUid, disabled } = data;
  if (!targetUid) throw new functions.https.HttpsError('invalid-argument', 'targetUid is required');
  
  const targetDoc = await db.collection('users').doc(targetUid);
  const targetData = (await targetDoc.get()).data() || {};
  
  if (targetData.role === 'super_admin') {
    throw new functions.https.HttpsError('permission-denied', '無法停用 super_admin');
  }
  
  await targetDoc.update({
    disabled: !!disabled,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  
  await writeAuditLog(
    disabled ? 'user_disabled' : 'user_enabled',
    'user',
    targetUid,
    adminUid,
    adminEmail,
    { disabled: !disabled },
    { disabled },
    { ip: context.rawRequest.ip, userAgent: context.rawRequest.headers['user-agent'] }
  );
  
  return { success: true, disabled };
});

// ============ PAYMENTS ============

/**
 * 取得付款記錄列表
 * POST /admin/getPayments
 */
exports.adminGetPayments = functions.https.onCall(async (data, context) => {
  await verifyAdmin(context.rawRequest);
  
  const { page = 1, limit = 20, status = '', plan = '', search = '' } = data;
  const offset = (page - 1) * limit;
  
  let query = db.collection('payments').orderBy('createdAt', 'desc');
  
  if (status) query = query.where('status', '==', status);
  if (plan) query = query.where('plan', '==', plan);
  
  const totalSnap = await query.count().get();
  const paymentsSnap = await query.limit(limit).offset(offset).get();
  
  const payments = paymentsSnap.docs.map(doc => {
    const d = doc.data();
    return {
      paymentId: doc.id,
      ...d,
      createdAt: d.createdAt?.toDate?.()?.toISOString()
    };
  });
  
  return {
    payments,
    total: totalSnap.data().count,
    page,
    limit,
    hasMore: offset + payments.length < totalSnap.data().count
  };
});

// ============ ANALYTICS ============

/**
 * 取得流量分析資料
 * POST /admin/getAnalytics
 */
exports.adminGetAnalytics = functions.https.onCall(async (data, context) => {
  await verifyAdmin(context.rawRequest);
  
  const { days = 30 } = data;
  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  
  // 取得事件統計
  const eventTypes = ['page_view', 'login', 'register', 'payment_success', 'payment_failed', 'message_sent', 'error', 'webhook_received'];
  
  const eventStats = {};
  for (const eventType of eventTypes) {
    const snap = await db.collection('analytics_events')
      .where('eventType', '==', eventType)
      .where('createdAt', '>=', since)
      .count().get();
    eventStats[eventType] = snap.data().count;
  }
  
  // 每日趨勢
  const dailyStats = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateKey = d.toISOString().split('T')[0];
    dailyStats[dateKey] = { pageViews: 0, logins: 0, newUsers: 0, payments: 0 };
  }
  
  const eventsSnap = await db.collection('analytics_events')
    .where('createdAt', '>=', since)
    .orderBy('createdAt', 'desc')
    .limit(1000)
    .get();
  
  eventsSnap.docs.forEach(doc => {
    const d = doc.data();
    const dateKey = d.createdAt?.toDate?.()?.toISOString()?.split('T')[0];
    if (dateKey && dailyStats[dateKey]) {
      if (d.eventType === 'page_view') dailyStats[dateKey].pageViews++;
      if (d.eventType === 'login') dailyStats[dateKey].logins++;
      if (d.eventType === 'register') dailyStats[dateKey].newUsers++;
      if (d.eventType === 'payment_success') dailyStats[dateKey].payments++;
    }
  });
  
  // 熱門頁面
  const pageViewsMap = {};
  eventsSnap.docs.forEach(doc => {
    const d = doc.data();
    if (d.eventType === 'page_view' && d.metadata?.path) {
      pageViewsMap[d.metadata.path] = (pageViewsMap[d.metadata.path] || 0) + 1;
    }
  });
  const topPages = Object.entries(pageViewsMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, count]) => ({ path, count }));
  
  return {
    eventStats,
    dailyStats: Object.entries(dailyStats).reverse().map(([date, stats]) => ({ date, ...stats })),
    topPages,
    periodDays: days
  };
});

// ============ AUDIT LOGS ============

/**
 * 取得 Audit Logs
 * POST /admin/getAuditLogs
 */
exports.adminGetAuditLogs = functions.https.onCall(async (data, context) => {
  await verifyAdmin(context.rawRequest);
  
  const { page = 1, limit = 50, action = '', targetType = '' } = data;
  const offset = (page - 1) * limit;
  
  let query = db.collection('audit_logs').orderBy('createdAt', 'desc');
  
  if (action) query = query.where('action', '==', action);
  if (targetType) query = query.where('targetType', '==', targetType);
  
  const totalSnap = await query.count().get();
  const logsSnap = await query.limit(limit).offset(offset).get();
  
  const logs = logsSnap.docs.map(doc => ({
    logId: doc.id,
    ...doc.data(),
    createdAt: doc.data().createdAt?.toDate?.()?.toISOString()
  }));
  
  return {
    logs,
    total: totalSnap.data().count,
    page,
    limit,
    hasMore: offset + logs.length < totalSnap.data().count
  };
});

// ============ SETTINGS ============

/**
 * 取得系統設定
 * POST /admin/getSettings
 */
exports.adminGetSettings = functions.https.onCall(async (data, context) => {
  await verifySuperAdmin(context.rawRequest);
  
  const settingsDoc = await db.collection('settings').doc('system').get();
  const data_1 = settingsDoc.data() || {};
  
  return {
    maintenanceMode: data_1.maintenanceMode || false,
    registrationEnabled: data_1.registrationEnabled !== false,
    googleLoginEnabled: data_1.googleLoginEnabled !== false,
    maxDailyGuestMessages: data_1.maxDailyGuestMessages || 30,
    openaiApiEnabled: data_1.openaiApiEnabled || false
  };
});

/**
 * 更新系統設定
 * POST /admin/updateSettings
 */
exports.adminUpdateSettings = functions.https.onCall(async (data, context) => {
  const { uid: adminUid, email: adminEmail } = await verifySuperAdmin(context.rawRequest);
  
  const { updates } = data;
  const allowedSettings = ['maintenanceMode', 'registrationEnabled', 'googleLoginEnabled', 'maxDailyGuestMessages'];
  const cleanUpdates = {};
  
  for (const key of allowedSettings) {
    if (updates[key] !== undefined) {
      cleanUpdates[key] = updates[key];
    }
  }
  
  cleanUpdates.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  cleanUpdates.updatedBy = adminUid;
  
  await db.collection('settings').doc('system').set(cleanUpdates, { merge: true });
  
  await writeAuditLog(
    'settings_update',
    'settings',
    'system',
    adminUid,
    adminEmail,
    null,
    cleanUpdates,
    { ip: context.rawRequest.ip, userAgent: context.rawRequest.headers['user-agent'] }
  );
  
  return { success: true };
});

// ============ STRIPE WEBHOOK (增強版) ============

/**
 * 增強版 Stripe Webhook
 * 同時寫入 payments / subscriptions 集合
 */
exports.adminStripeWebhook = functions.https.onRequest(async (req, res) => {
  const stripeKey = functions.config().stripe?.secret_key || process.env.STRIPE_SECRET_KEY;
  const webhookSecret = functions.config().stripe?.webhook_secret || process.env.STRIPE_WEBHOOK_SECRET;
  
  if (!stripeKey) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  
  const stripe = require('stripe')(stripeKey);
  const sig = req.headers['stripe-signature'];
  
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }
  
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { uid, planId } = session.metadata || {};
        
        if (uid && planId) {
          const userRef = db.collection('users').doc(uid);
          const planData = PLANS[planId] || PLANS.free;
          
          await userRef.update({
            role: planId,
            plan: planId,
            dailyLimit: planData.dailyLimit,
            stripeCustomerId: session.customer,
            subscriptionId: session.subscription || null,
            subscriptionStatus: 'active',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          
          // 寫入 payments 記錄
          await db.collection('payments').add({
            paymentId: 'pay_' + session.id,
            userId: uid,
            stripeSessionId: session.id,
            stripePaymentIntentId: session.payment_intent || null,
            amount: session.amount_total || 0,
            currency: session.currency || 'cad',
            status: 'succeeded',
            plan: planId,
            description: planData.name,
            receiptUrl: session.receipt_url || null,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          
          // 寫入 analytics
          await db.collection('analytics_events').add({
            eventType: 'payment_success',
            userId: uid,
            metadata: { planId, amount: session.amount_total, currency: session.currency },
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          
          // 寫入 audit log
          await writeAuditLog(
            'payment_success',
            'payment',
            'pay_' + session.id,
            'system',
            'stripe_webhook',
            null,
            { uid, planId, amount: session.amount_total },
            null
          );
        }
        break;
      }
      
      case 'customer.subscription.deleted':
      case 'customer.subscription.updated': {
        const subscription = event.data.object;
        const users = await db.collection('users')
          .where('stripeCustomerId', '==', subscription.customer)
          .get();
        
        for (const userDoc of users.docs) {
          if (event.type === 'customer.subscription.deleted') {
            await userDoc.ref.update({
              role: 'free',
              plan: 'free',
              dailyLimit: PLANS.free.dailyLimit,
              subscriptionId: null,
              subscriptionStatus: 'cancelled',
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          } else {
            await userDoc.ref.update({
              subscriptionStatus: subscription.status,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        }
        
        // 更新 subscriptions 集合
        if (subscription.id) {
          await db.collection('subscriptions').doc('sub_' + subscription.id).set({
            subscriptionId: 'sub_' + subscription.id,
            stripeSubscriptionId: subscription.id,
            status: subscription.status,
            currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
            currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
            cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
        break;
      }
      
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.customer) {
          const users = await db.collection('users')
            .where('stripeCustomerId', '==', invoice.customer)
            .get();
          
          for (const userDoc of users.docs) {
            await userRef.update({
              subscriptionStatus: 'past_due',
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
          
          await db.collection('analytics_events').add({
            eventType: 'payment_failed',
            userId: users.docs[0]?.id || null,
            metadata: { invoiceId: invoice.id, amountDue: invoice.amount_due },
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        break;
      }
    }
    
    // 通用 webhook 事件記錄
    await db.collection('audit_logs').add({
      action: 'webhook_received',
      targetType: 'stripe',
      targetId: event.id,
      adminId: 'system',
      adminEmail: 'stripe_webhook',
      newValue: { type: event.type },
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============ ON USER CREATED TRIGGER ============

/**
 * 新用戶建立觸發
 * 自動設定 role = user，並記錄 analytics
 */
exports.onUserCreated = functions.auth.user().onCreate(async (user) => {
  const uid = user.uid;
  const email = user.email;
  
  // 檢查是否為 super_admin email
  const isSuperAdminEmail = email === 'wei512712@gmail.com';
  
  // 檢查是否為第一個用戶（如果是，設為 super_admin）
  const usersCount = await db.collection('users').count().get();
  const isFirstUser = usersCount.data().count === 0;
  
  let role = 'user';
  let plan = 'guest';
  
  if (isSuperAdminEmail || isFirstUser) {
    role = 'super_admin';
    plan = 'vip_pro_lifetime';
    console.log(`Super admin created: ${email || uid}`);
  }
  
  await db.collection('users').doc(uid).set({
    uid,
    email: email || null,
    role,
    plan,
    dailyLimit: PLANS[plan].dailyLimit,
    messagesUsedToday: 0,
    lastMessageDate: null,
    subscriptionStatus: null,
    stripeCustomerId: null,
    subscriptionId: null,
    disabled: false,
    isAnonymous: !email,
    lastActive: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  
  // 記錄 register 事件
  await db.collection('analytics_events').add({
    eventType: 'register',
    userId: uid,
    metadata: { email, method: email ? 'email' : 'anonymous' },
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  
  console.log(`User created: ${uid} | email: ${email} | role: ${role}`);
});