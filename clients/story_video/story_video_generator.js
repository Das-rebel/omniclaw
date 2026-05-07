/**
 * Story Video Generator - OmniClaw
 * 
 * One-command story-to-video generation using OmniClaw's clients.
 * 
 * Usage:
 *   node story_video_generator.js --story "A hero's journey" --genre adventure
 *   node story_video_generator.js --theme "love story" --provider kie-ai --duration 5
 * 
 * Or programmatically:
 *   const generator = require('./story_video/story_video_generator');
 *   const result = await generator.generate({ story: '...', ... });
 */

const { StoryNarratorClient } = require('../story_narrator_client');
const { UnifiedVideoClient, HiggsfieldClient } = require('../video/unified_video_client');
const { StoryToVideoOrchestrator } = require('./story_to_video_orchestrator');

class StoryVideoGenerator {
  constructor(config = {}) {
    // Video API keys (at least one required)
    // Free rotation: Open-Generative-AI (local, FREE) → Wavespeed (free tier) → Runware ($2 free) → Kie.ai (paid)
    this.videoClient = new UnifiedVideoClient({
      kieAiKey: config.kieAiKey || process.env.KIE_AI_API_KEY,
      runwareKey: config.runwareKey || process.env.RUNWARE_API_KEY,
      wavespeedKey: config.wavespeedKey || process.env.WAVESPEED_API_KEY,
      muapiKey: config.muapiKey || process.env.MUAPI_API_KEY,
      higgsfieldCredentials: config.higgsfieldCredentials || process.env.HIGGSFIELD_CREDENTIALS,
      openGenerativeAiUrl: config.openGenerativeAiUrl || process.env.OPEN_GEN_AI_URL || 'http://localhost:7860',
      defaultProvider: config.defaultProvider || 'auto',  // 'auto' = free-first rotation
      flowEnabled: true,
      flowPort: config.flowPort || 60807,
    });

    // Story narrator (optional - for AI story generation)
    this.narratorClient = config.narratorClient || null;

    // Orchestrator
    this.orchestrator = new StoryToVideoOrchestrator({
      videoClient: this.videoClient,
      narratorClient: this.narratorClient,
      outputDir: config.outputDir || process.env.STORY_VIDEO_OUTPUT || '/tmp/story_video',
      ffmpegPath: config.ffmpegPath || 'ffmpeg',
      defaultDuration: config.defaultDuration || 5,
      defaultResolution: config.defaultResolution || '720p',
      defaultAspectRatio: config.defaultAspectRatio || '16:9',
      generateAudio: config.generateAudio !== false,
    });
  }

  /**
   * Generate a video from a story
   * 
   * @param {Object} params
   * @param {string} params.story - Raw story text (or use theme for auto-generation)
   * @param {string} [params.theme] - Theme to auto-generate story
   * @param {string} [params.genre] - adventure|fantasy|scifi|mystery|comedy
   * @param {string} [params.character] - hero|villain|mentor|trickster|loveInterest
   * @param {string} [params.language] - hinglish|english|hindi
   * @param {string} [params.narrationVoice] - TTS voice name
   * @param {string} [params.videoProvider] - kie-ai|runware|wavespeed
   * @param {number} [params.duration] - Clip duration in seconds (4-15)
   * @param {string} [params.resolution] - 480p|720p|1080p
   * @param {string} [params.aspectRatio] - 16:9|9:16|4:3|1:1
   * @param {boolean} [params.splitIntoScenes] - Auto-split into scenes
   * @returns {Promise<Object>}
   */
  async generate(params = {}) {
    const {
      story,
      theme,
      genre = 'adventure',
      character = 'hero',
      language = 'hinglish',
      narrationVoice = 'NARRATOR',
      videoProvider = 'kie-ai',
      duration = 5,
      resolution = '720p',
      aspectRatio = '16:9',
      splitIntoScenes = true,
    } = params;

    // Auto-generate story from theme if provided
    let finalStory = story;
    if (!finalStory && theme) {
      console.log(`[StoryVideoGenerator] Auto-generating story for theme: "${theme}"`);
      finalStory = await this._generateStoryFromTheme({ theme, genre, character, language });
    }

    if (!finalStory) {
      throw new Error('Either story or theme parameter is required');
    }

    // Run the orchestrator
    return this.orchestrator.generateFromStory({
      story: finalStory,
      genre,
      character,
      language,
      narrationVoice,
      splitIntoScenes,
      videoProvider,
    });
  }

  /**
   * Generate video from a single prompt (no story parsing)
   */
  async generateFromPrompt(params = {}) {
    const {
      prompt,
      videoProvider = 'kie-ai',
      duration = 5,
      resolution = '720p',
      aspectRatio = '16:9',
    } = params;

    return this.orchestrator.generateFromPrompt({
      prompt,
      videoProvider,
      duration,
      resolution,
      aspectRatio,
    });
  }

  /**
   * Generate just the story (no video)
   */
  async generateStory(params = {}) {
    const { theme, genre = 'adventure', character = 'hero', language = 'hinglish' } = params;
    return this._generateStoryFromTheme({ theme, genre, character, language });
  }

  // ─── Private ───────────────────────────────────────────────────────────

  async _generateStoryFromTheme({ theme, genre, character, language }) {
    if (this.narratorClient) {
      try {
        const result = await this.narratorClient.generateStory({
          theme,
          genre,
          characters: character,
          language,
        });
        return typeof result === 'string' ? result : (result.story || result.text || JSON.stringify(result));
      } catch (err) {
        console.warn(`[StoryVideoGenerator] Narrator failed: ${err.message}, using fallback`);
      }
    }

    // Fallback: simple template story
    return this._fallbackStory(theme, genre, character);
  }

  _fallbackStory(theme, genre, archetype) {
    const stories = {
      adventure: `A brave ${archetype} embarked on an epic journey to discover the secret of "${theme}". Through treacherous mountains and dark forests, they faced many challenges. Finally, they reached the ancient temple where the truth about ${theme} was revealed. The hero returned home changed forever, having learned that the greatest treasure was the journey itself.`,
      fantasy: `In a magical realm where ${theme} held ancient power, a ${archetype} was chosen by destiny. They traveled through enchanted forests and crystal caves, battling dark forces. In the end, they discovered that true magic comes from within, and used this knowledge to bring peace to the kingdom of ${theme}.`,
      scifi: `In the year 2150, ${theme} became humanity's greatest challenge. A ${archetype} aboard the starship Horizon was tasked with a dangerous mission. Through asteroid fields and alien encounters, they persevered. The solution to ${theme} was found in an unexpected place — a message from Earth's past.`,
      mystery: `The mystery of "${theme}" had confounded everyone for decades. A brilliant ${archetype} arrived in town and began investigating. Clues led to hidden passages and secret meetings. In a dramatic revelation, the truth about ${theme} was uncovered — it had been hidden in plain sight all along.`,
      comedy: `Who knew ${theme} could cause so much chaos? Our ${archetype} certainly didn't expect the adventure that awaited. Through hilarious mix-ups and absurd situations, they somehow saved the day. In the end, they realized that sometimes the best adventures are the ones you never see coming.`,
    };
    return stories[genre] || stories.adventure;
  }
}

// ─── CLI Entry Point ──────────────────────────────────────────────────────

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || Object.keys(args).length === 0) {
    printHelp();
    process.exit(0);
  }

  async function main() {
    const generator = new StoryVideoGenerator({
      kieAiKey: args['kie-ai-key'] || process.env.KIE_AI_API_KEY,
      runwareKey: args['runware-key'] || process.env.RUNWARE_API_KEY,
      wavespeedKey: args['wavespeed-key'] || process.env.WAVESPEED_API_KEY,
      muapiKey: args['muapi-key'] || process.env.MUAPI_API_KEY,
      outputDir: args.output,
      defaultProvider: args.provider || 'auto',  // 'auto' = free-first rotation
      defaultDuration: parseInt(args.duration) || 5,
      defaultResolution: args.resolution || '720p',
      defaultAspectRatio: args.aspect || '16:9',
    });

    try {
      const result = await generator.generate({
        story: args.story,
        theme: args.theme,
        genre: args.genre || 'adventure',
        character: args.character || 'hero',
        language: args.language || 'hinglish',
        videoProvider: args.provider || 'auto',  // 'auto' = free-first rotation
        duration: parseInt(args.duration) || 5,
        resolution: args.resolution || '720p',
        aspectRatio: args.aspect || '16:9',
        splitIntoScenes: !args.noSceneSplit,
      });
      console.log(`\n✅ Story video generation complete!`);
      console.log(`📁 Project: ${result.projectId}`);
      console.log(`🎬 Final video: ${result.finalVideoPath}`);
      console.log(`🎥 Provider used: ${result.providerUsed || result.provider || 'auto-rotation'}`);
      console.log(`📽️  Clips: ${result.clips.length}`);
      console.log(`⏱️  Duration: ${result.totalDuration}s`);
    } catch (err) {
      console.error(`\n❌ Error: ${err.message}`);
      process.exit(1);
    }
  }

  main();
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      args[key] = val !== undefined ? val : true;
    } else if (arg.startsWith('-')) {
      args[argv[i + 1]] = argv[i + 2];
      i += 2;
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Story Video Generator - OmniClaw
================================
Generate videos from stories or themes using AI.

Usage:
  node story_video_generator.js [options]

Options:
  --story=<text>          Story text (or use --theme)
  --theme=<text>          Theme to auto-generate story
  --genre=<genre>        adventure|fantasy|scifi|mystery|comedy (default: adventure)
  --character=<type>      hero|villain|mentor|trickster|loveInterest (default: hero)
  --language=<lang>       hinglish|english|hindi (default: hinglish)
  --provider=<provider>   auto (free-first)|kie-ai|runware|wavespeed|muapi (default: auto)
  --duration=<seconds>    Clip duration 4-15 (default: 5)
  --resolution=<res>      480p|720p|1080p (default: 720p)
  --aspect=<ratio>        16:9|9:16|4:3|1:1 (default: 16:9)
  --output=<dir>          Output directory
  --noSceneSplit          Disable auto scene splitting
  --kie-ai-key=<key>      Kie.ai API key
  --runware-key=<key>     Runware API key
  --wavespeed-key=<key>   Wavespeed API key
  --muapi-key=<key>       MuAPI/ArtCraft API key

Examples:
  # Generate from a theme
  node story_video_generator.js --theme="dragon and knight" --genre=fantasy

  # Generate from story text
  node story_video_generator.js --story="A brave knight..." --provider=kie-ai

  # Vertical video format
  node story_video_generator.js --theme="love story" --aspect=9:16

Environment Variables:
  KIE_AI_API_KEY, RUNWARE_API_KEY, WAVESPEED_API_KEY, MUAPI_API_KEY
  STORY_VIDEO_OUTPUT=/tmp/story_video

Free Rotation Order (--provider=auto):
  1. MuAPI/ArtCraft — Seedance 2.0 API (free tier, no card needed)
  2. Wavespeed (free credits on signup)
  3. Runware ($2 free credits)
  4. Kie.ai (paid)
`);
}

module.exports = { StoryVideoGenerator, StoryToVideoOrchestrator };
