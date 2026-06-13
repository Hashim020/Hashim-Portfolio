// assets/js/animations.js
// Scroll-reveal via IntersectionObserver. Self-contained — does not touch main.js.
// Load this AFTER main.js with a normal <script> tag.
(function () {
  'use strict';

  var els = document.querySelectorAll('[data-reveal]');
  if (!els.length) return;

  // Older browsers without IntersectionObserver: show everything immediately.
  if (!('IntersectionObserver' in window)) {
    for (var i = 0; i < els.length; i++) els[i].classList.add('revealed');
    return;
  }

  var observer = new IntersectionObserver(function (entries, obs) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        obs.unobserve(entry.target); // reveal once, then stop watching
      }
    });
  }, {
    threshold: 0.12,
    rootMargin: '0px 0px -8% 0px' // trigger slightly before fully in view
  });

  els.forEach(function (el) { observer.observe(el); });
})();
