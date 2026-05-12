/**
 * OmniClaw Cookie Refresh Cloud Function
 * Receives cookie updates from browser extension and stores them in GCS
 *
 * Security:
 * - Validates request format
 * - Stores cookies in GCS with proper permissions
 * - Supports API key authentication
 */

const { Storage } = require('@google-cloud/storage');

// Initialize GCS client
const storage = new Storage({ projectId: 'omniclaw-personal-assistant' });
const BUCKET_NAME = 'omniclaw-knowledge-graph';
const COOKIE_DIR = 'vault/cookies/';

// API key for authentication (should be set as environment variable)
const API_KEY = process.env.COOKIE_REFRESH_API_KEY || 'omniclaw-cookie-refresh-2024';

/**
 * Validate API key from request
 */
function validateApiKey(req) {
    const providedKey = req.headers['x-api-key'] || req.query.api_key;

    if (!providedKey || providedKey !== API_KEY) {
        return false;
    }

    return true;
}

/**
 * Main HTTP handler
 */
exports.cookieRefreshHandler = async (req, res) => {
    // CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.set('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    // Health check endpoint
    if (req.method === 'GET' && req.path === '/health') {
        res.json({
            service: 'omniclaw-cookie-refresh',
            status: 'healthy',
            timestamp: new Date().toISOString()
        });
        return;
    }

    // Only POST requests allowed for cookie updates
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    // Validate API key
    if (!validateApiKey(req)) {
        res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
        return;
    }

    const path = req.path;

    try {
        // Handle Instagram cookies
        if (path === '/instagram') {
            await handleInstagramCookies(req, res);
        }
        // Handle Twitter cookies
        else if (path === '/twitter') {
            await handleTwitterCookies(req, res);
        }
        // Handle bulk cookie update
        else if (path === '/bulk') {
            await handleBulkCookies(req, res);
        }
        else {
            res.status(404).json({ error: 'Endpoint not found' });
        }
    } catch (error) {
        console.error('Cookie refresh error:', error);
        res.status(500).json({
            error: 'Internal server error',
            message: error.message
        });
    }
};

/**
 * Handle Instagram cookie updates
 */
async function handleInstagramCookies(req, res) {
    const { cookies, timestamp } = req.body;

    if (!cookies || !cookies.sessionid) {
        res.status(400).json({ error: 'Missing required cookies: sessionid' });
        return;
    }

    // Validate required Instagram cookies
    const requiredCookies = ['sessionid', 'csrftoken'];
    const missingCookies = requiredCookies.filter(name => !cookies[name]);

    if (missingCookies.length > 0) {
        res.status(400).json({
            error: `Missing required cookies: ${missingCookies.join(', ')}`
        });
        return;
    }

    // Prepare cookie data
    const cookieData = {
        platform: 'instagram',
        cookies: cookies,
        timestamp: timestamp || new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days
    };

    // Upload to GCS
    const fileName = `${COOKIE_DIR}instagram_cookies.json`;
    await uploadToGCS(fileName, cookieData);

    console.log(`✅ Instagram cookies updated at ${cookieData.timestamp}`);

    res.json({
        success: true,
        message: 'Instagram cookies updated successfully',
        expiresAt: cookieData.expiresAt
    });
}

/**
 * Handle Twitter cookie updates
 */
async function handleTwitterCookies(req, res) {
    const { cookies, timestamp } = req.body;

    if (!cookies || !cookies.auth_token) {
        res.status(400).json({ error: 'Missing required cookies: auth_token' });
        return;
    }

    // Validate required Twitter cookies
    const requiredCookies = ['auth_token', 'ct0'];
    const missingCookies = requiredCookies.filter(name => !cookies[name]);

    if (missingCookies.length > 0) {
        res.status(400).json({
            error: `Missing required cookies: ${missingCookies.join(', ')}`
        });
        return;
    }

    // Prepare cookie data
    const cookieData = {
        platform: 'twitter',
        cookies: cookies,
        timestamp: timestamp || new Date().toISOString(),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days
    };

    // Upload to GCS
    const fileName = `${COOKIE_DIR}twitter_cookies.json`;
    await uploadToGCS(fileName, cookieData);

    console.log(`✅ Twitter cookies updated at ${cookieData.timestamp}`);

    res.json({
        success: true,
        message: 'Twitter cookies updated successfully',
        expiresAt: cookieData.expiresAt
    });
}

/**
 * Handle bulk cookie updates (both platforms)
 */
async function handleBulkCookies(req, res) {
    const { instagram, twitter } = req.body;

    const results = {
        instagram: null,
        twitter: null
    };

    // Update Instagram cookies if provided
    if (instagram && instagram.cookies) {
        try {
            const cookieData = {
                platform: 'instagram',
                cookies: instagram.cookies,
                timestamp: instagram.timestamp || new Date().toISOString(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
            };

            await uploadToGCS(`${COOKIE_DIR}instagram_cookies.json`, cookieData);
            results.instagram = { success: true, message: 'Updated' };
        } catch (error) {
            results.instagram = { success: false, error: error.message };
        }
    }

    // Update Twitter cookies if provided
    if (twitter && twitter.cookies) {
        try {
            const cookieData = {
                platform: 'twitter',
                cookies: twitter.cookies,
                timestamp: twitter.timestamp || new Date().toISOString(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
            };

            await uploadToGCS(`${COOKIE_DIR}twitter_cookies.json`, cookieData);
            results.twitter = { success: true, message: 'Updated' };
        } catch (error) {
            results.twitter = { success: false, error: error.message };
        }
    }

    res.json({
        success: true,
        results: results,
        message: 'Bulk cookie update completed'
    });
}

/**
 * Upload data to GCS
 */
async function uploadToGCS(fileName, data) {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(fileName);

    const contents = JSON.stringify(data, null, 2);

    await file.save(contents, {
        contentType: 'application/json',
        metadata: {
            uploadedAt: new Date().toISOString()
        }
    });

    // Make file readable by VM service account
    await file.setMetadata({
        acl: [{
            entity: `projectEditor-${process.env.GCP_PROJECT}`,
            role: 'READER'
        }]
    });

    console.log(`📁 Uploaded to GCS: ${fileName}`);
}

/**
 * Get current cookie status
 */
exports.getCookieStatus = async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');

    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const bucket = storage.bucket(BUCKET_NAME);
        const status = {};

        // Check Instagram cookies
        try {
            const instagramFile = bucket.file(`${COOKIE_DIR}instagram_cookies.json`);
            const [exists] = await instagramFile.exists();
            if (exists) {
                const [contents] = await instagramFile.download();
                const data = JSON.parse(contents.toString());
                status.instagram = {
                    exists: true,
                    timestamp: data.timestamp,
                    expiresAt: data.expiresAt,
                    isValid: new Date(data.expiresAt) > new Date()
                };
            } else {
                status.instagram = { exists: false };
            }
        } catch (error) {
            status.instagram = { exists: false, error: error.message };
        }

        // Check Twitter cookies
        try {
            const twitterFile = bucket.file(`${COOKIE_DIR}twitter_cookies.json`);
            const [exists] = await twitterFile.exists();
            if (exists) {
                const [contents] = await twitterFile.download();
                const data = JSON.parse(contents.toString());
                status.twitter = {
                    exists: true,
                    timestamp: data.timestamp,
                    expiresAt: data.expiresAt,
                    isValid: new Date(data.expiresAt) > new Date()
                };
            } else {
                status.twitter = { exists: false };
            }
        } catch (error) {
            status.twitter = { exists: false, error: error.message };
        }

        res.json({
            service: 'omniclaw-cookie-refresh',
            status: status,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to get cookie status',
            message: error.message
        });
    }
};
