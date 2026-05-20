/**
 * Story Narrator Enhanced - Main Entry Point
 * Multi-TTS: Kokoro-82M + ElevenLabs + XTTS Celebrity voices
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const kokoroRoutes = require('./routes/kokoro');
const epubRoutes = require('./routes/epub');
const celebrityRoutes = require('./routes/celebrity');
const voiceRoutes = require('./routes/voice');
const storyRoutes = require('./routes/story');

const app = express();
const PORT = process.env.PORT || 8080;

// Security middleware
app.use(helmet());
app.use(cors());

// Rate limiting
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/api/', limiter);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'story-narrator-enhanced',
    version: '2.0.0',
    tts_providers: ['kokoro', 'elevenlabs', 'xtts']
  });
});

// Routes
app.use('/api/kokoro', kokoroRoutes);
app.use('/api/epub', epubRoutes);
app.use('/api/celebrity', celebrityRoutes);
app.use('/api/voices', voiceRoutes);
app.use('/api/story', storyRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Story Narrator Enhanced',
    version: '2.0.0',
    endpoints: {
      health: 'GET /health',
      kokoro_tts: 'POST /api/kokoro/synthesize',
      epub_audiobook: 'POST /api/epub/convert',
      celebrity_voice: 'POST /api/celebrity/synthesize',
      voices: 'GET /api/voices',
      story_generate: 'POST /api/story/generate',
      story_narrate: 'POST /api/story/narrate'
    }
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Story Narrator Enhanced running on port ${PORT}`);
});

module.exports = app;