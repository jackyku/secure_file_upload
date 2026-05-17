(function () {
    async function applyBranding() {
        try {
            const resp = await fetch('/api/branding');
            if (!resp.ok) return;
            const b = await resp.json();
            if (!b.name && !b.logo) return;

            if (b.name) document.title = b.name + ' — ' + document.title;

            const bar = document.createElement('div');
            bar.style.cssText = 'display:flex;align-items:center;gap:10px;padding-bottom:12px;margin-bottom:14px;border-bottom:1px solid rgba(15,23,36,0.08);';

            if (b.logo) {
                const img = document.createElement('img');
                img.src = b.logo;
                img.alt = b.name || 'Logo';
                img.style.cssText = 'height:42px;object-fit:contain;flex-shrink:0;';
                bar.appendChild(img);
            }
            if (b.name) {
                const span = document.createElement('span');
                span.textContent = b.name;
                span.style.cssText = 'font-weight:700;font-size:18px;color:var(--text,#0f1724);letter-spacing:-.01em;';
                bar.appendChild(span);
            }

            const container = document.querySelector('.container, .share-card');
            if (container) container.prepend(bar);
        } catch (e) { /* branding is non-critical */ }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyBranding);
    } else {
        applyBranding();
    }
})();
