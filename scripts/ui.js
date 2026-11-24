// Probe helper, evaluated in the sandbox page: a compact description of what is on screen.
(() => {
  const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const btns = [...document.querySelectorAll('button, [role=button], a.btn, .btn, .card, .tab, [tabindex]')].filter(vis).slice(0, 70).map((e) => {
    const r = e.getBoundingClientRect();
    return `${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)} <${e.tagName.toLowerCase()}.${String(e.className).slice(0, 40)}>${e.disabled ? ' [disabled]' : ''} ${(e.innerText || e.getAttribute('aria-label') || e.title || '').trim().replace(/\s+/g, ' ').slice(0, 60)}`;
  });
  return [
    'top: ' + [...document.querySelectorAll('#ui > *, body > div')].filter(vis).map((e) => (e.id ? '#' + e.id + ' ' : '') + String(e.className).slice(0, 60)).join(' | '),
    'lock: ' + !!document.pointerLockElement + '  size: ' + innerWidth + 'x' + innerHeight,
    'text: ' + (document.getElementById('ui')?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
    ...btns,
  ].join('\n');
})()
