/**
 * Shared Sidebar Renderer for Admin Panel
 * 所有 admin 頁面在 body 末尾加入：<div id="sidebarInsert"></div>
 * 然後引入這個 script
 */
const ADMIN_SIDEBAR_HTML = `
<aside class="sidebar">
  <a href="dashboard.html" class="sidebar-brand">
    <div class="sidebar-brand-icon">管</div>
    <div>
      <div class="sidebar-brand-text">管理後台</div>
      <div class="sidebar-brand-sub">Admin Panel</div>
    </div>
  </a>
  <nav class="sidebar-nav">
    <div class="sidebar-section-label">主選單</div>
    <a href="dashboard.html" class="nav-item" data-page="dashboard">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
      儀表板
    </a>
    <a href="users.html" class="nav-item" data-page="users">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      會員管理
    </a>
    <a href="payments.html" class="nav-item" data-page="payments">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
      付款記錄
    </a>
    <a href="analytics.html" class="nav-item" data-page="analytics">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      流量分析
    </a>
    <a href="audit-logs.html" class="nav-item" data-page="audit-logs">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
      操作日誌
    </a>
    <div class="sidebar-section-label" style="margin-top:8px;">系統</div>
    <a href="settings.html" class="nav-item" data-page="settings">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      系統設定
    </a>
  </nav>
  <div class="sidebar-footer">
    <div class="admin-user-info">
      <div class="admin-avatar" id="sidebarAdminAvatar">—</div>
      <div>
        <div class="admin-name" id="sidebarAdminName">載入中</div>
        <div class="admin-role" id="sidebarAdminRole">—</div>
      </div>
    </div>
    <button class="btn-logout" id="sidebarLogoutBtn">🚪 登出</button>
  </div>
</aside>
`;

function injectSidebar(user) {
  const placeholder = document.getElementById('sidebarInsert');
  if (!placeholder) {
    console.warn('No sidebar placeholder found');
    return;
  }
  
  placeholder.outerHTML = ADMIN_SIDEBAR_HTML;
  
  // Highlight current page
  const currentPage = location.pathname.split('/').pop().replace('.html', '') || 'dashboard';
  document.querySelectorAll('.nav-item').forEach(item => {
    if (item.dataset.page === currentPage) {
      item.classList.add('active');
    }
  });
  
  // Update user info if provided
  if (user) {
    const name = user.displayName || user.email || 'Admin';
    const el = document.getElementById('sidebarAdminAvatar');
    if (el) el.textContent = (name)[0].toUpperCase();
    const nameEl = document.getElementById('sidebarAdminName');
    if (nameEl) nameEl.textContent = name;
    const roleEl = document.getElementById('sidebarAdminRole');
    if (roleEl) roleEl.textContent = user.isSuperAdmin ? '⭐ 超級管理員' : '👤 管理員';
  }
  
  // Logout handler
  const logoutBtn = document.getElementById('sidebarLogoutBtn');
  if (logoutBtn && window.AdminAuth) {
    logoutBtn.addEventListener('click', () => AdminAuth.signOut());
  }
}

window.injectSidebar = injectSidebar;