const functions = require('firebase-functions');
const admin = require('firebase-admin');
const stripe = require('stripe');

admin.initializeApp();
const db = admin.firestore();

// Initialize Stripe with config
let stripeClient;
try {
  const stripeKey = functions.config().stripe?.secret_key || process.env.STRIPE_SECRET_KEY;
  if (stripeKey) {
    stripeClient = stripe(stripeKey);
  }
} catch (e) {
  console.warn('Stripe not configured:', e.message);
}

// ============ CONSTANTS ============
const PLANS = {
  guest: {
    dailyLimit: 30,
    canCreateCharacter: false,
    canSaveChat: false,
    maxPrivateChars: 0,
    name: 'Guest',
    color: '#9CA3AF'
  },
  free: {
    dailyLimit: 30,
    canCreateCharacter: true,
    canSaveChat: true,
    maxPrivateChars: 3,
    name: 'Free',
    color: '#10B981'
  },
  vip: {
    dailyLimit: -1, // unlimited
    canCreateCharacter: true,
    canSaveChat: true,
    maxPrivateChars: -1,
    name: 'VIP',
    color: '#F59E0B'
  },
  lifetime: {
    dailyLimit: -1,
    canCreateCharacter: true,
    canSaveChat: true,
    maxPrivateChars: -1,
    name: 'Lifetime',
    color: '#8B5CF6'
  }
};

// When VIP/Lifetime users get tired
const TIRED_THRESHOLD = 800;
const TIRED_MESSAGES = [
  '我累了，今天聊很多了...休息一下吧。',
  '哈～有點累了，改天再聊？',
  '我也需要喘口氣...',
  '抱歉，今天頭有點昏',
  '累了...改天再聊好不好？'
];

// ============ HELPERS ============
function getToday() {
  return new Date().toISOString().split('T')[0];
}

async function getUserData(uid) {
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) {
    const defaultData = {
      uid: uid,
      role: 'guest',
      plan: 'guest',
      dailyLimit: PLANS.guest.dailyLimit,
      messagesUsedToday: 0,
      lastMessageDate: null,
      subscriptionStatus: null,
      stripeCustomerId: null,
      subscriptionId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('users').doc(uid).set(defaultData);
    return defaultData;
  }
  return userDoc.data();
}

async function getTodayUsage(uid) {
  const today = getToday();
  const userData = await getUserData(uid);
  
  if (userData.lastMessageDate !== today) {
    await db.collection('users').doc(uid).update({
      messagesUsedToday: 0,
      lastMessageDate: today
    });
    return 0;
  }
  return userData.messagesUsedToday || 0;
}

function checkCanChat(userData, todayUsage) {
  const plan = PLANS[userData.plan] || PLANS.guest;
  
  // VIP/Lifetime - unlimited but get tired after many messages
  if (plan.dailyLimit === -1) {
    if (todayUsage >= TIRED_THRESHOLD) {
      return { allowed: Math.random() > 0.25, tired: true };
    }
    return { allowed: true, tired: false };
  }
  
  // Guest/Free - daily limit
  if (todayUsage >= plan.dailyLimit) {
    return { allowed: false, reason: 'daily_limit', limit: plan.dailyLimit };
  }
  
  return { allowed: true, tired: false, remaining: plan.dailyLimit - todayUsage };
}

// ============ MINIMAX AI ============
async function callMiniMaxAI(message, characterName, characterDesc, conversationHistory) {
  const apiKey = functions.config().minimax?.api_key || process.env.MINIMAX_API_KEY;
  
  if (!apiKey) {
    throw new Error('MiniMax API key not configured');
  }
  
  const systemPrompt = `你是一個普通人，在跟人聊天。你是「${characterName}」（${characterDesc}）。

說話要像正常人在聊天，不要罐頭回覆。活潑自然。`;

  const messages = [{ role: 'system', content: systemPrompt }];
  
  if (conversationHistory && conversationHistory.length > 0) {
    conversationHistory.slice(-10).forEach(msg => {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      });
    });
  }
  
  messages.push({ role: 'user', content: message });
  
  const response = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'MiniMax-Text-01',
      messages: messages,
      temperature: 0.9,
      max_tokens: 150
    })
  });
  
  if (!response.ok) {
    throw new Error(`MiniMax error: ${response.status}`);
  }
  
  const data = await response.json();
  if (data.choices?.[0]?.message?.content) {
    return data.choices[0].message.content.trim();
  }
  throw new Error('Invalid API response');
}

// ============ CLOUD FUNCTIONS ============

/**
 * 發送訊息
 */
exports.sendMessage = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const uid = context.auth.uid;
  const { message, characterName, characterDesc, conversationHistory } = data;
  
  if (!message || !characterName) {
    throw new functions.https.HttpsError('invalid-argument', '缺少必要參數');
  }
  
  try {
    const userData = await getUserData(uid);
    const todayUsage = await getTodayUsage(uid);
    const check = checkCanChat(userData, todayUsage);
    
    // Check limit
    if (!check.allowed) {
      return {
        success: false,
        error: 'limit_reached',
        message: '今日訊息額度已用完',
        upgradePlan: 'vip',
        upgradePrice: 299
      };
    }
    
    // Tired response for VIP/Lifetime
    if (check.tired) {
      const tiredMsg = TIRED_MESSAGES[Math.floor(Math.random() * TIRED_MESSAGES.length)];
      return {
        success: true,
        response: tiredMsg,
        tired: true,
        usageToday: todayUsage
      };
    }
    
    // Call AI
    const aiResponse = await callMiniMaxAI(message, characterName, characterDesc, conversationHistory);
    
    // Update usage
    await db.collection('users').doc(uid).update({
      messagesUsedToday: admin.firestore.FieldValue.increment(1),
      lastMessageDate: getToday(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    const plan = PLANS[userData.plan];
    const remaining = plan.dailyLimit === -1 ? -1 : plan.dailyLimit - todayUsage - 1;
    
    return {
      success: true,
      response: aiResponse,
      tired: false,
      usageToday: todayUsage + 1,
      remaining: remaining
    };
    
  } catch (error) {
    console.error('Send message error:', error);
    throw new functions.https.HttpsError('internal', '系統忙碌中，請稍後再試');
  }
});

/**
 * 取得會員狀態
 */
exports.getUserStatus = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const uid = context.auth.uid;
  const userData = await getUserData(uid);
  const todayUsage = await getTodayUsage(uid);
  const plan = PLANS[userData.plan] || PLANS.guest;
  
  return {
    uid: uid,
    role: userData.role || 'guest',
    plan: userData.plan || 'guest',
    planName: plan.name,
    planColor: plan.color,
    dailyLimit: plan.dailyLimit,
    usageToday: todayUsage,
    remaining: plan.dailyLimit === -1 ? -1 : Math.max(0, plan.dailyLimit - todayUsage),
    canCreateCharacter: plan.canCreateCharacter,
    maxPrivateChars: plan.maxPrivateChars,
    canSaveChat: plan.canSaveChat,
    isAnonymous: userData.email ? false : true,
    subscriptionStatus: userData.subscriptionStatus || null,
    createdAt: userData.createdAt?.toDate?.()?.toISOString() || null
  };
});

/**
 * 升級為 Free（Email註冊後）
 */
exports.upgradeToFree = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const uid = context.auth.uid;
  const { email } = data;
  
  try {
    await db.collection('users').doc(uid).update({
      role: 'free',
      plan: 'free',
      dailyLimit: PLANS.free.dailyLimit,
      email: email || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { success: true };
  } catch (error) {
    console.error('Upgrade to free error:', error);
    throw new functions.https.HttpsError('internal', '升級失敗');
  }
});

/**
 * 建立 Stripe Checkout
 */
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  if (!stripeClient) {
    throw new functions.https.HttpsError('failed-precondition', 'Stripe 未設定');
  }
  
  const uid = context.auth.uid;
  const { planId, priceId } = data;
  
  if (!planId || !priceId) {
    throw new functions.https.HttpsError('invalid-argument', '缺少方案參數');
  }
  
  const appUrl = functions.config().app?.url || 'https://loverchat-88cb3.web.app';
  
  try {
    const userData = await getUserData(uid);
    
    const session = await stripeClient.checkout.sessions.create({
      mode: planId === 'lifetime' ? 'payment' : 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/pricing.html`,
      customer_email: userData.email || undefined,
      metadata: { uid, planId }
    });
    
    return { success: true, url: session.url };
  } catch (error) {
    console.error('Stripe checkout error:', error);
    throw new functions.https.HttpsError('internal', '無法建立付款連結');
  }
});

/**
 * Stripe Customer Portal
 */
exports.createPortalSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  if (!stripeClient) {
    throw new functions.https.HttpsError('failed-precondition', 'Stripe 未設定');
  }
  
  const uid = context.auth.uid;
  const appUrl = functions.config().app?.url || 'https://loverchat-88cb3.web.app';
  
  try {
    const userData = await getUserData(uid);
    
    if (!userData.stripeCustomerId) {
      throw new functions.https.HttpsError('failed-precondition', '找不到付款資料');
    }
    
    const session = await stripeClient.billingPortal.sessions.create({
      customer: userData.stripeCustomerId,
      return_url: `${appUrl}/dashboard.html`
    });
    
    return { success: true, url: session.url };
  } catch (error) {
    console.error('Stripe portal error:', error);
    throw new functions.https.HttpsError('internal', '無法開啟管理頁面');
  }
});

/**
 * Stripe Webhook
 */
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  if (!stripeClient) {
    return res.status(500).json({ error: 'Stripe not configured' });
  }
  
  const sig = req.headers['stripe-signature'];
  const webhookSecret = functions.config().stripe?.webhook_secret || process.env.STRIPE_WEBHOOK_SECRET;
  
  if (!webhookSecret) {
    return res.status(500).json({ error: 'Webhook secret not configured' });
  }
  
  let event;
  try {
    event = stripeClient.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }
  
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { uid, planId } = session.metadata;
        
        if (!uid || !planId) break;
        
        const updates = {
          role: planId,
          plan: planId,
          stripeCustomerId: session.customer,
          subscriptionId: session.subscription || null,
          subscriptionStatus: 'active',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        
        await db.collection('users').doc(uid).update(updates);
        console.log(`User ${uid} upgraded to ${planId}`);
        break;
      }
      
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        const users = await db.collection('users')
          .where('stripeCustomerId', '==', subscription.customer)
          .get();
        
        users.forEach(async (doc) => {
          await doc.ref.update({
            role: 'free',
            plan: 'free',
            dailyLimit: PLANS.free.dailyLimit,
            subscriptionId: null,
            subscriptionStatus: 'cancelled',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
        break;
      }
    }
    
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * 儲存角色
 */
exports.saveCharacter = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const uid = context.auth.uid;
  const { name, description, visibility } = data;
  
  if (!name || !description) {
    throw new functions.https.HttpsError('invalid-argument', '缺少角色資料');
  }
  
  if (description.length < 100 && !data.avatarUrl) {
    throw new functions.https.HttpsError('invalid-argument', '角色描述需超過 100 字');
  }
  
  const userData = await getUserData(uid);
  const plan = PLANS[userData.plan] || PLANS.guest;
  
  if (!plan.canCreateCharacter) {
    throw new functions.https.HttpsError('permission-denied', '此方案無法建立角色');
  }
  
  const characterId = `${uid}_${Date.now()}`;
  
  await db.collection('characters').doc(characterId).set({
    characterId,
    ownerUid: uid,
    name,
    description,
    avatarUrl: data.avatarUrl || null,
    visibility: visibility || 'private',
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  
  return { success: true, characterId };
});

/**
 * 取得我的角色
 */
exports.getMyCharacters = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const uid = context.auth.uid;
  
  const characters = await db.collection('characters')
    .where('ownerUid', '==', uid)
    .orderBy('createdAt', 'desc')
    .get();
  
  return characters.docs.map(doc => doc.data());
});