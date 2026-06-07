const admin = require('firebase-admin');
const functions = require('firebase-functions');

admin.initializeApp({
  projectId: 'loverchat-88cb3'
});

exports.resetTestUser = functions.https.onRequest(async (req, res) => {
  const uid = '3rWURqzxmCWY8zIse8vYyC0G5aL2';
  try {
    const db = admin.firestore();
    const userRef = db.collection('users').doc(uid);
    await userRef.update({
      messagesUsedToday: 0,
      lastMessageDate: null
    });
    res.status(200).send('Reset OK');
  } catch (e) {
    res.status(500).send('Error: ' + e.message);
  }
});