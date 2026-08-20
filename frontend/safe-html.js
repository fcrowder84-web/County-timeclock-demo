(function (global) {
    'use strict';

    const replacements = Object.freeze({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    });

    function escape(value) {
        if (value === null || value === undefined) return '';
        return String(value).replace(/[&<>"']/g, character => replacements[character]);
    }

    global.SafeHtml = Object.freeze({ escape });
})(window);
