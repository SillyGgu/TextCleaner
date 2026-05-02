import { getContext } from '../../../extensions.js';
import { updateMessageBlock, saveChat, eventSource, event_types } from '../../../../script.js';

const extensionName = "TextCleaner";
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

const DB_NAME = 'LLMtranslatorDB';
const STORE_NAME = 'translations';

let currentMesId = null;
let isCompareMode = false;
let loadedFileName = "preset.json";

// 대조 모드 스크롤 동기화 핸들러 (리스너 누적 방지용 고정 참조)
const syncScrollHandler = (e) => {
    const $origPreview = $('#tc-original-preview');
    const $modPreview = $('#tc-modified-preview');
    if (e.target.id === 'tc-original-preview') {
        $modPreview[0].scrollTop = e.target.scrollTop;
    } else {
        $origPreview[0].scrollTop = e.target.scrollTop;
    }
};

const STORAGE_KEY = "tc_recent_editions";
const STORAGE_KEY_LLM = "tc_recent_editions_llm";
const THEME_KEY = "tc_current_theme";
const DIMENSIONS_KEY = "tc_popup_dimensions";
const PRESET_KEY = "tc_presets";

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
        } else if (!r.start && r.end) {
            // A가 비어있고 B만 있는 경우: 맨 처음부터 첫 번째 B(포함)까지 삭제
            const escapedEnd = r.end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`^[\\s\\S]*?${escapedEnd}`);
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
    // 텍스트를 라인 단위로 분리해서 라인별 diff 수행
    // 각 라인 내부는 토큰(한글/일본어/중국어 1글자, 영단어, 기타) 단위로 세분화
    function tokenize(text) {
        // CJK(한중일) 1글자씩, 영숫자 단어, 공백, 기타 문자 단위로 분리
        return text.match(/[\u1100-\u11FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]|[A-Za-z0-9_']+|[\s]+|./gsu) || [];
    }

    function lcs(a, b) {
        const n = a.length, m = b.length;
        // 메모리 절약: 2행만 유지
        let prev = new Array(m + 1).fill(0);
        let curr = new Array(m + 1).fill(0);
        const table = [];
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < m; j++) {
                curr[j + 1] = a[i] === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], curr[j]);
            }
            table.push([...curr]);
            [prev, curr] = [curr, new Array(m + 1).fill(0)];
        }
        return table;
    }

    function buildDiff(aTokens, bTokens) {
        if (aTokens.length === 0 && bTokens.length === 0) return [];
        if (aTokens.length === 0) return bTokens.map(t => ({ type: 'added', val: t }));
        if (bTokens.length === 0) return aTokens.map(t => ({ type: 'removed', val: t }));

        const table = lcs(aTokens, bTokens);
        const result = [];
        let i = aTokens.length - 1, j = bTokens.length - 1;

        while (i >= 0 || j >= 0) {
            if (i >= 0 && j >= 0 && aTokens[i] === bTokens[j]) {
                result.unshift({ type: 'common', val: aTokens[i] });
                i--; j--;
            } else if (j >= 0 && (i < 0 || (table[i] && table[i][j] >= (i > 0 ? table[i - 1][j + 1] : 0)))) {
                result.unshift({ type: 'added', val: bTokens[j] });
                j--;
            } else {
                result.unshift({ type: 'removed', val: aTokens[i] });
                i--;
            }
        }
        return result;
    }

    function mergeSame(diffs) {
        const merged = [];
        for (const d of diffs) {
            if (merged.length && merged[merged.length - 1].type === d.type) {
                merged[merged.length - 1].val += d.val;
            } else {
                merged.push({ ...d });
            }
        }
        return merged;
    }

    function diffToHtml(diffs) {
        let oldHtml = '', newHtml = '';
        for (const d of diffs) {
            const esc = escapeHtml(d.val).replace(/\n/g, '<br>');
            if (d.type === 'common') {
                oldHtml += esc;
                newHtml += esc;
            } else if (d.type === 'removed') {
                oldHtml += `<span class="tc-diff-removed">${esc}</span>`;
            } else if (d.type === 'added') {
                newHtml += `<span class="tc-diff-added">${esc}</span>`;
            }
        }
        return { oldHtml, newHtml };
    }

    // 텍스트가 너무 길면 라인 단위 diff만 수행 (성능)
    const MAX_TOKENS = 4000;
    const aTokens = tokenize(oldText);
    const bTokens = tokenize(newText);

    let diffs;
    if (aTokens.length > MAX_TOKENS || bTokens.length > MAX_TOKENS) {
        // 라인 단위로만 diff
        const aLines = oldText.split('\n');
        const bLines = newText.split('\n');
        diffs = buildDiff(aLines, bLines).map(d => ({
            type: d.type,
            val: d.val + '\n'
        }));
        // 마지막 개행 정리
        if (diffs.length && diffs[diffs.length - 1].val.endsWith('\n\n')) {
            diffs[diffs.length - 1].val = diffs[diffs.length - 1].val.slice(0, -1);
        }
    } else {
        diffs = buildDiff(aTokens, bTokens);
    }

    const merged = mergeSame(diffs);
    return diffToHtml(merged);
}

/**
 * 히스토리 관리
 */
function getCurrentHistoryKey() {
    const mode = $('.tc-mode-tabs .tc-tab.active').attr('data-mode');
    return mode === 'llm_manual' ? STORAGE_KEY_LLM : STORAGE_KEY;
}

function getHistory(overrideKey) {
    const storageKey = overrideKey || getCurrentHistoryKey();
    return JSON.parse(localStorage.getItem(storageKey) || "[]");
}

function saveToHistory(type, data) {
    const storageKey = getCurrentHistoryKey();
    let history = getHistory(storageKey);
    history = history.filter(item => JSON.stringify(item.data) !== JSON.stringify(data));
    history.unshift({ type, data });
    if (history.length > 10) history.pop();
    localStorage.setItem(storageKey, JSON.stringify(history));
    renderHistoryTags();
}

/**
 * 프리셋 관리
 */
function getPresets() {
    return JSON.parse(localStorage.getItem(PRESET_KEY) || "[]");
}

function savePreset(name, ranges, replacements) {
    const presets = getPresets();
    const existing = presets.findIndex(p => p.name === name);
    const preset = { name, ranges, replacements };
    if (existing >= 0) {
        presets[existing] = preset;
    } else {
        presets.push(preset);
    }
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
    renderPresetTags();
}

function deletePreset(name) {
    const presets = getPresets().filter(p => p.name !== name);
    localStorage.setItem(PRESET_KEY, JSON.stringify(presets));
    renderPresetTags();
}

function renderPresetTags() {
    const presets = getPresets();
    const $container = $('#tc-preset-area');
    $container.empty();

    presets.forEach((preset) => {
        const $chip = $('<div>').addClass('tc-preset-chip');
        const $name = $('<span>').text(preset.name);
        const $del = $('<span>').addClass('tc-preset-chip-del').text('✕');

        $del.on('click', (e) => {
            e.stopPropagation();
            if (confirm(`프리셋 "${preset.name}"을 삭제할까요?`)) {
                deletePreset(preset.name);
            }
        });

        $chip.on('click', () => loadPreset(preset));
        $chip.append($name).append($del);
        $container.append($chip);
    });
}

function loadPreset(preset) {
    $('#tc-range-container').empty();
    $('#tc-replace-container').empty();

    if (preset.ranges && preset.ranges.length > 0) {
        preset.ranges.forEach(r => addRangeRow(r.start, r.end));
    } else {
        addRangeRow();
    }

    if (preset.replacements && preset.replacements.length > 0) {
        preset.replacements.forEach(r => addReplaceRow(r.find, r.replace));
    } else {
        addReplaceRow();
    }

    toastr.success(`프리셋 "${preset.name}"을 불러왔습니다.`);
}

function collectCurrentRules() {
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
    return { ranges, replacements };
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
    const storageKey = getCurrentHistoryKey();
    let history = getHistory(storageKey);
    history.splice(index, 1); 
    localStorage.setItem(storageKey, JSON.stringify(history));
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
            <input type="text" class="tc-start-tag" style="flex:1" placeholder="시작">
            <span>~</span>
            <input type="text" class="tc-end-tag" style="flex:1" placeholder="종료">
            <i class="fa-solid fa-circle-xmark tc-row-remove"></i>
        </div>
    `);
    $row.find('.tc-start-tag').val(start);
    $row.find('.tc-end-tag').val(end);
    $row.find('.tc-row-remove').on('click', () => $row.remove());
    $('#tc-range-container').append($row);
}

function addReplaceRow(find = "", replace = "") {
    const $row = $(`
        <div class="tc-input-row tc-replace-row">
            <input type="text" class="tc-find-word" style="flex:1" placeholder="찾을 단어">
            <span>→</span>
            <input type="text" class="tc-replace-word" style="flex:1" placeholder="바꿀 단어">
            <i class="fa-solid fa-circle-xmark tc-row-remove"></i>
        </div>
    `);
    $row.find('.tc-find-word').val(find);
    $row.find('.tc-replace-word').val(replace);
    $row.find('.tc-row-remove').on('click', () => $row.remove());
    $('#tc-replace-container').append($row);
}

/**
 * 대조 모드 토글
 */
function toggleCompareMode() {
    isCompareMode = !isCompareMode;
    const $origView    = $('#tc-original-view');
    const $modView     = $('#tc-modified-view');
    const $origPreview = $('#tc-original-preview');
    const $modPreview  = $('#tc-modified-preview');
    const $btn         = $('#tc-compare-toggle-btn');

    if (isCompareMode) {
        $btn.addClass('active').text('🔍 편집 모드로 돌아가기');

        const originalText = $origView.val();
        const modifiedText = $modView.val();

        $origView.hide(); $modView.hide();
        $origPreview.show(); $modPreview.show();

        const diff = getDiffHtml(originalText, modifiedText);
        $origPreview.html(diff.oldHtml);
        $modPreview.html(diff.newHtml);

        if (!isMobile()) {
            $origPreview.off('scroll', syncScrollHandler).on('scroll', syncScrollHandler);
            $modPreview.off('scroll', syncScrollHandler).on('scroll', syncScrollHandler);
        }

        toastr.info('대조 모드가 시작됩니다');
    } else {
        $btn.removeClass('active').text('⚖️ 원본과 대조하기');

        $origView.show(); $modView.show();
        $origPreview.hide(); $modPreview.hide();

        $origPreview.off('scroll', syncScrollHandler);
        $modPreview.off('scroll', syncScrollHandler);
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
            <div class="tc-tab" data-mode="llm_manual">LLM 번역 관리</div> 
            <div class="tc-tab" data-mode="prompts" id="tc-tab-prompts">JSON 수정</div>
            <button id="tc-delete-reasoning-btn" class="tc-delete-reasoning-btn" title="현재 메시지의 추론(Reasoning) 블록을 즉시 삭제">🗑️ 추론 삭제</button>
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

                <!-- 프리셋 영역 -->
                <div class="tc-preset-section">
                    <span class="tc-preset-title">📁</span>
                    <div id="tc-preset-area"></div>
                    <button id="tc-save-preset-btn" class="tc-preset-save-btn" title="현재 규칙을 프리셋으로 저장">+</button>
                </div>

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
            <div id="tc-prompt-edit-area" style="display:none; flex-direction:column; gap:12px; flex:1; height: 100%;">
                <div class="tc-prompt-toolbar">
                    <button id="tc-import-json-btn" class="tc-prompt-load-btn">📂 JSON 불러오기</button>
                    <div class="tc-prompt-tool-groups">
                        <div class="tc-tool-group">
                            <span class="tc-tool-group-label">이름</span>
                            <button id="tc-export-names-btn" class="tc-tool-btn" title="프롬프트 name 항목을 txt로 저장">📤 내보내기</button>
                            <button id="tc-import-names-btn" class="tc-tool-btn" title="txt 파일로 name 항목 일괄 교체">📥 가져오기</button>
                        </div>
                        <div class="tc-tool-group">
                            <span class="tc-tool-group-label">이미지링크</span>
                            <button id="tc-export-images-btn" class="tc-tool-btn" title="JSON 내 이미지 URL을 txt로 저장">📤 내보내기</button>
                            <button id="tc-import-images-btn" class="tc-tool-btn" title="txt 파일의 새 URL로 이미지링크 일괄 교체">📥 가져오기</button>
                        </div>
                    </div>
                    <input type="file" id="tc-json-file-input" style="display:none;" accept=".json">
                    <input type="file" id="tc-names-file-input" style="display:none;" accept=".txt">
                    <input type="file" id="tc-images-file-input" style="display:none;" accept=".txt">
                </div>
                <textarea id="tc-prompt-json-view" class="tc-text-area" style="flex:1; font-family:monospace; font-size:12px; height:100%; white-space: pre;" placeholder="[📂 JSON 불러오기] 버튼을 눌러 파일을 선택하세요."></textarea>
            </div>
        </div>
        <div class="tc-popup-footer">
            <button id="tc-cancel-btn" class="tc-footer-btn tc-btn-cancel">취소</button>
            <button id="tc-apply-btn" class="tc-footer-btn tc-btn-apply">메시지에 적용</button>
        </div>
        <div id="tc-resize-handle" class="tc-resizer"></div>

        <!-- 이미지링크 가져오기 확인창 -->
        <div id="tc-image-confirm-overlay">
            <div id="tc-image-confirm-box">
                <div class="tc-icb-header">
                    <span>🖼️ 이미지링크 교체 확인</span>
                    <i class="fa-solid fa-xmark tc-icb-close" id="tc-icb-close-btn"></i>
                </div>
                <div class="tc-icb-body">
                    <div class="tc-icb-col">
                        <div class="tc-icb-col-label">기존 링크 <span id="tc-icb-old-count"></span></div>
                        <div id="tc-icb-old-list" class="tc-icb-list"></div>
                    </div>
                    <div class="tc-icb-col">
                        <div class="tc-icb-col-label" style="display:flex; justify-content:space-between; align-items:center;">
                            <span>새 링크 <span id="tc-icb-new-count"></span></span>
                            <button id="tc-icb-sort-btn" class="tc-tool-btn" title="파일명 기준으로 기존 링크 순서에 맞게 자동 정렬">🔀 자동 정렬</button>
                        </div>
                        <div id="tc-icb-new-list" class="tc-icb-list tc-icb-new-placeholder">
                            <span class="tc-icb-placeholder-text">📂 아래 버튼으로 txt 파일을 선택하세요.</span>
                        </div>
                        <button id="tc-icb-file-btn" class="tc-prompt-load-btn" style="flex-shrink:0;">📂 새 링크 txt 불러오기</button>
                        <input type="file" id="tc-images-file-input" style="display:none;" accept=".txt">
                    </div>
                </div>
                <div class="tc-icb-footer">
                    <span id="tc-icb-status" class="tc-icb-status"></span>
                    <div style="display:flex; gap:8px;">
                        <button id="tc-icb-cancel-btn" class="tc-footer-btn tc-btn-cancel">취소</button>
                        <button id="tc-icb-apply-btn" class="tc-footer-btn tc-btn-apply">교체 실행</button>
                    </div>
                </div>
            </div>
        </div>
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

    $('#tc-save-preset-btn').on('click', () => {
        const { ranges, replacements } = collectCurrentRules();
        if (ranges.length === 0 && replacements.length === 0) {
            toastr.warning("저장할 규칙이 없습니다.");
            return;
        }
        const name = prompt("프리셋 이름을 입력하세요:");
        if (!name || !name.trim()) return;
        savePreset(name.trim(), ranges, replacements);
        toastr.success(`프리셋 "${name.trim()}"이 저장되었습니다.`);
    });
    
    $('#tc-delete-reasoning-btn').on('click', async () => {
        if (currentMesId === null) {
            toastr.warning("메시지가 선택되지 않았습니다.");
            return;
        }

        const context = getContext();
        const message = context.chat[currentMesId];
        if (!message) {
            toastr.warning("메시지를 찾을 수 없습니다.");
            return;
        }

        if (!message.extra?.reasoning || message.extra.reasoning.trim() === '') {
            toastr.warning("삭제할 추론 블록이 없습니다.");
            return;
        }

        message.extra.reasoning = '';
        message.extra.reasoning_duration = undefined;

        updateMessageBlock(currentMesId, message);
        await saveChat();
        await eventSource.emit(event_types.MESSAGE_UPDATED, currentMesId);
        await eventSource.emit(event_types.MESSAGE_RENDERED, currentMesId);

        toastr.success("추론 블록이 삭제되었습니다.");
    });
	
    $('#tc-close-x, #tc-cancel-btn').on('click', () => {
        $('#tc-popup-window').hide();
        $('#tc-prompt-json-view').val('');
        loadedFileName = "preset.json";   
    });

    // 탭 클릭 이벤트
    $('.tc-tab').on('click', async function() {
        const mode = $(this).attr('data-mode');
        
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
            $('.tc-preset-section').hide();
            renderHistoryTags();
            
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
            $('.tc-preset-section').show();
            renderHistoryTags();
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
    $('#tc-export-images-btn').on('click', () => {
        try {
            const jsonStr = $('#tc-prompt-json-view').val();
            if (!jsonStr) return toastr.warning("JSON이 비어있습니다.");
            const imageRegex = /https?:\/\/[^\s'"\\]+\.(?:png|jpg|jpeg|gif|webp)[^\s'"\\]*/gi;
            const matches = jsonStr.match(imageRegex);
            if (!matches || matches.length === 0) return toastr.warning("이미지 링크를 찾을 수 없습니다.");
            const unique = [...new Set(matches)];
            downloadTextFile(unique.join('\n'), 'image_links.txt');
            toastr.success(`이미지 링크 ${unique.length}개를 내보냈습니다.`);
        } catch (e) { toastr.error("오류: " + e.message); }
    });
    $('#tc-import-names-btn').on('click', () => $('#tc-names-file-input').click());
    let tcNewUrls = [];

    function renderNewUrlList(urls) {
        const $newList = $('#tc-icb-new-list');
        $newList.removeClass('tc-icb-new-placeholder').empty();
        if (urls.length === 0) {
            $newList.addClass('tc-icb-new-placeholder').append('<span class="tc-icb-placeholder-text">📂 아래 버튼으로 txt 파일을 선택하세요.</span>');
            $('#tc-icb-new-count').text('');
            $('#tc-icb-status').text('');
            return;
        }
        urls.forEach((url, i) => {
            $newList.append(`<div class="tc-icb-row"><span class="tc-icb-idx">${i + 1}</span><span class="tc-icb-url" title="${url}">${url}</span></div>`);
        });
        const oldCount = parseInt($('#tc-icb-old-count').text().replace(/\D/g, '')) || 0;
        $('#tc-icb-new-count').text(`(${urls.length}개)`);
        const $status = $('#tc-icb-status');
        if (urls.length < oldCount) $status.text(`⚠️ ${oldCount - urls.length}개 부족`).css('color', '#e67e22');
        else if (urls.length > oldCount) $status.text(`⚠️ ${urls.length - oldCount}개 초과`).css('color', '#e67e22');
        else $status.text(`✅ 개수 일치`).css('color', '#28a745');
    }

    $('#tc-import-images-btn').on('click', () => {
        const jsonStr = $('#tc-prompt-json-view').val();
        if (!jsonStr) return toastr.warning("JSON이 비어있습니다.");
        const imageRegex = /https?:\/\/[^\s'"\\]+\.(?:png|jpg|jpeg|gif|webp)[^\s'"\\]*/gi;
        const oldUrls = [...new Set(jsonStr.match(imageRegex) || [])];
        if (oldUrls.length === 0) return toastr.warning("JSON에서 이미지링크를 찾을 수 없습니다.");

        const $oldList = $('#tc-icb-old-list');
        $oldList.empty();
        oldUrls.forEach((url, i) => {
            $oldList.append(`<div class="tc-icb-row"><span class="tc-icb-idx">${i + 1}</span><span class="tc-icb-url" title="${url}">${url}</span></div>`);
        });
        $('#tc-icb-old-count').text(`(${oldUrls.length}개)`);
        tcNewUrls = [];
        renderNewUrlList([]);
        $('#tc-icb-status').text('');
        $('#tc-image-confirm-overlay').css('display', 'flex');
    });

    $('#tc-icb-file-btn').on('click', () => $('#tc-images-file-input').click());
    $('#tc-images-file-input').on('change', function(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function(e) {
            tcNewUrls = e.target.result.split(/\r?\n/).map(u => u.trim()).filter(Boolean);
            renderNewUrlList(tcNewUrls);
            if (tcNewUrls.length === 0) toastr.warning("파일에 URL이 없습니다.");
        };
        reader.readAsText(file);
        $(this).val('');
    });

    $('#tc-icb-sort-btn').on('click', () => {
        if (tcNewUrls.length === 0) return toastr.warning("새 링크 txt를 먼저 불러오세요.");
        const oldUrls = $('#tc-icb-old-list').find('.tc-icb-url').map((_, el) => $(el).attr('title')).get();

        const getFilename = url => url.split('/').pop().split('?')[0].toLowerCase();
        const getCoreFilename = url => getFilename(url).replace(/\.[^.]+$/, '');

        const sorted = oldUrls.map(oldUrl => {
            const core = getCoreFilename(oldUrl);
            return tcNewUrls.find(newUrl => getFilename(newUrl).includes(core)) || null;
        });

        const unmatched = tcNewUrls.filter(newUrl => {
            const fn = getFilename(newUrl);
            return !oldUrls.some(oldUrl => fn.includes(getCoreFilename(oldUrl)));
        });

        let unmatchedIdx = 0;
        tcNewUrls = sorted.map(u => u || (unmatched[unmatchedIdx++] || ''));
        renderNewUrlList(tcNewUrls);
        toastr.success("파일명 기준으로 정렬했습니다.");
    });

    $('#tc-icb-close-btn, #tc-icb-cancel-btn').on('click', () => {
        $('#tc-image-confirm-overlay').hide();
        tcNewUrls = [];
    });

    $('#tc-icb-apply-btn').on('click', () => {
        if (tcNewUrls.length === 0) return toastr.warning("새 링크 txt를 먼저 불러오세요.");
        const jsonStr = $('#tc-prompt-json-view').val();
        const imageRegex = /https?:\/\/[^\s'"\\]+\.(?:png|jpg|jpeg|gif|webp)[^\s'"\\]*/gi;
        const oldUrls = [...new Set(jsonStr.match(imageRegex) || [])];
        const urlMap = {};
        oldUrls.forEach((old, i) => {
            urlMap[old] = tcNewUrls[i] || tcNewUrls[tcNewUrls.length - 1];
        });
        const replaced = jsonStr.replace(imageRegex, (match) => urlMap[match] || match);
        $('#tc-prompt-json-view').val(replaced);
        $('#tc-image-confirm-overlay').hide();
        tcNewUrls = [];
        toastr.success(`이미지링크 ${oldUrls.length}종을 교체했습니다.`);
    });

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
    let rafId = null;
    let pendingLeft, pendingTop;

    const popupEl = $popup[0];

    $header.on('mousedown', (e) => {
        if (isMobile()) return;
        if (e.target.closest('.tc-popup-close-btn') || e.target.closest('.tc-btn-add-row') || e.target.closest('.tc-theme-dot')) return;
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        const pos = $popup.position();
        startLeft = pos.left; startTop = pos.top;
        pendingLeft = startLeft; pendingTop = startTop;
        $header.css('cursor', 'grabbing');
        // will-change로 GPU 합성 레이어 예약
        popupEl.style.willChange = 'left, top';
        e.preventDefault();
    });

    const onMouseMove = (e) => {
        if (!isDragging) return;
        let nl = startLeft + (e.clientX - startX);
        let nt = startTop + (e.clientY - startY);
        nl = Math.max(0, Math.min(nl, window.innerWidth - $popup.outerWidth()));
        nt = Math.max(0, Math.min(nt, window.innerHeight - $popup.outerHeight()));
        pendingLeft = nl;
        pendingTop = nt;

        if (!rafId) {
            rafId = requestAnimationFrame(() => {
                popupEl.style.left = pendingLeft + 'px';
                popupEl.style.top = pendingTop + 'px';
                rafId = null;
            });
        }
    };

    const onMouseUp = () => {
        if (isDragging) {
            isDragging = false;
            $header.css('cursor', 'move');
            popupEl.style.willChange = 'auto';
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            saveDimensions($popup);
        }
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseup', onMouseUp);
}
/**
 * 리사이징 로직 (PC 전용)
 */
function setupResizable($popup, $handle) {
    let isResizing = false;
    let startW, startH, startX, startY;
    let rafId = null;
    let pendingW, pendingH;
    const popupEl = $popup[0];

    $handle.on('mousedown', (e) => {
        if (isMobile()) return;
        isResizing = true;
        startX = e.clientX; startY = e.clientY;
        startW = $popup.outerWidth();
        startH = $popup.outerHeight();
        pendingW = startW; pendingH = startH;
        popupEl.style.willChange = 'width, height';
        e.preventDefault();
        e.stopPropagation();
    });

    const onMouseMove = (e) => {
        if (!isResizing) return;
        const nw = startW + (e.clientX - startX);
        const nh = startH + (e.clientY - startY);
        if (nw > 400) pendingW = nw;
        if (nh > 500) pendingH = nh;

        if (!rafId) {
            rafId = requestAnimationFrame(() => {
                popupEl.style.width = pendingW + 'px';
                popupEl.style.height = pendingH + 'px';
                rafId = null;
            });
        }
    };

    const onMouseUp = () => {
        if (isResizing) {
            isResizing = false;
            popupEl.style.willChange = 'auto';
            if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
            saveDimensions($popup);
        }
    };

    window.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('mouseup', onMouseUp);
}
async function openCleanerPopup(mesId) {
    ensurePopupExists();
    isCompareMode = false;
    
    $('#tc-prompt-json-view').val('');
    loadedFileName = "preset.json";

    // DOM에서 실제 mesid를 다시 읽어와 인덱스 불일치 방지
    const $mesBlock = $(`.mes[mesid="${mesId}"]`);
    const latestMesId = $mesBlock.length ? parseInt($mesBlock.attr('mesid')) : mesId;
    currentMesId = latestMesId;

    const context = getContext();
    const message = context.chat[latestMesId];
    if (!message) {
        // 혹시 chat 배열 마지막 메시지로 fallback
        const lastIndex = context.chat.length - 1;
        if (lastIndex >= 0) {
            currentMesId = lastIndex;
        } else {
            toastr.error("메시지를 찾을 수 없습니다.");
            return;
        }
    }
    const content = (context.chat[currentMesId] || {}).mes || '';
    
    
    $('.tc-tab').removeClass('active');
    $('.tc-tab[data-mode="original"]').addClass('active');
    
    
    $('#tc-standard-edit-area').show();
    $('#tc-prompt-edit-area').hide();
    $('#tc-left-label').text('원본 메시지');
    $('#tc-right-label').text('최종 결과 (자유 편집)');
	$('#tc-apply-btn').text('메시지에 적용');
	$('.tc-preset-section').show();


    
    $('#tc-original-view').val(content).show();
    $('#tc-modified-view').val(content).show();
    $('#tc-original-preview').hide();
    $('#tc-modified-preview').hide();
    $('#tc-compare-toggle-btn').removeClass('active').text('⚖️ 원본과 대조하기');

    $('#tc-range-container, #tc-replace-container').empty();
    addRangeRow();
    addReplaceRow();
    
    renderHistoryTags();
    renderPresetTags();

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
        .on('click', (e) => {
            e.stopPropagation();
            // 클릭 시점에 부모 .mes의 현재 mesid를 다시 읽음 (move up/down 대응)
            const currentId = $btn.closest('.mes').attr('mesid');
            openCleanerPopup(currentId !== undefined ? currentId : mesId);
        });
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

        request.onsuccess = (event) => {
            const record = event.target.result;
            if (record) {
                const updateRequest = store.put({ 
                    ...record, 
                    translation: newTranslation, 
                    provider: provider, 
                    model: model, 
                    date: date 
                });
                updateRequest.onsuccess = () => resolve();
                updateRequest.onerror = (e) => reject(new Error('put error'));
            } else {
                // 현재 트랜잭션이 완전히 닫힌 뒤 새 트랜잭션으로 추가
                transaction.oncomplete = () => {
                    addTranslationToDB(originalText, newTranslation).then(resolve).catch(reject);
                };
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