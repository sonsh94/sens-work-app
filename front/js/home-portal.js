(() => {
  'use strict';
  const primary = ['worklog_new.html', 'wl_read.html', 'work-history-search.html'];
  const competency = ['SECM_myself.html', 'CHECKLIST.html', 'pci.html', 'top10.html'];
  const level = ['lv-status.html', 'skill_levels.html', 'test.html'];
  const labels = {
    'worklog_new.html': ['작업이력 작성', '오늘 수행한 작업 등록'],
    'wl_read.html': ['작업이력 조회', '지난 작업 내역 확인'],
    'CHECKLIST.html': ['셀프체크리스트', '설비별 체크리스트 작성'],
    'SECM_myself.html': ['SECM', '개인 역량과 성장 확인'],
    'myworks-execution.html': ['MyWorks 완료율', '일일 작업 완료 현황'],
    'workload.html': ['Workload', '그룹·사이트별 업무량'],
    'pci.html': ['PCI', '작업항목별 역량'],
    'top10.html': ['TOP10', '역량 현황'],
    'business.html': ['출장 관리', '국내·해외 출장'],
    'setupboard.html': ['SET UP 설비', '설치 설비 현황'],
    'work-history-search.html': ['작업이력 검색', '조건별 작업 검색'],
    'skill_levels.html': ['레벨인증', 'LEVEL Certification'],
    'test.html': ['레벨평가', "Eng'r Level Test"],
    'admin_user_create.html': ['계정 관리', '가입 승인·사용자 관리'],
    'analysis.html': ['인원 운영 분석', 'Predicted Workers'],
    'work-item-edit-admin.html': ['기간 수정 이력', '작업이력 수정 관리'],
  };
  const filename = node => {
    try { return new URL(node.getAttribute('href'), location.href).pathname.split('/').pop(); }
    catch { return ''; }
  };
  const visible = node => !node.hidden && !node.classList.contains('hidden')
    && node.style.display !== 'none' && getComputedStyle(node).display !== 'none';
  const icon = (shape) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + shape + '</svg>';
  const icons = {
    home: icon('<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-7h6v7"/>'),
    work: icon('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>'),
    skill: icon('<path d="m3 7 9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4"/>'),
    chart: icon('<path d="M4 20V11M10 20V4M16 20V8M22 20H2"/>'),
    other: icon('<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="3" width="6" height="6" rx="1"/><rect x="3" y="15" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/>'),
    settings: icon('<circle cx="12" cy="12" r="3"/><path d="m9 3 1-1h4l1 3 3 1 3 1v4l-2 2-1 3-1 3h-4l-2-2-3-1-3-1v-4l2-2 1-3z"/>'),
  };
  function init() {
    const launcher = document.getElementById('launcher');
    const source = launcher?.querySelector('.grid');
    if (!launcher || !source || document.getElementById('home-portal')) return;
    const portal = document.createElement('div');
    portal.id = 'home-portal';
    portal.innerHTML = `
      <aside class="portal-sidebar" aria-label="업무 메뉴">
        <nav class="portal-nav">
          <a class="is-current" href="./index.html" aria-current="page">${icons.home}<span>홈</span></a>
          <a href="#portal-primary">${icons.work}<span>작업이력</span></a>
          <a href="#portal-competency">${icons.skill}<span>역량</span></a>
          <a href="#portal-level">${icons.chart}<span>LEVEL</span></a>
          <a href="#portal-extra">${icons.other}<span>기타 업무</span></a>
        </nav>
        <details class="portal-admin" id="portal-admin" hidden>
          <summary>${icons.settings}<span>관리자 도구</span><span class="portal-chevron">⌄</span></summary>
          <div id="portal-admin-links" class="portal-admin-links"></div>
        </details>
      </aside>
      <div class="portal-main">
        <header class="portal-greeting">
          <p class="portal-eyebrow">현장 업무 포털</p>
          <h1 id="portal-greeting">오늘의 업무를 시작하세요</h1>
          <p>오늘 필요한 업무를 빠르게 시작하세요.</p>
        </header>
        <section id="portal-primary" aria-labelledby="portal-primary-title">
          <h2 id="portal-primary-title">작업 이력</h2>
          <div class="portal-analysis-grid portal-category-grid" id="portal-primary-links"></div>
        </section>
        <section id="portal-competency" aria-labelledby="portal-competency-title" hidden>
          <h2 id="portal-competency-title">역량</h2>
          <div class="portal-analysis-grid portal-category-grid" id="portal-competency-links"></div>
        </section>
        <section id="portal-level" aria-labelledby="portal-level-title" hidden>
          <h2 id="portal-level-title">LEVEL</h2>
          <div class="portal-analysis-grid portal-category-grid" id="portal-level-links"></div>
        </section>
        <details class="portal-extra" id="portal-extra" hidden>
          <summary><strong>기타 업무</strong><span class="portal-extra-hint">출장 · 현장 지원 · 평가</span><span class="portal-chevron">⌄</span></summary>
          <div class="portal-extra-grid" id="portal-extra-links"></div>
        </details>
      </div>`;
    launcher.querySelector('.inner').append(portal);
    const buckets = {
      primary: document.getElementById('portal-primary-links'),
      competency: document.getElementById('portal-competency-links'),
      level: document.getElementById('portal-level-links'),
      admin: document.getElementById('portal-admin-links'),
      extra: document.getElementById('portal-extra-links'),
    };
    const known = new Set();
    function decorate(node, key) {
      if (!node.dataset.portalDecorated) {
        const definition = labels[key];
        const title = Array.from(node.children).find(el => el.tagName === 'SPAN' && !el.classList.contains('signup-pending-badge'));
        if (title) {
          title.classList.add('portal-link-title');
          if (definition) title.textContent = definition[0];
        }
        let description = node.querySelector('small');
        if (definition) {
          if (!description) { description = document.createElement('small'); node.append(description); }
          description.textContent = definition[1];
        }
        node.dataset.portalDecorated = '1';
      }
    }
    function reconcile() {
      const incoming = Array.from(source.querySelectorAll('a.app'));
      for (const node of incoming) {
        const key = filename(node);
        const category = primary.includes(key) ? 'primary'
          : competency.includes(key) ? 'competency'
          : level.includes(key) ? 'level'
          : node.classList.contains('admin-only') || node.classList.contains('beta-owner-only') ? 'admin' : 'extra';
        decorate(node, key);
        node.dataset.portalCategory = category;
        known.add(node);
        buckets[category].append(node);
      }
      for (const [category, order] of [['primary', primary], ['competency', competency], ['level', level]]) {
        for (const key of order) {
          for (const node of Array.from(buckets[category].children)) {
            if (filename(node) === key) buckets[category].append(node);
          }
        }
      }
      const has = category => Array.from(buckets[category].children).some(visible);
      document.getElementById('portal-primary').hidden = !has('primary');
      document.getElementById('portal-competency').hidden = !has('competency');
      document.getElementById('portal-level').hidden = !has('level');
      document.getElementById('portal-extra').hidden = !has('extra');
      document.getElementById('portal-admin').hidden = !has('admin');
      for (const link of portal.querySelectorAll('a[href="#portal-primary"],a[href="#portal-competency"],a[href="#portal-level"],a[href="#portal-extra"]')) {
        const section = document.querySelector(link.getAttribute('href'));
        link.hidden = !section || section.hidden;
      }
    }
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(() => { queued = false; reconcile(); });
    };
    new MutationObserver(records => {
      if (records.some(record => record.type === 'childList' && record.target === source
        && Array.from(record.addedNodes).some(node => node.nodeType === 1)
        || record.type === 'attributes' && known.has(record.target))) schedule();
    }).observe(launcher, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    portal.querySelectorAll('a[href="#portal-extra"]').forEach(link => link.addEventListener('click', () => {
      document.getElementById('portal-extra').open = true;
    }));
    const brandTag = document.querySelector('.brand__tag');
    if (brandTag) brandTag.textContent = '현장 업무를 한곳에서';
    const login = document.getElementById('login-btn'), logout = document.getElementById('logout-btn');
    if (login) login.textContent = '로그인';
    if (logout) logout.textContent = '로그아웃';
    document.body.classList.add('home-portal');
    reconcile();
    const token = localStorage.getItem('x-access-token');
    if (token) fetch('/user-info', { headers: { 'x-access-token': token } })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        const info = data?.result || {};
        const name = String(info.NAME || info.name || info.nickname || '').trim();
        if (name) document.getElementById('portal-greeting').textContent = '안녕하세요, ' + name + '님';
      }).catch(() => {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

