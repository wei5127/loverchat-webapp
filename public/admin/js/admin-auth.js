/**
 * Admin Auth Module — 統一管理 /admin/ 的認證
 * 所有 admin 頁面都引用這個 module
 */
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';

const AdminAuth = (() => {
  const ADMIN_FUNCTIONS = [
    'adminCheckAuth',
    'adminGetDashboardStats',
    'adminGetUsers',
    'adminGetUser',
    'adminUpdateUser',
    'adminToggleUserStatus',
    'adminGetPayments',
    'adminGetAnalytics',
    'adminGetAuditLogs',
    'adminGetSettings',
    'adminUpdateSettings'
  ];
  
  let _currentUser = null;
  let _authChecked = false;
  let _listeners = [];
  
  // Firebase config
  const firebaseConfig = {
    apiKey: "AIzaSyBgCHhpBgJofh6fuEnFcy1CdQYxlCV-OUQ",
    authDomain: "loverchat-88cb3.firebaseapp.com",
    projectId: "loverchat-88cb3",
    storageBucket: "loverchat-88cb3.firebasestorage.app",
    messagingSenderId: "726884368190",
    appId: "1:726884368190:web:897b286fde11396928766f"
  };
  
  let _app, _auth, _functions;
  
  function init() {
    if (_app) return;
    // Initialize Firebase app if not already initialized
    const existingApps = getApps();
    _app = existingApps[0] || initializeApp(firebaseConfig, 'admin');
    _auth = getAuth(_app);
    _functions = getFunctions(_app);
  }
  
  /**
   * 檢查目前的登入狀態（async）
   */
  /**
   * 檢查目前的登入狀態（async）
   * 加入 15 秒超時，防止無限期等待
   */
  async function checkAuth() {
    init();
    return new Promise((resolve) => {
      // 超時 15 秒後自動放棄
      const timeoutId = setTimeout(() => {
        console.warn('Admin checkAuth timeout, resolving as null');
        _currentUser = null;
        _authChecked = true;
        resolve(null);
      }, 15000);
      
      const unsubscribe = _auth.onAuthStateChanged(async (user) => {
        clearTimeout(timeoutId);
        unsubscribe();
        
        if (!user) {
          _currentUser = null;
          _authChecked = true;
          resolve(null);
          return;
        }
        
        try {
          // 取得 ID token
          const idToken = await user.getIdToken();
          
          // 呼叫 adminCheckAuth 驗證權限
          const checkAuthFn = httpsCallable(_functions)('adminCheckAuth');
          const result = await checkAuthFn({});
          const data = result.data || {};
          
          if (!data.authenticated || !data.isAdmin) {
            // 不是 admin，強制登出
            await _auth.signOut();
            _currentUser = null;
            _authChecked = true;
            resolve(null);
            return;
          }
          
          _currentUser = data;
          _currentUser.idToken = idToken;
          _currentUser.firebaseUser = user;
          _authChecked = true;
          
          // 通知所有監聽器
          _listeners.forEach(cb => cb(_currentUser));
          resolve(_currentUser);
        } catch (e) {
          console.error('Admin auth check failed:', e);
          // 網路錯誤時，允許重試
          _currentUser = null;
          _authChecked = true;
          resolve(null);
        }
      }, (error) => {
        clearTimeout(timeoutId);
        console.error('Auth state error:', error);
        _currentUser = null;
        _authChecked = true;
        resolve(null);
      });
    });
  }
  
  /**
   * 確保已認證（用於頁面 guard）
   * 如果未認證，重導向到 login
   */
  async function requireAuth(returnUrl = window.location.href) {
    if (!_authChecked) {
      await checkAuth();
    }
    
    if (!_currentUser) {
      // 儲存返回 URL，登入後可以返回
      sessionStorage.setItem('adminReturnUrl', returnUrl);
      window.location.href = 'login.html';
      return false;
    }
    
    return true;
  }
  
  /**
   * 確保是 super_admin
   */
  async function requireSuperAdmin() {
    const ok = await requireAuth();
    if (!ok) return false;
    
    if (!_currentUser.isSuperAdmin) {
      alert('需要超級管理員權限');
      window.location.href = 'dashboard.html';
      return false;
    }
    return true;
  }
  
  /**
   * 呼叫 Admin API（含自動 ID token 注入）
   */
  async function api(functionName, data = {}) {
    if (!_currentUser || !_currentUser.idToken) {
      throw new Error('Not authenticated. Call checkAuth() first.');
    }
    
    init();
    const fn = httpsCallable(_functions)(functionName);
    const result = await fn(data);
    
    if (result.data?.error) {
      throw new Error(result.data.error.message || result.data.error);
    }
    
    return result.data;
  }
  
  /**
   * Google 登入（使用 redirect）
   */
  async function signInWithGoogle() {
    init();
    const provider = new GoogleAuthProvider();
    // 強制重新登入，確保取得 fresh token
    provider.setCustomParameters({ prompt: 'select_account' });
    
    try {
      await getAuth(_app).signInWithRedirect(provider);
      // 頁面會被重導向到 Google，之後再重導向回來
    } catch (e) {
      if (e.code !== 'auth/redirect-cancelled-by-user') {
        throw e;
      }
      // 用戶取消，什麼都不做
    }
  }
  
  /**
   * 處理 Google 登入後的結果（應在 login 頁的 onLoad 呼叫）
   */
  async function handleRedirectResult() {
    init();
    const result = await getAuth(_app).getRedirectResult();
    return result;
  }
  
  /**
   * 登出
   */
  async function signOut() {
    init();
    await getAuth(_app).signOut();
    _currentUser = null;
    window.location.href = 'login.html';
  }
  
  /**
   * 訂閱認證狀態變化
   */
  function onAuthChange(callback) {
    _listeners.push(callback);
    return () => {
      _listeners = _listeners.filter(cb => cb !== callback);
    };
  }
  
  /**
   * 格式化金額（cents → dollar）
   */
  function formatCurrency(cents, currency = 'CAD') {
    if (currency === 'CAD') {
      return `CA$${(cents / 100).toFixed(2)}`;
    }
    return `${(cents / 100).toFixed(2)} ${currency}`.toUpperCase();
  }
  
  /**
   * 格式化日期
   */
  function formatDate(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  }
  
  /**
   * 顯示 loading overlay
   */
  function showLoading(text = '載入中...') {
    let el = document.getElementById('admin-loading');
    if (!el) {
      el = document.createElement('div');
      el.id = 'admin-loading';
      el.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(255,255,255,0.9);display:flex;align-items:center;justify-content:center;z-index:9999;flex-direction:column;gap:16px;';
      el.innerHTML = '<div style="width:48px;height:48px;border:4px solid #eadbea;border-top-color:#f56fa8;border-radius:50%;animation:spin 1s linear infinite;"></div><span style="color:#75687f;font-size:14px;">' + text + '</span><style>@keyframes spin{to{transform:rotate(360deg)}}</style>';
      document.body.appendChild(el);
    }
    el.querySelector('span').textContent = text;
    el.style.display = 'flex';
  }
  
  function hideLoading() {
    const el = document.getElementById('admin-loading');
    if (el) el.style.display = 'none';
  }
  
  /**
   * 顯示 toast 訊息
   */
  function showToast(message, type = 'success') {
    const colors = {
      success: '#10b981',
      error: '#ef4444',
      warning: '#f59e0b',
      info: '#3b82f6'
    };
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;bottom:24px;right:24px;padding:12px 20px;background:${colors[type] || colors.info};color:white;border-radius:12px;font-size:14px;font-weight:500;z-index:10000;box-shadow:0 4px 12px rgba(0,0,0,0.15);animation:slideIn 0.3s ease`;
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => {
      el.style.animation = 'slideOut 0.3s ease forwards';
      setTimeout(() => el.remove(), 300);
    }, 3000);
  }
  
  return {
    init,
    checkAuth,
    requireAuth,
    requireSuperAdmin,
    api,
    signInWithGoogle,
    handleRedirectResult,
    signOut,
    onAuthChange,
    formatCurrency,
    formatDate,
    showLoading,
    hideLoading,
    showToast,
    get currentUser() { return _currentUser; },
    get isSuperAdmin() { return _currentUser?.isSuperAdmin; },
    get isAdmin() { return _currentUser?.isAdmin; }
  };
})();

// 全域實例
window.AdminAuth = AdminAuth;