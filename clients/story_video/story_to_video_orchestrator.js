/**
 * Story-to-Video Orchestrator - OmniClaw
 * 
 * Inspired by huobao-drama architecture:
 * https://github.com/chatfire-AI/huobao-drama
 * 
 * Pipeline: Story → Script → Scenes → Shots → Video Clips → Final Video
 * 
 * Wraps:
 *   - StoryNarratorClient (story generation + TTS)
 *   - UnifiedVideoClient (video generation via Kie.ai, Runware, Wavespeed)
 *   - FFmpeg for video stitching
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const FlowCDPClient = require('../video/flow_cdp_client');

class StoryToVideoOrchestrator {
  constructor(config = {}) {
    this.videoClient = config.videoClient;       // UnifiedVideoClient
    this.narratorClient = config.narratorClient; // StoryNarratorClient (optional)
    this.outputDir = config.outputDir || '/tmp/story_video';
    this.ffmpegPath = config.ffmpegPath || 'ffmpeg';

    // Ensure output dir exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    // Generation settings
    this.defaultDuration = config.defaultDuration || 5;  // seconds per clip
    this.defaultResolution = config.defaultResolution || '720p';
    this.defaultAspectRatio = config.defaultAspectRatio || '16:9';
    this.generateAudio = config.generateAudio !== false;

    // Flow CDP client for scene thumbnail generation
    this.flowClient = config.flowClient || null;
    this.flowPort = config.flowPort || 60807;

    // Scene splitting
    this.maxScenesPerStory = config.maxScenesPerStory || 8;
  }

  /**
   * Main entry point: Generate a complete video from a story/theme
   * 
   * @param {Object} params
   * @param {string} params.story - Story text or theme
   * @param {string} [params.genre] - Genre: adventure, fantasy, scifi, mystery, comedy
   * @param {string} [params.character] - Character type: hero, villain, mentor, etc.
   * @param {string} [params.language] - Language: hinglish, english, etc.
   * @param {string} [params.narrationVoice] - TTS voice
   * @param {boolean} [params.splitIntoScenes] - Auto-split story into scenes
   * @param {string} [params.videoProvider] - 'kie-ai' | 'runware' | 'wavespeed'
   * @returns {Promise<Object>} { projectId, scenes, clips, finalVideo, audio }
   */
  async generateFromStory({
    story,
    genre = 'adventure',
    character = 'hero',
    language = 'hinglish',
    narrationVoice = 'NARRATOR',
    splitIntoScenes = true,
    videoProvider = 'wavespeed',  // Default to Wavespeed (tested, $0.125/5s)
  } = {}) {
    const projectId = `story_${Date.now()}`;
    const projectDir = path.join(this.outputDir, projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    console.log(`[StoryToVideo] Starting project: ${projectId}`);

    // Step 1: Parse story into scenes
    const scenes = await this._parseStoryIntoScenes(story, genre, character, language, splitIntoScenes);
    console.log(`[StoryToVideo] Parsed ${scenes.length} scenes`);

    // Step 2: Generate video clips for each scene
    const clips = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      console.log(`[StoryToVideo] Generating clip ${i + 1}/${scenes.length}: "${scene.description}"`);

      const clip = await this._generateSceneClip(scene, i, projectDir, {
        provider: videoProvider,
        duration: this.defaultDuration,
        resolution: this.defaultResolution,
        aspectRatio: this.defaultAspectRatio,
      });
      clips.push(clip);
    }

    // Step 3: Generate narration audio
    let audioPath = null;
    if (this.generateAudio && this.narratorClient) {
      console.log(`[StoryToVideo] Generating narration...`);
      audioPath = await this._generateNarration(story, language, narrationVoice, projectDir);
    }

    // Step 4: Stitch clips into final video
    console.log(`[StoryToVideo] Stitching ${clips.length} clips...`);
    const finalVideoPath = await this._stitchClips(clips, audioPath, projectDir);

    const result = {
      projectId,
      projectDir,
      scenes,
      clips,
      audioPath,
      finalVideoPath,
      totalDuration: clips.reduce((sum, c) => sum + (c.duration || 0), 0),
    };

    console.log(`[StoryToVideo] Complete! Final video: ${finalVideoPath}`);
    return result;
  }

  /**
   * Generate video directly from a prompt (no story parsing)
   */
  async generateFromPrompt({
    prompt,
    duration = 5,
    resolution,
    aspectRatio,
    provider = 'wavespeed',
  } = {}) {
    const clipId = `clip_${Date.now()}`;
    const clipDir = path.join(this.outputDir, clipId);
    fs.mkdirSync(clipDir, { recursive: true });

    console.log(`[StoryToVideo] Generating clip from prompt: "${prompt}"`);

    const clip = await this._generateSceneClip(
      { description: prompt, sceneNumber: 0 },
      0,
      clipDir,
      { provider, duration, resolution, aspectRatio }
    );

    return { clipId, clipDir, ...clip };
  }

  // ─── Private: Scene Parsing ───────────────────────────────────────────────

  /**
   * Parse story text into structured scenes
   */
  async _parseStoryIntoScenes(story, genre, character, language, splitIntoScenes) {
    if (!splitIntoScenes) {
      return [{
        sceneNumber: 0,
        description: story,
        genre,
        character,
        location: 'unknown',
        mood: 'dramatic',
      }];
    }

    // Simple scene splitting: split by sentences/punctuation and group into scenes
    const sentences = story.split(/[.!?]+/).filter(s => s.trim().length > 10);
    const scenes = [];
    const sentencesPerScene = Math.max(2, Math.ceil(sentences.length / this.maxScenesPerStory));

    for (let i = 0; i < sentences.length; i += sentencesPerScene) {
      const group = sentences.slice(i, i + sentencesPerScene);
      const sceneText = group.join('. ').trim();
      if (sceneText.length < 5) continue;

      scenes.push({
        sceneNumber: scenes.length,
        description: sceneText,
        genre,
        character,
        location: this._inferLocation(sceneText),
        mood: this._inferMood(sceneText),
      });
    }

    return scenes;
  }

  _inferLocation(text) {
    const lower = text.toLowerCase();
    if (/forest|jungle|tree|nature/.test(lower)) return 'forest';
    if (/city|street|building|urban|downtown/.test(lower)) return 'city';
    if (/ocean|sea|beach|water|wave/.test(lower)) return 'ocean';
    if (/space|planet|galaxy|stars|cosmos/.test(lower)) return 'space';
    if (/castle|kingdom|medieval/.test(lower)) return 'castle';
    if (/home|house|room|bedroom/.test(lower)) return 'indoor';
    return 'outdoor';
  }

  _inferMood(text) {
    const lower = text.toLowerCase();
    if (/happy|joy|laugh|excited|celebrate/.test(lower)) return 'happy';
    if (/sad|cry|tears|miss|alone/.test(lower)) return 'sad';
    if (/scary|fear|terror|monster|ghost/.test(lower)) return 'scary';
    if (/action|fight|battle|chase|run/.test(lower)) return 'action';
    if (/romance|love|kiss|heart/.test(lower)) return 'romantic';
    return 'dramatic';
  }

  // ─── Private: Clip Generation ─────────────────────────────────────────────

  async _generateSceneClip(scene, index, projectDir, opts = {}) {
    const { provider, duration, resolution, aspectRatio } = opts;
    const clipId = `scene_${String(index).padStart(3, '0')}`;

    // Build video prompt from scene description
    const videoPrompt = this._buildVideoPrompt(scene);

    // Generate thumbnail via Flow BEFORE the video clip
    let thumbnailPath = null;
    thumbnailPath = await this._generateSceneThumbnail(scene, index, projectDir);

    // Generate video
    let videoUrl = null;
    let taskId = null;
    let videoCost = 0;

    if (this.videoClient) {
      try {
        const result = await this.videoClient.generateVideo({
          prompt: videoPrompt,
          provider,
          duration: duration || this.defaultDuration,
          resolution: resolution || this.defaultResolution,
          aspectRatio: aspectRatio || this.defaultAspectRatio,
          waitForCompletion: true,
        });

        videoUrl = result.videoUrl || result.output?.videoUrl;
        taskId = result.requestId || result.task_id;
        videoCost = result.cost || 0;
      } catch (err) {
        console.error(`[StoryToVideo] Video generation failed for ${clipId}: ${err.message}`);
      }
    }

    const clip = {
      clipId,
      sceneNumber: scene.sceneNumber,
      description: scene.description,
      videoPrompt,
      videoUrl,
      taskId,
      videoCost,
      duration: duration || this.defaultDuration,
      location: scene.location,
      mood: scene.mood,
      thumbnailPath,
      localPath: null, // Will be set after download
    };

    // Download video if URL available
    if (videoUrl) {
      const localPath = await this._downloadVideo(videoUrl, `${clipId}.mp4`, projectDir);
      clip.localPath = localPath;
    }

    return clip;
  }

  /**
   * Generate a scene thumbnail image via Google Flow CDP
   */
  async _generateSceneThumbnail(scene, index, projectDir) {
    const thumbDir = path.join(projectDir, 'thumbnails');
    fs.mkdirSync(thumbDir, { recursive: true });

    try {
      const client = this.flowClient || new FlowCDPClient(this.flowPort);
      if (!this.flowClient) {
        await client.connect();
        this.flowClient = client; // reuse for subsequent scenes
      }

      const thumbnailPrompt = this._buildThumbnailPrompt(scene);
      console.log(`[StoryToVideo] Generating thumbnail for scene ${index}: "${thumbnailPrompt.substring(0, 60)}..."`);

      const result = await client.generate(thumbnailPrompt, { outputDir: thumbDir });

      if (result.success && result.images && result.images.length > 0) {
        console.log(`[StoryToVideo] Thumbnail generated: ${result.images[0]}`);
        return result.images[0];
      }

      console.warn(`[StoryToVideo] Thumbnail generation returned no images for scene ${index}`);
      return null;
    } catch (err) {
      console.warn(`[StoryToVideo] Thumbnail generation failed for scene ${index}: ${err.message}`);
      return null;
    }
  }

  /**
   * Build a prompt optimized for thumbnail/image generation
   */
  _buildThumbnailPrompt(scene) {
    const { description, location, mood } = scene;

    const styleMap = {
      dramatic: 'cinematic, dramatic lighting, epic composition',
      action: 'dynamic, intense, frozen motion, impactful',
      happy: 'bright, vibrant, warm colors, joyful',
      sad: 'muted tones, emotional, soft light',
      scary: 'dark, ominous, atmospheric, suspenseful',
      romantic: 'soft warm light, intimate, dreamy',
    };

    const style = styleMap[mood] || styleMap.dramatic;
    const shortDesc = description.length > 150 ? description.substring(0, 150) + '...' : description;

    return `${shortDesc}. ${style}, high quality, 16:9 aspect ratio, scene thumbnail`;
  }

  _buildVideoPrompt(scene) {
    // Convert scene description into a vivid video generation prompt
    const { description, location, mood } = scene;

    // Vivid visual adjectives based on mood
    const moodAdjectives = {
      dramatic: 'cinematic, dramatic lighting, epic',
      action: 'fast-paced, dynamic camera, intense',
      happy: 'bright, vibrant colors, joyful',
      sad: 'muted tones, emotional lighting, melancholic',
      scary: 'dark, ominous, suspenseful',
      romantic: 'soft lighting, warm colors, intimate',
    };

    const adj = moodAdjectives[mood] || moodAdjectives.dramatic;

    // Location-based setting
    const locationSettings = {
      forest: 'mystical forest with ancient trees, fog, dappled sunlight',
      city: 'busy city streets, neon lights, urban atmosphere',
      ocean: 'vast ocean horizon, waves crashing, dramatic sky',
      space: 'cosmic space nebula, stars, planets',
      castle: 'grand medieval castle, stone walls, torchlit',
      indoor: 'cozy interior, warm lighting, intimate space',
      outdoor: 'open landscape, natural lighting',
    };

    const setting = locationSettings[location] || locationSettings.outdoor;

    // Truncate and build prompt
    const shortDesc = description.length > 200 ? description.substring(0, 200) + '...' : description;

    return `${shortDesc}. ${setting}, ${adj}, high quality, professional cinematography`;
  }

  // ─── Private: Audio Generation ────────────────────────────────────────────

  async _generateNarration(text, language, voice, projectDir) {
    if (!this.narratorClient) return null;

    try {
      const result = await this.narratorClient.synthesize({
        text: text.substring(0, 5000), // Limit text length
        voice,
        language,
      });

      if (result.audio) {
        const audioPath = path.join(projectDir, 'narration.mp3');
        fs.writeFileSync(audioPath, result.audio);
        return audioPath;
      }
    } catch (err) {
      console.error(`[StoryToVideo] Narration failed: ${err.message}`);
    }
    return null;
  }

  // ─── Private: Video Stitching ─────────────────────────────────────────────

  async _stitchClips(clips, audioPath, projectDir) {
    const validClips = clips.filter(c => c.localPath && fs.existsSync(c.localPath));

    if (validClips.length === 0) {
      throw new Error('No valid clips to stitch');
    }

    // Create concat list file
    const concatFile = path.join(projectDir, 'concat.txt');
    const concatContent = validClips.map(c => `file '${c.localPath}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);

    const outputPath = path.join(projectDir, 'final_video.mp4');

    // Build FFmpeg command
    const args = ['-f', 'concat', '-safe', '0', '-i', concatFile, '-c:v', 'libx264', '-crf', '23', '-preset', 'fast'];

    if (audioPath && fs.existsSync(audioPath)) {
      // Mix audio with video
      args.push('-i', audioPath, '-c:a', 'aac', '-b:a', '128k', '-shortest');
    } else if (this.generateAudio) {
      // Generate silent audio track
      const silentAudio = path.join(projectDir, 'silent.mp3');
      fs.writeFileSync(silentAudio, Buffer.from([]));
    }

    args.push('-y', outputPath);

    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, args);
      let stderr = '';

      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => {
        if (code === 0) {
          resolve(outputPath);
        } else {
          // Try simpler concat without re-encoding
          this._stitchClipsSimple(validClips, outputPath).then(resolve).catch(reject);
        }
      });
      proc.on('error', reject);
    });
  }

  async _stitchClipsSimple(clips, outputPath) {
    const concatFile = path.join(path.dirname(outputPath), 'concat.txt');
    const concatContent = clips.map(c => `file '${c.localPath}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);

    return new Promise((resolve, reject) => {
      const proc = spawn(this.ffmpegPath, [
        '-f', 'concat', '-safe', '0', '-i', concatFile,
        '-c', 'copy', '-y', outputPath
      ]);
      proc.on('close', code => code === 0 ? resolve(outputPath) : reject(new Error(`FFmpeg exit ${code}`)));
      proc.on('error', reject);
    });
  }

  // ─── Private: Utilities ───────────────────────────────────────────────────

  async _downloadVideo(url, filename, projectDir) {
    const destPath = path.join(projectDir, filename);

    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http;

      const req = protocol.get(url, { timeout: 30000 }, response => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          return this._downloadVideo(response.headers.location, filename, projectDir).then(resolve).catch(reject);
        }

        if (response.statusCode !== 200) {
          return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        }

        const stream = fs.createWriteStream(destPath);
        response.pipe(stream);
        stream.on('finish', () => resolve(destPath));
        stream.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
    });
  }

  /**
   * List all generated projects
   */
  listProjects() {
    if (!fs.existsSync(this.outputDir)) return [];
    return fs.readdirSync(this.outputDir)
      .filter(f => fs.statSync(path.join(this.outputDir, f)).isDirectory())
      .map(f => ({
        id: f,
        path: path.join(this.outputDir, f),
        modified: fs.statSync(path.join(this.outputDir, f)).mtime,
      }))
      .sort((a, b) => b.modified - a.modified);
  }

  /**
   * Clean up a project
   */
  deleteProject(projectId) {
    const projectDir = path.join(this.outputDir, projectId);
    if (fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
      return true;
    }
    return false;
  }
}

module.exports = { StoryToVideoOrchestrator };
