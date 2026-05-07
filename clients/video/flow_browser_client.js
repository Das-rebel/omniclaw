/**
 * Google Flow Automation via SOTA-Browser (PI Browser Automation)
 * 
 * Automates Google Flow (labs.google/fx/tools/flow) to generate:
 * - Nano Banana 2 images
 * - Veo 3.1 videos
 * 
 * Uses sota-browser (PI's JavaScript/Chrome CDP-based automation) instead of browser2api.
 * 
 * IMPORTANT: Flow requires Google account authentication. The browser must be
 * logged into a Google account that has access to Flow (free tier works).
 */

const { browser_create_session, browser_create_tab, browser_navigate, 
        browser_click, browser_type, browser_wait, browser_screenshot,
        browser_get_state, browser_get_html, browser_evaluate,
        browser_close_session, browser_list_tabs } = require('./browser_utils');

const path = require('path');
const fs = require('fs');

class FlowBrowserClient {
  constructor(options = {}) {
    this.outputDir = options.outputDir || '/tmp/flow_output';
    this.verbose = options.verbose || false;
    this.browser = null;
    this.tabId = null;
    
    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Check if currently logged into Google Flow
   * @returns {Promise<boolean>}
   */
  async isLoggedIn() {
    try {
      await this._ensureBrowser();
      
      // Navigate to Flow and check for login elements
      await browser_navigate(this.tabId, 'https://labs.google/fx/tools/flow');
      await browser_wait(3);
      
      const html = await browser_get_html(this.tabId);
      
      // Check if we're on the login page
      if (html.includes('accounts.google.com')) {
        return false;
      }
      
      // Check for create button (indicates logged in)
      const state = await browser_get_state(this.tabId);
      const hasCreateButton = state.elements?.some(el => 
        el.text?.toLowerCase().includes('create')
      );
      
      // Check for profile/account elements
      const hasAccount = html.includes('Google Account') || 
                        html.includes('profile') ||
                        html.includes('aria-label');
      
      return hasCreateButton || hasAccount;
    } catch (e) {
      this._log('Login check error:', e.message);
      return false;
    }
  }

  /**
   * Generate image(s) via Google Flow
   * @param {string} prompt - Text description
   * @param {object} params
   * @param {string} [params.model='nano-banana-2'] - Model: 'nano-banana-2', 'nano-banana-pro', 'imagen-4'
   * @param {string} [params.orientation='landscape'] - 'landscape', 'portrait', 'square'
   * @param {number} [params.count=2] - Number of images (1-4)
   * @returns {Promise<{success: boolean, images?: string[], error?: string}>}
   */
  async generateImage(prompt, params = {}) {
    const {
      model = 'nano-banana-2',
      orientation = 'landscape',
      count = 2,
    } = params;

    this._log(`Generating image with prompt: "${prompt}"`);
    this._log(`Model: ${model}, Orientation: ${orientation}, Count: ${count}`);

    try {
      // Step 1: Ensure browser and navigate to Flow
      await this._ensureBrowser();
      
      // Step 2: Navigate to Flow and handle auth
      await this._navigateToFlow();
      
      // Step 3: Find and use the prompt input
      await this._inputPrompt(prompt);
      
      // Step 4: Select model (Nano Banana 2, etc)
      await this._selectModel(model);
      
      // Step 5: Set orientation if needed
      await this._setOrientation(orientation);
      
      // Step 6: Click Generate and wait for results
      const imagePaths = await this._generateAndDownload(count);
      
      return {
        success: true,
        images: imagePaths,
      };
    } catch (e) {
      this._log('Image generation error:', e.message);
      return {
        success: false,
        error: e.message,
      };
    }
  }

  /**
   * Generate video via Google Flow
   * @param {string} prompt - Text description
   * @param {object} params
   * @param {string} [params.model='veo-3.1-fast'] - Model: 'veo-3.1-fast', 'veo-3.1-quality'
   * @param {string} [params.orientation='landscape'] - 'landscape', 'portrait'
   * @param {number} [params.duration=5] - Duration in seconds
   * @returns {Promise<{success: boolean, video?: string, error?: string}>}
   */
  async generateVideo(prompt, params = {}) {
    const {
      model = 'veo-3.1-fast',
      orientation = 'landscape',
      duration = 5,
    } = params;

    this._log(`Generating video with prompt: "${prompt}"`);
    this._log(`Model: ${model}, Orientation: ${orientation}, Duration: ${duration}s`);

    try {
      // Step 1: Ensure browser and navigate to Flow
      await this._ensureBrowser();
      
      // Step 2: Navigate to Flow and handle auth
      await this._navigateToFlow();
      
      // Step 3: Input prompt
      await this._inputPrompt(prompt);
      
      // Step 4: Switch to Video mode if not already
      await this._switchToVideoMode();
      
      // Step 5: Select video model
      await this._selectVideoModel(model);
      
      // Step 6: Generate and download
      const videoPath = await this._generateVideoAndDownload(duration);
      
      return {
        success: true,
        video: videoPath,
      };
    } catch (e) {
      this._log('Video generation error:', e.message);
      return {
        success: false,
        error: e.message,
      };
    }
  }

  /**
   * Get available models for Flow
   */
  getModels() {
    return {
      image: ['nano-banana-2', 'nano-banana-pro', 'imagen-4'],
      video: ['veo-3.1-fast', 'veo-3.1-quality', 'veo-2-fast', 'veo-2-quality'],
    };
  }

  /**
   * Close the browser session
   */
  async close() {
    if (this.browser && this.tabId) {
      try {
        await browser_close_session(this.browser);
        this._log('Browser session closed');
      } catch (e) {
        this._log('Error closing browser:', e.message);
      }
      this.browser = null;
      this.tabId = null;
    }
  }

  // ─── Private Methods ───────────────────────────────────────────────────

  async _ensureBrowser() {
    if (!this.browser) {
      this.browser = await browser_create_session('flow-' + Date.now());
      this._log('Created new browser session:', this.browser);
    }
    
    if (!this.tabId) {
      const tab = await browser_create_tab(this.browser, 'https://labs.google/fx/tools/flow');
      this.tabId = tab.id;
      this._log('Created new tab:', this.tabId);
    }
  }

  async _navigateToFlow() {
    this._log('Navigating to Google Flow...');
    await browser_navigate(this.tabId, 'https://labs.google/fx/tools/flow');
    await browser_wait(2);
    
    // Check if redirected to login page
    const state = await browser_get_state(this.tabId);
    const url = state.url || '';
    
    if (url.includes('accounts.google.com')) {
      this._log('Redirected to Google Sign-In. Please authenticate manually.');
      this._log('Waiting for login completion...');
      
      // Wait for redirect back to Flow (up to 5 minutes for manual login)
      const maxWait = 300; // 5 minutes
      for (let i = 0; i < maxWait; i++) {
        await browser_wait(1);
        const currentState = await browser_get_state(this.tabId);
        const currentUrl = currentState.url || '';
        
        if (!currentUrl.includes('accounts.google.com')) {
          this._log('Login successful, returned to Flow');
          break;
        }
        
        if (i % 30 === 0 && i > 0) {
          this._log(`Still waiting for login... (${i}s elapsed)`);
        }
      }
    }
    
    // Take a screenshot to see current state
    const screenshot = await browser_screenshot(this.tabId);
    this._log('Current page state captured (base64 length:', screenshot.length, ')');
  }

  async _inputPrompt(prompt) {
    this._log('Inputting prompt...');
    
    // Try to find the prompt textarea/input
    // Flow UI typically has a prompt bar with textarea or contenteditable
    const promptSelectors = [
      'textarea[placeholder*="Describe"]',
      'textarea[placeholder*="prompt"]',
      'textarea[aria-label*="prompt"]',
      'div[contenteditable="true"][data-placeholder*="Describe"]',
      'div[contenteditable="true"][data-placeholder*="prompt"]',
      'input[type="text"][placeholder*="Describe"]',
      'textarea',
      'div[contenteditable="true"]',
    ];

    let promptFound = false;
    for (const selector of promptSelectors) {
      try {
        const elements = await browser_evaluate(this.tabId, (sel) => {
          const els = document.querySelectorAll(sel);
          return Array.from(els).map(el => ({
            tag: el.tagName,
            placeholder: el.placeholder || el.getAttribute('data-placeholder') || '',
            contenteditable: el.contentEditable,
            ariaLabel: el.getAttribute('aria-label') || '',
            rect: el.getBoundingClientRect(),
          })).filter(el => el.rect.width > 0 && el.rect.height > 0);
        }, selector);
        
        if (elements && elements.length > 0) {
          this._log(`Found prompt element with selector: ${selector}`, elements);
          
          // Click to focus the element
          await browser_click(selector, this.tabId);
          await browser_wait(0.5);
          
          // Type the prompt
          await browser_type(selector, prompt, this.tabId);
          promptFound = true;
          break;
        }
      } catch (e) {
        this._log(`Selector ${selector} failed:`, e.message);
      }
    }

    if (!promptFound) {
      throw new Error('Could not find prompt input element. Flow UI may have changed.');
    }
    
    this._log('Prompt entered successfully');
  }

  async _selectModel(model) {
    this._log(`Selecting model: ${model}`);
    
    // Model selection is typically a dropdown or tab in Flow UI
    // Look for model selector
    const modelSelectors = [
      'button[aria-label*="model"]',
      'button[aria-label*="Model"]',
      'div[role="button"][aria-label*="model"]',
      'select',
      '[data-testid*="model"]',
    ];

    for (const selector of modelSelectors) {
      try {
        const visible = await browser_evaluate(this.tabId, (sel) => {
          const el = document.querySelector(sel);
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }, selector);
        
        if (visible) {
          await browser_click(selector, this.tabId);
          await browser_wait(0.5);
          
          // Try to select the specific model
          const modelOptionSelectors = [
            `div[role="option"][data-value*="${model}"]`,
            `div[role="option"][aria-label*="${model}"]`,
            `span[title*="${model}"]`,
            `button[value*="${model}"]`,
          ];
          
          for (const optSel of modelOptionSelectors) {
            try {
              await browser_click(optSel, this.tabId);
              this._log(`Selected model option: ${optSel}`);
              return;
            } catch (e) {}
          }
        }
      } catch (e) {
        this._log(`Model selector ${selector} failed:`, e.message);
      }
    }
    
    this._log('Note: Model selection may need manual intervention');
  }

  async _setOrientation(orientation) {
    this._log(`Setting orientation: ${orientation}`);
    
    const orientationMap = {
      'landscape': ['landscape', 'horizontal', '16:9'],
      'portrait': ['portrait', 'vertical', '9:16'],
      'square': ['square', '1:1'],
    };
    
    const terms = orientationMap[orientation] || [orientation];
    
    // Look for aspect ratio / orientation selector
    const orientationSelectors = [
      'button[aria-label*="aspect"]',
      'button[aria-label*="ratio"]',
      'button[aria-label*="orientation"]',
      'button[aria-label*="size"]',
    ];

    for (const selector of orientationSelectors) {
      try {
        await browser_click(selector, this.tabId);
        await browser_wait(0.5);
        
        // Click the matching option
        for (const term of terms) {
          try {
            await browser_click(`div[role="option"] >> text="${term}"`, this.tabId);
            this._log(`Selected orientation: ${term}`);
            return;
          } catch (e) {}
        }
      } catch (e) {}
    }
  }

  async _switchToVideoMode() {
    this._log('Switching to video mode...');
    
    // Look for Video tab/button
    const videoSelectors = [
      'button[aria-label*="Video"]',
      'button[aria-label*="video"]',
      'div[role="tab"]:has-text("Video")',
      'button:has-text("Video")',
    ];

    for (const selector of videoSelectors) {
      try {
        await browser_click(selector, this.tabId);
        await browser_wait(0.5);
        this._log('Switched to video mode');
        return;
      } catch (e) {}
    }
    
    this._log('Video mode switch may need manual intervention');
  }

  async _selectVideoModel(model) {
    this._log(`Selecting video model: ${model}`);
    await this._selectModel(model); // Reuse same logic
  }

  async _generateAndDownload(count) {
    this._log(`Generating ${count} image(s)...`);
    
    // Find and click Generate button
    const generateSelectors = [
      'button[aria-label*="Generate"]',
      'button[type="submit"]',
      'button:has-text("Generate")',
      'div[role="button"]:has-text("Generate")',
    ];

    let generateClicked = false;
    for (const selector of generateSelectors) {
      try {
        await browser_click(selector, this.tabId);
        generateClicked = true;
        this._log(`Clicked generate button: ${selector}`);
        break;
      } catch (e) {}
    }

    if (!generateClicked) {
      throw new Error('Could not find Generate button');
    }

    // Wait for generation (can take 10-60 seconds)
    this._log('Waiting for generation to complete...');
    const maxWait = 120; // 2 minutes max
    for (let i = 0; i < maxWait; i++) {
      await browser_wait(1);
      
      // Check if generation is complete by looking for download buttons or images
      const state = await browser_evaluate(this.tabId, () => {
        // Look for generated images
        const images = Array.from(document.querySelectorAll('img[src*="lh3.google"]'));
        const downloadButtons = Array.from(document.querySelectorAll('button[aria-label*="Download"]'));
        const generating = document.querySelector('[aria-label*="generat"]') !== null;
        const loading = document.querySelector('.loading, [class*="spinner"]') !== null;
        
        return {
          imageCount: images.length,
          downloadButtonCount: downloadButtons.length,
          isGenerating: generating || loading,
        };
      });

      if (state && !state.isGenerating && state.imageCount > 0) {
        this._log(`Generation complete! Found ${state.imageCount} images`);
        
        // Download images
        const imagePaths = [];
        for (let i = 0; i < Math.min(count, state.imageCount); i++) {
          const imgPath = await this._downloadImage(i);
          if (imgPath) imagePaths.push(imgPath);
        }
        
        return imagePaths;
      }

      if (i % 15 === 0 && i > 0) {
        this._log(`Still generating... (${i}s elapsed)`);
      }
    }

    throw new Error('Generation timed out');
  }

  async _downloadImage(index) {
    this._log(`Downloading image ${index}...`);
    
    const timestamp = Date.now();
    const filename = `flow_image_${timestamp}_${index}.png`;
    const filepath = path.join(this.outputDir, filename);
    
    // Try to find and click download button for this image
    const downloadSelectors = [
      `button[aria-label*="Download"]:nth-of-type(${index + 1})`,
      `button[aria-label*="download"][data-index="${index}"]`,
      `.download-btn:nth-of-type(${index + 1})`,
    ];

    for (const selector of downloadSelectors) {
      try {
        await browser_click(selector, this.tabId);
        this._log(`Clicked download button: ${selector}`);
        
        // Wait for download and try to find the file
        await browser_wait(2);
        
        // Check if file was downloaded
        const files = fs.readdirSync(this.outputDir);
        const newFiles = files.filter(f => f.includes(`flow_image_${timestamp}`));
        if (newFiles.length > 0) {
          return path.join(this.outputDir, newFiles[0]);
        }
      } catch (e) {}
    }

    // Alternative: Get image src and download via URL
    try {
      const imgData = await browser_evaluate(this.tabId, (idx) => {
        const images = document.querySelectorAll('img[src*="lh3.google"]');
        if (images[idx]) {
          return images[idx].src;
        }
        return null;
      }, index);

      if (imgData) {
        // Download via curl
        const result = require('child_process').spawnSync('curl', ['-o', filepath, imgData]);
        if (result.status === 0 && fs.existsSync(filepath)) {
          this._log(`Downloaded image to: ${filepath}`);
          return filepath;
        }
      }
    } catch (e) {
      this._log('Image download error:', e.message);
    }

    this._log(`Could not download image ${index}`);
    return null;
  }

  async _generateVideoAndDownload(duration) {
    this._log(`Generating video (${duration}s)...`);
    
    // Similar to image generation but for video
    // Find and click Generate button
    const generateSelectors = [
      'button[aria-label*="Generate"]',
      'button[type="submit"]',
      'button:has-text("Generate")',
    ];

    let generateClicked = false;
    for (const selector of generateSelectors) {
      try {
        await browser_click(selector, this.tabId);
        generateClicked = true;
        this._log(`Clicked generate button: ${selector}`);
        break;
      } catch (e) {}
    }

    if (!generateClicked) {
      throw new Error('Could not find Generate button');
    }

    // Wait for video generation (longer than images, can take 1-5 minutes)
    this._log('Waiting for video generation to complete...');
    const maxWait = 300; // 5 minutes max
    for (let i = 0; i < maxWait; i++) {
      await browser_wait(1);
      
      const state = await browser_evaluate(this.tabId, () => {
        const videos = Array.from(document.querySelectorAll('video'));
        const downloadButtons = Array.from(document.querySelectorAll('button[aria-label*="Download"]'));
        const generating = document.querySelector('[aria-label*="generat"]') !== null;
        
        return {
          videoCount: videos.length,
          downloadButtonCount: downloadButtons.length,
          isGenerating: generating,
        };
      });

      if (state && !state.isGenerating && state.videoCount > 0) {
        this._log(`Video generation complete!`);
        
        // Download video
        const timestamp = Date.now();
        const filename = `flow_video_${timestamp}.mp4`;
        const filepath = path.join(this.outputDir, filename);
        
        // Get video src and download
        const videoData = await browser_evaluate(this.tabId, () => {
          const video = document.querySelector('video');
          return video ? video.src : null;
        });

        if (videoData) {
          require('child_process').spawnSync('curl', ['-o', filepath, videoData]);
          if (fs.existsSync(filepath)) {
            this._log(`Downloaded video to: ${filepath}`);
            return filepath;
          }
        }
      }

      if (i % 30 === 0 && i > 0) {
        this._log(`Still generating video... (${i}s elapsed)`);
      }
    }

    throw new Error('Video generation timed out');
  }

  _log(...args) {
    if (this.verbose) {
      console.log('[FlowBrowser]', new Date().toISOString(), ...args);
    }
  }
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
Google Flow Browser Client - OmniClaw
=====================================
Browser-automated image/video generation via Google Flow (Nano Banana 2, Veo 3.1)

Usage:
  node flow_browser_client.js "A cute nano banana"
  node flow_browser_client.js "A sunset" --model imagen-4 --count 4
  node flow_browser_client.js "A cat walking" --video --model veo-3.1-fast

Options:
  --model=<model>      nano-banana-2|nano-banana-pro|imagen-4 (images)
                       veo-3.1-fast|veo-3.1-quality (video)
  --orientation=<o>    landscape|portrait|square (default: landscape)
  --count=<n>          Number of images 1-4 (default: 2)
  --duration=<secs>    Video duration in seconds (default: 5)
  --output-dir=<dir>   Output directory (default: /tmp/flow_output)
  --video              Generate video instead of image
  --check-login        Check if logged into Flow

Prerequisites:
  1. Must be signed into Google in the browser
  2. Flow free tier includes 100 credits + 50/day

Note:
  Uses sota-browser (PI browser automation) instead of browser2api.
  Run with verbose logging: DEBUG=1 node flow_browser_client.js ...
`);
    process.exit(0);
  }

  if (args.includes('--check-login')) {
    const client = new FlowBrowserClient({ verbose: true });
    client.isLoggedIn().then(loggedIn => {
      console.log(loggedIn ? '✅ Logged into Google Flow' : '❌ Not logged in');
      client.close();
      process.exit(loggedIn ? 0 : 1);
    });
    return;
  }

  const prompt = args[0];
  if (!prompt) {
    console.error('Error: Prompt is required');
    process.exit(1);
  }

  const isVideo = args.includes('--video');
  const getArg = (flag, defaultVal) => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : defaultVal;
  };
  const model = getArg('--model', isVideo ? 'veo-3.1-fast' : 'nano-banana-2');
  const orientation = getArg('--orientation', 'landscape');
  const count = parseInt(getArg('--count', '2'));
  const duration = parseInt(getArg('--duration', '5'));
  const outputDir = getArg('--output-dir', '/tmp/flow_output');

  async function main() {
    const client = new FlowBrowserClient({ outputDir, verbose: true });
    
    try {
      if (isVideo) {
        const result = await client.generateVideo(prompt, { model, orientation, duration });
        console.log('\n' + (result.success ? '✅ Video generated!' : '❌ Failed'));
        if (result.video) console.log('Output:', result.video);
        if (result.error) console.log('Error:', result.error);
      } else {
        const result = await client.generateImage(prompt, { model, orientation, count });
        console.log('\n' + (result.success ? '✅ Images generated!' : '❌ Failed'));
        if (result.images?.length > 0) {
          console.log('Output files:');
          result.images.forEach((img, i) => console.log(`  [${i+1}] ${img}`));
        }
        if (result.error) console.log('Error:', result.error);
      }
    } catch (e) {
      console.error('Error:', e.message);
    } finally {
      await client.close();
    }
  }

  main();
}

module.exports = { FlowBrowserClient };