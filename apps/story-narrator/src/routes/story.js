/**
 * Story Routes - Story generation and narration
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');

// Story generation templates
const STORY_TEMPLATES = {
  fantasy: {
    theme: 'Fantasy Adventure',
    characters: ['NARRATOR', 'HERO', 'WISE_OLD_MAN', 'VILLAIN'],
    setting: 'A mystical realm with ancient magic'
  },
  scifi: {
    theme: 'Science Fiction',
    characters: ['NARRATOR', 'HERO', 'SIDEKICK', 'VILLAIN'],
    setting: 'A futuristic galaxy with advanced technology'
  },
  mystery: {
    theme: 'Mystery',
    characters: ['NARRATOR', 'HERO', 'WISE_OLD_MAN'],
    setting: 'A Victorian mansion with dark secrets'
  },
  romance: {
    theme: 'Romance',
    characters: ['NARRATOR', 'HERO', 'FEMALE_LEAD'],
    setting: 'A charming countryside with blooming flowers'
  },
  horror: {
    theme: 'Horror',
    characters: ['NARRATOR', 'VILLAIN'],
    setting: 'A haunted castle with eerie shadows'
  }
};

// Celebrity voice mapping for story characters
const CHARACTER_VOICES = {
  NARRATOR: 'bm_daniel',
  HERO: 'am_michael',
  VILLAIN: 'am_anthony',
  SIDEKICK: 'am_fenris',
  WISE_OLD_MAN: 'bm_george',
  FEMALE_LEAD: 'hf_priya',
  ROMANTIC: 'hm_arpit'
};

/**
 * Get stories — returns template-based stories (matching deployed format)
 */
router.get('/stories', (req, res) => {
  const templateStories = Object.entries(STORY_TEMPLATES).map(([id, info], i) => ({
    id: i + 1,
    title: `The ${info.theme}`,
    genre: id,
    content: `[NARRATOR] In ${info.setting}, a tale was about to unfold. [neutral]
[${info.characters[1] || 'HERO'}] I must answer this call! [excited]
[NARRATOR] The journey had begun. [neutral]`
  }));
  res.json({ stories: templateStories, count: templateStories.length });
});

/**
 * Generate story — template-based (no external AI needed)
 */
router.post('/generate', async (req, res) => {
  const {
    theme = 'fantasy',
    prompt = '',
    characters = ['NARRATOR', 'HERO', 'VILLAIN'],
    language = 'en'
  } = req.body;

  const template = STORY_TEMPLATES[theme] || STORY_TEMPLATES.fantasy;
  const charList = characters.length >= 2 ? characters : template.characters;

  // Build story from template + prompt
  const promptText = prompt || `a ${template.theme.toLowerCase()} story`;
  const storyContent = `[NARRATOR] In ${template.setting}, a tale was about to unfold. ${promptText}. [neutral]
[${charList[1] || 'HERO'}] I must answer this call to adventure! [excited]
[NARRATOR] The path ahead was uncertain, but the journey had begun. [neutral]
[${charList[2] || 'VILLAIN'}] You cannot stop what has already been set in motion. [dark]
[NARRATOR] And so the balance of fate hung in the air, waiting to tip one way or another. [neutral]`;

  res.json({
    success: true,
    story: {
      theme: template.theme,
      setting: template.setting,
      characters: charList,
      language,
      content: storyContent,
      wordCount: storyContent.split(/\s+/).length
    }
  });
});

/**
 * Parse story into segments
 */
function parseStorySegments(storyText) {
  const segments = [];
  const regex = /\[(\w+)\]\s*([^[]+)\[(\w+)\]/g;
  
  let match;
  while ((match = regex.exec(storyText)) !== null) {
    const [, character, text, emotion] = match;
    segments.push({
      character,
      text: text.trim(),
      emotion: emotion.toLowerCase(),
      type: 'dialogue'
    });
  }
  
  // If no segments found, treat entire text as narrator
  if (segments.length === 0) {
    segments.push({
      character: 'NARRATOR',
      text: storyText.trim(),
      emotion: 'neutral',
      type: 'dialogue'
    });
  }
  
  return segments;
}

/**
 * Narrate story with voice synthesis
 */
router.post('/narrate', async (req, res) => {
  const {
    content,
    storyUrl,
    voice = 'NARRATOR',
    language = 'en',
    speed = 1.0
  } = req.body;
  
  try {
    let storyText = content;
    
    if (storyUrl) {
      // Fetch story from URL
      const response = await axios.get(storyUrl);
      storyText = response.data;
    }
    
    if (!storyText) {
      return res.status(400).json({ error: 'content or storyUrl required' });
    }
    
    // Parse into segments
    const segments = parseStorySegments(storyText);
    
    // Get voice for character
    const kokoroVoice = CHARACTER_VOICES[voice] || CHARACTER_VOICES.NARRATOR;
    
    res.json({
      success: true,
      segments: segments.length,
      estimatedDuration: segments.length * 3, // ~3 seconds per segment
      sampleSegments: segments.slice(0, 3),
      voice: kokoroVoice,
      language,
      speed,
      message: `Story parsed into ${segments.length} segments. Use /api/kokoro/synthesize for each segment.`
    });
    
  } catch (error) {
    console.error('Story narration error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Narrate story — returns parsed segments for client-side TTS
 * (No Kokoro needed — client uses browser SpeechSynthesis)
 */
router.get('/templates', (req, res) => {
  res.json({
    templates: Object.entries(STORY_TEMPLATES).map(([id, info]) => ({
      id,
      ...info
    }))
  });
});

module.exports = router;