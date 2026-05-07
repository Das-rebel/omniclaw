/**
 * Google Flow / Nano Banana Client for OmniClaw
 * Uses browser2api (Rabornkraken/browser2api) via Playwright to automate Google Flow
 * 
 * Supports:
 * - Nano Banana 2 (image generation)
 * - Imagen 4 (image generation)
 * - Veo 3.1 (video generation)
 * 
 * Requires: Python 3.11+, Google Chrome, browser2api installed
 * Install: python3 -m pip install -e /path/to/browser2api
 * 
 * Usage:
 *   node flow_client.js "A cute nano banana" --model nano-banana-2 --count 2
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const BROWSER2API_PATH = '/tmp/browser2api';
const FLOW_EXAMPLES = `${BROWSER2API_PATH}/examples`;
const FLOW_V2_SCRIPT = `${FLOW_EXAMPLES}/generate_flow_v2.py`;

class FlowClient {
  constructor(options = {}) {
    this.pythonPath = options.pythonPath || 'python3';
    this.outputDir = options.outputDir || '/tmp/flow_output';
    this.browserDataDir = options.browserDataDir || '~/.browser2api';
    
    // Ensure output dir exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Generate images via Google Flow (Nano Banana 2, Imagen 4)
   * @param {string} prompt - Text description
   * @param {object} params
   * @param {string} [params.model='nano-banana-2'] - 'nano-banana-2'|'nano-banana-pro'|'imagen-4'
   * @param {string} [params.orientation='landscape'] - 'landscape'|'portrait'|'square'
   * @param {number} [params.count=2] - Number of images (1-4)
   * @returns {Promise<object>}
   */
  async generateImage(prompt, params = {}) {
    const {
      model = 'nano-banana-2',
      orientation = 'landscape',
      count = 2,
    } = params;

    const args = [
      // Use updated v2 script (works with current Flow UI)
      `${FLOW_EXAMPLES}/generate_flow_v2.py`,
      prompt,
      `--model=${model}`,
      `--orientation=${orientation}`,
      `--count=${count}`,
      `--output-dir=${this.outputDir}`,
    ];

    return this._runPython(args);
  }

  /**
   * Generate video via Google Flow (Veo 3.1)
   * @param {string} prompt - Text description
   * @param {object} params
   * @param {string} [params.model='veo-3.1-fast'] - 'veo-3.1-fast'|'veo-3.1-quality'|'veo-2-fast'|'veo-2-quality'
   * @param {string} [params.orientation='landscape'] - 'landscape'|'portrait'
   * @param {number} [params.duration=5] - Duration in seconds
   * @returns {Promise<object>}
   */
  async generateVideo(prompt, params = {}) {
    const {
      model = 'veo-3.1-fast',
      orientation = 'landscape',
      duration = 5,
    } = params;

    const args = [
      `${FLOW_EXAMPLES}/generate_flow_video.py`,
      prompt,
      `--model=${model}`,
      `--orientation=${orientation}`,
      `--duration=${duration}s`,
      `--output-dir=${this.outputDir}`,
    ];

    return this._runPython(args);
  }

  /**
   * Check if Google Flow session is logged in
   * @returns {Promise<boolean>}
   */
  async isLoggedIn() {
    const loginScript = `
import asyncio
from browser2api import BrowserManager, Platform

async def check():
    bm = BrowserManager()
    try:
        context, page = await bm.launch_for_login(Platform.FLOW)
        await bm.close()
        return True
    except Exception as e:
        print(f"Login check failed: {e}")
        return False

import asyncio
result = asyncio.run(check())
print("LOGGED_IN" if result else "NOT_LOGGED_IN")
`;

    return new Promise((resolve) => {
      const proc = spawn('python3', ['-c', loginScript], {
        cwd: BROWSER2API_PATH,
        timeout: 30000,
      });

      let output = '';
      proc.stdout.on('data', d => output += d.toString());
      proc.stderr.on('data', d => output += d.toString());

      proc.on('close', () => {
        resolve(output.includes('LOGGED_IN'));
      });

      setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 30000);
    });
  }

  /**
   * Get list of available models
   */
  getModels() {
    return {
      image: ['nano-banana-2', 'nano-banana-pro', 'imagen-4'],
      video: ['veo-3.1-fast', 'veo-3.1-quality', 'veo-2-fast', 'veo-2-quality'],
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  _runPython(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.pythonPath, args, {
        cwd: BROWSER2API_PATH,
        timeout: 180000, // 3 min for image generation
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', d => { stdout += d.toString(); process.stdout.write(d); });
      proc.stderr.on('data', d => { stderr += d.toString(); process.stderr.write(d); });

      proc.on('close', (code) => {
        if (code === 0) {
          // Parse output for image paths
          const images = [];
          const lines = stdout.split('\n');
          
          for (const line of lines) {
            if (line.includes('.png') || line.includes('.jpg') || line.includes('.webp')) {
              const match = line.match(/(\/\S+\.(?:png|jpg|webp))/);
              if (match) {
                images.push(match[1]);
              }
            }
          }

          resolve({
            success: true,
            images,
            output: stdout.trim(),
          });
        } else {
          resolve({
            success: false,
            error: stderr || stdout || `Process exited with code ${code}`,
            output: stdout,
          });
        }
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
Google Flow Client - OmniClaw
============================
Browser-automated image/video generation via Google Flow (Nano Banana 2, Veo 3.1)

Usage:
  node flow_client.js "A cute nano banana"
  node flow_client.js "A sunset" --model imagen-4 --count 4
  node flow_client.js "A cat walking" --video --model veo-3.1-fast

Options:
  --model=<model>      nano-banana-2|nano-banana-pro|imagen-4 (images)
                       veo-3.1-fast|veo-3.1-quality (video)
  --orientation=<o>    landscape|portrait|square (default: landscape)
  --count=<n>          Number of images 1-4 (default: 2)
  --duration=<secs>    Video duration in seconds (default: 5)
  --output-dir=<dir>   Output directory (default: /tmp/flow_output)
  --video              Generate video instead of image

Examples:
  # Generate images with Nano Banana 2
  node flow_client.js "A dragon on a mountain" --model nano-banana-2 --count 4

  # Generate video with Veo 3.1
  node flow_client.js "A flowing river in a forest" --video --model veo-3.1-fast

  # Check login status
  node flow_client.js --check-login

Prerequisites:
  1. Install browser2api: pip install -e /tmp/browser2api
  2. Install Playwright: playwright install chromium
  3. Run once to login: python3 examples/generate_flow.py (opens browser)
`);
    process.exit(0);
  }

  if (args.includes('--check-login')) {
    const client = new FlowClient();
    client.isLoggedIn().then(loggedIn => {
      console.log(loggedIn ? '✅ Logged into Google Flow' : '❌ Not logged in');
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
  const duration = getArg('--duration', '5');
  const outputDir = getArg('--output-dir', '/tmp/flow_output');

  async function main() {
    const client = new FlowClient({ outputDir });
    
    try {
      if (isVideo) {
        const result = await client.generateVideo(prompt, { model, orientation, duration: parseInt(duration) });
        console.log('\n' + (result.success ? '✅ Video generated!' : '❌ Failed') + ': ' + result.output);
      } else {
        const result = await client.generateImage(prompt, { model, orientation, count });
        console.log('\n' + (result.success ? '✅ Images generated!' : '❌ Failed'));
        if (result.images?.length > 0) {
          console.log('Output files:');
          result.images.forEach((img, i) => console.log(`  [${i+1}] ${img}`));
        }
      }
    } catch (e) {
      console.error('Error:', e.message);
      process.exit(1);
    }
  }

  main();
}

module.exports = { FlowClient };
