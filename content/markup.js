/*!
 * Jira Diff Highlighter
 * ------------------------------------------------
 * Jira wiki-markup tokenizer, for optional syntax highlighting inside the diff.
 *
 * Deliberately a scanner, not a parser: history values are diff fragments and
 * frequently malformed halves of markup, so anything that needs a balanced tree
 * would give up exactly when it is most needed. Every token carries its exact
 * source text, so concatenating the tokens reproduces the input byte for byte —
 * that invariant is what lets the renderer merge these runs with diff runs by
 * character offset.
 */
(function (root) {
    'use strict';

    var HEADING = /^(h[1-6]\.)([ \t]*)/;
    var LIST = /^([ \t]*)([*#]{1,3}|-{1,2}|\+)([ \t]+)/;

    /**
     * Inline rules, tried in order at each position. `wrap` marks the delimiter
     * characters so they can be dimmed independently of the content.
     */
    var INLINE = [
        // {{monospace}}
        { kind: 'mono', re: /^\{\{([\s\S]*?)\}\}/, open: 2, close: 2 },
        // {noformat}, {code:java}, {color:#ff0000}, {panel}, {quote}
        { kind: 'macro', re: /^\{[a-zA-Z][^}\n]*\}/ },
        // !image.png|width=538!
        { kind: 'image', re: /^!([^!\n]+)!/ },
        // [text|https://…] and [https://…]
        { kind: 'link', re: /^\[([^\]\n]*)\]/, open: 1, close: 1 },
        // bare URL
        { kind: 'url', re: /^(?:https?|ftp):\/\/[^\s|\])}>]+/ },
        // *strong*
        { kind: 'strong', re: /^\*([^*\n]+)\*/, open: 1, close: 1 },
        // _emphasis_
        { kind: 'em', re: /^_([^_\n]+)_/, open: 1, close: 1 },
        // ??citation??
        { kind: 'cite', re: /^\?\?([^?\n]+)\?\?/, open: 2, close: 2 },
        // +inserted+
        { kind: 'ins', re: /^\+([^+\n]+)\+/, open: 1, close: 1 }
    ];

    function push(out, kind, text) {
        if (!text) return;
        var last = out[out.length - 1];
        if (last && last.kind === kind) last.text += text;
        else out.push({ kind: kind, text: text });
    }

    function scanInline(text, out) {
        var index = 0;
        var plain = '';

        while (index < text.length) {
            var matched = null;
            for (var r = 0; r < INLINE.length && !matched; r++) {
                var rule = INLINE[r];
                var hit = rule.re.exec(text.slice(index));
                if (hit) matched = { rule: rule, text: hit[0] };
            }

            if (!matched) {
                plain += text.charAt(index);
                index += 1;
                continue;
            }

            push(out, 'text', plain);
            plain = '';

            var whole = matched.text;
            var rule2 = matched.rule;
            if (rule2.open) {
                push(out, 'delim', whole.slice(0, rule2.open));
                push(out, rule2.kind, whole.slice(rule2.open, whole.length - rule2.close));
                push(out, 'delim', whole.slice(whole.length - rule2.close));
            } else {
                push(out, rule2.kind, whole);
            }
            index += whole.length;
        }
        push(out, 'text', plain);
    }

    /**
     * @param {string} line
     * @returns {Array<{kind: string, text: string}>} concatenates back to `line`
     */
    function tokenizeLine(line) {
        var out = [];
        if (!line) return out;

        var offset = 0;
        var heading = HEADING.exec(line);
        if (heading) {
            push(out, 'delim', heading[1]);
            push(out, 'text', heading[2]);
            offset = heading[0].length;
        } else {
            var list = LIST.exec(line);
            if (list) {
                push(out, 'text', list[1]);
                push(out, 'delim', list[2]);
                push(out, 'text', list[3]);
                offset = list[0].length;
            }
        }

        scanInline(line.slice(offset), out);
        return out;
    }

    function isHeading(line) {
        return HEADING.test(line);
    }

    root.JDHMarkup = {
        tokenizeLine: tokenizeLine,
        isHeading: isHeading
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHMarkup;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
