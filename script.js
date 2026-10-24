/* ==========================================================================
   Mon Site — script.js
   --------------------------------------------------------------------------
   Aucune dépendance. Tout est protégé par un try/catch : si un module échoue,
   les autres continuent de fonctionner.

   Sommaire
     0. Configuration (à modifier : mode d'envoi du formulaire)
     1. Utilitaires
     2. Titres découpés mot par mot + apparitions « swipe down »
     3. Défilement : en-tête, barre de progression, parallaxe, lien actif
     4. Défilement lissé à la molette + ancres fluides
     5. Menu mobile
     6. Halo qui suit la souris (hero)
     7. Formulaire de contact (validation, estimation, envoi, anti-bot)
     8. Petits plus (année, e-mails protégés, boutons « Choisir »)
   ========================================================================== */
(() => {
  'use strict';

  /* ======================================================================
     0. CONFIGURATION
     ====================================================================== */
  const CONFIG = {
    /* Mode d'envoi du formulaire :
       'php'       → formulaire.php sur ton hébergement (RECOMMANDÉ : jeton signé, limitation
                     de débit, aucune clé dans le navigateur, e-mail envoyé par ton serveur)
       'web3forms' → envoi direct depuis le navigateur via https://web3forms.com (sans serveur)
       'formspree' → envoi direct depuis le navigateur via https://formspree.io (sans serveur)

       ⚠ Pour 'web3forms' / 'formspree' : ajoute aussi le domaine du service dans la directive
         `connect-src` de la Content-Security-Policy du fichier .htaccess, sinon le navigateur
         bloquera l'envoi (ex. connect-src 'self' https://api.web3forms.com). */
    provider: 'php',

    php: { endpoint: 'formulaire.php' },
    web3forms: { endpoint: 'https://api.web3forms.com/submit', accessKey: 'VOTRE_CLE_ACCES_WEB3FORMS' },
    formspree: { endpoint: 'https://formspree.io/f/VOTRE_ID_FORMSPREE' },

    minFillMs: 3000,     // anti-bot : délai minimum entre l'ouverture du formulaire et l'envoi
    timeoutMs: 15000,    // abandon d'une requête trop longue
    tokenMaxAgeMs: 90 * 60 * 1000, // un jeton est redemandé après 90 min (le serveur l'accepte 2 h)

    // Tarifs utilisés pour l'estimation affichée sous le formulaire (purement indicatif)
    prices: { 'type-a': 700, 'type-b': 1000, hosting: 30 },
  };


  /* ======================================================================
     1. UTILITAIRES
     ====================================================================== */
  const root = document.documentElement;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  // Le CSS n'applique les états « masqués » (animations) que si le JS tourne
  root.classList.remove('no-js');
  root.classList.add('js');


  /* ======================================================================
     2. TITRES MOT PAR MOT + APPARITIONS « SWIPE DOWN »
     Chaque mot est enveloppé dans un masque ; il « tombe » du haut quand le
     titre entre à l'écran. Les blocs .reveal glissent du haut vers le bas.
     ====================================================================== */
  function splitWords(element) {
    let index = 0;
    const walk = (node) => {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) { walk(child); return; }
        if (child.nodeType !== Node.TEXT_NODE) return;

        const fragment = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach((part) => {
          if (!part) return;
          if (/^\s+$/.test(part)) { fragment.append(document.createTextNode(' ')); return; }
          const outer = document.createElement('span');
          const inner = document.createElement('span');
          outer.className = 'w';
          inner.className = 'w__in';
          inner.textContent = part;                       // textContent : jamais d'HTML injecté
          inner.style.setProperty('--w', String(index++)); // décalage entre les mots
          outer.append(inner);
          fragment.append(outer);
        });
        child.replaceWith(fragment);
      });
    };
    walk(element);
  }

  function initReveal() {
    $$('[data-split]').forEach(splitWords);

    // Les enfants d'un groupe apparaissent l'un après l'autre
    $$('[data-stagger]').forEach((group) => {
      Array.from(group.children).forEach((child, i) => child.style.setProperty('--i', String(i)));
    });

    const targets = $$('.reveal, [data-split]');
    const finish = (el) => el.classList.add('is-done'); // libère le calque GPU (will-change)

    if (!('IntersectionObserver' in window) || reduceMotion.matches) {
      targets.forEach((el) => { el.classList.add('is-in'); finish(el); });
      return;
    }

    // Seuil à 0 : les cartes sont masquées par un clip-path, ce qui ramène leur ratio d'intersection à 0.
    // On déclenche donc dès qu'elles entrent dans la fenêtre (marge basse de 10 %).
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        el.classList.add('is-in');
        setTimeout(() => finish(el), 2800);
        observer.unobserve(el);
      });
    }, { threshold: 0, rootMargin: '0px 0px -10% 0px' });

    targets.forEach((el) => observer.observe(el));
  }


  /* ======================================================================
     3. DÉFILEMENT : en-tête, progression, parallaxe, lien actif
     Un seul écouteur passif, regroupé via requestAnimationFrame : lecture
     d'abord, écriture ensuite (pas de recalcul de mise en page inutile).
     ====================================================================== */
  function initScrollEffects() {
    const header = $('.header');
    const bar = $('.progress span');
    const hero = $('.hero');
    const heroInner = $('.hero__inner');
    let heroVisible = Boolean(hero);
    let ticking = false;

    const update = () => {
      ticking = false;
      const y = window.scrollY;
      const max = Math.max(1, root.scrollHeight - window.innerHeight);

      if (header) header.classList.toggle('is-scrolled', y > 12);
      if (bar) bar.style.transform = 'scaleX(' + clamp(y / max, 0, 1).toFixed(4) + ')';

      // Parallaxe douce : le contenu du hero descend moins vite que la page et s'estompe
      if (heroInner && heroVisible && !reduceMotion.matches) {
        const progress = clamp(y / window.innerHeight, 0, 1);
        heroInner.style.transform = 'translate3d(0,' + (y * 0.14).toFixed(1) + 'px,0)';
        heroInner.style.opacity = String(1 - progress * 0.85);
      }
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    // Pas de lecture de window.scrollY au chargement (elle forcerait un calcul de mise en page) :
    // si le navigateur restaure une position, il émet un évènement « scroll ».

    if (hero && 'IntersectionObserver' in window) {
      new IntersectionObserver(([entry]) => { heroVisible = entry.isIntersecting; onScroll(); }).observe(hero);
    }
  }

  // Met en évidence le lien du menu correspondant à la section affichée
  function initActiveNav() {
    const links = $$('.nav__list a[href^="#"]');
    if (!links.length || !('IntersectionObserver' in window)) return;

    const byId = new Map(links.map((a) => [a.getAttribute('href').slice(1), a]));
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const link = byId.get(entry.target.id);
        if (!link) return;
        if (entry.isIntersecting) {
          links.forEach((a) => a.removeAttribute('aria-current'));
          link.setAttribute('aria-current', 'true');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    }, { rootMargin: '-45% 0px -50% 0px' }); // bande fine au milieu de l'écran

    byId.forEach((_, id) => { const section = document.getElementById(id); if (section) observer.observe(section); });
  }


  /* ======================================================================
     4. DÉFILEMENT LISSÉ À LA MOLETTE + ANCRES FLUIDES
     - Souris à molette uniquement : sur mobile/tactile, le défilement natif
       (inertie du système) reste intact, c'est le plus fluide.
     - Pavés tactiles / souris haute résolution : on ne touche à rien.
     - Désactivé si l'utilisateur préfère moins de mouvement.
     ====================================================================== */
  function initSmoothScroll() {
    if (reduceMotion.matches || !finePointer.matches) return null;
    root.classList.add('has-smooth'); // coupe le `scroll-behavior: smooth` natif (évite le double lissage)

    // Resynchronisées sur la vraie position avant chaque usage (syncToReal) : pas de lecture au chargement
    let current = 0;   // position affichée
    let target = 0;    // position visée
    let lastSet = 0;   // dernière position écrite par nous
    let raf = 0;
    let lastTime = 0;
    let anchor = null;            // élément visé (recalculé à chaque image : la page peut changer de hauteur)

    const maxScroll = () => Math.max(0, root.scrollHeight - window.innerHeight);
    const headerOffset = () => parseFloat(getComputedStyle(root).scrollPaddingTop) || 0;
    const anchorY = (el) => el.getBoundingClientRect().top + window.scrollY - headerOffset() - (parseFloat(getComputedStyle(el).scrollMarginTop) || 0);

    const syncToReal = () => { current = target = lastSet = window.scrollY; };
    const stop = () => { if (raf) cancelAnimationFrame(raf); raf = 0; anchor = null; syncToReal(); };

    function frame(now) {
      const dt = Math.min(64, now - (lastTime || now - 16));
      lastTime = now;

      // Quelqu'un d'autre a bougé la page (barre de défilement, clavier…) : on lui rend la main
      if (Math.abs(window.scrollY - lastSet) > 2) { stop(); return; }

      if (anchor) target = clamp(anchorY(anchor), 0, maxScroll());

      // Lissage exponentiel indépendant de la fréquence d'écran (60/120/144 Hz)
      current += (target - current) * (1 - Math.exp(-dt / 85));
      if (Math.abs(target - current) < 0.5) current = target;

      lastSet = current;
      window.scrollTo(0, current);

      if (current !== target) { raf = requestAnimationFrame(frame); return; }
      raf = 0; anchor = null; lastTime = 0;
    }

    const run = () => { if (!raf) { lastTime = 0; raf = requestAnimationFrame(frame); } };

    // Une zone qui défile elle-même (textarea…) garde son comportement natif
    function canScrollInside(el, dy) {
      for (let node = el; node && node !== document.body && node !== root; node = node.parentElement) {
        if (node.scrollHeight <= node.clientHeight + 1) continue;
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY !== 'auto' && overflowY !== 'scroll') continue;
        if (dy > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0) return true;
      }
      return false;
    }

    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey || e.defaultPrevented) return;      // zoom du navigateur
      if (root.classList.contains('menu-open')) return;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;           // geste horizontal

      const dy = e.deltaMode === 1 ? e.deltaY * 34
               : e.deltaMode === 2 ? e.deltaY * window.innerHeight
               : e.deltaY;
      if (!raf && Math.abs(dy) < 40) return;                         // pavé tactile : déjà fluide nativement
      if (canScrollInside(e.target, dy)) return;

      e.preventDefault();
      if (!raf) syncToReal();
      anchor = null;
      target = clamp(target + dy, 0, maxScroll());
      run();
    }, { passive: false });

    // Défilement déclenché par autre chose que nous : on resynchronise
    window.addEventListener('scroll', () => { if (!raf) syncToReal(); }, { passive: true });
    window.addEventListener('resize', () => { if (!raf) syncToReal(); else target = clamp(target, 0, maxScroll()); }, { passive: true });

    return {
      to(destination) {            // destination : élément ou position en px
        if (!raf) syncToReal();
        anchor = typeof destination === 'number' ? null : destination;
        target = clamp(anchor ? anchorY(anchor) : destination, 0, maxScroll());
        run();
      },
    };
  }

  // Liens internes (#tarifs, #contact…) : défilement fluide + focus pour l'accessibilité
  function initAnchors(smooth) {
    document.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = e.target.closest('a[href^="#"]');
      if (!link) return;

      const hash = link.getAttribute('href');
      let id = '';
      try { id = decodeURIComponent(hash.slice(1)); } catch (_) { return; }

      const toTop = id === '' || id === 'top';
      const el = toTop ? null : document.getElementById(id);
      if (!toTop && !el) return;

      e.preventDefault();
      if (smooth) {
        smooth.to(toTop ? 0 : el);
      } else if (toTop) {
        window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
      } else {
        el.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
      }

      if (history.pushState) history.pushState(null, '', toTop ? location.pathname + location.search : hash);
      if (el) { el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); }
    });
  }


  /* ======================================================================
     5. MENU MOBILE (plein écran, descend du haut)
     ====================================================================== */
  function initMenu() {
    const button = $('.burger');
    const nav = $('#menu');
    if (!button || !nav) return;

    const behind = $$('main, footer'); // rendu inerte quand le menu est ouvert (clavier + lecteurs d'écran)
    const desktop = window.matchMedia('(min-width: 900px)');

    const setOpen = (open) => {
      root.classList.toggle('menu-open', open);
      button.setAttribute('aria-expanded', String(open));
      button.setAttribute('aria-label', open ? 'Fermer le menu' : 'Ouvrir le menu');
      behind.forEach((el) => { el.inert = open; });
    };

    button.addEventListener('click', () => setOpen(!root.classList.contains('menu-open')));
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) setOpen(false); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root.classList.contains('menu-open')) { setOpen(false); button.focus(); }
    });
    desktop.addEventListener('change', (e) => { if (e.matches) setOpen(false); });
  }


  /* ======================================================================
     6. HALO QUI SUIT LA SOURIS (hero, bureau uniquement)
     ====================================================================== */
  function initGlow() {
    const hero = $('.hero');
    const glow = $('.glow');
    if (!hero || !glow || !finePointer.matches || reduceMotion.matches) return;

    let x = 0, y = 0, tx = 0, ty = 0, raf = 0;
    const loop = () => {
      x += (tx - x) * 0.12;
      y += (ty - y) * 0.12;
      glow.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
      raf = Math.abs(tx - x) + Math.abs(ty - y) > 0.5 ? requestAnimationFrame(loop) : 0;
    };

    hero.addEventListener('pointermove', (e) => {
      const rect = hero.getBoundingClientRect();
      tx = e.clientX - rect.left;
      ty = e.clientY - rect.top;
      glow.classList.add('is-on');
      if (!raf) raf = requestAnimationFrame(loop);
    }, { passive: true });
    hero.addEventListener('pointerleave', () => glow.classList.remove('is-on'));
  }


  /* ======================================================================
     7. FORMULAIRE DE CONTACT
     Couches anti-bot côté navigateur :
       • champ piège « website » (honeypot) : un robot le remplit, pas un humain
       • délai minimum de remplissage
       • jeton signé fourni par formulaire.php (mode 'php')
     La vraie sécurité est côté serveur (formulaire.php) : tout est revérifié là-bas.
     ====================================================================== */
  function initForm() {
    const form = $('#contact-form');
    if (!form) return;

    const fields = {
      name: form.elements.namedItem('name'),
      email: form.elements.namedItem('email'),
      plan: form.elements.namedItem('plan'),
      message: form.elements.namedItem('message'),
    };
    const hosting = form.elements.namedItem('hosting');
    const honeypot = form.elements.namedItem('website');
    const status = $('#form-status');
    const success = $('#form-success');
    const resetButton = $('#form-reset');
    const estimate = $('#estimate');
    const estimateValue = $('#estimate-value');

    let touchedAt = 0;  // premier contact de l'utilisateur avec le formulaire
    form.addEventListener('focusin', () => { if (!touchedAt) touchedAt = Date.now(); });
    form.addEventListener('input', () => { if (!touchedAt) touchedAt = Date.now(); });

    /* ---------- Estimation indicative ---------- */
    const formatEuro = (n) => n.toLocaleString('fr-FR') + '\u00a0€';
    const updateEstimate = () => {
      const base = CONFIG.prices[fields.plan.value];
      if (!base) { estimate.hidden = true; return; }
      estimateValue.textContent = formatEuro(base + (hosting.checked ? CONFIG.prices.hosting : 0));
      estimate.hidden = false;
    };
    fields.plan.addEventListener('change', updateEstimate);
    hosting.addEventListener('change', updateEstimate);

    /* ---------- Validation (mêmes règles que formulaire.php) ---------- */
    const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\p{Nd} .,'’&-]{1,79}$/u;
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
    const clean = (value) => value.replace(/\s+/g, ' ').trim();
    const countLinks = (text) => (text.match(/https?:\/\/|www\./gi) || []).length;

    const validators = {
      name() {
        const v = clean(fields.name.value);
        if (!v) return 'Indiquez votre nom.';
        if (v.length < 2) return 'Votre nom est un peu court.';
        if (!NAME_RE.test(v)) return 'Ce nom contient des caractères non autorisés.';
        return '';
      },
      email() {
        const v = fields.email.value.trim();
        if (!v) return 'Indiquez votre adresse e-mail.';
        if (v.length > 254 || !EMAIL_RE.test(v)) return 'Cette adresse e-mail semble incorrecte.';
        return '';
      },
      plan() {
        return fields.plan.value ? '' : 'Choisissez une formule dans la liste.';
      },
      message() {
        const v = fields.message.value.trim();
        if (v.length < 10) return 'Votre message est un peu court (10 caractères minimum).';
        if (v.length > 2000) return 'Votre message est trop long (2 000 caractères maximum).';
        if (countLinks(v) > 2) return 'Merci de limiter le message à 2 liens maximum.';
        return '';
      },
    };

    const fieldBox = (name) => fields[name].closest('.field');
    const errorBox = (name) => $('#e-' + name);

    function setError(name, message) {
      const box = fieldBox(name);
      const error = errorBox(name);
      box.classList.toggle('is-invalid', Boolean(message));
      fields[name].setAttribute('aria-invalid', message ? 'true' : 'false');
      error.textContent = message || '';
      error.hidden = !message;
    }

    function validateAll(focusFirst) {
      let firstInvalid = null;
      Object.keys(validators).forEach((name) => {
        const message = validators[name]();
        setError(name, message);
        if (message && !firstInvalid) firstInvalid = fields[name];
      });
      if (firstInvalid && focusFirst) firstInvalid.focus();
      return !firstInvalid;
    }

    // Une erreur affichée disparaît dès que le champ est corrigé
    Object.keys(fields).forEach((name) => {
      const recheck = () => { if (fieldBox(name).classList.contains('is-invalid')) setError(name, validators[name]()); };
      fields[name].addEventListener('input', recheck);
      fields[name].addEventListener('change', recheck);
    });

    /* ---------- Messages d'état ---------- */
    const setStatus = (text, kind) => {
      status.textContent = text || '';
      status.className = 'form__status' + (kind ? ' is-' + kind : '');
    };
    const setSending = (sending) => {
      form.classList.toggle('is-sending', sending);
      form.setAttribute('aria-busy', String(sending));
    };

    /* ---------- Jeton signé (mode 'php') ---------- */
    const token = { value: '', at: 0, pending: null };

    function ensureToken(force) {
      const fresh = token.value && Date.now() - token.at < CONFIG.tokenMaxAgeMs;
      if (fresh && !force) return Promise.resolve(token.value);
      if (token.pending && !force) return token.pending;

      token.pending = fetch(CONFIG.php.endpoint + '?action=token', {
        method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store',
      })
        .then((res) => res.json())
        .then((json) => {
          if (!json || typeof json.token !== 'string') throw new Error('token');
          token.value = json.token;
          token.at = Date.now();
          return token.value;
        })
        .finally(() => { token.pending = null; });
      return token.pending;
    }

    // Le jeton est demandé dès que le formulaire approche de l'écran
    if (CONFIG.provider === 'php' && 'IntersectionObserver' in window) {
      const watcher = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return;
        watcher.disconnect();
        ensureToken(false).catch(() => { /* réessayé à l'envoi */ });
      }, { rootMargin: '900px 0px' });
      watcher.observe(form);
    }

    // Délai minimum de remplissage (les humains mettent plus de 3 s ; pas les robots)
    async function waitMinimumFillTime() {
      const readyAt = Math.max(touchedAt, token.at) + CONFIG.minFillMs + 250;
      const remaining = readyAt - Date.now();
      if (remaining > 0) await sleep(remaining);
    }

    /* ---------- Envoi ---------- */
    async function postJSON(url, body) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CONFIG.timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
          credentials: 'omit',
          cache: 'no-store',
          signal: controller.signal,
        });
        let json = null;
        try { json = await res.json(); } catch (_) { /* réponse non JSON */ }
        return { ok: res.ok, status: res.status, json };
      } finally {
        clearTimeout(timer);
      }
    }

    const PLAN_LABELS = { 'type-a': 'Site Type A — 700 €', 'type-b': 'Site Type B — 1 000 €', autre: 'Autre / Question' };

    const senders = {
      // Notre serveur : formulaire.php (jeton signé + toutes les protections)
      async php(data) {
        let result;
        for (let attempt = 0; attempt < 2; attempt++) {
          await ensureToken(attempt > 0);
          await waitMinimumFillTime();
          result = await postJSON(CONFIG.php.endpoint, {
            name: data.name, email: data.email, plan: data.plan, hosting: data.hosting,
            message: data.message, website: data.website, token: token.value,
          });
          const code = result.json && result.json.code;
          if (code === 'token') { token.value = ''; continue; }  // jeton expiré / déjà utilisé : on en redemande un
          break;
        }
        return { ok: Boolean(result.json && result.json.ok === true), status: result.status, json: result.json };
      },

      // Web3Forms : envoi direct depuis le navigateur (clé d'accès publique par conception)
      async web3forms(data) {
        if (/^VOTRE_/.test(CONFIG.web3forms.accessKey)) throw new Error('config');
        await waitMinimumFillTime();
        const result = await postJSON(CONFIG.web3forms.endpoint, {
          access_key: CONFIG.web3forms.accessKey,
          subject: 'Nouveau message — ' + PLAN_LABELS[data.plan],
          from_name: 'Mon Site (formulaire)',
          name: data.name,
          email: data.email,
          formule: PLAN_LABELS[data.plan],
          option_hebergement: data.hosting ? 'Oui (+30 €)' : 'Non',
          message: data.message,
          botcheck: false,
        });
        return { ok: Boolean(result.ok && result.json && result.json.success === true), status: result.status, json: result.json };
      },

      // Formspree : envoi direct depuis le navigateur
      async formspree(data) {
        if (/VOTRE_/.test(CONFIG.formspree.endpoint)) throw new Error('config');
        await waitMinimumFillTime();
        const result = await postJSON(CONFIG.formspree.endpoint, {
          name: data.name,
          email: data.email,
          formule: PLAN_LABELS[data.plan],
          option_hebergement: data.hosting ? 'Oui (+30 €)' : 'Non',
          message: data.message,
          _subject: 'Nouveau message — ' + PLAN_LABELS[data.plan],
        });
        return { ok: result.ok, status: result.status, json: result.json };
      },
    };

    function describeFailure(result) {
      const json = result.json || {};
      if (result.status === 422 && json.errors) {
        Object.keys(json.errors).forEach((name) => { if (fields[name]) setError(name, String(json.errors[name])); });
        const first = Object.keys(json.errors).find((name) => fields[name]);
        if (first) fields[first].focus();
        return 'Merci de vérifier les champs indiqués.';
      }
      if (result.status === 429) return 'Trop de tentatives pour le moment. Merci de réessayer dans quelques minutes.';
      if (typeof json.message === 'string' && json.message) return json.message;
      return 'L\u2019envoi a échoué. Merci de réessayer dans un instant.';
    }

    function showSuccess() {
      form.reset();
      updateEstimate();
      touchedAt = 0;
      token.value = '';                          // un jeton ne sert qu'une fois
      form.hidden = true;
      success.hidden = false;
      success.focus();
      if (CONFIG.provider === 'php') ensureToken(true).catch(() => {});
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (form.classList.contains('is-sending')) return;
      setStatus('');
      if (!validateAll(true)) return;

      const data = {
        name: clean(fields.name.value),
        email: fields.email.value.trim(),
        plan: fields.plan.value,
        hosting: hosting.checked,
        message: fields.message.value.trim(),
        website: honeypot ? honeypot.value : '',
      };

      // Champ piège rempli = robot : on simule un succès, rien n'est envoyé
      if (data.website) { setSending(true); await sleep(1200); setSending(false); showSuccess(); return; }

      setSending(true);
      try {
        const result = await senders[CONFIG.provider](data);
        if (result.ok) showSuccess();
        else setStatus(describeFailure(result), 'error');
      } catch (error) {
        const notConfigured = error && error.message === 'config';
        setStatus(notConfigured
          ? 'Le formulaire n\u2019est pas encore configuré (voir CONFIG en haut de script.js).'
          : 'Connexion impossible pour le moment. Vérifiez votre réseau puis réessayez.', 'error');
      } finally {
        setSending(false);
      }
    });

    resetButton.addEventListener('click', () => {
      success.hidden = true;
      form.hidden = false;
      setStatus('');
      fields.name.focus();
    });
  }


  /* ======================================================================
     8. PETITS PLUS
     ====================================================================== */
  // Boutons « Choisir le Type A/B » : présélectionnent la formule dans le formulaire
  function initPlanButtons() {
    const select = $('#f-plan');
    if (!select) return;
    $$('[data-choose]').forEach((el) => {
      el.addEventListener('click', () => {
        select.value = el.getAttribute('data-choose');
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }

  // E-mails protégés des collecteurs de spam : l'adresse n'existe pas dans le HTML brut
  function initMailLinks() {
    $$('[data-mail-user][data-mail-domain]').forEach((el) => {
      const address = el.getAttribute('data-mail-user') + '@' + el.getAttribute('data-mail-domain');
      const link = document.createElement('a');
      link.href = 'mailto:' + address;
      link.textContent = address;
      el.textContent = '';
      el.append(link);
    });
  }

  function initYear() {
    $$('[data-year]').forEach((el) => { el.textContent = String(new Date().getFullYear()); });
  }


  /* ======================================================================
     DÉMARRAGE
     ====================================================================== */
  const run = (fn) => { try { return fn(); } catch (error) { console.error('[Mon Site]', error); return null; } };

  run(initReveal);
  run(initScrollEffects);
  run(initActiveNav);
  const smooth = run(initSmoothScroll);
  run(() => initAnchors(smooth));
  run(initMenu);
  run(initGlow);
  run(initPlanButtons);
  run(initForm);
  run(initMailLinks);
  run(initYear);
})();
