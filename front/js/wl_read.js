/* wl_read.js — 페이지네이션 + 엑셀 날짜/Work Items/Parts 수정 */
'use strict';
const API = 'http://13.125.122.202:3001';
const token = localStorage.getItem('x-access-token') || '';
const me = (() => { try { return JSON.parse(atob(token.split('.')[1])); } catch { return null; } })();
axios.defaults.headers.common['x-access-token'] = token;
const APPROVER_MAP = {'PEE1:PT':['조지훈','전대영','손석현'],'PEE1:HS':['진덕장','한정훈','정대환'],'PEE1:IC':['강문호','배한훈','최원준'],'PEE1:CJ':['강문호','배한훈','최원준'],'PEE2:PT':['이지웅','송왕근','정현우'],'PEE2:HS':['안재영','김건희'],'PSKH:*':['유정현','문순현']};
function canEdit(g,s){if(!me)return false;if(me.role==='admin'||me.role==='editor')return true;const k=g==='PSKH'?'PSKH:*':`${g}:${s}`;return(APPROVER_MAP[k]||[]).includes(me.nickname);}
function canEditByWorker(ev){if(!me)return false;if(me.role==='admin')return true;return(ev.workers||[]).some(w=>w.engineer_name===me.nickname);}

let curEv=null,isEdit=false,allRows=[],curPage=1;
const PAGE_SIZE = 50;

function fmtDate(r){if(!r)return'—';const s=String(r);if(s.includes('T'))return s.split('T')[0];const d=new Date(r);if(isNaN(d))return s;return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function fmtDateInput(r){return r?fmtDate(r):'';}
function fmtTime(r){return r?String(r).substring(0,5):'—';}
function fmtTimeInput(r){return r?String(r).substring(0,5):'';}
function renderText(t){if(!t||t==='—')return'—';return String(t).replace(/<br\s*\/?>/gi,'\n');}
function escHtml(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function toast(type,title,msg){const r=document.getElementById('toast-root');if(!r)return;const el=document.createElement('div');el.className=`toast ${type}`;el.innerHTML=`<div class="toast-head"><span class="badge">${type==='error'?'ERR':'OK'}</span>${escHtml(title)}</div><div class="toast-body">${escHtml(msg)}</div>`;r.appendChild(el);setTimeout(()=>el.remove(),4500);}

function initNav(){if(me){document.querySelectorAll('.sign-container.unsigned').forEach(e=>e.classList.add('hidden'));document.querySelectorAll('.sign-container.signed').forEach(e=>e.classList.remove('hidden'));if(me.role!=='admin')document.querySelectorAll('.admin-only').forEach(e=>e.style.display='none');}document.getElementById('sign-out')?.addEventListener('click',()=>{localStorage.removeItem('x-access-token');location.href='./signin.html';});document.querySelector('.menu-btn')?.addEventListener('click',()=>document.querySelector('.menu-bar')?.classList.toggle('open'));}

function initDates(){const t=new Date(),f=new Date(t);f.setMonth(f.getMonth()-1);const fm=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;document.getElementById('f-date-from').value=fm(f);document.getElementById('f-date-to').value=fm(t);}

function getFilters(){return{travel_scope:document.getElementById('f-travel-scope').value,date_from:document.getElementById('f-date-from').value,date_to:document.getElementById('f-date-to').value,group:document.getElementById('f-group').value,site:document.getElementById('f-site').value,work_type:document.getElementById('f-work-type').value,rework_filter:document.getElementById('f-rework').value,equipment_name:document.getElementById('f-eq-name').value.trim(),worker_name:document.getElementById('f-worker').value.trim(),task_name:document.getElementById('f-title').value.trim()};}

function applyReworkFilter(rows,reworkFilter){if(!Array.isArray(rows))return[];if(reworkFilter==='Y')return rows.filter(r=>Number(r.is_rework)===1);if(reworkFilter==='N')return rows.filter(r=>Number(r.is_rework)!==1);return rows;}

/* ══ Search + Pagination ══ */
async function doSearch(){
  const w=document.getElementById('table-wrapper');
  w.innerHTML='<div class="loading-state"><i class="fas fa-circle-notch fa-spin"></i> 조회 중...</div>';

  const f=getFilters();
  // 필터가 하나도 없으면 날짜 필터 강제 적용
  const hasFilter = Object.values(f).some(v=>v);
  if(!hasFilter){
    toast('warn','조건 필요','최소 하나의 필터(기간 등)를 설정해주세요.');
    w.innerHTML='<div class="empty-state"><i class="fas fa-filter"></i><p>검색 조건을 설정 후 조회하세요.<br>기간 미설정 시 최근 1달이 기본 적용됩니다.</p></div>';
    return;
  }

  const p=new URLSearchParams();
  for(const[k,v]of Object.entries(f)){if(v&&k!=='rework_filter')p.set(k,v);}
  p.set('limit','1000'); // 서버에서 최대 1000건

  try{
    const{data}=await axios.get(`${API}/wl/events?${p}`);
    const serverRows=data.rows||[];
    allRows=applyReworkFilter(serverRows,f.rework_filter);
    const total=data.total||serverRows.length;
    curPage=1;

    const summary=document.getElementById('result-summary');
    summary.style.display='';
    summary.querySelectorAll('.summary-note,.pagination').forEach(e=>e.remove());
    document.getElementById('result-count').textContent=allRows.length;

    if(total>serverRows.length){
      summary.insertAdjacentHTML('beforeend',`<span class="summary-note">(전체 ${total}건 중 최근 ${serverRows.length}건 수신)</span>`);
    }
    if(f.rework_filter==='Y'){
      summary.insertAdjacentHTML('beforeend', `<span class="summary-note rework">REWORK만 표시</span>`);
    }else if(f.rework_filter==='N'){
      summary.insertAdjacentHTML('beforeend', `<span class="summary-note">일반 작업만 표시</span>`);
    }

    if(!allRows.length){
      const emptyText = f.rework_filter==='Y' ? '조건에 맞는 REWORK 작업이 없습니다.' : (f.rework_filter==='N' ? '조건에 맞는 일반 작업이 없습니다.' : '결과 없음');
      w.innerHTML=`<div class="empty-state"><i class="fas fa-inbox"></i><p>${emptyText}</p></div>`;
      return;
    }
    renderPage();
  }catch(e){w.innerHTML=`<div class="empty-state"><p>조회 실패: ${escHtml(e.response?.data?.error||e.message)}</p></div>`;}
}

function renderPage(){
  const totalPages=Math.ceil(allRows.length/PAGE_SIZE);
  const start=(curPage-1)*PAGE_SIZE;
  const pageRows=allRows.slice(start,start+PAGE_SIZE);
  const w=document.getElementById('table-wrapper');

  let tableHtml=`<div class="table-scroll"><table class="wl-table"><thead><tr><th>Date</th><th>Work Code</th><th>Title</th><th>EQ Name</th><th>Country</th><th>Group</th><th>Site</th><th>Type</th><th>EMS</th><th>Workers</th><th>RW</th></tr></thead><tbody>`;
  pageRows.forEach(r=>{
    const rowClass=`clickable-row${Number(r.is_rework)===1?' row-rework':''}`;
    const reworkCell=Number(r.is_rework)===1?'<span class="rework-badge">RW</span>':'<span class="rework-badge muted">-</span>';
    tableHtml+=`<tr data-id="${r.id}" class="${rowClass}"><td>${fmtDate(r.task_date)}</td><td class="code-cell">${escHtml(r.work_code||'')}</td><td>${escHtml(r.task_name||'')}</td><td>${escHtml(r.equipment_name||'')}</td><td>${escHtml(r.country||'—')}</td><td>${escHtml(r.group||'')}</td><td>${escHtml(r.site||'')}</td><td>${escHtml(r.work_type||'')}${r.work_type2?'/'+escHtml(r.work_type2):''}</td><td>${r.ems==1?'유상':'무상'}</td><td>${escHtml(r.workers_str||'')}</td><td>${reworkCell}</td></tr>`;
  });
  tableHtml+='</tbody></table></div>';
  w.innerHTML=tableHtml;

  // Pagination
  if(totalPages>1){
    const sumEl=document.getElementById('result-summary');
    let pgHtml='<div class="pagination">';
    pgHtml+=`<button ${curPage<=1?'disabled':''} data-pg="${curPage-1}">‹</button>`;
    for(let i=1;i<=totalPages;i++){
      if(totalPages>7 && Math.abs(i-curPage)>2 && i!==1 && i!==totalPages){
        if(i===curPage-3||i===curPage+3) pgHtml+='<span style="padding:0 4px;">…</span>';
        continue;
      }
      pgHtml+=`<button class="${i===curPage?'active':''}" data-pg="${i}">${i}</button>`;
    }
    pgHtml+=`<button ${curPage>=totalPages?'disabled':''} data-pg="${curPage+1}">›</button></div>`;
    // 기존 pagination 제거 후 추가
    sumEl.querySelectorAll('.pagination').forEach(e=>e.remove());
    sumEl.insertAdjacentHTML('beforeend',pgHtml);
    sumEl.querySelectorAll('.pagination button').forEach(b=>b.addEventListener('click',()=>{
      const pg=+b.dataset.pg;if(pg>=1&&pg<=totalPages){curPage=pg;renderPage();}
    }));
  }

  w.querySelectorAll('.clickable-row').forEach(tr=>tr.addEventListener('click',()=>openDetail(+tr.dataset.id)));
}

/* ══ Detail ══ */
async function openDetail(id){document.getElementById('modal-overlay').style.display='block';document.getElementById('detail-modal').style.display='block';document.body.style.overflow='hidden';document.getElementById('m-work-code').textContent='불러오는 중...';
try{const{data}=await axios.get(`${API}/wl/event/${id}`);curEv=data;fillModal(data);setEditMode(false);}catch{toast('error','오류','조회 실패');closeModal();}}

function fillModal(ev){document.getElementById('m-work-code').textContent=ev.work_code||'—';document.getElementById('m-title').textContent=ev.task_name||'';document.getElementById('m-date').textContent=fmtDate(ev.task_date);document.getElementById('m-ems').textContent=ev.ems==1?'유상':'무상';document.getElementById('m-group-site').textContent=`${ev.group||'—'} / ${ev.site||'—'}`;document.getElementById('m-line').textContent=ev.line||'—';document.getElementById('m-eq-name').textContent=ev.equipment_name||'—';document.getElementById('m-eq-type').textContent=ev.equipment_type||'—';document.getElementById('m-warranty').textContent=ev.warranty||'—';document.getElementById('m-work-type').textContent=ev.work_type||'—';document.getElementById('m-work-type2').textContent=ev.work_type2||'—';document.getElementById('m-sop').textContent=`${ev.SOP||'—'} / ${ev.tsguide||'—'}`;document.getElementById('m-status-text').textContent=ev.status||'—';
const rw=document.getElementById('m-rework');rw.innerHTML=ev.is_rework?`<span class="rework-yes">✅ Rework${ev.rework_seq>0?' ('+ev.rework_seq+'차)':''}</span>`:'N';
document.getElementById('m-rework-reason').textContent=ev.rework_reason||'—';
const reworkDetailSection=document.getElementById('m-rework-detail-section');
const reworkDetailEl=document.getElementById('m-rework-detail');
if(Number(ev.is_rework)===1){reworkDetailSection.style.display='';reworkDetailEl.textContent=renderText(ev.rework_detail)||'—';}else{reworkDetailSection.style.display='none';reworkDetailEl.textContent='—';}
const tb=document.getElementById('m-workers-tbody');tb.innerHTML='';(ev.workers||[]).forEach(w=>{const tr=document.createElement('tr');tr.innerHTML=`<td>${escHtml(w.engineer_name)}</td><td><span class="role-badge role-${w.role||'main'}">${w.role||'main'}</span></td><td>${fmtTime(w.start_time)}</td><td>${fmtTime(w.end_time)}</td><td>${w.none_time??0}분</td><td>${w.move_time??0}분</td><td>${w.task_duration??'—'}분</td>`;tb.appendChild(tr);});
document.getElementById('m-action').textContent=renderText(ev.task_description);document.getElementById('m-cause').textContent=renderText(ev.task_cause);document.getElementById('m-result').textContent=renderText(ev.task_result);
const h=document.getElementById('m-history');h.innerHTML='';(ev.approvals||[]).forEach(a=>{const d=document.createElement('div');d.className='approval-row';const dt=a.acted_at?new Date(a.acted_at).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',hour12:false}):'';d.innerHTML=`<span class="approval-action-badge action-${escHtml(a.action)}">${escHtml(a.action)}</span><span class="approval-actor">${escHtml(a.actor_name||'—')}</span><span class="approval-time">${escHtml(dt)}</span>${a.comment?`<span class="approval-comment">${escHtml(a.comment)}</span>`:''}`;h.appendChild(d);});
document.getElementById('btn-edit-toggle').style.display=canEditByWorker(ev)?'':'none';
document.getElementById('btn-delete').style.display=canEditByWorker(ev)?'':'none';}

function closeModal(){document.getElementById('detail-modal').style.display='none';document.getElementById('modal-overlay').style.display='none';document.body.style.overflow='';curEv=null;isEdit=false;}

function setEditMode(on){isEdit=on;document.getElementById('view-mode').style.display=on?'none':'';document.getElementById('edit-mode').style.display=on?'':'none';const tb=document.getElementById('btn-edit-toggle');if(tb){tb.innerHTML=on?'<i class="fas fa-eye"></i> 보기':'<i class="fas fa-edit"></i> 수정';}if(on&&curEv)fillEditForm(curEv);}

function fillEditForm(ev){document.getElementById('e-date').value=fmtDateInput(ev.task_date);document.getElementById('e-group').value=ev.group||'PEE1';document.getElementById('e-site').value=ev.site||'PT';document.getElementById('e-line').value=ev.line||'';document.getElementById('e-eq-name').value=ev.equipment_name||'';document.getElementById('e-eq-type').value=ev.equipment_type||'';document.getElementById('e-warranty').value=ev.warranty||'WI';document.getElementById('e-work-type').value=ev.work_type||'MAINT';document.getElementById('e-work-type2').value=ev.work_type2||'';document.getElementById('e-rework').value=ev.is_rework?'1':'0';document.getElementById('e-title').value=ev.task_name||'';document.getElementById('e-status').value=ev.status||'';document.getElementById('e-action').value=renderText(ev.task_description);document.getElementById('e-cause').value=renderText(ev.task_cause);document.getElementById('e-result').value=renderText(ev.task_result);const l=document.getElementById('e-workers-list');l.innerHTML='';(ev.workers||[]).forEach(w=>l.appendChild(mkEWRow(w)));}

function mkEWRow(w){const d=document.createElement('div');d.className='e-worker-row';d.innerHTML=`<input class="ew-name" placeholder="이름" value="${escHtml(w?.engineer_name||'')}"><select class="ew-role"><option value="main"${(w?.role||'main')==='main'?' selected':''}>main</option><option value="support"${w?.role==='support'?' selected':''}>support</option></select><input type="time" class="ew-time" value="${fmtTimeInput(w?.start_time)}"><input type="time" class="ew-time" value="${fmtTimeInput(w?.end_time)}"><input type="number" class="ew-num" min="0" value="${w?.none_time||0}"><input type="number" class="ew-num" min="0" value="${w?.move_time||0}"><button type="button" class="btn-remove-sm">−</button>`;d.querySelector('.btn-remove-sm').addEventListener('click',()=>d.remove());return d;}
function collectPatch(){return{task_name:document.getElementById('e-title').value.trim(),task_date:document.getElementById('e-date').value,group:document.getElementById('e-group').value,site:document.getElementById('e-site').value,line:document.getElementById('e-line').value.trim(),equipment_name:document.getElementById('e-eq-name').value.trim(),equipment_type:document.getElementById('e-eq-type').value.trim(),warranty:document.getElementById('e-warranty').value,work_type:document.getElementById('e-work-type').value,work_type2:document.getElementById('e-work-type2').value||null,is_rework:document.getElementById('e-rework').value==='1'?1:0,status:document.getElementById('e-status').value.trim(),task_description:document.getElementById('e-action').value.trim(),task_cause:document.getElementById('e-cause').value.trim(),task_result:document.getElementById('e-result').value.trim()};}
function collectWorkers(){return[...document.querySelectorAll('.e-worker-row')].map(d=>{const ins=d.querySelectorAll('input'),sel=d.querySelector('select');return{name:ins[0].value.trim(),role:sel.value,start_time:ins[1].value?ins[1].value+':00':null,end_time:ins[2].value?ins[2].value+':00':null,none_time:Number(ins[3].value)||0,move_time:Number(ins[4].value)||0};}).filter(w=>w.name);}

async function doSave(){if(!curEv)return;const patch=collectPatch(),workers=collectWorkers();if(!workers.length){toast('error','오류','작업자 1명 이상');return;}
try{await axios.put(`${API}/wl/event/${curEv.id}`,{patch,workers});toast('success','수정 완료','저장되었습니다.');const{data}=await axios.get(`${API}/wl/event/${curEv.id}`);curEv=data;fillModal(data);setEditMode(false);doSearch();}catch(e){toast('error','실패',e.response?.data?.error||e.message);}}

async function doDelete(){if(!curEv)return;if(!confirm('이 작업이력을 완전히 삭제하시겠습니까?\n삭제된 데이터는 복구할 수 없습니다.'))return;
try{await axios.delete(`${API}/wl/event/${curEv.id}`);toast('success','삭제 완료','작업이력이 삭제되었습니다.');closeModal();doSearch();}catch(e){toast('error','삭제 실패',e.response?.data?.error||e.message);}}

/* ══ Excel (날짜 수정 + Work Items/Parts 포함) ══ */
async function doExcel(){const f=getFilters();const p=new URLSearchParams();for(const[k,v]of Object.entries(f)){if(v&&k!=='rework_filter')p.set(k,v);}
try{toast('success','준비 중','엑셀 데이터 준비...');const{data}=await axios.get(`${API}/wl/export/excel?${p}`);const filtered=applyReworkFilter(data||[],f.rework_filter);if(!filtered.length){toast('error','없음','데이터 없음');return;}
const hd=['Work Code','Title','Date','Country','Group','Site','Line','EQ Type','EQ Name','Warranty','EMS','Work Type','Work Sort','Setup Item','Status','Action','Cause','Result','SOP','TS Guide','Rework','Rework Seq','Work Items','Parts','Worker','Role','Level','Start','End','None(분)','Move(분)','Duration(분)','Approval'];
const rows=filtered.map(r=>[r.work_code,r.task_name,
  fmtDate(r.task_date), // 날짜 포맷 수정
  r.country,r.group,r.site,r.line,r.equipment_type,r.equipment_name,r.warranty,r.ems_text,r.work_type,r.work_type2,r.setup_item,r.status,r.task_description,r.task_cause,r.task_result,r.SOP,r.tsguide,r.is_rework,r.rework_seq,
  r.work_items_str||'', // Work Items
  r.parts_str||'',      // Parts
  r.engineer_name,r.role,r.eng_level,r.w_start_time?String(r.w_start_time).substring(0,5):'',r.w_end_time?String(r.w_end_time).substring(0,5):'',r.w_none_time,r.w_move_time,r.task_duration,r.approval_status]);
const wb=XLSX.utils.book_new(),ws=XLSX.utils.aoa_to_sheet([hd,...rows]);ws['!cols']=hd.map((h,i)=>{const mx=Math.max(h.length,...rows.slice(0,100).map(r=>String(r[i]||'').length));return{wch:Math.min(mx+2,50)};});XLSX.utils.book_append_sheet(wb,ws,'Worklog');XLSX.writeFile(wb,`worklog_${new Date().toISOString().split('T')[0]}.xlsx`);toast('success','완료','다운로드됨');}catch(e){toast('error','실패',e.response?.data?.error||e.message);}}

document.addEventListener('DOMContentLoaded',()=>{
initNav();initDates();
document.getElementById('btn-search')?.addEventListener('click',doSearch);
document.getElementById('btn-reset')?.addEventListener('click',()=>{['f-date-from','f-date-to','f-eq-name','f-worker','f-title'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});['f-group','f-site','f-work-type','f-rework','f-travel-scope'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});initDates();});
document.getElementById('btn-excel')?.addEventListener('click',doExcel);
document.getElementById('modal-close')?.addEventListener('click',closeModal);
document.getElementById('modal-overlay')?.addEventListener('click',closeModal);
document.getElementById('btn-edit-toggle')?.addEventListener('click',()=>setEditMode(!isEdit));
document.getElementById('btn-edit-cancel')?.addEventListener('click',()=>setEditMode(false));
document.getElementById('btn-edit-save')?.addEventListener('click',doSave);
document.getElementById('btn-delete')?.addEventListener('click',doDelete);
document.getElementById('e-add-worker')?.addEventListener('click',()=>{document.getElementById('e-workers-list').appendChild(mkEWRow({}));});
});
