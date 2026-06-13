// assets/js/parallax.js
// Lightweight scroll parallax. No dependencies. Load AFTER main.js.
//   data-parallax-bg="0.2"  -> shifts an element's background-position (depth bg)
//   data-parallax="0.06"    -> translateY on a foreground element (subtle drift)
// Higher number = stronger movement. Disabled <=1024px and for reduced-motion.
(function () {
  'use strict';

  var reduce = window.matchMedia &&
               window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var bgEls = [].slice.call(document.querySelectorAll('[data-parallax-bg]'));
  var fgEls = [].slice.call(document.querySelectorAll('[data-parallax]'));
  if (reduce || (!bgEls.length && !fgEls.length)) return;

  var enabled = window.innerWidth > 1024;
  var ticking = false;

  function apply() {
    ticking = false;
    if (!enabled) return;
    var mid = window.innerHeight / 2;

    bgEls.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var center = r.top + r.height / 2;
      var speed = parseFloat(el.getAttribute('data-parallax-bg')) || 0.15;
      var shift = (mid - center) * speed;
      var op = shift < 0 ? '- ' : '+ ';
      el.style.backgroundPosition =
        'center calc(50% ' + op + Math.abs(shift).toFixed(1) + 'px)';
    });

    fgEls.forEach(function (el) {
      var r = el.getBoundingClientRect();
      var center = r.top + r.height / 2;
      var speed = parseFloat(el.getAttribute('data-parallax')) || 0.06;
      var shift = (mid - center) * speed;
      el.style.transform = 'translate3d(0,' + shift.toFixed(1) + 'px,0)';
    });
  }

  function onScroll() {
    if (!ticking) { window.requestAnimationFrame(apply); ticking = true; }
  }

  function onResize() {
    enabled = window.innerWidth > 1024;
    if (!enabled) { // reset so mobile layout is clean
      bgEls.forEach(function (el) { el.style.backgroundPosition = ''; });
      fgEls.forEach(function (el) { el.style.transform = ''; });
    } else {
      apply();
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize);
  apply(); // set initial positions
})();
