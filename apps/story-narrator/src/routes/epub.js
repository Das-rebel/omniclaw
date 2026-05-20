/**
 * EPUB Routes - Convert EPUB to Audiobook
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs').promises;
const { spawn } = require('child_process');

// Celebrity voice to Kokoro voice mapping
const CELEBRITY_VOICES = {
  'morgan_freeman': 'bm_daniel',  // Deep male voice
  'tom_cruise': 'am_michael',     // Energetic male
  'amitabh_bachchan': 'hm_rahul',  // Hindi male
  'shah_rukh_khan': 'hm_arpit',    // Hindi male romantic
  'sandra_bullock': 'af_nicole',  // Female voice
  'alia_bhatt': 'hf_priya'        // Hindi female
};

// Archetype to voice mapping
const ARCHETYPE_VOICES = {
  'narrator': 'bm_daniel',
  'hero': 'am_michael',
  'villain': 'am_anthony',
  'wise_elder': 'bm_george',
  'romantic': 'hm_arpit',
  'female_lead': 'hf_priya',
  'comic': 'am_fenris'
};

/**
 * Parse EPUB and extract content
 */
async function parseEPUB(epubPath) {
  // Use Python epublib for parsing
  const pythonScript = `
import sys
import json
try:
    from ebooklib import epub
    from bs4 import BeautifulSoup
    
    book = epub.read_epub(sys.argv[1])
    chapters = []
    
    for item in book.get_items():
        if item.get_type() == 9:  # HTML
            soup = BeautifulSoup(item.get_content(), 'html.parser')
            text = soup.get_text(separator=' ', strip=True)
            if len(text) > 100:  # Skip very short sections
                chapters.append({
                    'title': soup.title.string if soup.title else 'Chapter',
                    'content': text
                })
    
    print(json.dumps(chapters))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;
  
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-c', pythonScript, epubPath]);
    let output = '';
    
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', d => console.error('EPUB parse error:', d.toString()));
    proc.on('close', code => {
      if (code === 0) {
        try { resolve(JSON.parse(output)); }
        catch { resolve([]); }
      } else {
        resolve([]);
      }
    });
  });
}

/**
 * Convert EPUB to audiobook segments
 */
router.post('/convert', async (req, res) => {
  const { 
    epubUrl, 
    epubPath,
    voice = 'narrator', 
    language = 'en',
    speed = 1.0,
    maxLength = 5000  // Max chars per segment
  } = req.body;
  
  let epubBuffer = null;
  let localPath = null;
  
  try {
    // Download or use local file
    if (epubUrl) {
      const axios = require('axios');
      const response = await axios.get(epubUrl, { responseType: 'arraybuffer' });
      epubBuffer = response.data;
    } else if (epubPath) {
      epubBuffer = await fs.readFile(epubPath);
    } else {
      return res.status(400).json({ error: 'epubUrl or epubPath required' });
    }
    
    // Save temp file
    const tempDir = '/tmp/epub-convert';
    await fs.mkdir(tempDir, { recursive: true });
    localPath = path.join(tempDir, `book_${Date.now()}.epub`);
    await fs.writeFile(localPath, epubBuffer);
    
    // Parse EPUB
    const chapters = await parseEPUB(localPath);
    
    if (!chapters || chapters.length === 0) {
      return res.status(400).json({ error: 'No content found in EPUB' });
    }
    
    // Get voice for archetype
    const kokoroVoice = ARCHETYPE_VOICES[voice] || ARCHETYPE_VOICES.narrator;
    
    // Split chapters into segments
    const segments = [];
    let segmentId = 0;
    
    for (const chapter of chapters) {
      const content = chapter.content;
      const title = chapter.title;
      
      // Split into manageable chunks
      const sentences = content.split(/(?<=[.!?])\s+/);
      let currentSegment = '';
      
      for (const sentence of sentences) {
        if ((currentSegment + ' ' + sentence).length > maxLength) {
          if (currentSegment) {
            segments.push({
              id: segmentId++,
              text: currentSegment.trim(),
              chapter: title,
              voice: kokoroVoice,
              language,
              speed
            });
            currentSegment = '';
          }
        } else {
          currentSegment = currentSegment ? `${currentSegment} ${sentence}` : sentence;
        }
      }
      
      // Flush remaining
      if (currentSegment) {
        segments.push({
          id: segmentId++,
          text: currentSegment.trim(),
          chapter: title,
          voice: kokoroVoice,
          language,
          speed
        });
      }
    }
    
    // Clean up temp file
    await fs.unlink(localPath).catch(() => {});
    
    res.json({
      success: true,
      chapters: chapters.length,
      segments: segments.length,
      sampleSegments: segments.slice(0, 5),
      voice: kokoroVoice,
      language,
      speed,
      message: `Ready to synthesize ${segments.length} segments`
    });
    
  } catch (error) {
    console.error('EPUB convert error:', error);
    res.status(500).json({ error: error.message });
  } finally {
    // Clean up
    if (localPath) {
      await fs.unlink(localPath).catch(() => {});
    }
  }
});

/**
 * Get EPUB metadata without full conversion
 */
router.post('/metadata', async (req, res) => {
  const { epubUrl, epubPath } = req.body;
  
  let localPath = null;
  
  try {
    if (epubUrl) {
      const axios = require('axios');
      const response = await axios.get(epubUrl, { responseType: 'arraybuffer' });
      const tempDir = '/tmp/epub-meta';
      await fs.mkdir(tempDir, { recursive: true });
      localPath = path.join(tempDir, `meta_${Date.now()}.epub`);
      await fs.writeFile(localPath, response.data);
    } else if (epubPath) {
      localPath = epubPath;
    } else {
      return res.status(400).json({ error: 'epubUrl or epubPath required' });
    }
    
    const pythonScript = `
import sys
import json
try:
    from ebooklib import epub
    
    book = epub.read_epub(sys.argv[1])
    meta = {
        'title': book.get_metadata('DC', 'title')[0][0] if book.get_metadata('DC', 'title') else 'Unknown',
        'author': book.get_metadata('DC', 'creator')[0][0] if book.get_metadata('DC', 'creator') else 'Unknown',
        'language': book.get_metadata('DC', 'language')[0][0] if book.get_metadata('DC', 'language') else 'en',
        'chapters': sum(1 for item in book.get_items() if item.get_type() == 9)
    }
    print(json.dumps(meta))
except Exception as e:
    print(json.dumps({'error': str(e)}))
`;
    
    const output = await new Promise((resolve, reject) => {
      const proc = spawn('python3', ['-c', pythonScript, localPath]);
      let data = '';
      proc.stdout.on('data', d => data += d.toString());
      proc.on('close', () => resolve(data));
    });
    
    const metadata = JSON.parse(output);
    res.json(metadata);
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  } finally {
    if (localPath && epubUrl) {
      await fs.unlink(localPath).catch(() => {});
    }
  }
});

module.exports = router;