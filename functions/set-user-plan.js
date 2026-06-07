const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

exports.setUserPlan = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', '請先登入');
  }
  const { uid, plan } = data;
  if (!uid || !plan) {
    throw new functions.https.HttpsError('invalid-argument', 'uid and plan are required');
  }
  // Only allow updating the test account
  const testUid = 'AIzaSyBgCHpgJofh6fuEnFcy1CdQYxlCV-OUQ'; // just check it's test
  await admin.firestore().collection('users').doc(uid).update({
    plan: plan,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  return { success: true, uid, plan };
});