/**
 * Nano Banana Image Generator - OmniClaw
 * Uses Google Gemini API key (from ~/.pi/agent/auth.json)
 * 
 * Usage:
 *   node nanobanana_image_client.js "A cute nano banana character"
 */

const https = require('https');

// API key from treequest config
const API_KEY = 'AIzaSyCenXB_6YztrrV-Uzt2cxTcc97o0fYMzvI';

const MODELS = {
  'nano-banana-2': 'nano-banana-2',
  'nano-banana-pro': 'nano-banana-pro-preview',
  'gemini-3.1-flash-image': 'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash-image': 'gemini-2.5-flash-image',
  'gemini-3-pro-image': 'gemini-3-pro-image-preview',
};

async function generateImage(prompt, model = 'nano-banana-pro-preview') {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  
  const data = JSON.stringify({
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE']
    }
  });

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.error) {
            resolve({ success: false, error: parsed.error.message, code: parsed.error.code });
          } else {
            // Check for image in response
            const imageParts = parsed.candidates?.[0]?.content?.parts?.filter(p => p.inlineData);
            if (imageParts?.length > 0) {
              const img = imageParts[0].inlineData;
              resolve({
                success: true,
                imageData: img.data,
                mimeType: img.mimeType,
                model
              });
            } else {
              // Text response (possibly queued or no image generated)
              const text = parsed.candidates?.[0]?.content?.parts?.map(p => p.text).join('');
              resolve({ success: true, text, model, noImage: true });
            }
          }
        } catch (e) {
          reject(new Error(`Parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

async function generateImageV1(prompt, model = 'nano-banana-pro-preview') {
  // Use v1 API 
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  
  const parts = [{ text: prompt }];
  
  const data = JSON.stringify({
    contents: [{ parts }],
    config: {
     _responseOptions: {
        responseMimeType: 'image/png'
      }
    }
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent?key=${API_KEY}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log(`Status: ${res.statusCode}, Body length: ${body.length}`);
        try {
          const parsed = JSON.parse(body);
          console.log(JSON.stringify(parsed, null, 2).slice(0, 2000));
          resolve(parsed);
        } catch (e) {
          console.log(`Raw response: ${body.slice(0, 500)}`);
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

// Test
async function main() {
  const prompt = process.argv[2] || 'A cute cartoon nano banana character holding a tiny sword, simple flat design, yellow background';
  const model = process.argv[3] || 'nano-banana-pro-preview';
  
  console.log(`Generating image with model: ${model}`);
  console.log(`Prompt: ${prompt}`);
  
  try {
    const result = await generateImageV1(prompt, model);
    console.log('Result:', JSON.stringify(result, null, 2).slice(0, 1000));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

if (require.main === module) {
  main();
}

module.exports = { generateImage, generateImageV1 };