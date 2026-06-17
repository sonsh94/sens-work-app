document.addEventListener('DOMContentLoaded', function () {
    const API_BASE_URL = 'http://13.125.122.202:3001';

    // =========================
    // 기존 화면 DOM
    // =========================
    const checkWarrantyButton = document.getElementById('check-warranty');
    const editInfoButton = document.getElementById('edit-info');
    const saveInfoButton = document.getElementById('save-info');

    const equipmentNameInput = document.getElementById('equipment_name');
    const groupSelect = document.getElementById('group');
    const siteSelect = document.getElementById('site');
    const lineSelect = document.getElementById('line');
    const equipmentTypeSelect = document.getElementById('equipment_type');
    const warrantySelect = document.getElementById('warranty');
    const infoTextarea = document.getElementById('info');
    const taskDateInput = document.getElementById('task_date');

    // =========================
    // 신규 설비 추가 모달 DOM
    // =========================
    const addModal = document.getElementById('equipment-add-modal');
    const confirmEquipmentAdd = document.getElementById('confirm-equipment-add');
    const cancelEquipmentAdd = document.getElementById('cancel-equipment-add');
    const closeModalButton = document.querySelector('.equipment-add-modal-close');

    const newEqname = document.getElementById('new_eqname');
    const newGroup = document.getElementById('new_group');
    const newSite = document.getElementById('new_site');
    const newLine = document.getElementById('new_line');
    const newType = document.getElementById('new_type');
    const newWarranty = document.getElementById('new_warranty');
    const newInfo = document.getElementById('new_info');

    // HTML에 있을 수도 있고 없을 수도 있는 필드
    const newFloor = document.getElementById('new_floor');
    const newBay = document.getElementById('new_bay');
    const newStartDate = document.getElementById('new_start_date');
    const newEndDate = document.getElementById('new_end_date');

    // =========================
    // 필수 요소 확인
    // =========================
    const requiredElements = {
        checkWarrantyButton,
        equipmentNameInput,
        groupSelect,
        siteSelect,
        lineSelect,
        equipmentTypeSelect,
        warrantySelect,
        addModal,
        confirmEquipmentAdd,
        cancelEquipmentAdd,
        closeModalButton,
        newEqname,
        newGroup,
        newSite,
        newLine,
        newType,
        newWarranty,
    };

    for (const [name, element] of Object.entries(requiredElements)) {
        if (!element) {
            console.error(`[equipmentwarranty.js] 필수 요소를 찾을 수 없습니다: ${name}`);
            return;
        }
    }

    // =========================
    // SITE별 LINE 옵션
    // =========================
    const LINE_OPTIONS = {
        PT: [
            'P1F',
            'P1D',
            'P2F',
            'P2D',
            'P2-S5',
            'P3F',
            'P3D',
            'P3-S5',
            'P4F',
            'P4D',
            'P4-S5',
            'Training',
        ],
        HS: [
            '1L',
            '12L',
            '13L',
            '15L',
            '16L',
            '17L',
            'S1',
            'S3',
            'S4',
            'S3V',
            'NRD',
            'NRDK',
            'NRD-V',
            'U4',
            'M1',
            '5L',
            'G1L',
            'Training',
        ],
        IC: ['M10', 'M14', 'M16', 'R3', 'Training'],
        CJ: ['M11', 'M12', 'M15', 'Training'],
        PSKH: ['PSKH', 'C1', 'C2', 'C3', 'C5', 'Training'],

        'USA-Portland': ['INTEL', 'Training'],
        'USA-Arizona': ['INTEL', 'Training'],
        'USA-Texas': ['Texas Instrument', 'Training'],

        Ireland: ['INTEL', 'Training'],
        'Japan-Hiroshima': ['MICRON', 'Training'],

        'China-Wuxi': ['MICRON', 'HYNIX', 'Training'],
        'China-Xian': ['MICRON', 'HYNIX', 'SAMSUNG', 'Training'],
        'China-Shanghai': ['MICRON', 'GTX', 'Training'],
        'China-Beijing': ['JIDIAN', 'Training'],

        'Taiwan-Taichoung': ['MICRON', 'Training'],
        'Taiwan-Linkou': ['MICRON', 'Training'],
        Singapore: ['MICRON', 'Training'],
        Training: ['Training', 'TRAINING'],
    };

    // =========================
    // 유틸 함수
    // =========================
    function getValue(element, defaultValue = '') {
        if (!element) return defaultValue;
        return String(element.value || '').trim();
    }

    function isEmptySelectValue(value) {
        return value === '' || value === 'SELECT' || value === 'select';
    }

    function todayString() {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    }

    function setSelectValueIfExists(selectElement, value) {
        if (!selectElement) return;

        const safeValue = value || '';

        const exists = Array.from(selectElement.options).some(option => {
            return option.value === safeValue || option.textContent === safeValue;
        });

        if (exists) {
            selectElement.value = safeValue;
        }
    }

    function fillLineOptions(targetSelect, selectedSite, defaultOptionValue = '') {
        if (!targetSelect) return;

        const site = String(selectedSite || '').trim();

        targetSelect.innerHTML = '';

        const defaultOption = document.createElement('option');
        defaultOption.value = defaultOptionValue;
        defaultOption.textContent = 'SELECT';
        targetSelect.appendChild(defaultOption);

        if (!site || !LINE_OPTIONS[site]) {
            targetSelect.disabled = true;
            return;
        }

        LINE_OPTIONS[site].forEach(line => {
            const option = document.createElement('option');
            option.value = line;
            option.textContent = line;
            targetSelect.appendChild(option);
        });

        targetSelect.disabled = false;
    }

    function updateNewLineOptions() {
        fillLineOptions(newLine, newSite.value, '');
        validateAddForm();
    }

    function updateMainLineOptions() {
        fillLineOptions(lineSelect, siteSelect.value, 'SELECT');
    }

    function validateAddForm() {
        const requiredFields = [newEqname, newGroup, newSite, newLine, newType, newWarranty];

        const isValid = requiredFields.every(field => {
            const value = getValue(field);
            return !isEmptySelectValue(value);
        });

        confirmEquipmentAdd.disabled = !isValid;
    }

    function openAddEquipmentModal() {
        console.log('🚨 설비 정보 없음 -> 설비 추가 모달 표시');

        // 입력한 EQ NAME 자동 복사
        newEqname.value = getValue(equipmentNameInput);

        // 메인 화면에서 이미 선택한 값이 있으면 신규 등록 모달에 복사
        if (!isEmptySelectValue(groupSelect.value)) {
            setSelectValueIfExists(newGroup, groupSelect.value);
        }

        if (!isEmptySelectValue(siteSelect.value)) {
            setSelectValueIfExists(newSite, siteSelect.value);
        }

        if (!isEmptySelectValue(equipmentTypeSelect.value)) {
            setSelectValueIfExists(newType, equipmentTypeSelect.value);
        }

        if (!isEmptySelectValue(warrantySelect.value)) {
            setSelectValueIfExists(newWarranty, warrantySelect.value);
        }

        updateNewLineOptions();

        if (!isEmptySelectValue(lineSelect.value)) {
            setSelectValueIfExists(newLine, lineSelect.value);
        }

        addModal.classList.add('active');
        addModal.style.display = 'flex';

        validateAddForm();
    }

    function closeAddModal() {
        console.log('✅ 모달 닫기');
        addModal.classList.remove('active');
        addModal.style.display = 'none';
    }

    function updateMainFields(equipmentData) {
        if (!equipmentData) return;

        groupSelect.value = equipmentData.GROUP || 'SELECT';
        siteSelect.value = equipmentData.SITE || 'SELECT';

        updateMainLineOptions();

        if (equipmentData.LINE) {
            setSelectValueIfExists(lineSelect, equipmentData.LINE);
        } else {
            lineSelect.value = 'SELECT';
        }

        equipmentTypeSelect.value = equipmentData.TYPE || 'SELECT';
        warrantySelect.value = equipmentData.WARRANTY_STATUS || 'SELECT';

        if (infoTextarea) {
            infoTextarea.value = equipmentData.INFO || '';
        }
    }

    // =========================
    // CHECK 버튼: 설비 조회
    // =========================
    checkWarrantyButton.addEventListener('click', function () {
        const equipmentName = getValue(equipmentNameInput);

        if (!equipmentName) {
            alert('설비명을 입력하세요.');
            return;
        }

        fetch(`${API_BASE_URL}/api/equipment?eqname=${encodeURIComponent(equipmentName)}`)
            .then(response => response.json())
            .then(data => {
                console.log('📡 서버 응답 데이터:', data);

                if (!Array.isArray(data) || data.length === 0) {
                    openAddEquipmentModal();
                    return;
                }

                const equipmentData = data.find(eq => {
                    return eq.EQNAME && eq.EQNAME.toLowerCase() === equipmentName.toLowerCase();
                });

                if (equipmentData) {
                    console.log('✅ 설비 정보 확인됨:', equipmentData);
                    updateMainFields(equipmentData);
                } else {
                    openAddEquipmentModal();
                }
            })
            .catch(error => {
                console.error('⚠️ 데이터 가져오기 오류:', error);
                alert('정보를 가져오는 데 오류가 발생했습니다. 다시 시도하세요.');
            });
    });

    // =========================
    // SITE 변경 시 LINE 옵션 갱신
    // =========================
    newSite.addEventListener('change', function () {
        updateNewLineOptions();
    });

    siteSelect.addEventListener('change', function () {
        updateMainLineOptions();
    });

    [newEqname, newGroup, newSite, newLine, newType, newWarranty].forEach(field => {
        field.addEventListener('input', validateAddForm);
        field.addEventListener('change', validateAddForm);
    });

    closeModalButton.addEventListener('click', closeAddModal);
    cancelEquipmentAdd.addEventListener('click', closeAddModal);

    // =========================
    // ADD 버튼: 신규 설비 등록
    // =========================
    confirmEquipmentAdd.addEventListener('click', async function () {
        const eqname = getValue(newEqname);
        const group = getValue(newGroup);
        const site = getValue(newSite);
        const line = getValue(newLine);
        const type = getValue(newType);
        const warrantyStatus = getValue(newWarranty);

        if (!eqname || !group || !site || !line || !type || !warrantyStatus) {
            alert('필수 항목을 모두 입력하세요.');
            return;
        }

        /*
          현재 신규 설비 모달에
          new_floor, new_bay, new_start_date, new_end_date 입력칸이 없을 수 있음.

          그래서 없는 경우 기본값 처리:
          - start_date: WORK DATE 값 → 없으면 오늘 날짜
          - end_date: 9999-12-31
        */
        const startDateValue =
            getValue(newStartDate) ||
            getValue(taskDateInput) ||
            todayString();

        const endDateValue =
            getValue(newEndDate) ||
            '9999-12-31';

        const equipmentData = {
            eqname: eqname,
            group: group,
            site: site,
            type: type,
            line: line,
            floor: getValue(newFloor),
            bay: getValue(newBay),
            start_date: startDateValue,
            end_date: endDateValue,
            warranty_status: warrantyStatus,
            info: getValue(newInfo),
        };

        console.log('📤 신규 설비 등록 요청 데이터:', equipmentData);

        try {
            const response = await fetch(`${API_BASE_URL}/api/equipment`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(equipmentData),
            });

            let result = {};
            try {
                result = await response.json();
            } catch (jsonError) {
                result = {};
            }

            if (!response.ok) {
                console.error('설비 추가 실패 응답:', result);
                alert('설비 추가 실패: ' + (result.error || result.details || response.status));
                return;
            }

            alert('설비가 추가되었습니다.');

            // 등록 성공 후 메인 화면에도 값 반영
            equipmentNameInput.value = eqname;
            groupSelect.value = group;
            siteSelect.value = site;

            updateMainLineOptions();
            setSelectValueIfExists(lineSelect, line);

            setSelectValueIfExists(equipmentTypeSelect, type);
            warrantySelect.value = warrantyStatus;

            if (infoTextarea) {
                infoTextarea.value = equipmentData.info || '';
            }

            closeAddModal();
        } catch (error) {
            console.error('설비 추가 오류:', error);
            alert('설비 추가 중 오류가 발생했습니다.');
        }
    });

    // =========================
    // INFO 수정 버튼
    // =========================
    if (editInfoButton && saveInfoButton && infoTextarea) {
        editInfoButton.addEventListener('click', function () {
            infoTextarea.disabled = false;
            saveInfoButton.style.display = 'inline-block';
            saveInfoButton.classList.remove('hidden');
            infoTextarea.focus();
        });
    }

    // =========================
    // INFO 저장 버튼
    // =========================
    if (saveInfoButton && infoTextarea) {
        saveInfoButton.addEventListener('click', async function () {
            const equipmentName = getValue(equipmentNameInput);
            const updatedInfo = getValue(infoTextarea);

            if (!equipmentName) {
                alert('설비명을 입력하세요.');
                return;
            }

            try {
                const response = await fetch(`${API_BASE_URL}/api/equipment/update-info`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        eqname: equipmentName,
                        info: updatedInfo,
                    }),
                });

                const result = await response.json();

                if (response.ok) {
                    alert('특이사항이 성공적으로 저장되었습니다.');
                    infoTextarea.disabled = true;
                    saveInfoButton.style.display = 'none';
                    saveInfoButton.classList.add('hidden');
                } else {
                    alert('특이사항 저장에 실패했습니다: ' + (result.error || response.status));
                }
            } catch (error) {
                console.error('특이사항 저장 실패:', error);
                alert('특이사항 저장 중 오류가 발생했습니다.');
            }
        });
    }

    // 최초 로딩 시 기본 LINE 옵션 정리
    updateMainLineOptions();
    updateNewLineOptions();

    console.log('✅ equipmentwarranty.js 로딩 완료');
});
