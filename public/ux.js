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

  // --- card spotlight: --mx/--my vars (CSS radial follow kore) ---
  const SPOT = '.card,.statband .big';
  let spotEl = null, spotRaf = 0, lastEv = null;
  addEventListener('pointermove', e => {
    lastEv = e;
    if (spotRaf) return;
    spotRaf = requestAnimationFrame(() => {
      spotRaf = 0;
      const ev = lastEv;
      const t = ev.target && ev.target.closest ? ev.target.closest(SPOT) : null;
      if (t) {
        const r = t.getBoundingClientRect();
        t.style.setProperty('--mx', ((ev.clientX - r.left) / r.width * 100).toFixed(1) + '%');
        t.style.setProperty('--my', ((ev.clientY - r.top) / r.height * 100).toFixed(1) + '%');
      }
    });
  }, { passive: true });

  // --- button click ripple ---
  addEventListener('pointerdown', e => {
    const b = e.target && e.target.closest ? e.target.closest('.btn') : null;
    if (!b || matchMedia('(prefers-reduced-motion:reduce)').matches) return;
    const r = b.getBoundingClientRect();
    const s = document.createElement('i');
    s.className = 'rip';
    s.style.left = (e.clientX - r.left) + 'px';
    s.style.top = (e.clientY - r.top) + 'px';
    b.appendChild(s);
    s.addEventListener('animationend', () => s.remove());
    setTimeout(() => s.remove(), 800);
  }, { passive: true });

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
  // ═════════ COOL LAYER v4 JS: magnetic / pagetrans / parallax / confetti ═════════
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FINE = matchMedia('(pointer:fine)').matches;

  // magnetic buttons: cursor er dike halka attract hoy
  if (FINE && !REDUCED) {
    const bound = new WeakSet();
    const magnetize = b => {
      if (bound.has(b)) return;
      bound.add(b);
      b.addEventListener('pointerenter', () => { b.__mr = b.getBoundingClientRect(); });
      b.addEventListener('pointermove', e => {
        if (!b.__mr || !b.__mr.width) b.__mr = b.getBoundingClientRect();
        const nx = Math.max(-1, Math.min(1, (e.clientX - (b.__mr.left + b.__mr.width / 2)) / (b.__mr.width / 2)));
        const ny = Math.max(-1, Math.min(1, (e.clientY - (b.__mr.top + b.__mr.height / 2)) / (b.__mr.height / 2)));
        b.style.transform = `translate(${(nx * 4).toFixed(1)}px, ${(ny * 4 - 2).toFixed(1)}px)`;
      });
      b.addEventListener('pointerleave', () => { b.style.transform = ''; b.__mr = null; });
    };
    const scanBtns = () => document.querySelectorAll('.btn').forEach(magnetize);
    scanBtns();
    let moT = 0;
    new MutationObserver(() => {
      clearTimeout(moT); moT = setTimeout(() => requestAnimationFrame(scanBtns), 120);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // page transitions: internal link click → soft exit → nav
  if (!REDUCED) {
    document.addEventListener('click', e => {
      const a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (!href || href.startsWith('#') || a.target === '_blank' || a.hasAttribute('download')) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      let u;
      try { u = new URL(a.href, location.href); } catch { return; }
      if (u.origin !== location.origin) return;
      if (u.pathname === location.pathname && u.hash) return;   // tab hash — nav na
      if (u.pathname === location.pathname && u.search === location.search) return;
      e.preventDefault();
      document.documentElement.classList.add('page-exit');
      setTimeout(() => { location.href = a.href; }, 175);
    });
  }

  // scroll parallax: hero-er stars + aurora layer’er depth
  if (!REDUCED) {
    const heroStars = document.querySelector('.hero .stars');
    const cineA = document.querySelector('.cine-aurora');
    let pRaf = 0;
    addEventListener('scroll', () => {
      if (pRaf) return;
      pRaf = requestAnimationFrame(() => {
        pRaf = 0;
        const y = scrollY;
        if (heroStars) heroStars.style.transform = `translateY(${(y * 0.16).toFixed(1)}px)`;
        if (cineA) cineA.style.transform = `translateY(${(-y * 0.05).toFixed(1)}px)`;
      });
    }, { passive: true });
  }

  // logo/brand click → MC particle burst (⛏💎⚡ confetti)
  function burstFX(x, y) {
    if (REDUCED) return;
    const EM = ['⛏️', '💎', '⚡', '🟪', '🟩', '🧱', '☘️'];
    for (let i = 0; i < 18; i++) {
      const s = document.createElement('span');
      s.className = 'burstfx';
      s.textContent = EM[i % EM.length];
      const ang = Math.random() * Math.PI * 2, dist = 42 + Math.random() * 78;
      s.style.left = x + 'px'; s.style.top = y + 'px';
      s.style.fontSize = (11 + Math.random() * 9) + 'px';
      s.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(0) + 'px');
      s.style.setProperty('--dy', (Math.sin(ang) * dist - 24).toFixed(0) + 'px');
      s.style.setProperty('--rot', (Math.random() * 260 - 130).toFixed(0) + 'deg');
      document.body.appendChild(s);
      setTimeout(() => s.remove(), 1050);
    }
  }
  document.querySelectorAll('.logo,.brand').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      burstFX(e.clientX, e.clientY);
      setTimeout(() => {
        if (location.pathname !== '/' ) location.href = '/';
      }, 620);
    }, true);
  });
})();
