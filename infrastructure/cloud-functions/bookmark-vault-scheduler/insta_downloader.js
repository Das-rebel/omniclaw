/**
 * Instagram Media Downloader
 * Uses instagrapi to download media bytes, avoiding 403 Forbidden errors
 */

const { Client } = require('instagrapi');

class InstagramDownloader {
    constructor(username, cookies = '') {
        this.username = username;
        this.cookies = cookies;
        this.client = new Client();
    }

    async init() {
        if (this.cookies) {
            this.client.set_settings({ cookies: this.parseCookies(this.cookies) });
        }
        try {
            this.client.user_id = this.client.user_id_from_username(this.username);
        } catch (e) {
            console.error('[Downloader] User ID resolution failed:', e.message);
        }
    }

    parseCookies(cookieString) {
        const cookies = {};
        if (!cookieString) return cookies;
        cookieString.split(';').forEach(part => {
            const [key, value] = part.split('=').map(s => s.trim());
            if (key && value) cookies[key] = value;
        });
        return cookies;
    }

    /**
     * Downloads media bytes from Instagram
     * @param {string} url - The Instagram post URL
     */
    async downloadMedia(url) {
        try {
            const shortcode = url.split('/p/')[1]?.split('/')[0];
            if (!shortcode) throw new Error('Invalid Instagram URL');

            const media = this.client.media_info(shortcode);
            
            if (media.media_type === 1) { // Photo
                const path = this.client.photo_download(media.pk);
                const bytes = require('fs').readFileSync(path);
                require('fs').unlinkSync(path); // Cleanup
                return { data: bytes, mimeType: 'image/jpeg' };
            } else if (media.media_type === 2) { // Video
                const path = this.client.video_download(media.pk);
                const bytes = require('fs').readFileSync(path);
                require('fs').unlinkSync(path); // Cleanup
                return { data: bytes, mimeType: 'video/mp4' };
            } else {
                throw new Error(`Unsupported media type: ${media.media_type}`);
            }
        } catch (error) {
            console.error(`[Downloader] Download failed for ${url}:`, error.message);
            throw error;
        }
    }
}

module.exports = { InstagramDownloader };
