/**
 * Gemini Multimodal Client
 * Handles interaction with Gemini 2.0 Flash for visual and audio analysis
 */

const axios = require('axios');

class GeminiClient {
  constructor(cookies = '') {
    this.apiKey = process.env.GOOGLE_API_KEY;
    this.groqKey = process.env.GROQ_API_KEY;
    this.cerebrasKey = process.env.CEREBRAS_API_KEY;
    this.endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
    this.groqEndpoint = 'https://api.groq.com/openai/v1/chat/completions';
    this.cerebrasEndpoint = 'https://api.cerebras.ai/v1/chat/completions';
    this.cookies = cookies;
    this.provider = 'gemini';
  }

  /**
   * Analyze media using raw bytes (direct upload to Gemini)
   * @param {Buffer} data - Raw media bytes
   * @param {string} mimeType - MIME type of the media
   * @param {string} caption - Accompanying text/caption
   */
  async analyzeMediaBytes(data, mimeType, caption = '') {
    if (!this.apiKey) {
      throw new Error('GOOGLE_API_KEY is not set in environment variables');
    }

    const prompt = `
      You are a world-class Visual Content Auditor and Curator. 
      Analyze the provided media asset (image or video) and the accompanying caption.
      
      Caption for context: "${caption}"
      
      Your goal is to extract high-fidelity structural knowledge for a personal knowledge graph.
      Provide the analysis in a strict JSON format with the following keys:
      - subject: A concise description of the main entity or theme (e.g., "Mid-century Modern Living Room", "Authentic Hyderabadi Biryani").
      - mood: The emotional or aesthetic tone (e.g., "Cinematic", "Gritty", "Minimalist", "Vibrant", "Nostalgic").
      - visual_tags: A list of 5-10 specific visual elements detected (e.g., "brass accents", "steaming rice", "neon lights", "bokeh background").
      - narrative_summary: A 1-2 sentence description of what is actually happening in the media.
      - aesthetic_score: A rating from 1-10 based on visual quality and composition.
      
      Return ONLY the JSON object. No markdown formatting, no preamble.
    `;

    try {
      const response = await axios.post(`${this.endpoint}?key=${this.apiKey}`, {
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: data.toString('base64')
                }
              }
            ]
          }
        ],
        generationConfig: {
          response_mime_type: 'application/json'
        }
      });

      const textResponse = response.data.candidates[0].content.parts[0].text;
      return JSON.parse(textResponse);
    } catch (error) {
      console.error('[GeminiClient] Analysis failed:', error.message);
      throw error;
    }
  }

  /**
   * Analyze text-only content (for Twitter posts without images)
   */
  async analyzeText(text, platform = 'twitter') {
    if (!this.apiKey && !this.groqKey) {
      throw new Error('No API keys available');
    }

    const escapedText = text.replace(/"/g, '\\"').substring(0, 500);
    const prompt = `
      You are a world-class Content Auditor and Curator.
      Analyze this ${platform} post and extract high-fidelity structural knowledge for a personal knowledge graph.
      Post content: "${escapedText}"
      
      Provide the analysis in a strict JSON format with the following keys:
      - subject: A concise description of the main entity or theme.
      - mood: The emotional or aesthetic tone (e.g., "Informative", "Enthusiastic", "Critical", "Neutral").
      - visual_tags: A list of 3-5 visual elements that could be inferred from this content if it were an image.
      - narrative_summary: A 1-2 sentence description of what this post conveys.
      - aesthetic_score: A rating from 1-10 for content quality and insightfulness.
      
      Return ONLY the JSON object. No markdown formatting, no preamble.
    `;

    // Try providers in order: Gemini -> Groq -> Cerebras (with retry)
    const providers = [];
    if (this.apiKey) providers.push({ name: 'gemini', call: () => this._callGemini(prompt) });
    if (this.groqKey) providers.push({ name: 'groq', call: () => this._callGroq(prompt) });
    if (this.cerebrasKey) providers.push({ name: 'cerebras', call: () => this._callCerebras(prompt) });

    for (let pi = 0; pi < providers.length; pi++) {
      const provider = providers[pi];
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) {
            const delay = attempt * 5000;
            console.log(`[GeminiClient] ${provider.name} retry ${attempt}/2, waiting ${delay/1000}s...`);
            await new Promise(r => setTimeout(r, delay));
          }
          const result = await provider.call();
          this.provider = provider.name;
          return result;
        } catch (err) {
          const status = err.response ? err.response.status : 0;
          if (status === 429 && pi < providers.length - 1) {
            console.log(`[GeminiClient] ${provider.name} rate-limited, trying next provider...`);
            break; // try next provider instead of retrying
          }
          if (status === 429 && attempt < 1) continue; // retry same provider
          if (pi === providers.length - 1 && attempt === 1) throw err; // last attempt
        }
      }
    }
    throw new Error('All providers exhausted');
  }

  async _callGemini(prompt) {
    const response = await axios.post(`${this.endpoint}?key=${this.apiKey}`, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { response_mime_type: 'application/json' }
    });
    return JSON.parse(response.data.candidates[0].content.parts[0].text);
  }

  async _callGroq(prompt) {
    const response = await axios.post(this.groqEndpoint, {
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    }, { headers: { 'Authorization': `Bearer ${this.groqKey}`, 'Content-Type': 'application/json' } });
    return JSON.parse(response.data.choices[0].message.content);
  }

  async _callCerebras(prompt) {
    const response = await axios.post(this.cerebrasEndpoint, {
      model: 'llama3.1-8b',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    }, { headers: { 'Authorization': `Bearer ${this.cerebrasKey}`, 'Content-Type': 'application/json' } });
    return JSON.parse(response.data.choices[0].message.content);
  }

  /**
   * Helper to convert URL to base64 for Gemini inline_data
   */
  async urlToBase64(url) {
    try {
      const response = await axios.get(url, { 
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://www.instagram.com/',
          'Cookie': this.cookies
        }
      });
      return Buffer.from(response.data, 'binary').toString('base64');
    } catch (error) {
      console.error(`[GeminiClient] Failed to download media from ${url}:`, error.message);
      throw error;
    }
  }
}

module.exports = { GeminiClient };
