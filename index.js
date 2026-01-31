import { getContext } from '../../../extensions.js';
import { updateMessageBlock, saveChat, eventSource, event_types } from '../../../../script.js';

const extensionName = "TextCleaner";
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

let currentMesId = null;
let lastProcessedContent = "";
let isCompareMode = false;
let currentEditMode = "original";

const STORAGE_KEY = "tc_recent_editions";
const THEME_KEY = "tc_current_theme";
const DIMENSIONS_KEY = "tc_popup_dimensions";

/**
 * 팝업의 현재 위치와 크기를 저장 (PC 전용)
 */
function saveDimensions($popup) {
    if (isMobile()) return;
    const dimensions = {
        top: $popup.css('top'),
        left: $popup.css('left'),
        width: $popup.css('width'),
        height: $popup.css('height')
    };
    localStorage.setItem(DIMENSIONS_KEY, JSON.stringify(dimensions));
}

/**
 * 모바일 여부 확인
 */
function isMobile() {
    return window.innerWidth <= 768;
}

/**
 * 다중 규칙 처리 로직
 */
function processTextMulti(originalText, ranges, replacements) {
    let newText = originalText;

    ranges.forEach(r => {
        if (r.start && r.end) {
            const escapedStart = r.start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const escapedEnd = r.end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`${escapedStart}[\\s\\S]*?${escapedEnd}`, 'g');
            newText = newText.replace(regex, '');
        }
    });

    replacements.forEach(rep => {
        if (rep.find) {
            const escapedFind = rep.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escapedFind, 'g');
            newText = newText.replace(regex, rep.replace || '');
        }
    });

    return newText;
}

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

/**
 * 단순 텍스트 대조(Diff) 로직 (단어 단위)
 */
function getDiffHtml(oldText, newText) {
    const oldChars = Array.from(oldText);
    const newChars = Array.from(newText);
    const n = oldChars.length;
    const m = newChars.length;

    // 1. LCS 알고리즘 (글자 단위)
    const dp = Array(n + 1).fill(null).map(() => Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            if (oldChars[i - 1] === newChars[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
            else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }

    let i = n, j = m, diffs = [];
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
            diffs.unshift({ type: 'common', val: oldChars[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diffs.unshift({ type: 'added', val: newChars[j - 1] });
            j--;
        } else {
            diffs.unshift({ type: 'removed', val: oldChars[i - 1] });
            i--;
        }
    }

    // 2. 1차 인접 동일 타입 병합
    let merged = [];
    diffs.forEach(item => {
        if (merged.length > 0 && merged[merged.length - 1].type === item.type) {
            merged[merged.length - 1].val += item.val;
        } else {
            merged.push(item);
        }
    });

    // 3. Semantic Cleanup (중요: 파편 방지 로직 개선)
    // 매우 짧은 공통 부분(4자 미만)이 변경사항 사이에 있거나 인접해 있으면 변경사항으로 흡수시킵니다.
    for (let iter = 0; iter < 3; iter++) { 
        let cleaned = [];
        for (let k = 0; k < merged.length; k++) {
            let item = merged[k];
            if (item.type === 'common' && item.val.length < 4) {
                let prev = cleaned[cleaned.length - 1];
                let next = merged[k + 1];

                // 앞이나 뒤에 변경사항이 있다면 해당 공통 파편을 변경사항에 병합
                if (prev && (prev.type === 'added' || prev.type === 'removed')) {
                    prev.val += item.val;
                    continue;
                } else if (next && (next.type === 'added' || next.type === 'removed')) {
                    next.val = item.val + next.val;
                    continue;
                }
            }
            
            if (cleaned.length > 0 && cleaned[cleaned.length - 1].type === item.type) {
                cleaned[cleaned.length - 1].val += item.val;
            } else {
                cleaned.push(item);
            }
        }
        merged = cleaned;
    }

    let oldHtml = "", newHtml = "";
    merged.forEach(item => {
        const escaped = escapeHtml(item.val);
        if (item.type === 'common') {
            oldHtml += escaped;
            newHtml += escaped;
        } else if (item.type === 'added') {
            oldHtml += `<span class="tc-diff-phantom">${escaped}</span>`;
            newHtml += `<span class="tc-diff-added">${escaped}</span>`;
        } else if (item.type === 'removed') {
            oldHtml += `<span class="tc-diff-removed">${escaped}</span>`;
            newHtml += `<span class="tc-diff-phantom">${escaped}</span>`;
        }
    });

    return { 
        oldHtml: oldHtml.replace(/\n/g, '<br>'), 
        newHtml: newHtml.replace(/\n/g, '<br>') 
    };
}

/**
 * 히스토리 관리
 */
function getHistory() {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
}

function saveToHistory(type, data) {
    let history = getHistory();
    history = history.filter(item => JSON.stringify(item.data) !== JSON.stringify(data));
    history.unshift({ type, data });
    if (history.length > 10) history.pop();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    renderHistoryTags();
}

/**
 * 테마 적용 로직
 */
function applyTheme(themeName) {
    const $popup = $('#tc-popup-window');
    $popup.removeClass('theme-lavender theme-pink theme-beige theme-blue');
    if (themeName !== 'dark') {
        $popup.addClass(`theme-${themeName}`);
    }
    $('.tc-theme-dot').removeClass('active');
    $(`.tc-theme-dot[data-theme="${themeName}"]`).addClass('active');
    localStorage.setItem(THEME_KEY, themeName);
}
/**
 * 태그 UI 렌더링
 */
function renderHistoryTags() {
    const history = getHistory();
    const $container = $('#tc-history-area');
    $container.empty();

    history.forEach((item, index) => {
        let label = "";
        if (item.type === 'range') label = `✂️ ${item.data.start}~${item.data.end}`;
        else label = `🔄 ${item.data.find}→${item.data.replace}`;

        const $tag = $('<div>').addClass('tc-tag').text(label);
        
        const $removeBtn = $('<i>')
            .addClass('fa-solid fa-xmark tc-tag-remove')
            .attr('title', '삭제');

        $removeBtn.on('click', (e) => {
            e.stopPropagation(); 
            deleteHistoryItem(index);
        });

        $tag.on('click', () => applyTagToInput(item.type, item.data));
        
        $tag.append($removeBtn);
        $container.append($tag);
    });
}
function deleteHistoryItem(index) {
    let history = getHistory();
    history.splice(index, 1); 
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    renderHistoryTags(); 
}
function applyTagToInput(type, data) {
    if (type === 'range') {
        let applied = false;
        $('.tc-range-row').each(function() {
            const $start = $(this).find('.tc-start-tag');
            const $end = $(this).find('.tc-end-tag');
            if (!$start.val() && !$end.val()) {
                $start.val(data.start); $end.val(data.end);
                applied = true; return false;
            }
        });
        if (!applied) addRangeRow(data.start, data.end);
    } else {
        let applied = false;
        $('.tc-replace-row').each(function() {
            const $find = $(this).find('.tc-find-word');
            if (!$find.val()) {
                $find.val(data.find); $(this).find('.tc-replace-word').val(data.replace);
                applied = true; return false;
            }
        });
        if (!applied) addReplaceRow(data.find, data.replace);
    }
}

function addRangeRow(start = "", end = "") {
    const $row = $(`
        <div class="tc-input-row tc-range-row">
            <input type="text" class="tc-start-tag" style="flex:1" placeholder="시작" value="${start}">
            <span>~</span>
            <input type="text" class="tc-end-tag" style="flex:1" placeholder="종료" value="${end}">
            <i class="fa-solid fa-circle-xmark tc-row-remove"></i>
        </div>
    `);
    $row.find('.tc-row-remove').on('click', () => $row.remove());
    $('#tc-range-container').append($row);
}

function addReplaceRow(find = "", replace = "") {
    const $row = $(`
        <div class="tc-input-row tc-replace-row">
            <input type="text" class="tc-find-word" style="flex:1" placeholder="찾을 단어" value="${find}">
            <span>→</span>
            <input type="text" class="tc-replace-word" style="flex:1" placeholder="바꿀 단어" value="${replace}">
            <i class="fa-solid fa-circle-xmark tc-row-remove"></i>
        </div>
    `);
    $row.find('.tc-row-remove').on('click', () => $row.remove());
    $('#tc-replace-container').append($row);
}

/**
 * 대조 모드 토글
 */
function toggleCompareMode() {
    isCompareMode = !isCompareMode;
    const $origView = $('#tc-original-view');
    const $modView = $('#tc-modified-view');
    const $origPreview = $('#tc-original-preview');
    const $modPreview = $('#tc-modified-preview');
    const $btn = $('#tc-compare-toggle-btn');

    const syncScroll = (e) => {
        const target = e.target;
        if (target.id === 'tc-original-preview') {
            $modPreview[0].scrollTop = target.scrollTop;
        } else {
            $origPreview[0].scrollTop = target.scrollTop;
        }
    };

    if (isCompareMode) {
        $btn.addClass('active').text('🔍 편집 모드로 돌아가기');
        
        $origView.hide(); $modView.hide();
        $origPreview.show(); $modPreview.show();

        const originalText = $origView.val();
        const modifiedText = $modView.val();

        const diff = getDiffHtml(originalText, modifiedText);
        
        $origPreview.html(diff.oldHtml);
        $modPreview.html(diff.newHtml);
        
        if (!isMobile()) {
            $origPreview.on('scroll', syncScroll);
            $modPreview.on('scroll', syncScroll);
        }

        toastr.info("대조 모드가 시작됩니다");
    } else {
        $btn.removeClass('active').text('⚖️ 원본과 대조하기');
        
        $origView.show(); $modView.show();
        $origPreview.hide(); $modPreview.hide();
        
        $origPreview.off('scroll');
        $modPreview.off('scroll');
    }
}

/**
 * 팝업 생성
 */
function ensurePopupExists() {
    if ($('#tc-popup-window').length) return;

    const html = `
    <div id="tc-popup-window">
        <div class="tc-popup-header" id="tc-drag-handle">
            <span class="tc-popup-header-title">🧹 Text Cleaner</span>
            <div style="display: flex; align-items: center;">
                <div class="tc-theme-selector">
                    <div class="tc-theme-dot active" data-theme="dark" style="background:#212121;" title="Dark"></div>
                    <div class="tc-theme-dot" data-theme="lavender" style="background:#d5c9dd;" title="Lavender"></div>
                    <div class="tc-theme-dot" data-theme="pink" style="background:#ffb7c5;" title="Pink"></div>
                    <div class="tc-theme-dot" data-theme="beige" style="background:#9ba59c;" title="Beige Green"></div>
                    <div class="tc-theme-dot" data-theme="blue" style="background:#668589;" title="Antique Blue"></div>
                </div>
                <i class="fa-solid fa-xmark tc-popup-close-btn" id="tc-close-x"></i>
            </div>
        </div>
        <div class="tc-mode-tabs">
            <div class="tc-tab active" data-mode="original">원본 메시지 수정</div>
            <div class="tc-tab" data-mode="translation" id="tc-tab-translation" style="display:none;">번역문 수정</div>
        </div>
        <div class="tc-popup-body">
            <div class="tc-input-group">
                <div class="tc-section-header">
                    <label>영역 삭제 (A ~ B)</label>
                    <button class="tc-btn-add-row" id="tc-add-range-btn">+ 추가</button>
                </div>
                <div id="tc-range-container" class="tc-rows-container"></div>
            </div>

            <div class="tc-input-group">
                <div class="tc-section-header">
                    <label>단어 치환</label>
                    <button class="tc-btn-add-row" id="tc-add-replace-btn">+ 추가</button>
                </div>
                <div id="tc-replace-container" class="tc-rows-container"></div>
            </div>

            <div id="tc-history-area" class="tc-history-tags"></div>

            <div class="tc-action-buttons">
                <button id="tc-process-btn" class="tc-btn-process">✨ 설정한 모든 내용으로 치환 실행</button>
                <button id="tc-compare-toggle-btn" class="tc-btn-compare">⚖️ 원본과 대조하기</button>
            </div>

            <div class="tc-diff-container">
                <div class="tc-diff-box">
                    <span>원본 메시지</span>
                    <textarea id="tc-original-view" class="tc-text-area" readonly></textarea>
                    <div id="tc-original-preview" class="tc-preview-area" style="display:none;"></div>
                </div>
                <div class="tc-diff-box">
                    <span>최종 결과 (자유 편집)</span>
                    <textarea id="tc-modified-view" class="tc-text-area"></textarea>
                    <div id="tc-modified-preview" class="tc-preview-area" style="display:none;"></div>
                </div>
            </div>
        </div>
        <div class="tc-popup-footer">
            <button id="tc-cancel-btn" class="tc-footer-btn tc-btn-cancel">취소</button>
            <button id="tc-apply-btn" class="tc-footer-btn tc-btn-apply">메시지에 적용</button>
        </div>
        <div id="tc-resize-handle" class="tc-resizer"></div>
    </div>`;

    $('body').append(html);

    setupDraggable($('#tc-popup-window'), $('#tc-drag-handle'));
    setupResizable($('#tc-popup-window'), $('#tc-resize-handle'));

    $('.tc-theme-dot').on('click', function() {
        applyTheme($(this).attr('data-theme'));
    });

    $('#tc-add-range-btn').on('click', () => addRangeRow());
    $('#tc-add-replace-btn').on('click', () => addReplaceRow());
    $('#tc-close-x, #tc-cancel-btn').on('click', () => $('#tc-popup-window').hide());
    $('#tc-compare-toggle-btn').on('click', toggleCompareMode);
	$('.tc-tab').on('click', function() {
        const mode = $(this).attr('data-mode');
        if (mode === currentEditMode) return;

        const context = getContext();
        const message = context.chat[currentMesId];
        
        currentEditMode = mode;
        $('.tc-tab').removeClass('active');
        $(this).addClass('active');

        let content = (mode === 'translation') ? message.extra.display_text : message.mes;
        
        $('#tc-original-view').val(content);
        $('#tc-modified-view').val(content);
        
        if (isCompareMode) {
            const diff = getDiffHtml(content, content);
            $('#tc-original-preview').html(diff.oldHtml);
            $('#tc-modified-preview').html(diff.newHtml);
        }
        
        toastr.info(`${mode === 'translation' ? '번역문' : '원본'} 수정 모드로 전환되었습니다.`);
    });

    $('#tc-process-btn').on('click', () => {
        const ranges = [];
        $('.tc-range-row').each(function() {
            const start = $(this).find('.tc-start-tag').val();
            const end = $(this).find('.tc-end-tag').val();
            if (start || end) ranges.push({ start, end });
        });

        const replacements = [];
        $('.tc-replace-row').each(function() {
            const find = $(this).find('.tc-find-word').val();
            const replace = $(this).find('.tc-replace-word').val();
            if (find) replacements.push({ find, replace });
        });

        const original = $('#tc-original-view').val();
        const processed = processTextMulti(original, ranges, replacements);
        
        $('#tc-modified-view').val(processed.trim());
        lastProcessedContent = processed.trim();
        
        if (isCompareMode) {
            const $origView = $('#tc-original-view');
            const $modView = $('#tc-modified-view');
            const diff = getDiffHtml($origView.val(), $modView.val());
            $('#tc-original-preview').html(diff.oldHtml);
            $('#tc-modified-preview').html(diff.newHtml);
        }

        toastr.info("치환 결과가 반영되었습니다.");
    });

    $('#tc-apply-btn').on('click', async () => {
        if (currentMesId === null) return;

        $('.tc-range-row').each(function() {
            const s = $(this).find('.tc-start-tag').val();
            const e = $(this).find('.tc-end-tag').val();
            if (s && e) saveToHistory('range', { start: s, end: e });
        });
        $('.tc-replace-row').each(function() {
            const f = $(this).find('.tc-find-word').val();
            const r = $(this).find('.tc-replace-word').val();
            if (f) saveToHistory('replace', { find: f, replace: r });
        });

        const finalContent = $('#tc-modified-view').val();
        const context = getContext();
        const message = context.chat[currentMesId];

        if (currentEditMode === 'translation') {
            if (!message.extra) message.extra = {};
            message.extra.display_text = finalContent;
            toastr.success("번역문이 수정되었습니다.");
        } else {
            message.mes = finalContent;
            toastr.success("원본 메시지가 수정되었습니다.");
        }
        
        updateMessageBlock(currentMesId, message);
        await saveChat();
        
        await eventSource.emit(event_types.MESSAGE_UPDATED, currentMesId);
        await eventSource.emit(event_types.MESSAGE_RENDERED, currentMesId);

        $('#tc-popup-window').hide();
    });
}

/**
 * 드래그 로직 (PC 전용)
 */
function setupDraggable($popup, $header) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;

    $header.on('mousedown', (e) => {
        if (isMobile()) return; 
        if (e.target.closest('.tc-popup-close-btn') || e.target.closest('.tc-btn-add-row') || e.target.closest('.tc-theme-dot')) return;
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        const pos = $popup.position();
        startLeft = pos.left; startTop = pos.top;
        $header.css('cursor', 'grabbing');
        e.preventDefault();
    });

    $(window).on('mousemove', (e) => {
        if (!isDragging) return;
        let nl = startLeft + (e.clientX - startX);
        let nt = startTop + (e.clientY - startY);
        nl = Math.max(0, Math.min(nl, window.innerWidth - $popup.outerWidth()));
        nt = Math.max(0, Math.min(nt, window.innerHeight - $popup.outerHeight()));
        $popup.css({ left: nl + 'px', top: nt + 'px' });
    });

    $(window).on('mouseup', () => { 
        if (isDragging) {
            isDragging = false; 
            $header.css('cursor', 'move'); 
            saveDimensions($popup);
        }
    });
}
/**
 * 리사이징 로직 (PC 전용)
 */
function setupResizable($popup, $handle) {
    let isResizing = false;
    let startW, startH, startX, startY;

    $handle.on('mousedown', (e) => {
        if (isMobile()) return;
        isResizing = true;
        startX = e.clientX; startY = e.clientY;
        startW = $popup.outerWidth();
        startH = $popup.outerHeight();
        e.preventDefault();
        e.stopPropagation();
    });

    $(window).on('mousemove', (e) => {
        if (!isResizing) return;
        const nw = startW + (e.clientX - startX);
        const nh = startH + (e.clientY - startY);
        if (nw > 400) $popup.css('width', nw + 'px');
        if (nh > 500) $popup.css('height', nh + 'px');
    });

    $(window).on('mouseup', () => { 
        if (isResizing) {
            isResizing = false; 
            saveDimensions($popup);
        }
    });
}
async function openCleanerPopup(mesId) {
    ensurePopupExists();
    currentMesId = mesId;
    isCompareMode = false; 
    currentEditMode = "original"; 
    
    const context = getContext();
    const message = context.chat[mesId];
    const content = message.mes;
    
    $('.tc-tab').removeClass('active');
    $('.tc-tab[data-mode="original"]').addClass('active');
    
    if (message.extra && message.extra.display_text) {
        $('#tc-tab-translation').show();
    } else {
        $('#tc-tab-translation').hide();
    }
    
    $('#tc-original-view').val(content).show();
    $('#tc-modified-view').val(content).show();
    $('#tc-original-preview').hide();
    $('#tc-modified-preview').hide();
    $('#tc-compare-toggle-btn').removeClass('active').text('⚖️ 원본과 대조하기');
    
    lastProcessedContent = content;

    $('#tc-range-container, #tc-replace-container').empty();
    addRangeRow();
    addReplaceRow();
    
    renderHistoryTags();

    const savedTheme = localStorage.getItem(THEME_KEY) || 'dark';
    applyTheme(savedTheme);

    const $popup = $('#tc-popup-window');
    
    if (isMobile()) {
        const $chat = $('#chat');
        if ($chat.length > 0) {
            const rect = $chat[0].getBoundingClientRect();
            $popup.css({
                display: 'flex',
                top: rect.top + 'px',
                height: rect.height + 'px',
                left: '50%',
                width: '98%',
                transform: 'translateX(-50%)',
                margin: '0',
                position: 'fixed',
                'padding-bottom': 'env(safe-area-inset-bottom)'
            });
        }
        $('#tc-resize-handle').hide();
    } else {
        const savedDim = localStorage.getItem(DIMENSIONS_KEY);
        if (savedDim) {
            const dim = JSON.parse(savedDim);
            $popup.css({
                display: 'flex',
                top: dim.top,
                left: dim.left,
                width: dim.width,
                height: dim.height,
                transform: 'none' 
            });
        } else {
            $popup.css({ display: 'flex', width: '850px', height: '750px', transform: 'none' });
            const nl = (window.innerWidth - $popup.outerWidth()) / 2;
            const nt = (window.innerHeight - $popup.outerHeight()) / 2;
            $popup.css({ left: nl + 'px', top: nt + 'px' });
        }
        $('#tc-resize-handle').show();
    }
}

function addCleanerButton($mesBlock) {
    if ($mesBlock.find('.tc-cleaner-btn').length) return;
    const mesId = $mesBlock.attr('mesid');
    if (mesId === undefined) return;

    const $btn = $('<div>')
        .addClass('mes_button tc-cleaner-btn fa-solid fa-broom interactable')
        .attr('title', '텍스트 수정 도구')
        .css({ 'opacity': '0.8', 'margin-left': '5px', 'color': '#4a90e2' })
        .on('click', (e) => { e.stopPropagation(); openCleanerPopup(mesId); });
    $mesBlock.find('.extraMesButtons').append($btn);
}

$(document).ready(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = `${extensionFolderPath}/style.css`;
    document.head.appendChild(link);

    $("#chat .mes").each(function () { addCleanerButton($(this)); });
    const chatObserver = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            $(mutation.addedNodes).each(function() {
                if ($(this).hasClass('mes')) addCleanerButton($(this));
            });
        });
    });
    chatObserver.observe(document.getElementById('chat'), { childList: true, subtree: true });
});