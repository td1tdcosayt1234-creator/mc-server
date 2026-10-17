// MC Panel — shared cinematic UX engine (IIFE: global scope nai, conflict nai)
(function () {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  // --- scroll progress + nav shrink ---
  const sp = $('#sp'), navE = $('.nav');
  const onScroll = () => {
    if (sp) {
      const h = document.documentElement;
      const max = (h.scrollHeight || 1) - innerHeight;
      sp.style.width = (max > 0 ? (scrollY / max * 100) : 0) + '%';
    }
    if (navE) navE.classList.toggle('scrolled', scrollY > 10);
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // --- cursor glow ---
  const cg = $('#cg');
  if (cg) {
    cg.style.opacity = '0'; cg.style.transition = 'opacity .4s';
    addEventListener('pointermove', e => {
      cg.style.opacity = '1';
      cg.style.left = e.clientX + 'px'; cg.style.top = e.clientY + 'px';
    }, { passive: true });
    document.addEventListener('mouseleave', () => cg.style.opacity = '0');
  }

  // --- reveal on scroll ---
  const io = new IntersectionObserver(es => es.forEach(x => {
    if (!x.isIntersecting) return;
    x.target.classList.add('rved');
    const c = x.target.dataset.count;
    if (c != null && window.__uxCount) try { window.__uxCount(x.target, +c); } catch {}
    io.unobserve(x.target);
  }), { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  $$('.reveal,[data-reveal]').forEach(el => io.observe(el));

  // --- count-up (hidden tab e rAF freeze hoy — tokhon somoyi set kore dei) ---
  window.__uxCount = (el, to) => {
    const suffix = el.dataset.suffix || '';
    if (document.hidden) { el.textContent = String(to) + suffix; return; }
    const from = (+String(el.textContent).replace(/[^\d.]/g, '') || 0);
    if (from === to) { el.textContent = String(to) + suffix; return; }
    const t0 = performance.now(), dur = 900;
    const tick = t => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(from + (to - from) * e)) + suffix;
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  // --- reveal safety: 2.5s por o viewport e thaka element rved na hole forcefully dai (IO edge-case cover) ---
  setTimeout(() => {
    $$('.reveal').forEach(el => {
      if (el.classList.contains('rved')) return;
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) el.classList.add('rved');
    });
  }, 2500);

  // --- 3D tilt (desktop only) ---
  if (matchMedia('(pointer:fine)').matches) {
    $$('[data-tilt]').forEach(el => {
      el.style.willChange = 'transform';
      el.addEventListener('pointermove', e => {
        const r = el.getBoundingClientRect();
        const px = (e.clientX - r.left) / r.width - .5, py = (e.clientY - r.top) / r.height - .5;
        el.style.transform = `perspective(900px) rotateX(${(-py * 5).toFixed(2)}deg) rotateY(${(px * 7).toFixed(2)}deg) translateY(-3px)`;
      }, { passive: true });
      el.addEventListener('pointerleave', () => { el.style.transform = ''; });
    });
  }

  // --- starfield + shooting stars ---
  const stars = $('.stars');
  if (stars) {
    for (let i = 0; i < 26; i++) {
      const s = document.createElement('i'); s.className = 'star';
      s.style.left = (Math.random() * 100) + '%';
      s.style.top = (Math.random() * 58) + '%';
      const d = 2 + Math.random() * 4;
      s.style.animationDuration = d + 's';
      s.style.animationDelay = (-Math.random() * d) + 's';
      s.style.opacity = String(.18 + .5 * Math.random());
      stars.appendChild(s);
    }
    for (let i = 0; i < 3; i++) {
      const s = document.createElement('b'); s.className = 'shoot';
      s.style.left = (58 + Math.random() * 36) + '%';
      s.style.top = (Math.random() * 20) + '%';
      s.style.animationDuration = (7 + Math.random() * 6) + 's';
      s.style.animationDelay = (Math.random() * 8) + 's';
      stars.appendChild(s);
    }
  }
})();
