(function() {
  'use strict';

  var API_BASE = window.location.origin;
  var password = sessionStorage.getItem('vault_password') || null;
  var currentTab = 'dashboard';
  var vaultStatus = {};
  var browseOffset = 0;
  var browseTotal = 0;
  var currentBrowseFile = 'vault/twitter_bookmarks_automated.json';

  // DOM Elements
  var loginScreen = document.getElementById('login-screen');
  var dashboard = document.getElementById('dashboard');
  var loginForm = document.getElementById('login-form');
  var loginError = document.getElementById('login-error');
  var tabs = document.querySelectorAll('.tab');
  var tabContents = document.querySelectorAll('.tab-content');
  var refreshBtn = document.getElementById('refresh-btn');
  var logoutBtn = document.getElementById('logout-btn');
  var lastUpdate = document.getElementById('last-update');
  var toast = document.getElementById('toast');

  // Init
  // Hide loading overlay immediately on page load
  var loadingOverlay = document.getElementById('loading-overlay');
  if (loadingOverlay) {
    loadingOverlay.style.display = 'none';
  }

  if (password) {
    showDashboard();
  } else {
    // Show login screen, ensure loading overlay is hidden
    if (loadingOverlay) loadingOverlay.style.display = 'none';
  }

  // Auth
  loginForm.addEventListener('submit', function(e) {
    e.preventDefault();
    var passInput = document.getElementById('password');
    var pass = passInput.value;
    fetch(API_BASE + '/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pass })
    }).then(function(res) {
      if (res.ok) {
        password = pass;
        sessionStorage.setItem('vault_password', pass);
        showDashboard();
      } else {
        loginError.textContent = 'Invalid password';
      }
    }).catch(function(e) {
      loginError.textContent = 'Connection error: ' + e.message;
    });
  });

  logoutBtn.addEventListener('click', function() {
    password = null;
    sessionStorage.removeItem('vault_password');
    loginScreen.classList.remove('hidden');
    dashboard.classList.add('hidden');
  });

  function showDashboard() {
    loginScreen.classList.add('hidden');
    dashboard.classList.remove('hidden');
    loadAllData();
    startAutoRefresh();
  }

  // Tab switching
  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      var tabId = tab.dataset.tab;
      tabs.forEach(function(t) { t.classList.remove('active'); });
      tabContents.forEach(function(c) { c.classList.remove('active'); });
      tab.classList.add('active');
      document.getElementById('tab-' + tabId).classList.add('active');
      currentTab = tabId;
      if (tabId === 'search') initSearch();
    });
  });

  // Refresh button
  refreshBtn.addEventListener('click', loadAllData);

  // Auto refresh
  var autoRefreshInterval;
  function startAutoRefresh() {
    if (autoRefreshInterval) clearInterval(autoRefreshInterval);
    autoRefreshInterval = setInterval(function() {
      if (currentTab === 'dashboard' || currentTab === 'system') {
        loadAllData();
      }
    }, 60000);
  }

  // API helper
  function api(endpoint, options) {
    options = options || {};
    var url = API_BASE + endpoint + (endpoint.includes('?') ? '&' : '?') + 'password=' + encodeURIComponent(password);
    return fetch(url, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' }
    }).then(function(res) {
      if (res.status === 401) {
        logoutBtn.click();
        throw new Error('Unauthorized');
      }
      if (!res.ok) return res.text().then(function(t) { throw new Error(t); });
      return res.json();
    });
  }

  // Load all data
  function loadAllData() {
    return Promise.all([
      loadVaultStatus(),
      loadSyncHistory(),
      loadFunctionsStatus(),
      loadSchedulersStatus()
    ]).then(function() {
      lastUpdate.textContent = 'Updated: ' + new Date().toLocaleTimeString();
    });
  }

  // Vault Status
  function loadVaultStatus() {
    return api('/api/vault/status').then(function(data) {
      vaultStatus = data;
      renderVaultStats();
    }).catch(function(e) {
      showToast('Failed to load vault status: ' + e.message, 'error');
    });
  }

  function renderVaultStats() {
    var container = document.getElementById('vault-stats');
    var sources = [
      { key: 'vault/twitter_bookmarks_automated.json', title: 'Twitter Bookmarks', icon: 'twitter' },
      { key: 'vault/instagram_scrape.json', title: 'Instagram Saved', icon: 'instagram' },
      { key: 'vault/bookmarks_automated.json', title: 'Browser Bookmarks', icon: 'bookmarks' },
      { key: 'unified_knowledge_graph.json', title: 'Knowledge Graph', icon: 'kg' }
    ];

    container.innerHTML = sources.map(function(s) {
      var data = vaultStatus[s.key];
      var hasError = !data || data.error;
      var count = data && data.count !== undefined ? data.count : (hasError ? 'N/A' : '...');
      var updated = data && data.updated ? new Date(data.updated).toLocaleString() : 'N/A';
      var size = data && data.size ? formatBytes(data.size) : 'N/A';
      return '<div class="stat-card ' + (hasError ? 'error' : '') + '">' +
        '<div class="stat-header">' +
          '<div class="stat-icon ' + s.icon + '">' + getIcon(s.icon) + '</div>' +
          '<span class="status-dot ' + (hasError ? 'error' : 'success') + '"></span>' +
        '</div>' +
        '<div class="stat-title">' + s.title + '</div>' +
        '<div class="stat-count">' + (typeof count === 'number' ? count.toLocaleString() : count) + '</div>' +
        '<div class="stat-meta">Updated: ' + updated + '<br>Size: ' + size + '</div>' +
      '</div>';
    }).join('');

    if (vaultStatus['vault/latest_sync_summary.json']) {
      var summary = vaultStatus['vault/latest_sync_summary.json'];
      var syncContainer = document.getElementById('sync-history');
      var html = '';
      if (summary.twitter) html += '<div class="history-item"><span class="history-source">Twitter</span><span class="history-count">' + (summary.twitter.count || 0) + ' posts</span></div>';
      if (summary.instagram) html += '<div class="history-item"><span class="history-source">Instagram</span><span class="history-count">' + (summary.instagram.count || 0) + ' posts</span></div>';
      if (html) syncContainer.innerHTML = html;
    }
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    var k = 1024;
    var sizes = ['B', 'KB', 'MB', 'GB'];
    var i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function getIcon(type) {
    var icons = {
      twitter: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
      instagram: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073z"/></svg>',
      bookmarks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>',
      kg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 000 20 14.5 14.5 0 000-20"/><path d="M2 12h20"/></svg>'
    };
    return icons[type] || '';
  }

  // Sync History
  function loadSyncHistory() {
    var container = document.getElementById('sync-history');
    return api('/api/vault/history').then(function(history) {
      if (!history || history.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted)">No sync history</p>';
        return;
      }
      container.innerHTML = history.slice(0, 5).map(function(h) {
        return '<div class="history-item">' +
          '<span class="history-source">' + (h.source || 'Unknown') + '</span>' +
          '<span class="history-count">' + (h.count || 0) + ' posts</span>' +
          '<span class="history-time">' + (h.timestamp ? new Date(h.timestamp).toLocaleString() : '') + '</span>' +
        '</div>';
      }).join('');
    }).catch(function() {
      container.innerHTML = '<p style="color: var(--text-muted)">No sync history</p>';
    });
  }

  // Sync buttons
  document.querySelectorAll('.btn-sync').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var syncType = btn.dataset.sync;
      btn.disabled = true;
      var statusContainer = document.getElementById('sync-status');
      statusContainer.innerHTML = '<div class="sync-status-item"><span class="status running">Triggering ' + syncType + '...</span></div>';
      api('/api/sync/' + syncType, { method: 'POST' }).then(function(res) {
        if (res.success) {
          statusContainer.innerHTML = '<div class="sync-status-item"><span class="status success">' + res.message + '</span></div>';
          showToast(res.message, 'success');
        } else {
          statusContainer.innerHTML = '<div class="sync-status-item"><span class="status error">' + (res.error || 'Failed') + '</span></div>';
          showToast('Sync failed: ' + res.error, 'error');
        }
      }).catch(function(e) {
        statusContainer.innerHTML = '<div class="sync-status-item"><span class="status error">' + e.message + '</span></div>';
        showToast('Sync error: ' + e.message, 'error');
      }).finally(function() {
        btn.disabled = false;
      });
    });
  });

  // Browse
  var browseLoadBtn = document.getElementById('browse-load');
  if (browseLoadBtn) {
    browseLoadBtn.addEventListener('click', function() {
      currentBrowseFile = document.getElementById('browse-file').value;
      browseOffset = 0;
      loadBrowseData();
    });
  }

  function loadBrowseData() {
    var container = document.getElementById('browse-data');
    var info = document.getElementById('browse-info');
    if (!container) return;
    api('/api/vault/browse?file=' + encodeURIComponent(currentBrowseFile) + '&limit=5&offset=' + browseOffset).then(function(data) {
      browseTotal = data.total;
      info.textContent = 'Showing ' + (data.offset + 1) + '-' + Math.min(data.offset + data.limit, data.total) + ' of ' + data.total + ' items';
      if (!data.data || data.data.length === 0) {
        container.innerHTML = '<div class="browse-item">No data found</div>';
        return;
      }
      container.innerHTML = data.data.slice(0, 5).map(function(item) {
        var text = item.text || item.caption || item.description || item.title || '';
        var author = item.author || item.author_name || item.user?.username || (item.authorHandle ? '@' + item.authorHandle.replace('https://x.com/', '').replace('http://x.com/', '') : '');
        var time = item.created_at || item.timestamp || item.date || '';
        var url = item.url || item.permalink || item.link || item.uri || '';
        var id = item.id || item.shortcode || '';
        var retweets = item.retweet_count || item.retweets || 0;
        var likes = item.like_count || item.likes || item.favorite_count || 0;
        var replies = item.reply_count || 0;

        // Convert timestamps to nice format
        if (time && typeof time === 'string' && time.length > 20) {
          try { time = new Date(time).toLocaleString(); } catch(e) {}
        }

        // Auto-link URLs in text (clickable)
        var linkedText = text.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" class="tweet-link">$1</a>');
        // Also link bare x.com/twitter links
        linkedText = linkedText.replace(/(x\.com\/[^\s<]+)/g, '<a href="https://$1" target="_blank" rel="noopener" class="tweet-link">https://$1</a>');

        return '<div class="browse-item tweet-card"><div class="tweet-header">' +
          (author ? '<span class="tweet-author">' + escapeHtml(author) + '</span>' : '') +
          (time ? '<span class="tweet-time">' + time + '</span>' : '') +
        '</div><div class="tweet-text">' + linkedText + '</div><div class="tweet-footer">' +
          '<span class="tweet-stat">↩ ' + replies + '</span>' +
          '<span class="tweet-stat">♺ ' + retweets + '</span>' +
          '<span class="tweet-stat">♥ ' + likes + '</span>' +
          (url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" class="tweet-url">Open Tweet ↗</a>' : '') +
        '</div></div>';
      }).join('');
      renderPagination();
    }).catch(function(e) {
      container.innerHTML = '<div class="browse-item" style="color: var(--error)">Error: ' + e.message + '</div>';
    });
  }

  function renderPagination() {
    var container = document.getElementById('browse-pagination');
    if (!container) return;
    var totalPages = Math.ceil(browseTotal / 5);
    var currentPage = Math.floor(browseOffset / 5) + 1;
    container.innerHTML = '' +
      '<button onclick="window.browsePrev()"' + (currentPage <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<span>Page ' + currentPage + ' of ' + totalPages + '</span>' +
      '<button onclick="window.browseNext()"' + (currentPage >= totalPages ? ' disabled' : '') + '>Next</button>';
  }

  window.browsePrev = function() {
    browseOffset = Math.max(0, browseOffset - 5);
    loadBrowseData();
  };

  window.browseNext = function() {
    browseOffset = Math.min(browseTotal - 5, browseOffset + 5);
    loadBrowseData();
  };

  // Functions status
  function loadFunctionsStatus() {
    var container = document.getElementById('functions-list');
    if (!container) return;
    return api('/api/functions/status').then(function(functions) {
      if (!functions || functions.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted)">No functions found</p>';
        return;
      }
      container.innerHTML = functions.map(function(f) {
        return '<div class="function-card">' +
          '<div class="function-info">' +
            '<span class="function-name">' + f.name + '</span>' +
            '<span class="function-region">' + (f.region || 'N/A') + '</span>' +
            '<span class="function-url">' + (f.url || 'N/A') + '</span>' +
          '</div>' +
          '<span class="function-state ' + (f.state === 'ACTIVE' ? 'active' : 'error') + '">' + f.state + '</span>' +
        '</div>';
      }).join('');
    }).catch(function(e) {
      container.innerHTML = '<p style="color: var(--error)">Error: ' + e.message + '</p>';
    });
  }

  // Schedulers status
  function loadSchedulersStatus() {
    var container = document.getElementById('schedulers-list');
    if (!container) return;
    return api('/api/schedulers/status').then(function(schedulers) {
      if (!schedulers || schedulers.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted)">No schedulers found</p>';
        return;
      }
      container.innerHTML = schedulers.map(function(s) {
        return '<div class="scheduler-card">' +
          '<div class="scheduler-info">' +
            '<span class="scheduler-name">' + s.name + '</span>' +
            '<span class="scheduler-schedule">' + (s.schedule || 'N/A') + '</span>' +
            '<span class="scheduler-uri">' + (s.uri || 'N/A') + '</span>' +
          '</div>' +
          '<span class="scheduler-state ' + (s.state === 'ENABLED' ? 'active' : 'error') + '">' + s.state + '</span>' +
        '</div>';
      }).join('');
    }).catch(function(e) {
      container.innerHTML = '<p style="color: var(--error)">Error: ' + e.message + '</p>';
    });
  }

  // ============ SEARCH TAB (server-side) ============
  var searchInitialized = false;

  function initSearch() {
    if (searchInitialized) return;
    searchInitialized = true;

    var searchInput = document.getElementById('search-input');
    var searchBtn = document.getElementById('search-btn');
    var searchSource = document.getElementById('search-source');

    // Preload index on tab open
    document.getElementById('search-status').textContent = 'Loading search index...';
    api('/api/vault/search/preload').then(function(preload) {
      document.getElementById('search-status').textContent =
        preload.count + ' items indexed' + (preload.cached ? ' (cached)' : ' (fresh)');
      showToast('Search ready: ' + preload.count + ' items', 'success');
    }).catch(function(e) {
      document.getElementById('search-status').textContent = 'Index load failed: ' + e.message;
    });

    // Search on button click
    if (searchBtn) {
      searchBtn.addEventListener('click', doSearch);
    }
    // And on Enter
    if (searchInput) {
      searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') doSearch();
      });
    }
    // Source filter change
    if (searchSource) {
      searchSource.addEventListener('change', doSearch);
    }
  }

  function doSearch() {
    var query = (document.getElementById('search-input').value || '').trim();
    var source = (document.getElementById('search-source').value) || 'all';
    var container = document.getElementById('search-results');
    var statusEl = document.getElementById('search-status');
    var countEl = document.getElementById('search-count');

    if (!container) return;
    if (query.length < 2 && source === 'all') {
      container.innerHTML = '<p style="color: var(--text-muted)">Enter at least 2 characters or select a source filter</p>';
      return;
    }

    statusEl.textContent = 'Searching...';
    api('/api/vault/search?q=' + encodeURIComponent(query) + '&source=' + source + '&limit=50').then(function(res) {
      statusEl.textContent = '';
      countEl.textContent = res.total + ' results';
      if (res.results.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted)">No results found</p>';
        return;
      }
      window.lastSearchResults = res.results;
      container.innerHTML = res.results.map(function(r, i) {
        var text = r.text || '';
        var author = r.author || '';
        var time = r.created_at || r.timestamp || '';
        var url = r.url || '';
        var retweets = r.retweet_count || r.retweets || 0;
        var likes = r.like_count || r.likes || r.favorite_count || 0;
        var replies = r.reply_count || 0;

        // Convert timestamps
        if (time && typeof time === 'string' && time.length > 20) {
          try { time = new Date(time).toLocaleString(); } catch(e) {}
        }

        // Auto-link URLs in text (clickable)
        var linkedText = text.substring(0, 280).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        linkedText = linkedText.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener" class="tweet-link">$1</a>');
        linkedText = linkedText.replace(/(x\.com\/[^\s<]+)/g, '<a href="https://$1" target="_blank" rel="noopener" class="tweet-link">https://$1</a>');
        if (text.length > 280) linkedText += '…';

        return '<div class="browse-item tweet-card" data-index="' + i + '">' +
          '<div class="tweet-header">' +
            '<span class="tweet-author">' + escapeHtml(author) + '</span>' +
            (time ? '<span class="tweet-time">' + time + '</span>' : '') +
          '</div>' +
          '<div class="tweet-text">' + linkedText + '</div>' +
          '<div class="tweet-footer">' +
            '<span class="tweet-stat">↩ ' + replies + '</span>' +
            '<span class="tweet-stat">♺ ' + retweets + '</span>' +
            '<span class="tweet-stat">♥ ' + likes + '</span>' +
            (url ? '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" class="tweet-url">Open Tweet ↗</a>' : '') +
          '</div>' +
        '</div>';
      }).join('');

      container.querySelectorAll('.btn-open-url').forEach(function(btn) {
        btn.addEventListener('click', function() {
          window.open(btn.dataset.url, '_blank');
        });
      });
    }).catch(function(e) {
      statusEl.textContent = 'Search failed: ' + e.message;
    });
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Toast
  function showToast(message, type) {
    type = type || '';
    toast.textContent = message;
    toast.className = 'toast show ' + type;
    setTimeout(function() { toast.className = 'toast'; }, 3000);
  }
})();
