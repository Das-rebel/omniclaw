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
 * Generate story using Claude
 */
router.post('/generate', async (req, res) => {
  const {
    theme = 'Fantasy Adventure',
    setting = 'A magical kingdom',
    plotOutline,
    characters = ['NARRATOR', 'HERO', 'VILLAIN'],
    language = 'en'
  } = req.body;
  
  try {
    // Call Claude for story generation
    const anthropic = require('@anthropic-ai/sdk');
    const client = new anthropic();
    
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Generate a short story (about 500 words) with the following elements:
        
Theme: ${theme}
Setting: ${setting}
${plotOutline ? `Plot: ${plotOutline}` : ''}
Characters: ${characters.join(', ')}

Format the story with character markers like [NARRATOR], [HERO], [VILLAIN] etc.
Include emotion tags like [neutral], [excited], [sad], [angry], [whisper].
Make it engaging and suitable for audio narration.

Output format example:
[NARRATOR] The adventure begins in a mystical land. [neutral]
[HERO] I must find the ancient artifact! [excited]
[NARRATOR] The hero journeyed forth into the unknown. [neutral]`
      }]
    });
    
    const storyText = message.content[0].text;
    
    res.json({
      success: true,
      story: {
        theme,
        setting,
        characters,
        language,
        content: storyText,
        wordCount: storyText.split(/\s+/).length
      }
    });
    
  } catch (error) {
    console.error('Story generation error:', error);
    res.status(500).json({ error: error.message });
  }
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
 * Synthesize entire story as audiobook
 */
router.post('/synthesize-story', async (req, res) => {
  const { storyText, voice = 'NARRATOR', language = 'en', speed = 1.0 } = req.body;
  
  if (!storyText) {
    return res.status(400).json({ error: 'storyText required' });
  }
  
  try {
    // Parse story
    const segments = parseStorySegments(storyText);
    const kokoroVoice = CHARACTER_VOICES[voice] || CHARACTER_VOICES.NARRATOR;
    
    // Synthesize each segment via Kokoro
    const synthesisResults = [];
    
    for (const segment of segments) {
      try {
        const response = await axios.post(
          'http://localhost:8081/synthesize',
          {
            text: segment.text,
            voice: kokoroVoice,
            speed,
            language
          },
          { timeout: 10000 }
        );
        
        synthesisResults.push({
          ...segment,
          audio: response.data.audio,
          success: true
        });
      } catch (error) {
        synthesisResults.push({
          ...segment,
          audio: null,
          success: false,
          error: error.message
        });
      }
    }
    
    res.json({
      success: true,
      totalSegments: synthesisResults.length,
      successfulSyntheses: synthesisResults.filter(s => s.success).length,
      results: synthesisResults
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get story templates
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