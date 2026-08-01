// Progressive enhancement only — every page works without this file.
(function () {
  'use strict';

  // Ship renders come from EVE's image server; if a type has no art (or the
  // board is offline) swap in the tinted initials tile instead of a broken icon.
  document.addEventListener('error', function (event) {
    var img = event.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.fallbackApplied) return;
    img.dataset.fallbackApplied = '1';

    var name = img.alt || '?';
    var span = document.createElement('span');
    span.className = img.closest('.killhead-ship') ? 'shipfallback big' : 'shipfallback';
    if (img.classList.contains('itemicon')) {
      span.className = 'itemicon placeholder';
      span.textContent = '';
    } else {
      span.textContent = name.split(/[\s-]+/).filter(Boolean).slice(0, 2)
        .map(function (w) { return w[0].toUpperCase(); }).join('');
      span.style.background = tint(name);
    }
    img.replaceWith(span);
  }, true);

  function tint(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return 'hsl(' + (hash % 360) + ' 45% 32%)';
  }

  // "/" focuses the search box, as on most killboards.
  document.addEventListener('keydown', function (event) {
    if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    var input = document.querySelector('.searchbox input');
    if (input) {
      event.preventDefault();
      input.focus();
    }
  });
})();
