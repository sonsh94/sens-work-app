(() => {
  const state = {
    token: localStorage.getItem('x-access-token') || localStorage.getItem('token') || '',
    me: null,
    availableRows: [],
    currentStatus: 'SUBMITTED',
    queue: [],
    selectedId: null,
    currentDetail: null,
    currentAccess: null,
    toastTimer: null,
  };

  const els = {};
  document.addEventListener('DOMContentLoaded', init);

  function qs(id) { return document.getElementById(id); }

  async function init() {
    cache();
    bind();

    try {
      const [me, available] = await Promise.all([
        api('/api/checklists/me'),
        api('/api/checklists/available'),
      ]);

      state.me = me;
      state.availableRows = Array.isArray(available?.rows) ? available.rows : [];
      const role = me?.user?.role;
      els.userBadge.textContent = `${me?.engineer?.name || me?.user?.nickname || '사용자'} · ${role || '-'}`;

      if (role !== 'admin') {
        document.body.innerHTML = '<div style="padding:40px;font-family:system-ui">관리자만 접근할 수 있습니다.</div>';
        return;
      }

      renderEquipmentFilter();
      updateTabs();
      await loadCounts();
      await loadQueue();
    } catch (error) {
      console.error(error);
      showToast(error.message || '결재 화면 초기화 중 오류가 발생했습니다.', 'danger');
    }
  }

  function cache() {
    Object.assign(els, {
      userBadge: qs('userBadge'),
      submittedCount: qs('submittedCount'),
      approvedCount: qs('approvedCount'),
      rejectedCount: qs('rejectedCount'),
      equipmentFilter: qs('equipmentFilter'),
      kindFilter: qs('kindFilter'),
      keywordInput: qs('keywordInput'),
      reloadBtn: qs('reloadBtn'),
      queueCountBadge: qs('queueCountBadge'),
      queueList: qs('queueList'),
      detailTitle: qs('detailTitle'),
      detailMeta: qs('detailMeta'),
      detailStatusPill: qs('detailStatusPill'),
      detailEngineer: qs('detailEngineer'),
      detailEquipment: qs('detailEquipment'),
      detailCompletion: qs('detailCompletion'),
      detailComment: qs('detailComment'),
      decisionComment: qs('decisionComment'),
      approveBtn: qs('approveBtn'),
      rejectBtn: qs('rejectBtn'),
      detailSections: qs('detailSections'),
      openAccessModalBtn: qs('openAccessModalBtn'),
      accessModal: qs('accessModal'),
      accessModalMeta: qs('accessModalMeta'),
      closeAccessModalBtn: qs('closeAccessModalBtn'),
      accessEquipmentSelect: qs('accessEquipmentSelect'),
      accessTypeSelect: qs('accessTypeSelect'),
      accessReasonInput: qs('accessReasonInput'),
      saveAccessBtn: qs('saveAccessBtn'),
      accessSummary: qs('accessSummary'),
      accessOverrideList: qs('accessOverrideList'),
      toast: qs('toast'),
      tabs: [...document.querySelectorAll('.status-tab')],
      modalClosers: [...document.querySelectorAll('[data-close-modal]')],
    });
  }

  function bind() {
    const reloadAll = async () => {
      state.selectedId = null;
      await loadCounts();
      await loadQueue();
    };

    els.tabs.forEach((tab) => {
      tab.addEventListener('click', async () => {
        if (state.currentStatus === tab.dataset.status) return;
        state.currentStatus = tab.dataset.status;
        state.selectedId = null;
        updateTabs();
        await loadQueue();
      });
    });

    els.equipmentFilter.addEventListener('change', reloadAll);
    els.kindFilter.addEventListener('change', reloadAll);
    els.keywordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') reloadAll();
    });
    els.reloadBtn.addEventListener('click', reloadAll);
    els.approveBtn.addEventListener('click', () => decide('APPROVED'));
    els.rejectBtn.addEventListener('click', () => decide('REJECTED'));
    els.openAccessModalBtn.addEventListener('click', openAccessModal);
    els.closeAccessModalBtn.addEventListener('click', closeAccessModal);
    els.saveAccessBtn.addEventListener('click', saveAccessOverride);
    els.accessSummary.addEventListener('click', onAccessSummaryClick);
    els.accessOverrideList.addEventListener('click', onOverrideListClick);

    els.modalClosers.forEach((node) => node.addEventListener('click', closeAccessModal));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.accessModal.classList.contains('hidden')) {
        closeAccessModal();
      }
    });
  }

  function renderEquipmentFilter() {
    const map = new Map();
    state.availableRows.forEach((row) => {
      if (!map.has(row.equipment_group_code)) {
        map.set(row.equipment_group_code, row.equipment_group_name || row.equipment_group_code);
      }
    });

    const options = ['<option value="">전체</option>'];
    [...map.entries()].forEach(([code, name]) => {
      options.push(`<option value="${escapeAttr(code)}">${escapeHtml(name)}</option>`);
    });
    els.equipmentFilter.innerHTML = options.join('');
  }

  function updateTabs() {
    els.tabs.forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.status === state.currentStatus);
    });
  }

  async function loadCounts() {
    const statuses = ['SUBMITTED', 'REJECTED', 'APPROVED'];
    const results = await Promise.all(statuses.map((status) => fetchQueue(status)));
    const countMap = new Map(results.map((result, index) => [statuses[index], Array.isArray(result?.rows) ? result.rows.length : 0]));

    els.submittedCount.textContent = countMap.get('SUBMITTED') || 0;
    els.rejectedCount.textContent = countMap.get('REJECTED') || 0;
    els.approvedCount.textContent = countMap.get('APPROVED') || 0;

    results.forEach((result) => mergeEquipmentOptions(Array.isArray(result?.rows) ? result.rows : []));
  }

  async function fetchQueue(status) {
    const params = new URLSearchParams();
    params.set('status', status);
    if (els.equipmentFilter.value) params.set('equipment_group', els.equipmentFilter.value);
    if (els.kindFilter.value) params.set('kind', els.kindFilter.value);
    if (els.keywordInput.value.trim()) params.set('keyword', els.keywordInput.value.trim());
    return api(`/api/checklists/admin/requests?${params.toString()}`);
  }

  async function loadQueue() {
    setBusy(true);
    try {
      const data = await fetchQueue(state.currentStatus);
      state.queue = Array.isArray(data?.rows) ? data.rows : [];
      mergeEquipmentOptions(state.queue);
      renderQueue();

      if (state.selectedId && state.queue.some((row) => row.response_id === state.selectedId)) {
        await loadDetail(state.selectedId);
      } else if (state.queue[0]) {
        await loadDetail(state.queue[0].response_id);
      } else {
        clearDetail();
      }
    } catch (error) {
      console.error(error);
      showToast(error.message || '결재 목록 조회 중 오류가 발생했습니다.', 'danger');
    } finally {
      setBusy(false);
    }
  }

  function mergeEquipmentOptions(rows) {
    const existing = new Map([...els.equipmentFilter.options].map((option) => [option.value, option.textContent]));
    rows.forEach((row) => {
      if (!existing.has(row.equipment_group_code)) {
        existing.set(row.equipment_group_code, row.equipment_group_name || row.equipment_group_code);
      }
    });

    const currentValue = els.equipmentFilter.value;
    const options = ['<option value="">전체</option>'];
    [...existing.entries()]
      .filter(([value]) => value)
      .sort((a, b) => a[1].localeCompare(b[1], 'ko'))
      .forEach(([code, name]) => {
        options.push(`<option value="${escapeAttr(code)}">${escapeHtml(name)}</option>`);
      });
    els.equipmentFilter.innerHTML = options.join('');
    els.equipmentFilter.value = currentValue;
  }

  function renderQueue() {
    els.queueCountBadge.textContent = `${state.queue.length}건`;

    if (!state.queue.length) {
      els.queueList.className = 'queue-list empty-box';
      els.queueList.textContent = '해당 조건의 체크리스트가 없습니다.';
      return;
    }

    els.queueList.className = 'queue-list';
    els.queueList.innerHTML = state.queue.map((row) => {
      const when = row.approved_at || row.rejected_at || row.submitted_at || row.updated_at;
      const percent = row.total_questions
        ? Math.round((Number(row.checked_questions || 0) / Number(row.total_questions || 0)) * 1000) / 10
        : 0;

      return `
        <button type="button" class="queue-item ${row.response_id === state.selectedId ? 'is-active' : ''}" data-id="${row.response_id}">
          <div class="queue-item__top">
            <strong>${escapeHtml(row.engineer_name || '-')}</strong>
            <span class="status-pill status-pill--${String(row.response_status || '').toLowerCase()}">${escapeHtml(getStatusText(row.response_status))}</span>
          </div>
          <p class="queue-item__sub">${escapeHtml(row.equipment_group_name || row.equipment_group_code || '-')} · ${escapeHtml(row.checklist_kind || '-')}</p>
          <div class="queue-item__meta">
            <span>${percent}%</span>
            <span>${escapeHtml(formatDateTime(when))}</span>
          </div>
        </button>
      `;
    }).join('');

    els.queueList.querySelectorAll('.queue-item').forEach((button) => {
      button.addEventListener('click', async () => {
        await loadDetail(Number(button.dataset.id));
      });
    });
  }

  async function loadDetail(responseId) {
    if (!responseId) return;
    try {
      const data = await api(`/api/checklists/admin/requests/${responseId}`);
      state.selectedId = responseId;
      state.currentDetail = data;
      renderQueue();
      renderDetail(data);
    } catch (error) {
      console.error(error);
      showToast(error.message || '상세 조회 중 오류가 발생했습니다.', 'danger');
    }
  }

  function renderDetail(data) {
    const template = data?.template || {};
    const engineer = data?.engineer || {};
    const response = data?.response || {};
    const summary = data?.summary || {};

    els.detailTitle.textContent = template.template_name || '상세 정보';
    els.detailMeta.textContent = `${template.equipment_group_name || template.equipment_group_code || '-'} · ${template.checklist_kind || '-'} · v${template.version_no || 1}`;
    els.detailStatusPill.className = `status-pill status-pill--${String(response.response_status || '').toLowerCase()}`;
    els.detailStatusPill.textContent = getStatusText(response.response_status || '-');

    els.detailEngineer.textContent = `${engineer.name || '-'} · ${engineer.group || '-'} / ${engineer.site || '-'}`;
    els.detailEquipment.textContent = `${template.equipment_group_name || template.equipment_group_code || '-'} / ${template.checklist_kind || '-'}`;
    els.detailCompletion.textContent = `${summary.completion_rate || 0}% (${summary.checked_questions || 0}/${summary.total_questions || 0})`;
    els.detailComment.textContent = response.decision_comment || '-';
    els.decisionComment.value = response.decision_comment || '';
    els.openAccessModalBtn.disabled = !engineer.id;

    const canApprove = !!data?.permission?.can_approve;
    els.approveBtn.disabled = !canApprove;
    els.rejectBtn.disabled = !canApprove;

    if (!Array.isArray(data?.sections) || !data.sections.length) {
      els.detailSections.className = 'detail-sections empty-box empty-box--lg';
      els.detailSections.textContent = '표시할 상세 질문이 없습니다.';
      return;
    }

    els.detailSections.className = 'detail-sections';
    els.detailSections.innerHTML = data.sections.map((section, sectionIndex) => {
      const percent = Number(section?.summary?.completion_rate || 0);
      return `
        <article class="detail-section">
          <div class="detail-section__head">
            <div>
              <h3>${sectionIndex + 1}. ${escapeHtml(section.section_name)}</h3>
              <p>${section.summary.checked_questions}/${section.summary.total_questions} 완료</p>
            </div>
            <div style="width:min(220px,32%)">
              <div class="mini-bar"><span style="width:${percent}%"></span></div>
            </div>
          </div>
          <div class="detail-question-list">
            ${section.questions.map((question, questionIndex) => `
              <div class="detail-question ${question.is_checked ? 'is-checked' : ''}">
                <div class="detail-question__meta">
                  <span>${sectionIndex + 1}.${questionIndex + 1}</span>
                  <code>${escapeHtml(question.question_code || '-')}</code>
                  <b>${question.is_checked ? '완료' : '미완료'}</b>
                </div>
                <p>${escapeHtml(question.question_text || '')}</p>
              </div>
            `).join('')}
          </div>
        </article>
      `;
    }).join('');
  }

  async function decide(decision) {
    if (!state.selectedId) {
      showToast('결재 대상을 먼저 선택하세요.', 'danger');
      return;
    }

    const message = decision === 'APPROVED' ? '이 체크리스트를 승인하시겠습니까?' : '이 체크리스트를 반려하시겠습니까?';
    if (!window.confirm(message)) return;

    try {
      await api(`/api/checklists/admin/requests/${state.selectedId}/decision`, {
        method: 'POST',
        body: {
          decision,
          comment: els.decisionComment.value.trim(),
        },
      });
      await loadCounts();
      await loadQueue();
      scrollToTop();
      showToast(decision === 'APPROVED' ? '승인 처리했습니다.' : '반려 처리했습니다.');
    } catch (error) {
      console.error(error);
      showToast(error.message || '결재 처리 중 오류가 발생했습니다.', 'danger');
    }
  }

  async function openAccessModal() {
    const engineerId = state.currentDetail?.engineer?.id;
    if (!engineerId) {
      showToast('체크리스트를 먼저 선택하세요.', 'danger');
      return;
    }

    try {
      els.accessSummary.className = 'access-summary empty-box';
      els.accessSummary.textContent = '권한 정보를 불러오는 중입니다.';
      els.accessOverrideList.className = 'override-list empty-box';
      els.accessOverrideList.textContent = '권한 정보를 불러오는 중입니다.';
      els.accessModal.classList.remove('hidden');
      els.accessModal.setAttribute('aria-hidden', 'false');

      const data = await api(`/api/checklists/admin/access?engineer_id=${encodeURIComponent(engineerId)}`);
      state.currentAccess = data;
      renderAccessModal(data);
    } catch (error) {
      console.error(error);
      showToast(error.message || '권한 예외 정보를 불러오지 못했습니다.', 'danger');
      closeAccessModal();
    }
  }

  function closeAccessModal() {
    els.accessModal.classList.add('hidden');
    els.accessModal.setAttribute('aria-hidden', 'true');
  }

  function renderAccessModal(data) {
    const engineer = data?.engineer || {};
    const fixedEquipment = data?.policy === 'REGISTERED_EQUIPMENT';
    [els.accessEquipmentSelect, els.accessTypeSelect, els.accessReasonInput, els.saveAccessBtn].forEach((el) => { el.disabled = fixedEquipment; });
    const finalAccess = Array.isArray(data?.final_access) ? data.final_access : [];
    const defaultAccess = new Map((Array.isArray(data?.default_access) ? data.default_access : []).map((row) => [row.code, !!row.allowed]));
    const overrideMap = new Map((Array.isArray(data?.overrides) ? data.overrides : []).map((row) => [row.equipment_group_code, row]));

    els.accessModalMeta.textContent = `${engineer.name || '-'} · ${engineer.group || '-'} / ${engineer.site || '-'} · ${fixedEquipment ? '본인의 메인/멀티설비만 사용할 수 있습니다.' : '등록된 설비 권한을 확인하세요.'}`;
    els.accessEquipmentSelect.innerHTML = finalAccess.map((row) => `<option value="${escapeAttr(row.code)}">${escapeHtml(row.display_name || row.code)}</option>`).join('');
    els.accessTypeSelect.value = 'ALLOW';
    els.accessReasonInput.value = '';

    if (!finalAccess.length) {
      els.accessSummary.className = 'access-summary empty-box';
      els.accessSummary.textContent = '설비 권한 정보가 없습니다.';
    } else {
      els.accessSummary.className = 'access-summary';
      els.accessSummary.innerHTML = finalAccess.map((row) => {
        const override = overrideMap.get(row.code);
        const baseAllowed = !!defaultAccess.get(row.code);
        const finalAllowed = !!row.allowed;
        return `
          <article class="access-card">
            <div class="access-card__top">
              <div>
                <strong>${escapeHtml(row.display_name || row.code)}</strong>
                <div class="access-card__code">${escapeHtml(row.code)}</div>
              </div>
              ${override ? `<span class="access-badge ${override.access_type === 'ALLOW' ? 'is-allow' : 'is-deny'}">예외 ${escapeHtml(override.access_type)}</span>` : ''}
            </div>
            <div class="access-badges">
              <span class="access-badge ${baseAllowed ? 'is-allow' : 'is-deny'}">기본 ${baseAllowed ? '허용' : '차단'}</span>
              <span class="access-badge ${finalAllowed ? 'is-allow' : 'is-deny'}">최종 ${finalAllowed ? '허용' : '차단'}</span>
            </div>
            <p>${escapeHtml(fixedEquipment ? (finalAllowed ? '본인 메인/멀티 등록 설비' : '본인 메인/멀티 외 설비') : (override?.reason || '등록된 예외 사유 없음'))}</p>
            <div class="access-card__actions" style="${fixedEquipment ? 'display:none' : ''}">
              <button type="button" class="btn btn-line access-pick-btn" data-eq="${escapeAttr(row.code)}" data-type="${escapeAttr(override?.access_type || (finalAllowed ? 'ALLOW' : 'DENY'))}" data-reason="${escapeAttr(override?.reason || '')}">이 설비 편집</button>
              ${override ? `<button type="button" class="btn btn-line access-remove-btn" data-eq="${escapeAttr(row.code)}">예외 삭제</button>` : ''}
            </div>
          </article>
        `;
      }).join('');
    }

    const overrides = Array.isArray(data?.overrides) ? data.overrides : [];
    if (!overrides.length) {
      els.accessOverrideList.className = 'override-list empty-box';
      els.accessOverrideList.textContent = fixedEquipment ? '메인/멀티설비 등록값에 고정됩니다. 기존 그룹 권한과 예외는 적용하지 않습니다.' : '등록된 예외가 없습니다.';
      return;
    }

    els.accessOverrideList.className = 'override-list';
    els.accessOverrideList.innerHTML = overrides.map((row) => `
      <article class="override-item">
        <div class="override-item__meta">
          <strong>${escapeHtml(findEquipmentName(row.equipment_group_code, finalAccess))}</strong>
          <p>${escapeHtml(row.equipment_group_code)} · ${escapeHtml(row.access_type)}</p>
          <span>${escapeHtml(row.reason || '사유 없음')} · ${escapeHtml(formatDateTime(row.updated_at || row.created_at))}</span>
        </div>
        <button type="button" class="btn btn-line access-remove-btn" data-eq="${escapeAttr(row.equipment_group_code)}">삭제</button>
      </article>
    `).join('');
  }

  function onAccessSummaryClick(event) {
    const pickBtn = event.target.closest('.access-pick-btn');
    if (pickBtn) {
      els.accessEquipmentSelect.value = pickBtn.dataset.eq || '';
      els.accessTypeSelect.value = pickBtn.dataset.type || 'ALLOW';
      els.accessReasonInput.value = pickBtn.dataset.reason || '';
      els.accessReasonInput.focus();
      return;
    }

    const removeBtn = event.target.closest('.access-remove-btn');
    if (removeBtn) {
      deleteAccessOverride(removeBtn.dataset.eq);
    }
  }

  function onOverrideListClick(event) {
    const removeBtn = event.target.closest('.access-remove-btn');
    if (!removeBtn) return;
    deleteAccessOverride(removeBtn.dataset.eq);
  }

  async function saveAccessOverride() {
    const engineerId = state.currentAccess?.engineer?.id;
    const equipmentGroup = els.accessEquipmentSelect.value;
    const accessType = els.accessTypeSelect.value;
    const reason = els.accessReasonInput.value.trim();

    if (!engineerId || !equipmentGroup) {
      showToast('설비와 대상을 먼저 확인하세요.', 'danger');
      return;
    }

    try {
      const data = await api('/api/checklists/admin/access', {
        method: 'PUT',
        body: {
          engineer_id: engineerId,
          equipment_group: equipmentGroup,
          access_type: accessType,
          reason,
        },
      });
      state.currentAccess = data;
      renderAccessModal(data);
      showToast('권한 예외를 저장했습니다.');
    } catch (error) {
      console.error(error);
      showToast(error.message || '권한 예외 저장 중 오류가 발생했습니다.', 'danger');
    }
  }

  async function deleteAccessOverride(equipmentGroup) {
    const engineerId = state.currentAccess?.engineer?.id;
    if (!engineerId || !equipmentGroup) return;
    if (!window.confirm('이 설비에 대한 예외를 삭제하시겠습니까?')) return;

    try {
      const data = await api(`/api/checklists/admin/access/${encodeURIComponent(engineerId)}/${encodeURIComponent(equipmentGroup)}`, {
        method: 'DELETE',
      });
      state.currentAccess = data;
      renderAccessModal(data);
      showToast('권한 예외를 삭제했습니다.');
    } catch (error) {
      console.error(error);
      showToast(error.message || '권한 예외 삭제 중 오류가 발생했습니다.', 'danger');
    }
  }

  function clearDetail() {
    state.selectedId = null;
    state.currentDetail = null;
    els.detailTitle.textContent = '항목을 선택하세요.';
    els.detailMeta.textContent = '왼쪽 목록에서 한 건을 선택하면 상세가 표시됩니다.';
    els.detailStatusPill.className = 'status-pill status-pill--idle';
    els.detailStatusPill.textContent = '-';
    els.detailEngineer.textContent = '-';
    els.detailEquipment.textContent = '-';
    els.detailCompletion.textContent = '-';
    els.detailComment.textContent = '-';
    els.decisionComment.value = '';
    els.approveBtn.disabled = true;
    els.rejectBtn.disabled = true;
    els.openAccessModalBtn.disabled = true;
    els.detailSections.className = 'detail-sections empty-box empty-box--lg';
    els.detailSections.textContent = '상세 체크리스트가 여기에 표시됩니다.';
  }

  function setBusy(disabled) {
    els.reloadBtn.disabled = disabled;
    els.equipmentFilter.disabled = disabled;
    els.kindFilter.disabled = disabled;
  }

  function getStatusText(status) {
    const map = {
      SUBMITTED: '결재 대기',
      REJECTED: '반려',
      APPROVED: '승인 완료',
      ACTIVE: '작성중',
    };
    return map[String(status || '').toUpperCase()] || String(status || '-');
  }

  function findEquipmentName(code, rows) {
    const found = (rows || []).find((row) => row.code === code);
    return found?.display_name || code;
  }

  async function api(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      ...(state.token ? { 'x-access-token': state.token, Authorization: `Bearer ${state.token}` } : {}),
      ...(options.headers || {}),
    };

    const res = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'include',
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data?.error || data?.message || '요청 처리 실패');
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  }

  function showToast(message, type = 'success') {
    clearTimeout(state.toastTimer);
    els.toast.textContent = message;
    els.toast.className = `toast toast--${type}`;
    els.toast.classList.remove('hidden');
    state.toastTimer = setTimeout(() => {
      els.toast.classList.add('hidden');
    }, 2600);
  }

  function formatDateTime(value) {
    if (!value) return '-';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/"/g, '&quot;');
  }
})();
