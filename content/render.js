/*!
 * Jira Diff Highlighter
 * ------------------------------------------------
 * Builds the diff widget DOM.
 *
 * Two passes, GitHub-style:
 *   1. line-level diff  -> aligned rows (equal / replace / del / ins)
 *   2. word-level diff  -> intra-line highlights inside "replace" rows
 *
 * Optional wiki-markup highlighting is layered on by merging the markup token
 * runs with the diff runs by character offset, so a highlighted span never
 * straddles a diff boundary and vice versa.
 *
 * Everything is created with createElement/textContent — ticket content is
 * never re-injected as HTML.
 */
(function (root) {
    'use strict';

    var D = root.JDHDiff;
    var DELETE = -1;
    var EQUAL = 0;
    var INSERT = 1;

    /** Above this ratio of changed characters, a line pair is treated as an
     *  outright rewrite and rendered without confusing word-level confetti. */
    var REWRITE_RATIO = 0.72;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function splitLines(text) {
        return text.length ? text.split('\n') : [];
    }

    /* ------------------------------------------------------------------ *
     * Row model
     * ------------------------------------------------------------------ */

    function buildRows(oldLines, newLines) {
        var groups = D.group(D.diffArrays(oldLines, newLines));
        var rows = [];
        var i, k;

        for (i = 0; i < groups.length; i++) {
            var g = groups[i];

            if (g.op === EQUAL) {
                for (k = 0; k < g.aEnd - g.aStart; k++) {
                    rows.push({ type: 'equal', a: g.aStart + k, b: g.bStart + k });
                }
                continue;
            }

            if (g.op === DELETE) {
                var next = groups[i + 1];
                if (next && next.op === INSERT) {
                    var dels = g.aEnd - g.aStart;
                    var ins = next.bEnd - next.bStart;
                    var span = Math.max(dels, ins);
                    for (k = 0; k < span; k++) {
                        var a = k < dels ? g.aStart + k : -1;
                        var b = k < ins ? next.bStart + k : -1;
                        rows.push({
                            type: a !== -1 && b !== -1 ? 'replace' : (a !== -1 ? 'del' : 'ins'),
                            a: a,
                            b: b
                        });
                    }
                    i++; // the INSERT group has been consumed
                } else {
                    for (k = 0; k < g.aEnd - g.aStart; k++) {
                        rows.push({ type: 'del', a: g.aStart + k, b: -1 });
                    }
                }
                continue;
            }

            for (k = 0; k < g.bEnd - g.bStart; k++) {
                rows.push({ type: 'ins', a: -1, b: g.bStart + k });
            }
        }
        return rows;
    }

    /** Replace long runs of untouched lines with a single expandable marker. */
    function collapseEqualRuns(rows, context) {
        var out = [];
        var i = 0;
        while (i < rows.length) {
            if (rows[i].type !== 'equal') {
                out.push(rows[i]);
                i++;
                continue;
            }
            var j = i;
            while (j < rows.length && rows[j].type === 'equal') j++;
            var run = rows.slice(i, j);
            var head = i === 0 ? 0 : context;
            var tail = j === rows.length ? 0 : context;

            if (run.length > head + tail + 2) {
                for (var h = 0; h < head; h++) out.push(run[h]);
                out.push({ type: 'skip', rows: run.slice(head, run.length - tail) });
                for (var t = run.length - tail; t < run.length; t++) out.push(run[t]);
            } else {
                for (var r = 0; r < run.length; r++) out.push(run[r]);
            }
            i = j;
        }
        return out;
    }

    function computeStats(rows) {
        var added = 0;
        var removed = 0;
        for (var i = 0; i < rows.length; i++) {
            var t = rows[i].type;
            if (t === 'ins') added++;
            else if (t === 'del') removed++;
            else if (t === 'replace') {
                added++;
                removed++;
            }
        }
        return { added: added, removed: removed };
    }

    /* ------------------------------------------------------------------ *
     * Cell rendering: diff runs merged with markup runs
     * ------------------------------------------------------------------ */

    /** Word-level diff for one aligned line pair, cached on the row. */
    function segmentsFor(row, ctx) {
        if (row.type !== 'replace') return null;
        if (row._segments !== undefined) return row._segments;

        var result = D.diffText(
            ctx.oldLines[row.a], ctx.newLines[row.b], ctx.settings.granularity
        );
        row._segments = result.changedRatio > REWRITE_RATIO ? null : result.segments;
        return row._segments;
    }

    /** Per-character diff op for the side being rendered. */
    function opsForLine(line, segments, side, rowType) {
        var ops = new Array(line.length);
        var i;

        function fill(op) {
            for (i = 0; i < line.length; i++) ops[i] = op;
            return ops;
        }

        if (segments) {
            var at = 0;
            for (var s = 0; s < segments.length; s++) {
                var seg = segments[s];
                if (seg.op === DELETE && side !== 'old') continue;
                if (seg.op === INSERT && side !== 'new') continue;
                for (var c = 0; c < seg.text.length; c++) ops[at++] = seg.op;
            }
            // The segments for one side must reassemble that side's line. If they
            // ever don't, fall back rather than mis-colour the text.
            if (at === line.length) return ops;
        }

        if (rowType === 'del' || (rowType === 'replace' && side === 'old')) return fill(DELETE);
        if (rowType === 'ins' || (rowType === 'replace' && side === 'new')) return fill(INSERT);
        return fill(EQUAL);
    }

    /** Per-character markup kind. */
    function kindsForLine(line, ctx) {
        var kinds = new Array(line.length);
        var i;
        if (!ctx.markup) {
            for (i = 0; i < line.length; i++) kinds[i] = 'text';
            return kinds;
        }
        var tokens = root.JDHMarkup.tokenizeLine(line);
        var at = 0;
        for (var t = 0; t < tokens.length; t++) {
            for (var c = 0; c < tokens[t].text.length; c++) kinds[at++] = tokens[t].kind;
        }
        while (at < line.length) kinds[at++] = 'text';
        return kinds;
    }

    function appendRun(cell, text, op, kind) {
        var className = '';
        var tag = 'span';
        if (op === DELETE) {
            tag = 'del';
            className = 'jdh-mark jdh-mark--del';
        } else if (op === INSERT) {
            tag = 'ins';
            className = 'jdh-mark jdh-mark--ins';
        }
        if (kind && kind !== 'text') {
            className += (className ? ' ' : '') + 'jdh-mk jdh-mk--' + kind;
        }
        if (!className) {
            cell.appendChild(document.createTextNode(text));
            return;
        }
        cell.appendChild(el(tag, className, text));
    }

    function appendLine(cell, line, segments, side, rowType, ctx) {
        if (!line) return;
        var ops = opsForLine(line, segments, side, rowType);
        var kinds = kindsForLine(line, ctx);

        var start = 0;
        for (var i = 1; i <= line.length; i++) {
            var boundary = i === line.length ||
                ops[i] !== ops[start] || kinds[i] !== kinds[start];
            if (!boundary) continue;
            appendRun(cell, line.slice(start, i), ops[start], kinds[start]);
            start = i;
        }
    }

    function fillCell(cell, text, row, side, ctx) {
        if (text === undefined || text === null) {
            cell.classList.add('jdh-code--empty');
            return;
        }
        if (ctx.markup && root.JDHMarkup.isHeading(text)) {
            cell.classList.add('jdh-code--heading');
        }
        appendLine(cell, text, segmentsFor(row, ctx), side, row.type, ctx);
    }

    function gutter(value, side) {
        var g = el('div', 'jdh-gutter jdh-gutter--' + side);
        g.textContent = value === -1 || value === undefined ? '' : String(value + 1);
        return g;
    }

    /* ------------------------------------------------------------------ *
     * Skip / expand markers
     * ------------------------------------------------------------------ */

    function makeSkipRow(row, ctx, mode) {
        var wrapper = el('div', 'jdh-row jdh-row--skip');
        var cell = el('div', 'jdh-skip');
        cell.style.gridColumn = '1 / -1';

        var button = el('button', 'jdh-expand');
        button.type = 'button';
        button.textContent = '⋯ ' + row.rows.length + ' ' +
            (row.rows.length === 1 ? 'unchanged line' : 'unchanged lines');
        button.title = 'Show unchanged lines';
        button.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            var frag = document.createDocumentFragment();
            for (var i = 0; i < row.rows.length; i++) {
                frag.appendChild(renderRow(row.rows[i], ctx, mode));
            }
            wrapper.replaceWith(frag);
        });

        cell.appendChild(button);
        wrapper.appendChild(cell);
        return wrapper;
    }

    /* ------------------------------------------------------------------ *
     * Row rendering
     * ------------------------------------------------------------------ */

    function renderRow(row, ctx, mode) {
        if (row.type === 'skip') return makeSkipRow(row, ctx, mode);
        return mode === 'unified' ? renderUnifiedRow(row, ctx) : renderSplitRow(row, ctx);
    }

    function renderSplitRow(row, ctx) {
        var wrapper = el('div', 'jdh-row jdh-row--' + row.type);

        wrapper.appendChild(gutter(row.a, 'old'));
        var oldCell = el('div', 'jdh-code jdh-code--old');
        if (row.a === -1) oldCell.classList.add('jdh-code--filler');
        else fillCell(oldCell, ctx.oldLines[row.a], row, 'old', ctx);
        wrapper.appendChild(oldCell);

        wrapper.appendChild(gutter(row.b, 'new'));
        var newCell = el('div', 'jdh-code jdh-code--new');
        if (row.b === -1) newCell.classList.add('jdh-code--filler');
        else fillCell(newCell, ctx.newLines[row.b], row, 'new', ctx);
        wrapper.appendChild(newCell);

        return wrapper;
    }

    function unifiedLine(kind, aIdx, bIdx, sign, row, side, ctx) {
        var wrapper = el('div', 'jdh-row jdh-row--' + kind);
        wrapper.appendChild(gutter(aIdx, 'old'));
        wrapper.appendChild(gutter(bIdx, 'new'));
        wrapper.appendChild(el('div', 'jdh-sign', sign));

        var cell = el('div', 'jdh-code');
        var text = side === 'old' ? ctx.oldLines[aIdx] : ctx.newLines[bIdx];
        fillCell(cell, text, row, side, ctx);
        wrapper.appendChild(cell);
        return wrapper;
    }

    function renderUnifiedRow(row, ctx) {
        if (row.type === 'equal') {
            return unifiedLine('equal', row.a, row.b, ' ', row, 'old', ctx);
        }
        if (row.type === 'del') {
            return unifiedLine('del', row.a, -1, '−', row, 'old', ctx);
        }
        if (row.type === 'ins') {
            return unifiedLine('ins', -1, row.b, '+', row, 'new', ctx);
        }
        var frag = document.createDocumentFragment();
        frag.appendChild(unifiedLine('del', row.a, -1, '−', row, 'old', ctx));
        frag.appendChild(unifiedLine('ins', -1, row.b, '+', row, 'new', ctx));
        return frag;
    }

    /* ------------------------------------------------------------------ *
     * Blame
     * ------------------------------------------------------------------ */

    function renderBlame(grid, chain, ctx) {
        var result = root.JDHHistory.blame(chain);
        var frag = document.createDocumentFragment();

        for (var i = 0; i < result.lines.length; i++) {
            var revision = result.revisions[i];
            var index = chain.revisions.indexOf(revision);
            var alt = index % 2 === 1 ? ' is-alt' : '';

            var wrapper = el('div', 'jdh-row jdh-row--blame');
            var who = el('div', 'jdh-blame' + alt,
                revision.initial ? '— original —' : (revision.author || 'unknown'));
            who.title = revision.initial
                ? 'Already present before the first recorded change'
                : (revision.author || 'unknown') + ' · ' + (revision.when || 'unknown time');
            wrapper.appendChild(who);
            wrapper.appendChild(el('div', 'jdh-blame-when' + alt, revision.when || ''));
            wrapper.appendChild(gutter(i, 'new'));

            var cell = el('div', 'jdh-code' + alt);
            fillCell(cell, result.lines[i], { type: 'equal' }, 'new', ctx);
            wrapper.appendChild(cell);
            frag.appendChild(wrapper);
        }

        grid.appendChild(frag);
        return result;
    }

    /* ------------------------------------------------------------------ *
     * Clipboard
     * ------------------------------------------------------------------ */

    /**
     * Copy, synchronous path first.
     *
     * Both mechanisms need the user activation from the click that got us here,
     * and activation does not survive an await — so execCommand cannot live in
     * the rejection handler of navigator.clipboard.writeText, or it always runs
     * too late and fails. execCommand also covers on-premise Jira served over
     * plain http, where navigator.clipboard does not exist at all.
     */
    function copyText(text, done) {
        if (legacyCopy(text)) {
            done(true);
            return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                function () { done(true); },
                function () { done(false); }
            );
            return;
        }
        done(false);
    }

    /** @returns {boolean} whether the copy went through */
    function legacyCopy(text) {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        // Must stay rendered and in the viewport — an off-screen or fully
        // transparent element gets skipped by some engines.
        area.style.cssText = 'position:fixed;top:0;left:0;width:2em;height:2em;' +
            'padding:0;border:none;outline:none;box-shadow:none;background:transparent;' +
            'color:transparent;z-index:-1;';
        document.body.appendChild(area);

        var selection = document.getSelection();
        var previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

        area.select();
        var ok = false;
        try {
            ok = document.execCommand('copy');
        } catch (err) {
            ok = false;
        }
        area.remove();

        // Put the user's own selection back where it was.
        if (previous && selection) {
            selection.removeAllRanges();
            selection.addRange(previous);
        }
        return ok;
    }

    function toUnifiedText(ctx, rows, label) {
        var lines = ['--- ' + label + ' (old)', '+++ ' + label + ' (new)'];
        rows.forEach(function (row) {
            if (row.type === 'skip') {
                row.rows.forEach(function (r) { lines.push(' ' + ctx.oldLines[r.a]); });
            } else if (row.type === 'equal') {
                lines.push(' ' + ctx.oldLines[row.a]);
            } else if (row.type === 'del') {
                lines.push('-' + ctx.oldLines[row.a]);
            } else if (row.type === 'ins') {
                lines.push('+' + ctx.newLines[row.b]);
            } else {
                lines.push('-' + ctx.oldLines[row.a]);
                lines.push('+' + ctx.newLines[row.b]);
            }
        });
        return lines.join('\n');
    }

    /* ------------------------------------------------------------------ *
     * Toolbar pieces
     * ------------------------------------------------------------------ */

    function badge(className, text, title) {
        var b = el('span', 'jdh-badge ' + className, text);
        if (title) b.title = title;
        return b;
    }

    function toolbarButton(label, action, value, title) {
        var button = el('button', 'jdh-btn', label);
        button.type = 'button';
        button.dataset.action = action;
        if (value) button.dataset.value = value;
        if (title) button.title = title;
        return button;
    }

    function menuItem(label, action, title) {
        var item = el('button', 'jdh-menu-item', label);
        item.type = 'button';
        item.dataset.action = action;
        if (title) item.title = title;
        return item;
    }

    function revisionLabel(chain, index) {
        var revision = chain.revisions[index];
        if (revision.initial) return 'original';
        if (!revision.author) return 'v' + index;
        return 'v' + index + ' · ' + revision.author.split(/\s+/)[0];
    }

    /* ------------------------------------------------------------------ *
     * Public entry point
     * ------------------------------------------------------------------ */

    /**
     * @param {string} oldText
     * @param {string} newText
     * @param {object} settings
     * @param {object} [meta] fieldName, chain, revisionIndex, onToggleOriginal,
     *                        onViewChange, onMarkupChange
     */
    function build(oldText, newText, settings, meta) {
        var info = meta || {};
        var chain = info.chain || null;
        var canBlame = !!(chain && chain.revisions.length >= 2);
        var canPickRevisions = !!(chain && chain.revisions.length > 2);

        // from/to stay null until the user picks a pair. The default view must
        // be the change this history entry actually recorded — deriving it from
        // the chain instead would diff straight across a gap in a broken chain
        // and show a change nobody ever made.
        var state = {
            view: settings.viewMode === 'unified' ? 'unified' : 'split',
            markup: settings.highlightMarkup !== false,
            from: null,
            to: null
        };
        var defaultTo = chain && info.revisionIndex > 0 ? info.revisionIndex : null;
        var defaultFrom = defaultTo === null ? null : defaultTo - 1;

        var ctx = { oldLines: [], newLines: [], settings: settings, markup: state.markup };
        var rawRows = [];
        var stats = { added: 0, removed: 0 };

        function currentTexts() {
            if (chain && state.from !== null && state.to !== null) {
                return [chain.revisions[state.from].value, chain.revisions[state.to].value];
            }
            return [oldText, newText];
        }

        function recompute() {
            var pair = currentTexts();
            ctx.oldLines = splitLines(pair[0]);
            ctx.newLines = splitLines(pair[1]);
            ctx.markup = state.markup;
            rawRows = buildRows(ctx.oldLines, ctx.newLines);
            stats = computeStats(rawRows);
        }

        var container = el('div', 'jdh');
        var toolbar = el('div', 'jdh-toolbar');
        var statsHolder = el('span', 'jdh-stats');
        var toast = el('span', 'jdh-toast');
        toast.hidden = true;

        function flash(message, isError) {
            toast.textContent = message;
            toast.hidden = false;
            toast.classList.toggle('is-error', !!isError);
            clearTimeout(flash.timer);
            flash.timer = setTimeout(function () { toast.hidden = true; }, 1800);
        }

        if (info.fieldName) toolbar.appendChild(el('span', 'jdh-field', info.fieldName));
        toolbar.appendChild(statsHolder);
        toolbar.appendChild(toast);
        toolbar.appendChild(el('span', 'jdh-spacer'));

        var segmented = el('div', 'jdh-segmented');
        var splitBtn = toolbarButton('Side by side', 'view', 'split', 'Two-column diff');
        var unifiedBtn = toolbarButton('Unified', 'view', 'unified', 'Single-column diff');
        var blameBtn = toolbarButton('Blame', 'view', 'blame',
            canBlame
                ? 'Who last touched each line of the current value'
                : 'Needs more than one recorded change to this field');
        blameBtn.disabled = !canBlame;
        segmented.appendChild(splitBtn);
        segmented.appendChild(unifiedBtn);
        segmented.appendChild(blameBtn);
        toolbar.appendChild(segmented);

        var revisionsBtn = toolbarButton('Revisions', 'revisions', null,
            canPickRevisions
                ? 'Compare any two revisions of this field'
                : 'Only one recorded change to this field');
        revisionsBtn.disabled = !canPickRevisions;
        toolbar.appendChild(revisionsBtn);

        var zoomBtn = null;
        if (!info.standalone) {
            zoomBtn = toolbarButton('⤢', 'zoom', null,
                'Enlarge to the full window (Esc to close)');
            zoomBtn.setAttribute('aria-label', 'Enlarge diff');
            toolbar.appendChild(zoomBtn);
        }

        var menuButton = toolbarButton('⋯', 'menu', null, 'More actions');
        toolbar.appendChild(menuButton);

        var menu = el('div', 'jdh-menu');
        menu.hidden = true;
        var markupItem = menuItem('', 'markup', 'Dim wiki markup and highlight its structure');
        menu.appendChild(markupItem);
        menu.appendChild(el('div', 'jdh-menu-sep'));
        menu.appendChild(menuItem('Copy new value', 'copy-new'));
        menu.appendChild(menuItem('Copy old value', 'copy-old'));
        menu.appendChild(menuItem('Copy as unified diff', 'copy-diff'));
        menu.appendChild(el('div', 'jdh-menu-sep'));
        var expandItem = menuItem('Expand unchanged lines', 'expand');
        menu.appendChild(expandItem);
        if (typeof info.onOpenInTab === 'function') {
            menu.appendChild(menuItem('Open in a new tab', 'open-tab',
                'Full-page view, independent of this Jira tab'));
        }
        if (typeof info.onToggleOriginal === 'function') {
            menu.appendChild(menuItem("Show Jira's original view", 'original'));
        }
        toolbar.appendChild(menu);

        container.appendChild(toolbar);

        /* revisions panel ---------------------------------------------- */
        var revisionsPanel = el('div', 'jdh-revisions');
        revisionsPanel.hidden = true;
        var fromSelect = null;
        var toSelect = null;

        if (chain) {
            var fromWrap = el('label', 'jdh-rev-field');
            fromWrap.appendChild(el('span', 'jdh-rev-label', 'From'));
            fromSelect = el('select', 'jdh-rev-select');
            fromWrap.appendChild(fromSelect);

            var toWrap = el('label', 'jdh-rev-field');
            toWrap.appendChild(el('span', 'jdh-rev-label', 'To'));
            toSelect = el('select', 'jdh-rev-select');
            toWrap.appendChild(toSelect);

            chain.revisions.forEach(function (revision, index) {
                var text = revisionLabel(chain, index) +
                    (revision.when ? ' · ' + revision.when : '');
                var a = el('option', null, text);
                a.value = String(index);
                fromSelect.appendChild(a);
                var b = el('option', null, text);
                b.value = String(index);
                toSelect.appendChild(b);
            });

            revisionsPanel.appendChild(fromWrap);
            revisionsPanel.appendChild(toWrap);

            var latestBtn = toolbarButton('Compare to latest', 'latest', null,
                'Diff the selected "from" revision against the newest value');
            revisionsPanel.appendChild(latestBtn);
            revisionsPanel.appendChild(el('span', 'jdh-spacer'));
            revisionsPanel.appendChild(el(
                'span', 'jdh-rev-count',
                chain.revisions.length + ' recorded revisions'
            ));

            if (!chain.complete) {
                var warning = el('div', 'jdh-warning');
                warning.textContent = 'History looks incomplete — ' + chain.gaps.length +
                    ' gap' + (chain.gaps.length === 1 ? '' : 's') +
                    ' where one revision does not continue from the previous one. ' +
                    'Older entries may not be loaded yet, so revision comparisons ' +
                    'and blame across a gap can be wrong.';
                revisionsPanel.appendChild(warning);
            }

            function onSelect() {
                var from = parseInt(fromSelect.value, 10);
                var to = parseInt(toSelect.value, 10);
                if (from === to) {
                    flash('Pick two different revisions', true);
                    return;
                }
                state.from = Math.min(from, to);
                state.to = Math.max(from, to);
                syncSelects();
                recompute();
                paint();
            }
            fromSelect.addEventListener('change', onSelect);
            toSelect.addEventListener('change', onSelect);
            latestBtn.addEventListener('click', function (event) {
                event.preventDefault();
                state.to = chain.revisions.length - 1;
                if (state.from === null || state.from >= state.to) {
                    state.from = defaultFrom === null ? state.to - 1
                        : Math.min(defaultFrom, state.to - 1);
                }
                syncSelects();
                recompute();
                paint();
            });
        }

        function syncSelects() {
            if (!fromSelect) return;
            var from = state.from === null ? defaultFrom : state.from;
            var to = state.to === null ? defaultTo : state.to;
            if (from === null || to === null) return;
            fromSelect.value = String(from);
            toSelect.value = String(to);
        }

        container.appendChild(revisionsPanel);

        /* body -------------------------------------------------------- */
        var viewport = el('div', 'jdh-viewport');
        var grid = el('div', 'jdh-grid');
        viewport.appendChild(grid);
        container.appendChild(viewport);

        function paintStats() {
            statsHolder.textContent = '';
            if (state.view === 'blame') {
                statsHolder.appendChild(badge(
                    'jdh-badge--neutral',
                    chain.revisions.length + ' revisions',
                    'Blame is computed over the whole recorded history'
                ));
                if (chain && !chain.complete) {
                    statsHolder.appendChild(badge(
                        'jdh-badge--warn', 'incomplete history',
                        'Some revisions are missing, so attribution may be wrong'
                    ));
                }
                return;
            }
            if (stats.added === 0 && stats.removed === 0) {
                statsHolder.appendChild(badge('jdh-badge--neutral', 'no textual change'));
                return;
            }
            statsHolder.appendChild(badge('jdh-badge--add', '+' + stats.added,
                stats.added + ' added line(s)'));
            statsHolder.appendChild(badge('jdh-badge--del', '−' + stats.removed,
                stats.removed + ' removed line(s)'));
        }

        function paint() {
            container.dataset.view = state.view;
            // Markup can be toggled without touching the diff, so the flag has
            // to be refreshed here and not only in recompute().
            ctx.markup = state.markup;
            grid.className = 'jdh-grid jdh-grid--' + state.view;
            grid.textContent = '';
            markupItem.textContent = (state.markup ? '✓ ' : '　') + 'Highlight wiki markup';

            if (state.view === 'blame' && canBlame) {
                renderBlame(grid, chain, ctx);
            } else {
                var rows = settings.collapseUnchanged
                    ? collapseEqualRuns(rawRows, Math.max(0, settings.contextLines | 0))
                    : rawRows;
                var frag = document.createDocumentFragment();
                for (var i = 0; i < rows.length; i++) {
                    frag.appendChild(renderRow(rows[i], ctx, state.view));
                }
                grid.appendChild(frag);
            }

            splitBtn.classList.toggle('is-active', state.view === 'split');
            unifiedBtn.classList.toggle('is-active', state.view === 'unified');
            blameBtn.classList.toggle('is-active', state.view === 'blame');
            revisionsBtn.classList.toggle('is-active', !revisionsPanel.hidden);
            expandItem.disabled = !grid.querySelector('.jdh-row--skip');
            paintStats();
        }

        /* menu open/close --------------------------------------------- */
        function closeMenu() {
            menu.hidden = true;
            document.removeEventListener('click', onDocumentClick, true);
            document.removeEventListener('keydown', onKeydown, true);
        }

        function onDocumentClick(event) {
            if (!menu.contains(event.target) && event.target !== menuButton) closeMenu();
        }

        function onKeydown(event) {
            if (event.key === 'Escape') closeMenu();
        }

        function openMenu() {
            menu.hidden = false;
            document.addEventListener('click', onDocumentClick, true);
            document.addEventListener('keydown', onKeydown, true);
        }

        /* actions ------------------------------------------------------ */
        var actions = {
            view: function (button) {
                if (button.disabled) return;
                state.view = button.dataset.value;
                paint();
                if (button.dataset.value !== 'blame' &&
                    typeof info.onViewChange === 'function') {
                    info.onViewChange(button.dataset.value);
                }
            },
            revisions: function () {
                revisionsPanel.hidden = !revisionsPanel.hidden;
                syncSelects();
                revisionsBtn.classList.toggle('is-active', !revisionsPanel.hidden);
            },
            menu: function () {
                if (menu.hidden) openMenu();
                else closeMenu();
            },
            markup: function () {
                state.markup = !state.markup;
                paint();
                closeMenu();
                if (typeof info.onMarkupChange === 'function') {
                    info.onMarkupChange(state.markup);
                }
            },
            expand: function () {
                grid.querySelectorAll('.jdh-row--skip .jdh-expand').forEach(function (b) {
                    b.click();
                });
                expandItem.disabled = true;
                closeMenu();
            },
            original: function () {
                closeMenu();
                if (typeof info.onToggleOriginal === 'function') info.onToggleOriginal();
            },
            zoom: function () {
                root.JDHExpand.toggle(container, function (expanded) {
                    if (!zoomBtn) return;
                    zoomBtn.textContent = expanded ? '⤡' : '⤢';
                    zoomBtn.title = expanded
                        ? 'Back into the page (Esc)'
                        : 'Enlarge to the full window (Esc to close)';
                    zoomBtn.classList.toggle('is-active', expanded);
                });
            },
            'open-tab': function () {
                closeMenu();
                if (typeof info.onOpenInTab !== 'function') return;
                info.onOpenInTab({
                    fieldName: info.fieldName || '',
                    oldText: currentTexts()[0],
                    newText: currentTexts()[1],
                    chain: chain,
                    revisionIndex: info.revisionIndex,
                    view: state.view
                }, function (ok, message) {
                    flash(ok ? 'Opened in a new tab' : (message || 'Could not open'), !ok);
                });
            },
            'copy-new': function () {
                copyText(currentTexts()[1], function (ok) {
                    flash(ok ? 'New value copied' : 'Copy failed', !ok);
                });
                closeMenu();
            },
            'copy-old': function () {
                copyText(currentTexts()[0], function (ok) {
                    flash(ok ? 'Old value copied' : 'Copy failed', !ok);
                });
                closeMenu();
            },
            'copy-diff': function () {
                var text = toUnifiedText(ctx, rawRows, info.fieldName || 'value');
                copyText(text, function (ok) {
                    flash(ok ? 'Unified diff copied' : 'Copy failed', !ok);
                });
                closeMenu();
            }
        };

        container.addEventListener('click', function (event) {
            var button = event.target.closest('button[data-action]');
            if (!button || !container.contains(button)) return;
            if (button.closest('.jdh-viewport')) return; // expand buttons handle themselves
            event.preventDefault();
            event.stopPropagation();
            var handler = actions[button.dataset.action];
            if (handler) handler(button);
        });

        recompute();
        syncSelects();
        paint();

        return {
            element: container,
            stats: stats,
            repaint: paint,
            setMarkup: function (on) {
                if (state.markup === on) return;
                state.markup = on;
                paint();
            },
            /** Adopt a layout chosen in another widget, without a rebuild. */
            setView: function (mode) {
                if (state.view === mode) return;
                // Blame is a per-field deep dive the user asked for explicitly;
                // another widget's layout switch must not yank them out of it.
                if (state.view === 'blame') return;
                if (mode !== 'split' && mode !== 'unified') return;
                state.view = mode;
                paint();
            },
            /** Must run before the widget is detached, or an expanded overlay
             *  would be left stranded on <body>. */
            destroy: function () {
                closeMenu();
                if (root.JDHExpand) root.JDHExpand.release(container);
            }
        };
    }

    root.JDHRender = {
        build: build,
        buildRows: buildRows,
        collapseEqualRuns: collapseEqualRuns,
        toUnifiedText: toUnifiedText
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHRender;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
