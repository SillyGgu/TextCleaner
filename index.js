import { getContext } from '../../../extensions.js';
import { updateMessageBlock, saveChat, eventSource, event_types } from '../../../../script.js';

const extensionName = "TextCleaner";
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

const DB_NAME = 'LLMtranslatorDB';
const STORE_NAME = 'translations';

let currentMesId = null;
let lastProcessedContent = "";
let isCompareMode = false;
let currentEditMode = "original";
let loadedFileName = "preset.json";

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

    let merged = [];
    diffs.forEach(item => {
        if (merged.length > 0 && merged[merged.length - 1].type === item.type) {
            merged[merged.length - 1].val += item.val;
        } else {
            merged.push(item);
        }
    });

    for (let iter = 0; iter < 3; iter++) { 
        let cleaned = [];
        for (let k = 0; k < merged.length; k++) {
            let item = merged[k];
            if (item.type === 'common' && item.val.length < 4) {
                let prev = cleaned[cleaned.length - 1];
                let next = merged[k + 1];

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
 * 텍스트 파일 다운로드 헬퍼 함수
 */
function downloadTextFile(content, filename) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
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
            <!-- 기존 번역문 수정 탭 제거됨 -->
            <div class="tc-tab" data-mode="llm_manual">LLM 번역 관리</div> <!-- [수정] 탭 이름 변경 -->
            <div class="tc-tab" data-mode="prompts" id="tc-tab-prompts">프롬프트 수정</div>
        </div>
        <div class="tc-popup-body">
            <!-- 일반 편집 모드 영역 (LLM 모드 공유) -->
            <div id="tc-standard-edit-area">
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
                        <span id="tc-left-label">원본 메시지</span>
                        <textarea id="tc-original-view" class="tc-text-area" readonly></textarea>
                        <div id="tc-original-preview" class="tc-preview-area" style="display:none;"></div>
                    </div>
                    <div class="tc-diff-box">
                        <span id="tc-right-label">최종 결과 (자유 편집)</span>
                        <textarea id="tc-modified-view" class="tc-text-area"></textarea>
                        <div id="tc-modified-preview" class="tc-preview-area" style="display:none;"></div>
                    </div>
                </div>
            </div>

            <!-- 프롬프트 편집 모드 영역 -->
            <div id="tc-prompt-edit-area" style="display:none; flex-direction:column; gap:10px; flex:1; height: 100%;">
                <div class="tc-section-header">
                    <label>프롬프트 JSON 및 이름 일괄 수정</label>
                    <div style="display:flex; gap:5px;">
                        <button id="tc-import-json-btn" class="tc-btn-add-row" style="background:#4a90e2; color:white;">📂 JSON 불러오기</button>
                        <button id="tc-export-names-btn" class="tc-btn-add-row">📤 이름 내보내기</button>
                        <button id="tc-import-names-btn" class="tc-btn-add-row">📥 이름 가져오기</button>
                        <input type="file" id="tc-json-file-input" style="display:none;" accept=".json">
                        <input type="file" id="tc-names-file-input" style="display:none;" accept=".txt">
                    </div>
                </div>
                <textarea id="tc-prompt-json-view" class="tc-text-area" style="flex:1; font-family:monospace; font-size:12px; height:100%; white-space: pre;" placeholder="[📂 JSON 불러오기] 버튼을 눌러 실리태번 프롬프트 파일을 선택하세요."></textarea>
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
    $('#tc-compare-toggle-btn').on('click', toggleCompareMode);
    
    $('#tc-close-x, #tc-cancel-btn').on('click', () => {
        $('#tc-popup-window').hide();
        $('#tc-prompt-json-view').val('');
        loadedFileName = "preset.json";   
    });

    // 탭 클릭 이벤트
    $('.tc-tab').on('click', async function() {
        const mode = $(this).attr('data-mode');
        currentEditMode = mode;
        
        $('.tc-tab').removeClass('active');
        $(this).addClass('active');

        if (mode === 'prompts') {
            $('#tc-standard-edit-area').hide();
            $('#tc-prompt-edit-area').css('display', 'flex');
            $('#tc-apply-btn').text('💾 JSON 다운로드');
            return; 
        }

        $('#tc-standard-edit-area').show();
        $('#tc-prompt-edit-area').hide();

        const context = getContext();
        const message = context.chat[currentMesId];
        let content = "";

        if (mode === 'llm_manual') {
            $('#tc-apply-btn').text('💾 DB 업데이트');
            $('#tc-left-label').text('기존 번역 데이터');
            $('#tc-right-label').text('최종 번역문');
            
            $('#tc-original-view').val("DB 조회 중...");
            $('#tc-modified-view').val("DB 조회 중...");

            try {
                const originalText = message.mes;
                const dbTranslation = await getTranslationFromDB(originalText);
                // DB에 없으면 현재 채팅창의 번역(display_text)을 가져옴
                content = dbTranslation || message.extra?.display_text || "";
            } catch (e) {
                console.error(e);
                content = "";
            }
            toastr.info(`LLM 번역 관리 모드로 전환되었습니다.`);

        } else {
            // 원본 메시지 수정 모드
            $('#tc-apply-btn').text('메시지에 적용');
            $('#tc-left-label').text('원본 메시지');
            $('#tc-right-label').text('최종 결과 (자유 편집)');
            content = message.mes;
            toastr.info(`원본 수정 모드로 전환되었습니다.`);
        }

        $('#tc-original-view').val(content);
        $('#tc-modified-view').val(content);
        
        if (isCompareMode) {
            const diff = getDiffHtml(content, content);
            $('#tc-original-preview').html(diff.oldHtml);
            $('#tc-modified-preview').html(diff.newHtml);
        }
    });

    // 적용 버튼 이벤트
    $('#tc-apply-btn').on('click', async () => {
        const activeMode = $('.tc-mode-tabs .tc-tab.active').attr('data-mode');

        if (activeMode === 'prompts') {
            const jsonStr = $('#tc-prompt-json-view').val();
            if (!jsonStr) {
                toastr.warning("저장할 내용이 없습니다.");
                return;
            }
            try {
                JSON.parse(jsonStr); 
                downloadTextFile(jsonStr, loadedFileName); 
                toastr.success(`'${loadedFileName}' 다운로드 완료.`);
            } catch (e) {
                toastr.error("JSON 형식이 올바르지 않아 다운로드할 수 없습니다.");
            }
            return; 
        }

        if (currentMesId === null) return;

        // 히스토리 저장
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

        // LLM 번역 관리 저장
        if (activeMode === 'llm_manual') {
            if (!finalContent.trim()) {
                toastr.warning("저장할 번역 내용이 없습니다.");
                return;
            }
            try {
                const originalText = message.mes;
                const existing = await getTranslationFromDB(originalText);
                
                if (existing) {
                    await updateTranslationByOriginalText(originalText, finalContent);
                    toastr.success("DB 데이터가 업데이트되었습니다.");
                } else {
                    await addTranslationToDB(originalText, finalContent);
                    toastr.success("DB에 번역이 등록되었습니다.");
                }

                if (!message.extra) message.extra = {};
                message.extra.display_text = finalContent;
                
            } catch (e) {
                toastr.error("DB 저장 실패: " + e.message);
                return;
            }
        } 
        // 원본 메시지 저장
        else {
            message.mes = finalContent;
            toastr.success("원본 메시지가 수정되었습니다.");
        }
        
        updateMessageBlock(currentMesId, message);
        await saveChat();
        await eventSource.emit(event_types.MESSAGE_UPDATED, currentMesId);
        await eventSource.emit(event_types.MESSAGE_RENDERED, currentMesId);

        $('#tc-popup-window').hide();
        $('#tc-prompt-json-view').val('');
        loadedFileName = "preset.json";
    });
    
    // (이하 프롬프트 및 치환 버튼 이벤트들 기존 유지)
    $('#tc-import-json-btn').on('click', () => $('#tc-json-file-input').click());
    $('#tc-json-file-input').on('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        loadedFileName = file.name; 
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const jsonContent = JSON.parse(e.target.result);
                $('#tc-prompt-json-view').val(JSON.stringify(jsonContent, null, 4));
                toastr.success(`'${loadedFileName}' 파일을 불러왔습니다.`);
            } catch (err) {
                toastr.error("JSON 파싱 실패: " + err.message);
            }
        };
        reader.readAsText(file);
        $(this).val(''); 
    });
    $('#tc-export-names-btn').on('click', () => {
        try {
            const jsonStr = $('#tc-prompt-json-view').val();
            if (!jsonStr) return toastr.warning("JSON이 비어있습니다.");
            const data = JSON.parse(jsonStr);
            let promptsArray = Array.isArray(data) ? data : (data.prompts || []);
            const names = promptsArray.map(p => p.name || "Unknown").join('\n');
            downloadTextFile(names, 'prompt_names.txt');
        } catch (e) { toastr.error("오류: " + e.message); }
    });
    $('#tc-import-names-btn').on('click', () => $('#tc-names-file-input').click());
    $('#tc-names-file-input').on('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            const newNames = e.target.result.split(/\r?\n/);
            try {
                const jsonStr = $('#tc-prompt-json-view').val();
                let data = JSON.parse(jsonStr);
                let promptsArray = Array.isArray(data) ? data : (data.prompts || null);
                if (!promptsArray) return toastr.error("프롬프트 구조 아님");
                promptsArray.forEach((p, i) => { if (i < newNames.length) p.name = newNames[i]; });
                $('#tc-prompt-json-view').val(JSON.stringify(data, null, 4));
                toastr.success("이름 업데이트 완료");
            } catch (err) { toastr.error("오류: " + err.message); }
        };
        reader.readAsText(file);
        $(this).val('');
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

        // [수정됨] 누적 적용을 위해 source를 original-view가 아닌 modified-view(현재 결과물)로 변경
        const currentContent = $('#tc-modified-view').val();
        const processed = processTextMulti(currentContent, ranges, replacements);
        
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
    
    $('#tc-prompt-json-view').val('');
    loadedFileName = "preset.json";
	
    const context = getContext();
    const message = context.chat[mesId];
    const content = message.mes;
    
    
    $('.tc-tab').removeClass('active');
    $('.tc-tab[data-mode="original"]').addClass('active');
    
    
    $('#tc-standard-edit-area').show();
    $('#tc-prompt-edit-area').hide();
    $('#tc-left-label').text('원본 메시지');
    $('#tc-right-label').text('최종 결과 (자유 편집)');
    $('#tc-apply-btn').text('메시지에 적용');


    
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
            $popup.css({ display: 'flex', width: '850px', height: '800px', transform: 'none' });
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

    const style = document.createElement('style');
    style.innerHTML = `
        #tc-popup-window, 
        #tc-popup-window input, 
        #tc-popup-window textarea, 
        #tc-popup-window .tc-preview-area,
        #tc-popup-window .tc-tab,
        #tc-popup-window .tc-btn-process {
            font-family: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, 
                         "Segoe UI", Roboto, "Helvetica Neue", Arial, "Apple SD Gothic Neo", 
                         "Noto Sans KR", "Malgun Gothic", 
                         "Noto Sans CJK SC", "Noto Sans CJK TC", "Microsoft YaHei", "微软雅黑", 
                         STHeiti, "sans-serif" !important;
        }
    `;
    document.head.appendChild(style);

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

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);

        request.onerror = (event) => {
            reject(new Error("IndexedDB open error"));
        };

        request.onsuccess = (event) => {
            resolve(event.target.result);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                objectStore.createIndex('originalText', 'originalText', { unique: false });
                objectStore.createIndex('provider', 'provider', { unique: false });
                objectStore.createIndex('model', 'model', { unique: false });
                objectStore.createIndex('date', 'date', { unique: false });
            }
        };
    });
}

async function getTranslationFromDB(originalText) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('originalText');
        const request = index.get(originalText);

        request.onsuccess = (event) => {
            const record = event.target.result;
            resolve(record ? record.translation : null);
        };
        request.onerror = (e) => {
            reject(new Error("DB get error"));
        };
        transaction.oncomplete = function () {
            db.close();
        };
    });
}

async function addTranslationToDB(originalText, translation) {
    const db = await openDB();
    
    
    const provider = "TextCleaner"; 
    const model = "Manual";

    const utcDate = new Date();
    const koreanDate = new Date(utcDate.getTime() + (9 * 60 * 60 * 1000));
    const date = koreanDate.toISOString();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        const request = store.add({
            originalText: originalText,
            translation: translation,
            provider: provider,
            model: model,
            date: date
        });

        request.onsuccess = (event) => {
            resolve("add success");
        };
        request.onerror = (event) => {
            reject(new Error("add error"));
        };
        transaction.oncomplete = function () {
            db.close();
        };
    });
}

async function updateTranslationByOriginalText(originalText, newTranslation) {
    const db = await openDB();
    const provider = "TextCleaner";
    const model = "Manual";
    
    const utcDate = new Date();
    const koreanDate = new Date(utcDate.getTime() + (9 * 60 * 60 * 1000));
    const date = koreanDate.toISOString();

    return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('originalText');
        const request = index.get(originalText);

        request.onsuccess = async (event) => {
            const record = event.target.result;
            if (record) {
                const updateRequest = store.put({ 
                    ...record, 
                    translation: newTranslation, 
                    provider: provider, 
                    model: model, 
                    date: date 
                });
                updateRequest.onsuccess = () => {
                    resolve();
                };
                updateRequest.onerror = (e) => {
                    reject(new Error('put error'));
                };
            } else {
                
                try {
                    await addTranslationToDB(originalText, newTranslation);
                    resolve();
                } catch(e) {
                    reject(e);
                }
            }
        };
        request.onerror = (e) => {
            reject(new Error('get error'));
        };
        transaction.oncomplete = function () {
            db.close();
        };
    });
}