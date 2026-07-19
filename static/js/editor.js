/* ─────────────────────────────────────────────────────────────────
   RUET CSE Routine — Visual Editor
   ─────────────────────────────────────────────────────────────── */

const ROUTINE_KEYS  = { odd: 'ruet_routine_odd', even: 'ruet_routine_even' };
const API_LOAD_BASE = '/routine/data/';
const API_SAVE_URL  = '/routine/save';

// ── Module state ──────────────────────────────────────────────────────────
let currentData     = null;   // { periods, times, routine }
let currentWeek     = 'odd';
let dirty           = false;

// ── Helpers ───────────────────────────────────────────────────────────────
const totalPeriods  = () => currentData?.periods?.length ?? 10;
const dayColCount   = (dayInfo) =>
    (dayInfo.slots || []).reduce((s, slot) => s + (parseInt(slot.colspan) || 1), 0);

// ── Toast ─────────────────────────────────────────────────────────────────
function showToast(msg, type = 'ok') {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `show ${type}`;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = ''; }, 3000);
}

function setStatus(msg, type = '') {
    const el = document.getElementById('statusMsg');
    if (!el) return;
    el.textContent = msg;
    el.className = type;
}

// ── Routine I/O ───────────────────────────────────────────────────────────
async function fetchRoutine(which) {
    const res = await fetch(`${API_LOAD_BASE}${which}.json`, { cache: 'no-store' });
    if (!res.ok) throw new Error('Failed to load routine JSON');
    return res.json();
}

function getLocalRoutine(which) {
    const raw = localStorage.getItem(ROUTINE_KEYS[which]);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

async function loadRoutine(which) {
    setStatus('Loading…');
    try {
        const data = getLocalRoutine(which) || await fetchRoutine(which);
        currentData = data;
        currentWeek = which;
        dirty = false;
        renderEditor();
        setStatus(`Loaded ${which} week.`);
    } catch (e) {
        setStatus('Failed to load: ' + e.message, 'error');
    }
}

async function saveRoutine() {
    if (!currentData) return;
    collectEditorState();

    // 1 — localStorage
    try {
        localStorage.setItem(ROUTINE_KEYS[currentWeek], JSON.stringify(currentData));
        dirty = false;
        setStatus('Saved locally. Syncing to backend database…');
    } catch {
        setStatus('LocalStorage save failed.', 'error');
        showToast('❌ Save failed', 'error');
        return;
    }

    // 2 — Database via Flask backend
    try {
        const res = await fetch(API_SAVE_URL, {
            method:  'POST',
            headers: {
                'Content-Type':  'application/json',
            },
            body: JSON.stringify({ week: currentWeek, data: currentData }),
        });

        if (res.ok) {
            setStatus('Saved & synced to MongoDB database ✓', 'ok');
            showToast('✅ Saved + synced!');
        } else {
            const err = await res.json().catch(() => ({}));
            setStatus(`Saved locally — database sync failed: ${err.error || res.status}`, 'error');
            showToast('💾 Local save OK — sync failed', 'error');
        }
    } catch {
        setStatus('Saved locally — server unreachable', 'error');
        showToast('💾 Local save OK — server offline', 'error');
    }
}

// ── Editor rendering ──────────────────────────────────────────────────────
function renderEditor() {
    const container = document.getElementById('dayList');
    if (!container) return;
    container.innerHTML = '';
    if (!currentData?.routine) return;
    currentData.routine.forEach((dayInfo, idx) => {
        container.appendChild(buildDayCard(dayInfo, idx));
    });
}

// ── Day card ──────────────────────────────────────────────────────────────
function buildDayCard(dayInfo, dayIdx) {
    const card = document.createElement('div');
    card.className = 'day-card';
    card.dataset.dayIdx = dayIdx;

    /* header */
    const header = document.createElement('div');
    header.className = 'day-header';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = dayInfo.day || '';
    nameInput.placeholder = 'Day name';
    nameInput.style.cssText =
        'background:transparent;border:none;color:#c4b5fd;font-weight:600;' +
        'font-size:.95rem;padding:0;width:auto;flex:1;min-width:80px;font-family:inherit';
    nameInput.addEventListener('input', () => {
        dayInfo.day = nameInput.value.trim();
        markDirty();
    });
    card._nameInput = nameInput;

    /* period counter badge */
    const counter = document.createElement('span');
    counter.className = 'period-counter';
    card._counter = counter;
    refreshCounter(card, dayInfo);

    /* action buttons */
    const actions = document.createElement('div');
    actions.className = 'day-actions';

    const addSlotBtn = document.createElement('button');
    addSlotBtn.className = 'btn btn-ghost btn-sm';
    addSlotBtn.textContent = '+ Slot';
    addSlotBtn.title = 'Add an empty slot';
    card._addSlotBtn = addSlotBtn;
    updateAddSlotBtn(addSlotBtn, dayInfo);

    addSlotBtn.addEventListener('click', () => {
        const used = dayColCount(dayInfo);
        const max  = totalPeriods();
        if (used >= max) {
            showToast(`⚠️ Day is full (${used}/${max} periods)`, 'error');
            return;
        }
        dayInfo.slots.push({ course: null });
        rebuildSlots(card, dayInfo);
        markDirty();
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn btn-danger btn-sm';
    removeBtn.textContent = '✕ Day';
    removeBtn.addEventListener('click', () => {
        if (!confirm(`Remove "${dayInfo.day || 'this day'}"?`)) return;
        currentData.routine.splice(dayIdx, 1);
        markDirty();
        renderEditor();
    });

    actions.append(addSlotBtn, removeBtn);
    header.append(nameInput, counter, actions);
    card.append(header);

    /* column header row */
    const colHdr = document.createElement('div');
    colHdr.className = 'slot-header-row';
    colHdr.innerHTML = `
        <span>#</span>
        <span>Course</span>
        <span class="tc">Teacher / Room</span>
        <span class="rc">Roll group</span>
        <span class="sc">Span</span>
        <span>Lab</span>
        <span></span>
    `;
    card.append(colHdr);

    /* slot list */
    const slotList = document.createElement('div');
    slotList.className = 'slot-list';
    card._slotList = slotList;
    card.append(slotList);

    buildSlotRows(slotList, dayInfo, card);
    return card;
}

// ── Counter helpers ───────────────────────────────────────────────────────
function refreshCounter(card, dayInfo) {
    const used = dayColCount(dayInfo);
    const max  = totalPeriods();
    const el   = card._counter;
    if (!el) return;
    el.textContent = `${used}/${max}p`;
    el.style.cssText =
        `font-size:.7rem;padding:.2rem .55rem;border-radius:999px;font-weight:700;` +
        `background:${used > max ? 'rgba(239,68,68,.2)' : used === max ? 'rgba(16,185,129,.15)' : 'rgba(124,58,237,.15)'};` +
        `color:${used > max ? '#fca5a5' : used === max ? '#6ee7b7' : '#c4b5fd'};`;
}

function updateAddSlotBtn(btn, dayInfo) {
    const full = dayColCount(dayInfo) >= totalPeriods();
    btn.disabled = full;
    btn.style.opacity = full ? '.4' : '';
    btn.title = full ? `Day is full (${totalPeriods()} periods used)` : 'Add an empty slot';
}

// ── Slot rows ─────────────────────────────────────────────────────────────
function buildSlotRows(slotList, dayInfo, card) {
    slotList.innerHTML = '';
    (dayInfo.slots || []).forEach((slot, sIdx) => {
        slotList.appendChild(buildSlotRow(slot, sIdx, dayInfo, slotList, card));
    });
}

function rebuildSlots(card, dayInfo) {
    buildSlotRows(card._slotList, dayInfo, card);
    refreshCounter(card, dayInfo);
    updateAddSlotBtn(card._addSlotBtn, dayInfo);
}

function buildSlotRow(slot, sIdx, dayInfo, slotList, card) {
    const row = document.createElement('div');
    row.className = 'slot-row' + (slot.isLab ? ' is-lab' : '');

    /* index */
    const idxEl = document.createElement('span');
    idxEl.className = 'slot-index';
    idxEl.textContent = sIdx + 1;

    /* course */
    const courseIn = document.createElement('input');
    courseIn.className = 'slot-course';
    courseIn.type = 'text';
    courseIn.value = slot.course || '';
    courseIn.placeholder = '— empty —';
    courseIn.addEventListener('input', () => {
        slot.course = courseIn.value.trim() || null;
        markDirty();
    });

    /* teacher */
    const teachIn = document.createElement('input');
    teachIn.className = 'tc';
    teachIn.type = 'text';
    teachIn.value = slot.teacher || '';
    teachIn.placeholder = 'Teacher / Room';
    teachIn.addEventListener('input', () => {
        slot.teacher = teachIn.value.trim() || undefined;
        markDirty();
    });

    /* roll */
    const rollIn = document.createElement('input');
    rollIn.className = 'rc';
    rollIn.type = 'text';
    rollIn.value = slot.roll || '';
    rollIn.placeholder = 'e.g. 1-30';
    rollIn.addEventListener('input', () => {
        slot.roll = rollIn.value.trim() || undefined;
        markDirty();
    });

    /* colspan ─ validated against remaining space */
    const spanIn = document.createElement('input');
    spanIn.className = 'sc';
    spanIn.type = 'number';
    spanIn.value = slot.colspan || 1;
    spanIn.min = 1;
    spanIn.max = totalPeriods();
    spanIn.style.textAlign = 'center';
    spanIn.addEventListener('change', () => {
        const v   = parseInt(spanIn.value) || 1;
        const old = parseInt(slot.colspan)  || 1;
        const used = dayColCount(dayInfo) - old + v;

        if (used > totalPeriods()) {
            spanIn.value = old;  // revert
            showToast(`⚠️ Exceeds ${totalPeriods()} total periods`, 'error');
            return;
        }
        slot.colspan = v > 1 ? v : undefined;
        markDirty();
        refreshCounter(card, dayInfo);
        updateAddSlotBtn(card._addSlotBtn, dayInfo);
    });

    /* lab toggle */
    const labWrap = document.createElement('label');
    labWrap.className = 'lab-toggle';
    const labCb = document.createElement('input');
    labCb.type = 'checkbox';
    labCb.checked = !!slot.isLab;
    labCb.addEventListener('change', () => {
        slot.isLab = labCb.checked || undefined;
        row.classList.toggle('is-lab', labCb.checked);
        markDirty();
    });
    labWrap.append(labCb, 'Lab');

    /* delete */
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.textContent = '✕';
    delBtn.title = 'Remove slot';
    delBtn.addEventListener('click', () => {
        dayInfo.slots.splice(sIdx, 1);
        rebuildSlots(card, dayInfo);
        markDirty();
    });

    row.append(idxEl, courseIn, teachIn, rollIn, spanIn, labWrap, delBtn);
    return row;
}

// ── Collect DOM → data ────────────────────────────────────────────────────
function collectEditorState() {
    document.querySelectorAll('.day-card').forEach((card, i) => {
        if (currentData.routine[i]) {
            currentData.routine[i].day = card._nameInput?.value?.trim()
                || currentData.routine[i].day;
        }
    });
}

// ── Dirty tracking ────────────────────────────────────────────────────────
function markDirty() {
    dirty = true;
    setStatus('Unsaved changes…');
}

// ── Add day ───────────────────────────────────────────────────────────────
function addDay() {
    if (!currentData) return;
    const ORDER  = ['Saturday','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday'];
    const used   = new Set(currentData.routine.map(d => d.day));
    const next   = ORDER.find(d => !used.has(d)) || 'New Day';
    currentData.routine.push({ day: next, slots: [{ course: null }] });
    markDirty();
    renderEditor();
    document.querySelector('.day-card:last-child')?.scrollIntoView({ behavior: 'smooth' });
}

// ── Boot ──────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadRoutine('odd');

    /* Week selector */
    document.getElementById('weekSelect')?.addEventListener('change', (e) => {
        if (dirty && !confirm('You have unsaved changes. Switch anyway?')) {
            e.target.value = currentWeek;
            return;
        }
        loadRoutine(e.target.value);
    });

    /* Reload from server JSON */
    document.getElementById('reloadBtn')?.addEventListener('click', async () => {
        if (dirty && !confirm('Reload will discard unsaved changes. Continue?')) return;
        try {
            const data = await fetchRoutine(currentWeek);
            currentData = data;
            dirty = false;
            renderEditor();
            setStatus('Reloaded from source JSON.');
            showToast('↺ Reloaded from server JSON');
        } catch {
            showToast('❌ Reload failed', 'error');
        }
    });

    /* Save */
    document.getElementById('saveBtn')?.addEventListener('click', saveRoutine);

    /* Add day */
    document.getElementById('addDayBtn')?.addEventListener('click', addDay);

    /* Unsaved-changes guard */
    window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });
});
