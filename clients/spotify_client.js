const https = require('https');
const querystring = require('querystring');

class SpotifyClient {
  constructor(accessToken, refreshToken) {
    this.accessToken = accessToken || null;
    this.refreshToken = refreshToken || process.env.SPOTIFY_REFRESH_TOKEN || null;
    this.baseUrl = 'https://api.spotify.com';

    this.clientId = process.env.SPOTIFY_CLIENT_ID || '';
    this.clientSecret = process.env.SPOTIFY_CLIENT_SECRET || '';
    this.tokenExpiry = accessToken ? Date.now() + 50 * 60 * 1000 : 0;
    this.requestTimeoutMs = 8000;
    this.isRefreshing = false;
  }

  async getPlaybackState() {
    const fallback = {
      isPlaying: false,
      track: null,
      device: null,
      progressMs: 0,
      unavailable: true,
      reason: 'Spotify playback state unavailable'
    };

    const response = await this._apiRequest('GET', '/v1/me/player');
    if (!response.ok || !response.body) {
      return fallback;
    }

    return {
      isPlaying: Boolean(response.body.is_playing),
      track: response.body.item
        ? {
          id: response.body.item.id || null,
          uri: response.body.item.uri || null,
          name: response.body.item.name || null,
          artists: Array.isArray(response.body.item.artists)
            ? response.body.item.artists.map((a) => a.name)
            : []
        }
        : null,
      device: response.body.device
        ? {
          id: response.body.device.id || null,
          name: response.body.device.name || null,
          volumePercent: response.body.device.volume_percent ?? null
        }
        : null,
      progressMs: response.body.progress_ms || 0,
      unavailable: false
    };
  }

  async getAvailableDevices() {
    const fallback = { devices: [], unavailable: true, reason: 'Unable to get devices' };
    const response = await this._apiRequest('GET', '/v1/me/player/devices');
    if (!response.ok || !response.body) {
      return fallback;
    }
    return {
      devices: response.body.devices || [],
      unavailable: false
    };
  }

  async transferPlayback(deviceId, play = true) {
    const fallback = this._actionFallback('transferPlayback', 'Unable to transfer playback');
    if (!deviceId) {
      return this._actionFallback('transferPlayback', 'Missing device ID');
    }
    const response = await this._apiRequest('PUT', '/v1/me/player', {
      device_ids: [deviceId],
      play: play
    });
    return response.ok ? { success: true, action: 'transferPlayback', deviceId } : fallback;
  }

  async playTrack(trackUri) {
    const fallback = this._actionFallback('playTrack', 'Unable to start track playback');
    if (!trackUri) {
      return this._actionFallback('playTrack', 'Missing track URI');
    }

    // First check for available devices
    const devicesResult = await this.getAvailableDevices();
    let deviceId = null;

    if (!devicesResult.unavailable && devicesResult.devices.length > 0) {
      // Find a device that's not restricted
      const suitableDevice = devicesResult.devices.find(d => !d.is_restricted);
      if (suitableDevice) {
        deviceId = suitableDevice.id;
        console.log(`[SpotifyClient] Found device: ${suitableDevice.name} (${deviceId})`);
        // Transfer playback to this device
        const transferResult = await this.transferPlayback(deviceId, false);
        if (transferResult.success) {
          console.log(`[SpotifyClient] Playback transferred to ${suitableDevice.name}`);
          // Small delay to let transfer complete
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    } else {
      console.log('[SpotifyClient] No available devices found or none controllable');
    }

    // Now try to play
    const playPath = deviceId ? `/v1/me/player/play?device_id=${deviceId}` : '/v1/me/player/play';
    const response = await this._apiRequest('PUT', playPath, {
      uris: [trackUri]
    });

    return response.ok ? { success: true, action: 'playTrack', trackUri, deviceId } : fallback;
  }

  async pausePlayback() {
    const fallback = this._actionFallback('pausePlayback', 'Unable to pause playback');
    const response = await this._apiRequest('PUT', '/v1/me/player/pause');
    return response.ok ? { success: true, action: 'pausePlayback' } : fallback;
  }

  async resumePlayback() {
    const fallback = this._actionFallback('resumePlayback', 'Unable to resume playback');
    const response = await this._apiRequest('PUT', '/v1/me/player/play');
    return response.ok ? { success: true, action: 'resumePlayback' } : fallback;
  }

  async nextTrack() {
    const fallback = this._actionFallback('nextTrack', 'Unable to skip to next track');
    const response = await this._apiRequest('POST', '/v1/me/player/next');
    return response.ok ? { success: true, action: 'nextTrack' } : fallback;
  }

  async previousTrack() {
    const fallback = this._actionFallback('previousTrack', 'Unable to go to previous track');
    const response = await this._apiRequest('POST', '/v1/me/player/previous');
    return response.ok ? { success: true, action: 'previousTrack' } : fallback;
  }

  async setVolume(level) {
    const normalized = Number(level);
    if (!Number.isFinite(normalized)) {
      return this._actionFallback('setVolume', 'Volume must be a number from 0-100');
    }

    const clamped = Math.max(0, Math.min(100, Math.round(normalized)));
    const path = `/v1/me/player/volume?${querystring.stringify({ volume_percent: clamped })}`;
    const response = await this._apiRequest('PUT', path);

    return response.ok
      ? { success: true, action: 'setVolume', level: clamped }
      : this._actionFallback('setVolume', 'Unable to set volume');
  }

  async searchTracks(query) {
    if (!query || !String(query).trim()) {
      return [];
    }

    const path = `/v1/search?${querystring.stringify({ q: String(query).trim(), type: 'track', limit: 10 })}`;
    const response = await this._apiRequest('GET', path);

    if (!response.ok || !response.body || !response.body.tracks) {
      return [];
    }

    const items = Array.isArray(response.body.tracks.items) ? response.body.tracks.items : [];
    return items.map((item) => ({
      id: item.id || null,
      uri: item.uri || null,
      name: item.name || null,
      artists: Array.isArray(item.artists) ? item.artists.map((a) => a.name) : [],
      album: item.album ? item.album.name : null,
      previewUrl: item.preview_url || null
    }));
  }

  async getRecommendations() {
    const path = `/v1/recommendations?${querystring.stringify({ seed_genres: 'pop', limit: 10 })}`;
    const response = await this._apiRequest('GET', path);

    if (!response.ok || !response.body || !Array.isArray(response.body.tracks)) {
      return [];
    }

    return response.body.tracks.map((item) => ({
      id: item.id || null,
      uri: item.uri || null,
      name: item.name || null,
      artists: Array.isArray(item.artists) ? item.artists.map((a) => a.name) : [],
      album: item.album ? item.album.name : null
    }));
  }

  async _refreshAccessToken() {
    if (!this.refreshToken) {
      console.log('[SpotifyClient] No refresh token available');
      return null;
    }

    if (this.isRefreshing) {
      console.log('[SpotifyClient] Token refresh already in progress, waiting...');
      while (this.isRefreshing) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return this.accessToken;
    }

    this.isRefreshing = true;
    console.log('[SpotifyClient] Refreshing access token...');

    try {
      const body = querystring.stringify({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken
      });

      const authHeader = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      const response = await this._httpRequest({
        hostname: 'accounts.spotify.com',
        path: '/api/token',
        method: 'POST',
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        }
      }, body);

      if (response.statusCode === 200 && response.body && response.body.access_token) {
        this.accessToken = response.body.access_token;
        if (response.body.refresh_token) {
          this.refreshToken = response.body.refresh_token;
          console.log('[SpotifyClient] Refresh token updated');
        }
        const expiresIn = Number(response.body.expires_in) || 3600;
        this.tokenExpiry = Date.now() + (expiresIn * 1000) - 60000;
        console.log('[SpotifyClient] Access token refreshed, expires in:', expiresIn, 'seconds');
        return this.accessToken;
      }

      console.log('[SpotifyClient] Token refresh failed:', response.statusCode);
      return null;
    } catch (error) {
      console.error('[SpotifyClient] Token refresh error:', error.message);
      return null;
    } finally {
      this.isRefreshing = false;
    }
  }

  async _ensureAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    if (!this.refreshToken) {
      console.log('[SpotifyClient] No refresh token available');
      return null;
    }

    return await this._refreshAccessToken();
  }

  async _apiRequest(method, path, body) {
    const token = await this._ensureAccessToken();
    if (!token) {
      return { ok: false, statusCode: 0, body: null };
    }

    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      Authorization: `Bearer ${token}`
    };

    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    try {
      let response = await this._httpRequest({
        hostname: this.baseUrl,
        path,
        method,
        headers
      }, payload);

      if (response.statusCode === 401) {
        this.accessToken = null;
        this.tokenExpiry = 0;
        const refreshed = await this._ensureAccessToken();

        if (!refreshed) {
          return { ok: false, statusCode: 401, body: response.body || null };
        }

        headers.Authorization = `Bearer ${refreshed}`;
        response = await this._httpRequest({
          hostname: this.baseUrl,
          path,
          method,
          headers
        }, payload);
      }

      return {
        ok: response.statusCode >= 200 && response.statusCode < 300,
        statusCode: response.statusCode,
        body: response.body
      };
    } catch (_error) {
      return { ok: false, statusCode: 0, body: null };
    }
  }

  _httpRequest(options, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          let parsed = null;
          if (data) {
            try {
              parsed = JSON.parse(data);
            } catch (_error) {
              parsed = null;
            }
          }

          resolve({
            statusCode: res.statusCode || 0,
            body: parsed
          });
        });
      });

      req.setTimeout(this.requestTimeoutMs, () => {
        req.destroy(new Error('Spotify request timeout'));
      });

      req.on('error', reject);

      if (body) {
        req.write(body);
      }

      req.end();
    });
  }

  _actionFallback(action, reason) {
    return {
      success: false,
      action,
      reason
    };
  }
}

module.exports = SpotifyClient;
