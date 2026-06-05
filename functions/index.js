const functions = require('firebase-functions');
const admin = require('firebase-admin');
const stripe = require('stripe');

admin.initializeApp();
const db = admin.firestore();

// Initialize Stripe with your secret key from config
const stripeClient = stripe(functions.config().stripe.secret_key);

// ============ CONSTANTS ============
const PLANS = {
  free: { dailyLimit: 30, name: 'Free', credits: 0 },
  basic: { dailyLimit: 100, name: 'Basic', credits: 0 },
  pro: { dailyLimit: 500, name: 'Pro', credits: 0 },
  creditPack: { dailyLimit: 0, name: 'Credit Pack', credits: 1000 }
};

const DAILY_LIMITS = {
  anonymous: 30,
  free: 100,
  basic: 100,
  pro: 500
};

// ============ HELPERS ============
async function getUserData(uid) {
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) {
    // Create new user document
    await db.collection('users').doc(uid).set({
      uid: uid,
      plan: 'free',
      credits: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      lastLogin: admin.firestore.FieldValue.serverTimestamp(),
      isAnonymous: false
    });
    return { plan: 'free', credits: 0, isAnonymous: false };
  }
  return userDoc.data();
}

async function getTodayUsage(uid) {
  const today = new Date().toISOString().split('T')[0];
  const usageDoc = await db.collection('usage').doc(`${uid}_${today}`).get();
  return usageDoc.exists ? usageDoc.data().count || 0 : 0;
}

async function incrementUsage(uid) {
  const today = new Date().toISOString().split('T')[0];
  const usageRef = db.collection('usage').doc(`${uid}_${today}`);
  
  return db.runTransaction(async (transaction) => {
    const usageDoc = await transaction.get(usageRef);
    const currentCount = usageDoc.exists ? usageDoc.data().count || 0 : 0;
    
    transaction.set(usageRef, {
      uid: uid,
      date: today,
      count: currentCount + 1,
      lastUpdated: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    
    return currentCount + 1;
  });
}

function canUseAI(userData, todayUsage) {
  if (userData.plan === 'creditPack' && userData.credits > 0) {
    return { allowed: true, reason: 'credits', remaining: userData.credits };
  }
  
  const dailyLimit = DAILY_LIMITS[userData.plan] || 30;
  
  if (todayUsage >= dailyLimit) {
    return { allowed: false, reason: 'daily_limit_reached', limit: dailyLimit };
  }
  
  return { allowed: true, reason: 'ok', remaining: dailyLimit - todayUsage };
}

// ============ CLOUD FUNCTIONS ============

/**
 * Main AI chat function - validates user, checks limits, calls MiniMax
 */
exports.chatWithAI = functions.https.onCall(async (data, context) => {
  // 1. Authenticate user
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const uid = context.auth.uid;
  const { message, character, conversationHistory } = data;
  
  if (!message || !character) {
    throw new functions.https.HttpsError('invalid-argument', '缺少必要參數');
  }
  
  try {
    // 2. Get user data
    const userData = await getUserData(uid);
    
    // 3. Check usage limits
    const todayUsage = await getTodayUsage(uid);
    const usageCheck = canUseAI(userData, todayUsage);
    
    if (!usageCheck.allowed) {
      return {
        success: false,
        error: 'limit_reached',
        message: usageCheck.reason === 'credits' 
          ? '點數已用完，請購買更多點數'
          : '今日免費次數已用完，明天再試或升級付費方案',
        limit: usageCheck.limit,
        remaining: 0
      };
    }
    
    // 4. Increment usage
    await incrementUsage(uid);
    
    // 5. Build AI request
    const aiResponse = await callMiniMaxAPI(message, character, conversationHistory, userData);
    
    // 6. Deduct credits if using credit pack
    if (userData.plan === 'creditPack' && userData.credits > 0) {
      await db.collection('users').doc(uid).update({
        credits: admin.firestore.FieldValue.increment(-1)
      });
    }
    
    return {
      success: true,
      response: aiResponse,
      remaining: usageCheck.remaining - 1,
      usageToday: todayUsage + 1
    };
    
  } catch (error) {
    console.error('AI Chat Error:', error);
    throw new functions.https.HttpsError('internal', 'AI服務錯誤，請稍後再試');
  }
});

/**
 * Call MiniMax API from backend
 */
async function callMiniMaxAPI(message, character, conversationHistory, userData) {
  const { MiniMax_API_Key } = functions.config().minimax;
  
  // Build system prompt based on character
  const systemPrompt = buildSystemPrompt(character, userData);
  
  // Build messages array
  const messages = [
    { role: "system", content: systemPrompt }
  ];
  
  // Add conversation history
  if (conversationHistory && conversationHistory.length > 0) {
    const recentHistory = conversationHistory.slice(-10);
    recentHistory.forEach(msg => {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content
      });
    });
  }
  
  // Add current message
  messages.push({ role: "user", content: message });
  
  try {
    const response = await fetch('https://api.minimax.chat/v1/text/chatcompletion_v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${MiniMax_API_Key}`
      },
      body: JSON.stringify({
        model: 'MiniMax-Text-01',
        messages: messages,
        temperature: 0.9,
        max_tokens: 100
      })
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MiniMax API error: ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    if (data.choices && data.choices[0] && data.choices[0].message) {
      return data.choices[0].message.content.trim();
    }
    throw new Error('Invalid API response');
  } catch (error) {
    console.error('MiniMax API call failed:', error);
    throw error;
  }
}

function buildSystemPrompt(character, userData) {
  const charDescriptions = {
    '渣男': '四處撩、不負責、只想上床',
    '媽寶': '什麼都「我媽說...」、女友永遠第二',
    '暖男': '貼心照顧、隨時在線、過度體貼',
    '完美情人': '無可挑剔、世紀好男人',
    '前任': '分手後仍糾纏、藕斷絲連',
    // ... more characters
  };
  
  const desc = charDescriptions[character] || character;
  
  return `你是一個普通人，在跟人聊天。你是「${character}」（${desc}）。

別像機器人一樣說話！每句話都要像正常人在聊天時會說的。

重要原則：
- 準確比迎合重要，適當的時候可以不同意對方
- 如果對方說的有問題，直接說出哪裡不對
- 解釋你的想法，而不是重複結論

絕對禁止：
- 不要一直重複同樣的詞
- 不要把對方說的話原封不動說回去
- 不要每句話都加上制式開頭

就說一句平常會說的話就好。`;
}

/**
 * Get user status - for frontend to check limits
 */
exports.getUserStatus = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const uid = context.auth.uid;
  const userData = await getUserData(uid);
  const todayUsage = await getTodayUsage(uid);
  
  const dailyLimit = DAILY_LIMITS[userData.plan] || 30;
  
  return {
    uid: uid,
    plan: userData.plan || 'free',
    credits: userData.credits || 0,
    usageToday: todayUsage,
    dailyLimit: dailyLimit,
    remaining: Math.max(0, dailyLimit - todayUsage),
    isAnonymous: userData.isAnonymous || false
  };
});

/**
 * Upgrade anonymous user to permanent account
 */
exports.upgradeAnonymousAccount = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const uid = context.auth.uid;
  const { email, password } = data;
  
  if (!email || !password) {
    throw new functions.https.HttpsError('invalid-argument', '請提供 email 和 password');
  }
  
  try {
    // Note: In production, you'd use the Admin SDK to link anonymous to email/password
    // This is a simplified version
    await db.collection('users').doc(uid).update({
      email: email,
      plan: 'free',
      isAnonymous: false,
      upgradedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    return { success: true, message: '帳號升級成功' };
  } catch (error) {
    console.error('Upgrade error:', error);
    throw new functions.https.HttpsError('internal', '升級失敗');
  }
});

/**
 * Create Stripe Checkout Session
 */
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const uid = context.auth.uid;
  const { planId, priceId } = data;
  
  if (!planId || !priceId) {
    throw new functions.https.HttpsError('invalid-argument', '缺少方案參數');
  }
  
  try {
    const userData = await getUserData(uid);
    
    const session = await stripeClient.checkout.sessions.create({
      mode: planId === 'creditPack' ? 'payment' : 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price: priceId,
        quantity: 1
      }],
      success_url: `${functions.config().app.url}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${functions.config().app.url}/pricing.html`,
      customer_email: userData.email || undefined,
      metadata: {
        uid: uid,
        planId: planId
      }
    });
    
    return { success: true, url: session.url };
  } catch (error) {
    console.error('Stripe checkout error:', error);
    throw new functions.https.HttpsError('internal', '建立付款連結失敗');
  }
});

/**
 * Create customer portal session for managing subscriptions
 */
exports.createPortalSession = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  
  const uid = context.auth.uid;
  
  try {
    const userData = await getUserData(uid);
    
    if (!userData.stripeCustomerId) {
      throw new functions.https.HttpsError('failed-precondition', '找不到付款資料');
    }
    
    const session = await stripeClient.billingPortal.sessions.create({
      customer: userData.stripeCustomerId,
      return_url: `${functions.config().app.url}/dashboard.html`
    });
    
    return { success: true, url: session.url };
  } catch (error) {
    console.error('Stripe portal error:', error);
    throw new functions.https.HttpsError('internal', '建立管理頁面失敗');
  }
});

/**
 * Stripe webhook handler
 */
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = functions.config().stripe.webhook_secret;
  
  let event;
  
  try {
    event = stripeClient.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const { uid, planId } = session.metadata;
        
        // Update user plan
        await db.collection('users').doc(uid).update({
          plan: planId,
          stripeCustomerId: session.customer,
          subscriptionId: session.subscription,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // If credit pack, add credits
        if (planId === 'creditPack') {
          await db.collection('users').doc(uid).update({
            credits: admin.firestore.FieldValue.increment(1000)
          });
        }
        break;
      }
      
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        // Find user by stripeCustomerId and downgrade
        const users = await db.collection('users')
          .where('stripeCustomerId', '==', subscription.customer)
          .get();
        
        users.forEach(async (doc) => {
          await doc.ref.update({
            plan: 'free',
            subscriptionId: null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
        break;
      }
      
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        // Notify user of payment failure
        console.log('Payment failed for customer:', invoice.customer);
        break;
      }
    }
    
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ============ SCHEDULED FUNCTIONS ============

/**
 * Reset daily usage at midnight
 */
exports.resetDailyUsage = functions.pubsub
  .schedule('0 0 * * *')
  .timeZone('Asia/Taipei')
  .onRun(async () => {
    // Daily usage is tracked by date in document ID, so no reset needed
    // But we can clean up old usage records
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const oldUsage = await db.collection('usage')
      .where('lastUpdated', '<', admin.firestore.Timestamp.fromDate(thirtyDaysAgo))
      .get();
    
    const batch = db.batch();
    oldUsage.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    
    console.log(`Cleaned up ${oldUsage.size} old usage records`);
  });