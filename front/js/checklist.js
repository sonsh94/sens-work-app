(() => {
  const state = {
    token: localStorage.getItem('x-access-token') || localStorage.getItem('token') || '',
    me: null,
    availableRows: [],
    currentEquipmentGroup: '',
    currentKind: '',
    checklist: null,
    dirty: false,
    collapsed: new Set(),
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

      renderHeader();
      pickDefaultSelection();
      renderEquipmentBoard();
      await loadChecklist();
    } catch (error) {
      console.error(error);
      showToast(error.message || '체크리스트 초기화 중 오류가 발생했습니다.', 'danger');
      els.checklistSections.className = 'empty-box empty-box--lg';
      els.checklistSections.textContent = error.message || '화면을 불러오지 못했습니다.';
    }
  }

  function cache() {
    Object.assign(els, {
      approvalLink: qs('approvalLink'),
      userBadge: qs('userBadge'),
      equipmentBoard: qs('equipmentBoard'),
      templateTitle: qs('templateTitle'),
      templateMeta: qs('templateMeta'),
      statusPill: qs('statusPill'),
      statusLabel: qs('statusLabel'),
      statusDate: qs('statusDate'),
      statusMessage: qs('statusMessage'),
      checklistSections: qs('checklistSections'),
      saveBtn: qs('saveBtn'),
      submitBtn: qs('submitBtn'),
      toast: qs('toast'),
    });
  }

  function bind() {
    els.saveBtn.addEventListener('click', () => saveChecklist('ACTIVE'));
    els.submitBtn.addEventListener('click', () => saveChecklist('SUBMITTED'));

    window.addEventListener('beforeunload', (e) => {
      if (!state.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  function renderHeader() {
    const user = state.me?.user || {};
    const engineer = state.me?.engineer || {};
    els.userBadge.textContent = `${engineer.name || user.nickname || '사용자'} · ${engineer.group || user.group || '-'} / ${engineer.site || user.site || '-'}`;
    els.approvalLink.classList.toggle('hidden', user.role !== 'admin');
  }

  function pickDefaultSelection() {
    if (state.currentEquipmentGroup && state.currentKind) return;
    const preferred = state.availableRows.find((row) => row.checklist_kind === 'SETUP') || state.availableRows[0];
    state.currentEquipmentGroup = preferred?.equipment_group_code || '';
    state.currentKind = preferred?.checklist_kind || 'SETUP';
  }

  function renderEquipmentBoard() {
    const grouped = new Map();
    for (const row of state.availableRows) {
      const code = row.equipment_group_code;
      if (!grouped.has(code)) {
        grouped.set(code, {
          code,
          name: row.equipment_group_name || code,
          rows: {},
        });
      }
      grouped.get(code).rows[row.checklist_kind] = row;
    }

    const items = [...grouped.values()];
    if (!items.length) {
      els.equipmentBoard.className = 'empty-box';
      els.equipmentBoard.textContent = '접근 가능한 설비가 없습니다.';
      return;
    }

    els.equipmentBoard.className = 'equipment-board';
    els.equipmentBoard.innerHTML = items.map((item) => {
      const setup = item.rows.SETUP || null;
      const maint = item.rows.MAINT || null;
      const setupSelected = state.currentEquipmentGroup === item.code && state.currentKind === 'SETUP';
      const maintSelected = state.currentEquipmentGroup === item.code && state.currentKind === 'MAINT';
      const cardSelected = state.currentEquipmentGroup === item.code;

      return `
        <article class="equipment-card ${cardSelected ? 'is-selected' : ''}">
          <div class="equipment-card__title">
            <strong>${escapeHtml(item.name)}</strong>
            <span>${escapeHtml(item.code)}</span>
          </div>
          <div class="kind-actions">
            ${renderKindButton(item.code, 'SETUP', setup, setupSelected)}
            ${renderKindButton(item.code, 'MAINT', maint, maintSelected)}
          </div>
        </article>
      `;
    }).join('');

    els.equipmentBoard.querySelectorAll('.kind-btn').forEach((button) => {
      if (button.disabled) return;
      button.addEventListener('click', async () => {
        const nextEquipment = button.dataset.eq;
        const nextKind = button.dataset.kind;

        if (state.currentEquipmentGroup === nextEquipment && state.currentKind === nextKind) return;
        if (state.dirty) {
          const proceed = window.confirm('저장되지 않은 변경사항이 있습니다. 이동하면 현재 변경사항이 사라집니다.');
          if (!proceed) return;
        }

        state.currentEquipmentGroup = nextEquipment;
        state.currentKind = nextKind;
        renderEquipmentBoard();
        await loadChecklist();
      });
    });
  }

  function renderKindButton(eqCode, kind, row, isSelected) {
    const disabled = !row;
    return `
      <button
        type="button"
        class="kind-btn ${isSelected ? 'is-selected' : ''} ${disabled ? 'is-disabled' : ''}"
        data-eq="${escapeAttr(eqCode)}"
        data-kind="${escapeAttr(kind)}"
        ${disabled ? 'disabled' : ''}
      >
        <b>${kind}</b>
        <small>${disabled ? '템플릿 없음' : getStatusText(row.response_status || 'ACTIVE')}</small>
      </button>
    `;
  }

  async function loadChecklist() {
    if (!state.currentEquipmentGroup || !state.currentKind) {
      els.checklistSections.className = 'empty-box empty-box--lg';
      els.checklistSections.textContent = '선택 가능한 체크리스트가 없습니다.';
      return;
    }

    setButtonsDisabled(true);
    setStatusState('loading', '불러오는 중', '체크리스트를 불러오는 중입니다.', '-');
    els.checklistSections.className = 'empty-box empty-box--lg';
    els.checklistSections.textContent = '체크리스트를 불러오는 중입니다.';

    try {
      const data = await api(`/api/checklists/my?equipment_group=${encodeURIComponent(state.currentEquipmentGroup)}&kind=${encodeURIComponent(state.currentKind)}`);
      state.checklist = data;
      state.dirty = false;
      state.collapsed.clear();
      renderCurrentChecklist();
    } finally {
      if (state.checklist?.permission) updateActionButtons(state.checklist.permission);
      else setButtonsDisabled(false);
    }
  }

  function renderCurrentChecklist() {
    const template = state.checklist?.template || {};
    const response = state.checklist?.response || {};
    const permission = state.checklist?.permission || {};
    const status = String(response.response_status || 'ACTIVE').toUpperCase();

    els.templateTitle.textContent = template.equipment_group_name || template.equipment_group_code || '체크리스트';
    els.templateMeta.textContent = `${template.checklist_kind || state.currentKind} · ${template.template_name || '현재 활성 템플릿'}`;

    const statusDate = response.approved_at || response.rejected_at || response.submitted_at || response.updated_at || template.updated_at || null;
    setStatusState(status.toLowerCase(), getStatusText(status), buildStatusMessage(status, response), formatDateTime(statusDate));

    if (!Array.isArray(state.checklist?.sections) || !state.checklist.sections.length) {
      els.checklistSections.className = 'empty-box empty-box--lg';
      els.checklistSections.textContent = '표시할 질문이 없습니다.';
      updateActionButtons(permission);
      return;
    }

    els.checklistSections.className = 'section-stack';
    els.checklistSections.innerHTML = state.checklist.sections.map((section, index) => renderSection(section, index + 1)).join('');

    els.checklistSections.querySelectorAll('.section-head').forEach((head) => {
      head.addEventListener('click', () => {
        const code = head.dataset.sectionCode;
        toggleSection(code);
      });
    });

    els.checklistSections.querySelectorAll('.question-check').forEach((checkbox) => {
      checkbox.addEventListener('change', handleToggle);
    });

    updateActionButtons(permission);
  }

  function renderSection(section, index) {
    return `
      <article class="section-card ${state.collapsed.has(section.section_code) ? 'is-collapsed' : ''}" data-section-code="${escapeAttr(section.section_code)}">
        <div class="section-head" data-section-code="${escapeAttr(section.section_code)}">
          <div class="section-head__left">
            <div class="section-index">${index}</div>
            <div>
              <h3>${escapeHtml(section.section_name)}</h3>
              <p>${section.questions.length}개 항목</p>
            </div>
          </div>
          <div class="section-toggle">${state.collapsed.has(section.section_code) ? '펼치기' : '접기'}</div>
        </div>
        <div class="section-body">
          ${section.questions.map((question, qIndex) => renderQuestion(question, index, qIndex + 1)).join('')}
        </div>
      </article>
    `;
  }

  function renderQuestion(question, sectionIndex, questionIndex) {
    return `
      <label class="question-row ${question.is_checked ? 'is-checked' : ''}">
        <input
          class="question-check"
          type="checkbox"
          data-question-id="${question.id}"
          ${question.is_checked ? 'checked' : ''}
        />
        <div class="question-copy">
          <div class="question-label">
            <code>${escapeHtml(question.question_code || `${sectionIndex}-${questionIndex}`)}</code>
            <span>${sectionIndex}.${questionIndex}</span>
          </div>
          <div class="question-text">${escapeHtml(question.question_text)}</div>
        </div>
        <span class="question-state">${question.is_checked ? '완료' : '미완료'}</span>
      </label>
    `;
  }

  function handleToggle(event) {
    const checkbox = event.currentTarget;
    const row = checkbox.closest('.question-row');
    row.classList.toggle('is-checked', checkbox.checked);
    const stateEl = row.querySelector('.question-state');
    if (stateEl) stateEl.textContent = checkbox.checked ? '완료' : '미완료';
    state.dirty = true;
  }

  function toggleSection(code) {
    const card = els.checklistSections.querySelector(`.section-card[data-section-code="${cssEscape(code)}"]`);
    if (!card) return;
    const collapsed = card.classList.toggle('is-collapsed');
    if (collapsed) state.collapsed.add(code);
    else state.collapsed.delete(code);
    const toggle = card.querySelector('.section-toggle');
    if (toggle) toggle.textContent = collapsed ? '펼치기' : '접기';
  }

  async function saveChecklist(nextStatus) {
    if (!state.checklist?.template) return;

    const message = nextStatus === 'SUBMITTED'
      ? '현재 체크 상태로 결재 요청하시겠습니까? 제출 후에는 승인 전까지 수정할 수 없습니다.'
      : '현재 체크 상태를 저장하시겠습니까?';

    if (!window.confirm(message)) return;

    setButtonsDisabled(true);
    try {
      const saved = await api('/api/checklists/my', {
        method: 'PUT',
        body: {
          equipment_group: state.currentEquipmentGroup,
          kind: state.currentKind,
          response_status: nextStatus,
          answers: collectAnswers(),
        },
      });

      state.checklist = saved;
      state.dirty = false;
      renderEquipmentBoardFromSaved(saved);
      renderEquipmentBoard();
      renderCurrentChecklist();
      if (nextStatus === 'SUBMITTED') {
        scrollToTop();
      }
      showToast(nextStatus === 'SUBMITTED' ? '결재 요청을 보냈습니다.' : '저장했습니다.');
    } catch (error) {
      console.error(error);
      showToast(error.message || '저장 중 오류가 발생했습니다.', 'danger');
    } finally {
      if (state.checklist?.permission) updateActionButtons(state.checklist.permission);
      else setButtonsDisabled(false);
    }
  }

  function renderEquipmentBoardFromSaved(saved) {
    if (!saved?.template) return;
    state.availableRows = state.availableRows.map((row) => {
      if (row.equipment_group_code === saved.template.equipment_group_code && row.checklist_kind === saved.template.checklist_kind) {
        const response = saved.response || {};
        return {
          ...row,
          response_status: response.response_status || 'ACTIVE',
          response_updated_at: response.updated_at || response.submitted_at || response.approved_at || response.rejected_at || row.response_updated_at,
          checked_count: saved?.summary?.checked_questions ?? row.checked_count,
          question_count: saved?.summary?.total_questions ?? row.question_count,
        };
      }
      return row;
    });
  }

  function collectAnswers() {
    return [...els.checklistSections.querySelectorAll('.question-check')].map((checkbox) => ({
      question_id: Number(checkbox.dataset.questionId),
      is_checked: checkbox.checked,
    }));
  }

  function updateActionButtons(permission) {
    const canEdit = true;
    const canSubmit = !!permission.can_submit;

    els.saveBtn.disabled = !canEdit;
    els.submitBtn.disabled = !canSubmit;

    els.checklistSections.querySelectorAll('.question-check').forEach((checkbox) => {
      checkbox.disabled = !canEdit;
    });
  }

  function setButtonsDisabled(disabled) {
    els.saveBtn.disabled = disabled;
    els.submitBtn.disabled = disabled;
  }

  function setStatusState(type, label, message, dateText) {
    els.statusPill.className = `status-pill status-pill--${type || 'idle'}`;
    els.statusPill.textContent = label || '-';
    els.statusLabel.textContent = label || '-';
    els.statusDate.textContent = dateText || '-';
    els.statusMessage.className = `status-message status-message--${type || 'idle'}`;
    els.statusMessage.textContent = message || '-';
  }

  function buildStatusMessage(status, response) {
    if (status === 'SUBMITTED') return '결재 요청이 제출된 상태입니다. 승인 또는 반려 전까지 수정할 수 없습니다.';
    if (status === 'APPROVED') return response?.decision_comment ? `승인 코멘트: ${response.decision_comment}` : '승인 완료 상태입니다.';
    if (status === 'REJECTED') return response?.decision_comment ? `반려 코멘트: ${response.decision_comment}` : '반려 상태입니다. 관리자 코멘트가 없습니다.';
    return '작성 중입니다. 체크 후 저장하거나 결재 요청할 수 있습니다.';
  }

  function getStatusText(status) {
    const map = {
      ACTIVE: '작성중',
      SUBMITTED: '결재 대기',
      APPROVED: '승인 완료',
      REJECTED: '반려',
      LOADING: '불러오는 중',
    };
    return map[String(status || '').toUpperCase()] || '대기';
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

  function cssEscape(value) {
    if (window.CSS?.escape) return window.CSS.escape(String(value));
    return String(value).replace(/"/g, '\\"');
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
