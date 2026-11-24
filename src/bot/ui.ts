/**
 * `readUi` runs INSIDE the sandbox page (sent as source text). It describes the DOM side of the game: which screen is
 * up, which dialog is open and what can be clicked. It only reads. Result: `UiState` (src/bot/snapshot.ts).
 */
export function readUi(): unknown {
  const W = innerWidth, H = innerHeight;
  const vis = (e: Element) => {
    const r = e.getBoundingClientRect();
    if (r.width < 3 || r.height < 3 || r.bottom <= 0 || r.right <= 0 || r.top >= H || r.left >= W) return false;
    const s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const txt = (e: Element) => ((e as HTMLElement).innerText || e.getAttribute('aria-label') || (e as HTMLElement).title || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  const opt = (e: Element) => {
    const r = e.getBoundingClientRect();
    // Click point: the centre of the part of the element that is inside the viewport.
    const x0 = Math.max(r.left, 2), x1 = Math.min(r.right, W - 2), y0 = Math.max(r.top, 2), y1 = Math.min(r.bottom, H - 2);
    const d = (e as HTMLElement).dataset || {};
    return {
      text: txt(e), cls: String((e as HTMLElement).className || '').slice(0, 80), x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2),
      w: Math.round(r.width), h: Math.round(r.height),
      disabled: !!(e as HTMLButtonElement).disabled || /\b(locked|off|disabled)\b/.test(String((e as HTMLElement).className)),
      key: d.key || d.id || d.k || undefined,
    };
  };
  // An offer card: its parts are separate elements, so read them apart instead of guessing from the joined text.
  const card = (e: Element) => {
    const part = (sel: string) => { const n = e.querySelector(sel); return n ? txt(n) : ''; };
    return { ...opt(e), name: part('h3, h4'), rarity: part('.rar'), tag: part('.kind'), sub: part('.sub'), effects: [...e.querySelectorAll('ul li')].map(txt).slice(0, 8) };
  };
  const all = (root: ParentNode, sel: string) => [...root.querySelectorAll(sel)].filter(vis);
  const q = (sel: string) => { const e = document.querySelector(sel); return e && vis(e) ? e : null; };

  const ui = document.getElementById('ui');
  let screen = 'unknown';
  if (document.getElementById('boot-retry')) screen = 'blocked';
  else if (q('#ui > .loading')) screen = q('#ui > .loading button') ? 'offline' : 'loading';
  else if (q('#ui > .screen.auth, #ui > .auth-page')) screen = 'auth';
  else if (q('#ui > .screen.sp')) screen = 'starter';
  else if (q('#ui > .screen.ls')) screen = 'select';
  else if (q('#ui > .screen.rg')) screen = 'map';
  else if (q('#ui > .screen.mm')) screen = q('.mh.in, .mh-pill') ? 'playmenu' : 'menu';
  else if (q('#ui > .passthru')) screen = 'run';
  else if (q('#ui > .screen')) screen = 'screen:' + String(document.querySelector('#ui > .screen')!.className).replace(/^screen\s*/, '').split(' ')[0];

  // ---- the dialog on top, if any ----
  const BTN = 'button, .btn, [role=button]';
  const CARD = '.card, .offer, .sp-card, .choice';
  let modal: any = null;
  const describe = (root: Element, kindHint: string) => {
    const panel = root.querySelector('.panel') || root;
    const cls = (String((root as HTMLElement).className) + ' | ' + String((panel as HTMLElement).className)).slice(0, 120);
    const pc = ' ' + String((panel as HTMLElement).className) + ' ';
    let kind = kindHint;
    if (/ pz /.test(pc)) kind = 'pause';
    else if (root.querySelector('.sm-hero')) kind = 'end';
    else if (root.querySelector('.card.offer')) kind = 'levelup';
    else if (/shop/.test(pc)) kind = 'shop';
    const cards = all(root, CARD).filter((c) => !c.querySelector(CARD) || c.matches('.sp-card'));
    const cardSet = new Set(cards);
    const actions = all(root, BTN).filter((b) => !cardSet.has(b) && ![...cardSet].some((c) => c.contains(b) && c !== b));
    const h = root.querySelector('h1, h2, h3, .ribbon, .title, header b');
    return { kind, title: h ? txt(h).slice(0, 80) : '', options: cards.slice(0, 12).map(card), actions: actions.slice(0, 24).map(opt), cls };
  };
  // Dialogs appended to <body> sit above everything; then the run's own dialog; then tours and guides.
  const bodyModals = all(document, 'body > .season-modal, body > .gl-lost, body > .mp-ov, body > .modal, #ui > .season-modal');
  const runModal = q('#ui > .passthru > .modal');
  const guide = q('.pb-guide');
  if (bodyModals.length) modal = describe(bodyModals[bodyModals.length - 1], /si-modal/.test(String((bodyModals[bodyModals.length - 1] as HTMLElement).className)) ? 'intro' : 'confirm');
  else if (guide) modal = describe(guide, 'guide');
  else if (runModal) modal = describe(runModal, 'unknown');

  const loadCard = q('#ui > .passthru .campo-loading, #ui > .passthru .zone-loading');
  const buttons = all(document, BTN).slice(0, 60).map(opt).filter((b) => !b.disabled);
  const notices = all(document, '.app-notice, .toast').map(txt).filter(Boolean).slice(0, 6);
  return {
    screen, modal, buttons, notices,
    text: ((ui as HTMLElement | null)?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
    href: location.href,
    loading: !!loadCard,
  };
}
