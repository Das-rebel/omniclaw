# Story-to-Video Platform — OmniClaw

**Inspired by [huobao-drama](https://github.com/chatfire-AI/huobao-drama)** — AI-powered end-to-end short drama generation.

## What It Does

Transform a story, theme, or prompt into a complete video — automatically.

```
Story/Theme → Script Parsing → Scene Breakdown → [Thumbnails + Video Clips] → Stitched Video
     ↑                                                          ↓
     └── AI Story Generation (optional) ← TTS Narration (optional)
```

## Architecture

| Component | File | Role |
|-----------|------|------|
| **FlowCDPClient** | `clients/video/flow_cdp_client.js` | Google Flow image gen via CDP (Chrome DevTools Protocol) |
| **UnifiedVideoClient** | `clients/video/unified_video_client.js` | Free-first provider rotation for video gen |
| **StoryVideoGenerator** | `clients/story_video/story_video_generator.js` | Main entry point: story → video |
| **StoryToVideoOrchestrator** | `clients/story_video/story_to_video_orchestrator.js` | Pipeline: parse → thumbnails → clips → stitch |
| **Full-size Download** | `clients/video/flow_fullsize_download.js` | Chunked 500KB base64 for full 1376×768 PNGs |

## Provider Rotation (Free-First)

| # | Provider | Type | Cost |
|---|----------|------|------|
| 1 | **Wavespeed** (WAN 2.1) | Video gen | $0.125/5s (tested ✅) |
| 2 | **Google Flow** (Nano Banana 2) | Image gen via CDP | FREE (IMAGES only) |
| 3 | **MuAPI/ArtCraft** | Seedance 2.0 API | Free tier, no card |
| 4 | **Runware** | Video gen | $2 free credits |
| 5 | **Kie.ai** | Video gen | Paid |

## Quick Start

```js
const { StoryVideoGenerator } = require('./clients/story_video/story_video_generator');

const generator = new StoryVideoGenerator({
  // API keys for video providers
  kieAiKey: process.env.KIE_AI_API_KEY,
  runwareKey: process.env.RUNWARE_API_KEY,
  wavespeedKey: process.env.WAVESPEED_API_KEY,
  muapiKey: process.env.MUAPI_API_KEY,
  // Flow is auto-enabled (Chrome CDP on port 60807)
});

// From a story
const result = await generator.generate({
  story: 'A brave knight embarks on an epic journey...',
  genre: 'adventure',
  splitIntoScenes: true,
});

// From a theme (auto-generates story)
const result = await generator.generate({
  theme: 'love story in Tokyo',
  genre: 'romance',
  language: 'english',
});
```

## Google Flow (Nano Banana 2) Setup

Flow provides FREE image generation via your Gemini Pro subscription.

### Prerequisites
1. Google Chrome installed at `/Applications/Google Chrome.app`
2. Chrome profile with Google account (sdas22@gmail.com)
3. Flow PRO access at `labs.google/fx/tools/flow`

### Launch Chrome with Debug Port
```bash
# Method 1: Auto-launch from code
node -e "
const FlowCDPClient = require('./clients/video/flow_cdp_client');
FlowCDPClient.launchWithProfile(60807).then(c => console.log('Ready'));
"

# Method 2: Manual launch
rsync -a ~/Library/Application\ Support/Google/Chrome/Default/{Cookies,'Login Data',Preferences} /tmp/chrome-flow-debug/Default/
rsync -a ~/Library/Application\ Support/Google/Chrome/'Local State' /tmp/chrome-flow-debug/
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=60807 --user-data-dir=/tmp/chrome-flow-debug \
  --no-first-run "https://accounts.google.com" &

# Then navigate to Flow:
# Open http://127.0.0.1:60807 in a browser to see available tabs
```

### Generate Images
```bash
# CLI
node flow_cdp_client.js --prompt "A cute puppy" --output /tmp/flow_output

# Programmatic
const client = new FlowCDPClient(60807);
await client.connect();
const result = await client.generate('A cute puppy', { outputDir: '/tmp/flow_output' });
// result.images = ['/tmp/flow_output/flow_full_xxx_0.png', ...]
```

### Full-Size Download (1376×768)
```bash
node flow_fullsize_download.js 60807 0 /tmp/flow_output/fullsize.png
```

## Pipeline Details

### Scene Thumbnail Generation (Flow)
Each scene gets a thumbnail via Google Flow:
1. Connect to Chrome via CDP (port 60807)
2. Create new Flow project
3. Set prompt in Slate.js editor via `Input.insertText`
4. Click Create (arrow_forward button)
5. Wait for generation (60-180s)
6. Download images via chunked base64 (500KB chunks)

### Video Clip Generation
Scene prompts are enhanced with mood/location adjectives and sent to the video provider rotation.

### Final Assembly
FFmpeg stitches clips + optional narration audio into final video.

## Known Issues

- **Flow generation may time out** — likely daily credit limits on PRO account
- **Slate.js text input is unreliable** on non-fresh editors; `Input.insertText` works on new projects
- **Chrome must be restarted** if too many tabs are opened (>10 tabs can crash it)
- **sota-browser CANNOT authenticate** with Google — only real Chrome via CDP works
- **WebSocket 1MB limit** — full-size images need chunked download

## CLI Usage

```bash
# Full story-to-video
node story_video_generator.js --theme="dragon and knight" --genre=fantasy

# With specific provider
node story_video_generator.js --story="A brave knight..." --provider=kie-ai

# Flow image only
node flow_cdp_client.js --prompt "sunset over mountains"
```

## Environment Variables

```
KIE_AI_API_KEY=       # Kie.ai video generation
RUNWARE_API_KEY=      # Runware video generation
WAVESPEED_API_KEY=    # Wavespeed video generation
MUAPI_API_KEY=        # MuAPI/ArtCraft Seedance 2.0
STORY_VIDEO_OUTPUT=   # Output directory (default: /tmp/story_video)
```
