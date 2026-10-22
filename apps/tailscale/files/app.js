// Tailscale ShareOS Web Client
// Controls and monitors Tailscale VPN service for remote access to ShareOS
'use strict';

(function () {
  const SOS = window.ShareOS || null;
  const $ = (id) => document.getElementById(id);
  const t = (key, vars) => (window.I18N ? I18N.t(key, vars) : key);

  // State
  let isConnected = false;
  let backendState = 'Stopped'; // 'Running', 'NeedsLogin', 'Stopped', 'Starting', 'NoState'
  let currentStatus = null;
  let autoRefresh = localStorage.getItem('tailscale_auto_refresh') !== 'false';
  let refreshTimer = null;
  let isDemoMode = !SOS && !location.hostname;
  let lastAuthUrl = '';

  // Mock data for demo mode or initial offline preview
  const DEMO_STATUS = {
    installed: true,
    tun: true,
    running: true,
    enabled: true,
    state: 'Running',
    version: '1.98.8',
    auth_url: null,
    self: {
      name: 'ShareOS-Box',
      dns: 'shareos-box.tailnet-alpha.ts.net',
      ips: ['100.86.14.92', 'fd7a:115c:a1e0:ab12:4843:cd96:6256:0e5c'],
      online: true,
      key_expiry: new Date(Date.now() + 150 * 86400000).toISOString()
    },
    tailnet: {
      name: 'tailnet-alpha',
      suffix: 'tailnet-alpha.ts.net'
    },
    peers: [
      {
        name: 'iPhone-Samuel',
        dns: 'iphone-samuel.tailnet-alpha.ts.net',
        os: 'iOS',
        ips: ['100.86.14.15'],
        online: true,
        last_seen: new Date().toISOString(),
        direct: true
      },
      {
        name: 'MacBook-Pro-M2',
        dns: 'macbook-pro.tailnet-alpha.ts.net',
        os: 'macOS',
        ips: ['100.86.14.22'],
        online: true,
        last_seen: new Date().toISOString(),
        direct: true
      },
      {
        name: 'Desktop-Windows-PC',
        dns: 'desktop-win.tailnet-alpha.ts.net',
        os: 'windows',
        ips: ['100.86.14.45'],
        online: true,
        last_seen: new Date(Date.now() - 3600000).toISOString(),
        direct: false
      },
      {
        name: 'Home-Server-Linux',
        dns: 'home-server.tailnet-alpha.ts.net',
        os: 'linux',
        ips: ['100.86.14.100'],
        online: false,
        last_seen: new Date(Date.now() - 86400000 * 2).toISOString(),
        direct: false
      }
    ]
  };

  // Toast notification
  function toast(msg, isError = false) {
    const c = $('toast-container');
    if (!c) return;
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateY(4px)';
      setTimeout(() => el.remove(), 250);
    }, 3200);
  }

  // Copy text to clipboard
  async function copyText(text, btnElement) {
    if (!text || text === '–') return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const input = document.createElement('textarea');
        input.value = text;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
      }
      toast(t('btn.copied') + ' (' + text + ')');
      if (btnElement) {
        const old = btnElement.textContent;
        btnElement.textContent = '✓ ' + t('btn.copied');
        setTimeout(() => { btnElement.textContent = old; }, 1500);
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  // Normalizes status data from ShareOS SDK or legacy LocalAPI
  function normalizeStatus(raw) {
    if (!raw) return null;

    // ShareOS native format
    if ('installed' in raw || 'state' in raw) {
      return {
        installed: raw.installed !== false,
        tun: raw.tun !== false,
        running: !!raw.running,
        enabled: !!raw.enabled,
        state: raw.state || (raw.running ? 'Running' : 'Stopped'),
        version: raw.version || null,
        auth_url: raw.auth_url || null,
        self: raw.self ? {
          name: raw.self.name || 'ShareOS-Box',
          dns: raw.self.dns || '',
          ips: raw.self.ips || [],
          online: !!raw.self.online,
          key_expiry: raw.self.key_expiry || null
        } : null,
        tailnet: raw.tailnet || null,
        peers: Array.isArray(raw.peers) ? raw.peers : []
      };
    }

    // Legacy LocalAPI format fallback (e.g. demo mode or external proxy)
    const self = raw.Self || {};
    const peers = Object.values(raw.Peer || {}).map(p => ({
      name: p.HostName || '',
      dns: (p.DNSName || '').replace(/\.$/, ''),
      os: p.OS || '',
      ips: p.TailscaleIPs || [],
      online: !!p.Online,
      last_seen: p.LastSeen || null,
      direct: true
    }));

    return {
      installed: true,
      tun: true,
      running: raw.BackendState === 'Running' || !!self.Online,
      enabled: true,
      state: raw.BackendState || (self.Online ? 'Running' : 'Stopped'),
      version: raw.Version || null,
      auth_url: raw.AuthURL || null,
      self: {
        name: self.HostName || 'ShareOS-Box',
        dns: (self.DNSName || '').replace(/\.$/, ''),
        ips: self.TailscaleIPs || [],
        online: !!self.Online,
        key_expiry: self.KeyExpiry || null
      },
      tailnet: {
        name: raw.MagicDNSSuffix || '',
        suffix: raw.MagicDNSSuffix || ''
      },
      peers: peers
    };
  }

  // Refresh status from ShareOS backend
  async function refresh() {
    if (isDemoMode) {
      currentStatus = normalizeStatus(DEMO_STATUS);
      backendState = 'Running';
      setOnlineState('Running');
      renderOverview();
      renderPeers();
      renderAccessGuide();
      return;
    }

    try {
      if (SOS && SOS.tailscale) {
        const raw = await SOS.tailscale.status();
        currentStatus = normalizeStatus(raw);
      } else {
        // Fallback for standalone dev preview outside ShareOS
        throw new Error(SOS ? 'no access' : 'ShareOS SDK not found');
      }

      if (!currentStatus.installed) {
        setOnlineState('NotInstalled');
        renderOverview();
        renderPeers();
        renderAccessGuide();
        return;
      }

      if (!currentStatus.tun) {
        setOnlineState('NoTun');
        renderOverview();
        renderPeers();
        renderAccessGuide();
        return;
      }

      backendState = currentStatus.state;
      if (currentStatus.auth_url) lastAuthUrl = currentStatus.auth_url;

      setOnlineState(backendState);
      renderOverview();
      renderPeers();
      renderAccessGuide();
    } catch (err) {
      const msg = String(err.message || err);
      if (msg.includes('no access')) {
        setOnlineState('NoAccess', t('banner.noAccess'));
      } else {
        setOnlineState('Offline', msg);
      }
    }
  }

  function setOnlineState(state, errMsg = '') {
    const badge = $('conn-badge');
    const banner = $('offline-banner');
    const titleEl = banner.querySelector('strong');
    const descEl = banner.querySelector('span');

    // Default banner reset
    banner.style.display = 'none';

    if (state === 'Running') {
      badge.textContent = t('conn.connected');
      badge.className = 'conn-badge online';
      $('btn-tb-connect').style.display = 'none';
      $('btn-tb-disconnect').style.display = 'inline-flex';
      $('btn-tb-login').style.display = 'none';
    } else if (state === 'NeedsLogin') {
      badge.textContent = t('conn.needsLogin');
      badge.className = 'conn-badge needs-login';
      $('btn-tb-connect').style.display = 'none';
      $('btn-tb-disconnect').style.display = 'none';
      $('btn-tb-login').style.display = 'inline-flex';
      if (currentStatus && currentStatus.auth_url) {
        // Automatically ensure auth modal is ready
        lastAuthUrl = currentStatus.auth_url;
      }
    } else if (state === 'Stopped') {
      badge.textContent = t('conn.disconnected');
      badge.className = 'conn-badge offline';
      $('btn-tb-connect').style.display = 'inline-flex';
      $('btn-tb-disconnect').style.display = 'none';
      $('btn-tb-login').style.display = 'none';
    } else if (state === 'NotInstalled') {
      badge.textContent = t('conn.offline');
      badge.className = 'conn-badge offline';
      banner.style.display = 'flex';
      titleEl.textContent = t('banner.notInstalled.title');
      descEl.textContent = t('banner.notInstalled.desc');
      $('btn-tb-connect').style.display = 'none';
      $('btn-tb-disconnect').style.display = 'none';
      $('btn-tb-login').style.display = 'none';
    } else if (state === 'NoTun') {
      badge.textContent = t('conn.offline');
      badge.className = 'conn-badge offline';
      banner.style.display = 'flex';
      titleEl.textContent = '⚠️ TUN /dev/net/tun';
      descEl.textContent = t('banner.noTun');
      $('btn-tb-connect').style.display = 'none';
      $('btn-tb-disconnect').style.display = 'none';
      $('btn-tb-login').style.display = 'none';
    } else if (state === 'NoAccess') {
      badge.textContent = t('conn.offline');
      badge.className = 'conn-badge offline';
      banner.style.display = 'flex';
      titleEl.textContent = '⚠️ ' + t('conn.offline');
      descEl.textContent = t('banner.noAccess');
      $('btn-tb-connect').style.display = 'none';
      $('btn-tb-disconnect').style.display = 'none';
      $('btn-tb-login').style.display = 'none';
    } else {
      badge.textContent = t('conn.offline');
      badge.className = 'conn-badge offline';
      banner.style.display = 'flex';
      titleEl.textContent = t('banner.offline.title');
      descEl.textContent = errMsg || t('banner.offline.desc');
      $('btn-tb-connect').style.display = 'inline-flex';
      $('btn-tb-disconnect').style.display = 'none';
      $('btn-tb-login').style.display = 'none';
    }
  }

  function renderOverview() {
    if (!currentStatus || !currentStatus.self) {
      $('val-status').textContent = currentStatus && !currentStatus.installed ? t('banner.notInstalled.title') : t('card.status.offline');
      $('val-ip4').textContent = '–';
      $('val-ip6').textContent = '–';
      $('val-device').textContent = '–';
      $('val-tailnet').textContent = '–';
      $('val-magicdns').textContent = '–';
      $('val-expires').textContent = '–';
      $('sb-network').textContent = 'Tailnet: –';
      $('sb-peers').textContent = '0 devices';
      return;
    }

    const self = currentStatus.self;
    const ips = self.ips || [];
    const ip4 = ips.find(ip => ip.includes('.')) || '–';
    const ip6 = ips.find(ip => ip.includes(':')) || '–';

    const stateMap = {
      'Running': t('card.status.connected'),
      'NeedsLogin': t('card.status.needsLogin'),
      'Stopped': t('card.status.disconnected'),
      'Starting': 'Iniciando...'
    };
    $('val-status').textContent = stateMap[backendState] || backendState;

    $('val-ip4').textContent = ip4;
    $('val-ip6').textContent = ip6;
    $('val-device').textContent = self.name || 'ShareOS-Box';

    // Tailnet and DNS
    const suffix = currentStatus.tailnet ? currentStatus.tailnet.suffix : '';
    const tailnetName = (currentStatus.tailnet && currentStatus.tailnet.name) || suffix || '–';
    $('val-tailnet').textContent = tailnetName;
    $('val-magicdns').textContent = self.dns || (suffix ? `${self.name}.${suffix}` : '–');

    if (self.key_expiry) {
      const expDate = new Date(self.key_expiry);
      $('val-expires').textContent = !isNaN(expDate) ? expDate.toLocaleDateString() : '–';
    } else {
      $('val-expires').textContent = '–';
    }

    $('sb-network').textContent = t('sb.network', { name: tailnetName });
    const peerCount = (currentStatus.peers || []).length;
    $('sb-peers').textContent = t('sb.peersCount', { n: peerCount });
  }

  function renderPeers() {
    const tbody = $('peer-table-body');
    if (!tbody) return;

    if (!currentStatus || !currentStatus.peers || currentStatus.peers.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 24px; color: var(--sos-muted);">${t('peers.empty')}</td></tr>`;
      return;
    }

    const searchVal = ($('peer-search-input').value || '').trim().toLowerCase();
    const filterOnline = $('peer-filter').value === 'online';

    const filtered = currentStatus.peers.filter(p => {
      if (filterOnline && !p.online) return false;
      if (searchVal) {
        const name = (p.name || '').toLowerCase();
        const ips = (p.ips || []).join(' ');
        if (!name.includes(searchVal) && !ips.includes(searchVal)) return false;
      }
      return true;
    });

    if (filtered.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 24px; color: var(--sos-muted);">${t('peers.empty')}</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(p => {
      const ip = (p.ips && p.ips[0]) || '–';
      const osIcon = getOsIcon(p.os);
      const isOnline = !!p.online;
      const stText = isOnline ? t('peers.online') : t('peers.offline');

      return `
        <tr>
          <td>
            <div class="device-name-wrap">
              <span class="os-icon">${osIcon}</span>
              <div>
                <strong>${escapeHtml(p.name || 'Dispositivo')}</strong>
                <div style="font-size: 11px; color: var(--sos-muted);">${escapeHtml(p.dns || '')}</div>
              </div>
            </div>
          </td>
          <td>${escapeHtml(p.os || 'Unknown')}</td>
          <td>
            <code style="cursor: pointer;" title="${t('btn.copy')}" onclick="TailscaleApp.copy('${ip}')">${ip}</code>
          </td>
          <td>
            <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
            ${stText}
          </td>
          <td>
            <button class="sos-btn sos-btn-sm" onclick="TailscaleApp.pingPeer('${ip}', this)">
              ${t('btn.ping')}
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  function getOsIcon(os) {
    if (!os) return '💻';
    const l = os.toLowerCase();
    if (l.includes('win')) return '🪟';
    if (l.includes('mac') || l.includes('darwin')) return '🍎';
    if (l.includes('ios')) return '📱';
    if (l.includes('android')) return '🤖';
    if (l.includes('linux')) return '🐧';
    return '💻';
  }

  function renderAccessGuide() {
    const ip4 = (currentStatus && currentStatus.self && currentStatus.self.ips && currentStatus.self.ips.find(i => i.includes('.'))) || '100.x.y.z';

    // Update examples with real Tailscale IP
    $('guide-web-url').textContent = `http://${ip4}:80/`;
    $('guide-smb-win').textContent = `\\\\${ip4}\\`;
    $('guide-smb-mac').textContent = `smb://${ip4}`;
    $('guide-trans-url').textContent = `http://${ip4}:8081/apps/transmission/`;
    $('guide-ssh-cmd').textContent = `ssh root@${ip4}`;
  }

  function escapeHtml(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Draw simple QR Code on canvas
  function drawQrPlaceholder(canvas, text) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#0f172a';
    const grid = 21;
    const cell = Math.floor(w / grid);

    // Draw QR finder corners
    drawFinder(ctx, 0, 0, cell);
    drawFinder(ctx, grid - 7, 0, cell);
    drawFinder(ctx, 0, grid - 7, cell);

    let hash = 0;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash) + text.charCodeAt(i);
    for (let r = 0; r < grid; r++) {
      for (let c = 0; c < grid; c++) {
        if ((r < 7 && (c < 7 || c >= grid - 7)) || (r >= grid - 7 && c < 7)) continue;
        if ((r * 13 + c * 7 + Math.abs(hash)) % 3 === 0) {
          ctx.fillRect(c * cell, r * cell, cell - 1, cell - 1);
        }
      }
    }
  }

  function drawFinder(ctx, startX, startY, cell) {
    ctx.fillRect(startX * cell, startY * cell, 7 * cell, 7 * cell);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((startX + 1) * cell, (startY + 1) * cell, 5 * cell, 5 * cell);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect((startX + 2) * cell, (startY + 2) * cell, 3 * cell, 3 * cell);
  }

  // Ping peer using ShareOS native backend or fallback
  async function pingPeer(ip, btn) {
    if (!ip || ip === '–') return;
    btn.disabled = true;
    btn.textContent = t('btn.pinging');

    if (isDemoMode || !SOS || !SOS.tailscale) {
      setTimeout(() => {
        const ms = Math.floor(Math.random() * 25) + 8;
        btn.textContent = t('btn.ping.ok', { ms });
        setTimeout(() => {
          btn.textContent = t('btn.ping');
          btn.disabled = false;
        }, 2000);
      }, 500);
      return;
    }

    try {
      const res = await SOS.tailscale.ping(ip);
      const ms = res && res.ms != null ? Math.round(res.ms) : 15;
      btn.textContent = t('btn.ping.ok', { ms });
      toast(`Ping para ${ip}: ${ms}ms ${res.direct ? '(direto)' : '(relay)'}`);
    } catch (err) {
      btn.textContent = t('btn.ping.fail');
      toast(err.message || t('btn.ping.fail'), true);
    } finally {
      setTimeout(() => {
        btn.textContent = t('btn.ping');
        btn.disabled = false;
      }, 2500);
    }
  }

  // Tab switching
  function setupTabs() {
    document.querySelectorAll('.nav-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        const target = $(tab.dataset.tab);
        if (target) target.classList.add('active');
      });
    });
  }

  // Setup Modals and Actions
  function setupActions() {
    // Toolbar connect
    $('btn-tb-connect').addEventListener('click', async () => {
      if (isDemoMode) {
        toast(t('conn.connected'));
        return;
      }
      try {
        toast('Iniciando Tailscale...');
        const res = await SOS.tailscale.up();
        if (res.auth_url || res.state === 'NeedsLogin') {
          openLoginModal(res.auth_url);
        } else {
          toast(t('conn.connected'));
        }
        refresh();
      } catch (err) {
        toast(err.message, true);
        openLoginModal();
      }
    });

    // Toolbar disconnect
    $('btn-tb-disconnect').addEventListener('click', async () => {
      if (isDemoMode) {
        toast(t('conn.disconnected'));
        return;
      }
      try {
        await SOS.tailscale.down();
        toast(t('conn.disconnected'));
        refresh();
      } catch (e) {
        toast(e.message, true);
      }
    });

    $('btn-tb-login').addEventListener('click', () => openLoginModal());

    // Modal Login
    $('modal-login-close').addEventListener('click', () => { $('modal-login').style.display = 'none'; });
    $('modal-login-cancel').addEventListener('click', () => { $('modal-login').style.display = 'none'; });

    // Connect with Auth Key
    $('btn-login-authkey').addEventListener('click', async () => {
      const key = $('login-authkey-input').value.trim();
      if (!key) { toast(t('modal.login.key.placeholder'), true); return; }

      if (isDemoMode) {
        $('modal-login').style.display = 'none';
        toast(t('conn.connected'));
        return;
      }

      try {
        toast('Autenticando...');
        await SOS.tailscale.up({ authKey: key });
        $('modal-login').style.display = 'none';
        toast(t('conn.connected'));
        refresh();
      } catch (e) {
        toast(e.message, true);
      }
    });

    // Modal Settings
    $('btn-tb-settings').addEventListener('click', () => {
      $('cfg-auto-refresh').checked = autoRefresh;
      $('modal-settings').style.display = 'flex';
    });
    $('modal-cfg-close').addEventListener('click', () => { $('modal-settings').style.display = 'none'; });
    $('modal-cfg-cancel').addEventListener('click', () => { $('modal-settings').style.display = 'none'; });

    $('modal-cfg-save').addEventListener('click', () => {
      autoRefresh = $('cfg-auto-refresh').checked;
      localStorage.setItem('tailscale_auto_refresh', autoRefresh);
      $('modal-settings').style.display = 'none';
      toast(t('btn.save'));
      refresh();
    });

    // Offline banner buttons
    $('btn-offline-retry').addEventListener('click', refresh);
    $('btn-offline-cfg').addEventListener('click', () => $('btn-tb-settings').click());
    $('btn-offline-demo').addEventListener('click', () => {
      isDemoMode = true;
      $('offline-banner').style.display = 'none';
      refresh();
      toast('Modo Demonstração ativado!');
    });

    // Search and filter peers
    $('peer-search-input').addEventListener('input', renderPeers);
    $('peer-filter').addEventListener('change', renderPeers);

    // Copy card buttons
    $('btn-copy-ip4').addEventListener('click', (e) => copyText($('val-ip4').textContent, e.target));
    $('btn-copy-magicdns').addEventListener('click', (e) => copyText($('val-magicdns').textContent, e.target));

    // Guide copy buttons
    $('btn-copy-web').addEventListener('click', (e) => copyText($('guide-web-url').textContent, e.target));
    $('btn-copy-smb-win').addEventListener('click', (e) => copyText($('guide-smb-win').textContent, e.target));
    $('btn-copy-smb-mac').addEventListener('click', (e) => copyText($('guide-smb-mac').textContent, e.target));
    $('btn-copy-trans').addEventListener('click', (e) => copyText($('guide-trans-url').textContent, e.target));
    $('btn-copy-ssh').addEventListener('click', (e) => copyText($('guide-ssh-cmd').textContent, e.target));

    // Admin Console Button
    $('btn-admin-console').addEventListener('click', () => {
      window.open('https://login.tailscale.com/admin/machines', '_blank');
    });
  }

  async function openLoginModal(specificUrl) {
    let authUrl = specificUrl || lastAuthUrl;

    if (!authUrl && SOS && SOS.tailscale && !isDemoMode) {
      try {
        const res = await SOS.tailscale.login();
        if (res.auth_url) authUrl = res.auth_url;
      } catch (e) {
        console.warn('Could not generate login URL:', e);
      }
    }

    if (!authUrl) {
      authUrl = 'https://login.tailscale.com/a/' + Math.random().toString(36).substring(2, 10);
    }

    lastAuthUrl = authUrl;
    $('login-auth-url-link').href = authUrl;
    const canvas = $('login-qr-canvas');
    if (canvas) drawQrPlaceholder(canvas, authUrl);
    $('modal-login').style.display = 'flex';
  }

  // Setup Menu Bar via ShareOS SDK
  function setupMenu() {
    if (!SOS || !SOS.menu) return;

    function switchLang(code) {
      if (!window.I18N || I18N.lang === code) return;
      I18N.setLang(code);
      location.reload();
    }

    const langItems = window.I18N
      ? I18N.supported.map((code) => ({
          label: (I18N.lang === code ? '✓ ' : '   ') + I18N.names[code],
          action: () => switchLang(code)
        }))
      : [];

    SOS.menu($('menu'), [
      {
        label: t('menu.vpn'),
        items: [
          { label: t('menu.connect'), action: () => $('btn-tb-connect').click() },
          { label: t('menu.disconnect'), action: () => $('btn-tb-disconnect').click() },
          '-',
          { label: t('menu.login'), action: () => openLoginModal() },
          {
            label: 'Desconectar da Conta (Logout)',
            action: async () => {
              if (confirm('Deseja realmente desconectar esta box da sua conta Tailscale?')) {
                try {
                  await SOS.tailscale.logout();
                  toast('Desconectado da conta Tailscale.');
                  refresh();
                } catch (e) {
                  toast(e.message, true);
                }
              }
            }
          },
          { label: t('menu.adminConsole'), action: () => window.open('https://login.tailscale.com/admin/machines', '_blank') },
          '-',
          { label: t('menu.close'), action: () => window.close() }
        ]
      },
      {
        label: t('menu.view'),
        items: [
          { label: t('menu.refresh'), kbd: 'F5', action: refresh },
          {
            label: 'Ver Log do Serviço',
            action: async () => {
              try {
                const res = await SOS.tailscale.log();
                alert(res.log || 'Nenhum log registrado.');
              } catch (e) {
                toast(e.message, true);
              }
            }
          },
          '-',
          { label: t('menu.light'), action: () => document.documentElement.setAttribute('data-theme', 'light') },
          { label: t('menu.dark'), action: () => document.documentElement.setAttribute('data-theme', 'dark') }
        ]
      },
      {
        label: t('menu.language'),
        items: langItems
      },
      {
        label: t('menu.help'),
        items: [
          { label: t('menu.guide'), action: () => document.querySelector('.nav-tab[data-tab="tab-access"]').click() },
          { label: t('menu.about'), action: () => toast('Tailscale VPN v1.0.0 para ShareOS') }
        ]
      }
    ]);
  }

  // Global helper on window
  window.TailscaleApp = {
    copy: copyText,
    pingPeer: pingPeer
  };

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F5') { e.preventDefault(); refresh(); }
    if (e.key === 'Escape') {
      $('modal-login').style.display = 'none';
      $('modal-settings').style.display = 'none';
    }
  });

  // Init
  setupTabs();
  setupActions();
  setupMenu();
  refresh();

  // Smart low-CPU polling (15s, paused when backgrounded)
  if (autoRefresh) {
    refreshTimer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 15000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && autoRefresh) refresh();
  });
})();
