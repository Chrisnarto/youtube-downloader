const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const app = express();
app.use(cors());
app.use(express.json());

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR);
}

// Convert TS to MP4 using ffmpeg-static with multiple strategies
async function convertTsToMp4(inputPath, outputPath) {
  // Strategy 1: Fast copy (no re-encoding)
  try {
    console.log(`🔄 Trying fast conversion (copy streams): ${inputPath} -> ${outputPath}`);
    await runFFmpeg(inputPath, outputPath, [
      '-i', inputPath,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-y',
      outputPath
    ]);
    console.log('✅ Fast MP4 conversion successful');
    return;
  } catch (error) {
    console.warn('⚠️ Fast conversion failed, trying re-encoding...', error.message);
  }

  // Strategy 2: Re-encode with compatible codecs
  try {
    console.log(`🔄 Trying re-encoding conversion: ${inputPath} -> ${outputPath}`);
    await runFFmpeg(inputPath, outputPath, [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-preset', 'fast',
      '-crf', '23',
      '-avoid_negative_ts', 'make_zero',
      '-y',
      outputPath
    ]);
    console.log('✅ Re-encoding MP4 conversion successful');
    return;
  } catch (error) {
    console.warn('⚠️ Re-encoding conversion failed, trying basic conversion...', error.message);
  }

  // Strategy 3: Basic conversion with minimal options
  try {
    console.log(`🔄 Trying basic conversion: ${inputPath} -> ${outputPath}`);
    await runFFmpeg(inputPath, outputPath, [
      '-i', inputPath,
      '-f', 'mp4',
      '-y',
      outputPath
    ]);
    console.log('✅ Basic MP4 conversion successful');
    return;
  } catch (error) {
    console.error('❌ All conversion strategies failed');
    throw new Error(`All FFmpeg conversion strategies failed. Last error: ${error.message}`);
  }
}

// Helper function to run FFmpeg with detailed diagnostics
function runFFmpeg(inputPath, outputPath, args) {
  return new Promise((resolve, reject) => {
    console.log(`🔧 FFmpeg command: ${ffmpegPath} ${args.join(' ')}`);
    
    // Check if input file exists and get info
    if (!fs.existsSync(inputPath)) {
      reject(new Error(`Input file does not exist: ${inputPath}`));
      return;
    }
    
    const inputStats = fs.statSync(inputPath);
    console.log(`📁 Input file size: ${inputStats.size} bytes`);
    
    // Check if ffmpeg-static is available
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      reject(new Error(`FFmpeg binary not found at: ${ffmpegPath}`));
      return;
    }
    
    console.log(`🔧 Using FFmpeg binary: ${ffmpegPath}`);
    
    const ffmpeg = spawn(ffmpegPath, args);
    let stderr = '';
    let stdout = '';
    
    ffmpeg.stdout.on('data', (data) => {
      const output = data.toString();
      stdout += output;
      // Log progress info
      if (output.includes('frame=') || output.includes('time=')) {
        console.log(`📊 FFmpeg progress: ${output.trim()}`);
      }
    });
    
    ffmpeg.stderr.on('data', (data) => {
      const error = data.toString();
      stderr += error;
      // Log detailed error info in real-time
      console.log(`🔍 FFmpeg stderr: ${error.trim()}`);
    });

    ffmpeg.on('close', (code) => {
      console.log(`🏁 FFmpeg process finished with exit code: ${code}`);
      
      if (code === 0) {
        // Check if output file was actually created
        if (fs.existsSync(outputPath)) {
          const outputStats = fs.statSync(outputPath);
          console.log(`✅ Output file created: ${outputStats.size} bytes`);
          
          if (outputStats.size === 0) {
            reject(new Error('Output file was created but is empty (0 bytes)'));
            return;
          }
          
          resolve();
        } else {
          reject(new Error('FFmpeg reported success but output file was not created'));
        }
      } else {
        console.error(`❌ FFmpeg failed with exit code ${code}`);
        console.error(`❌ Full stderr output: ${stderr}`);
        console.error(`❌ Full stdout output: ${stdout}`);
        
        // Analyze common error patterns
        let errorAnalysis = 'Unknown FFmpeg error';
        if (stderr.includes('Invalid data found when processing input')) {
          errorAnalysis = 'Input TS file appears to be corrupted or invalid';
        } else if (stderr.includes('No space left on device')) {
          errorAnalysis = 'Insufficient disk space for conversion';
        } else if (stderr.includes('Permission denied')) {
          errorAnalysis = 'Permission denied writing output file';
        } else if (stderr.includes('moov atom not found')) {
          errorAnalysis = 'Input file is incomplete or corrupted';
        }
        
        reject(new Error(`FFmpeg conversion failed (${errorAnalysis}): Exit code ${code}. Error: ${stderr}`));
      }
    });

    ffmpeg.on('error', (error) => {
      console.error('❌ FFmpeg spawn error:', error);
      reject(new Error(`Failed to start FFmpeg process: ${error.message}`));
    });

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      console.error('⏰ FFmpeg conversion timeout - killing process');
      ffmpeg.kill('SIGKILL');
      reject(new Error('FFmpeg conversion timeout (5 minutes)'));
    }, 5 * 60 * 1000);
    
    // Clear timeout if process finishes normally
    ffmpeg.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

// Diagnose TS file to check if it's valid
async function diagnoseTsFile(tsPath) {
  try {
    console.log(`🔍 Diagnosing TS file: ${tsPath}`);
    
    // Check file size
    const stats = fs.statSync(tsPath);
    console.log(`📊 TS file size: ${stats.size} bytes`);
    
    if (stats.size === 0) {
      console.error('❌ TS file is empty!');
      return;
    }
    
    // Read first few bytes to check TS packet structure
    const buffer = Buffer.alloc(188 * 3); // Read first 3 TS packets
    const fd = fs.openSync(tsPath, 'r');
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    
    console.log(`📖 Read ${bytesRead} bytes from TS file`);
    
    // Check for TS packet sync bytes (0x47)
    let validPackets = 0;
    for (let i = 0; i < bytesRead; i += 188) {
      if (buffer[i] === 0x47) {
        validPackets++;
      }
    }
    
    console.log(`✅ Found ${validPackets} valid TS packets out of ${Math.floor(bytesRead / 188)} expected`);
    
    if (validPackets === 0) {
      console.error('❌ No valid TS packets found - file may be corrupted');
    } else if (validPackets < Math.floor(bytesRead / 188)) {
      console.warn(`⚠️ Some TS packets are invalid (${validPackets}/${Math.floor(bytesRead / 188)})`);
    } else {
      console.log('✅ TS file appears to have valid packet structure');
    }
    
    // Use FFmpeg to probe the file
    console.log('🔍 Probing TS file with FFmpeg...');
    await new Promise((resolve, reject) => {
      const ffprobe = spawn(ffmpegPath, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        tsPath
      ]);
      
      let stdout = '';
      let stderr = '';
      
      ffprobe.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      ffprobe.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      ffprobe.on('close', (code) => {
        if (code === 0 && stdout) {
          try {
            const info = JSON.parse(stdout);
            console.log('📊 TS file info:');
            console.log(`   Format: ${info.format?.format_name || 'unknown'}`);
            console.log(`   Duration: ${info.format?.duration || 'unknown'} seconds`);
            console.log(`   Bitrate: ${info.format?.bit_rate || 'unknown'} bps`);
            console.log(`   Streams: ${info.streams?.length || 0}`);
            
            info.streams?.forEach((stream, index) => {
              console.log(`   Stream ${index}: ${stream.codec_type} (${stream.codec_name})`);
            });
            
            if (info.streams?.length === 0) {
              console.error('❌ No streams found in TS file');
            }
          } catch (parseError) {
            console.warn('⚠️ Could not parse FFprobe output:', parseError.message);
          }
        } else {
          console.warn(`⚠️ FFprobe failed with code ${code}: ${stderr}`);
        }
        resolve();
      });
      
      ffprobe.on('error', (error) => {
        console.warn('⚠️ FFprobe error:', error.message);
        resolve(); // Don't fail the whole process
      });
    });
    
  } catch (error) {
    console.warn('⚠️ TS file diagnosis failed:', error.message);
  }
}

// Extract M3U8 URL from Twitch video page
async function extractTwitchM3U8(twitchUrl) {
  try {
    console.log(`🔍 Extracting M3U8 from Twitch page: ${twitchUrl}`);
    
    // Check if it's already an M3U8 URL
    if (twitchUrl.includes('.m3u8')) {
      console.log('✅ URL is already an M3U8 stream');
      return twitchUrl;
    }
    
    // Extract video ID from Twitch URL
    let videoId = null;
    
    // Handle different Twitch URL formats
    if (twitchUrl.includes('twitch.tv/videos/')) {
      // https://www.twitch.tv/videos/123456789
      const match = twitchUrl.match(/\/videos\/(\d+)/);
      videoId = match ? match[1] : null;
    } else if (twitchUrl.includes('twitch.tv/') && twitchUrl.includes('/v/')) {
      // https://www.twitch.tv/username/v/123456789
      const match = twitchUrl.match(/\/v\/(\d+)/);
      videoId = match ? match[1] : null;
    } else if (twitchUrl.match(/^\d+$/)) {
      // Just the video ID number
      videoId = twitchUrl;
    }
    
    if (!videoId) {
      throw new Error('Could not extract video ID from Twitch URL. Supported formats: twitch.tv/videos/123456789');
    }
    
    console.log(`📹 Extracted video ID: ${videoId}`);
    
    // Get video info from Twitch API (using public endpoints)
    console.log('🔍 Fetching video information...');
    
    // Try to get the M3U8 URL using Twitch's public API patterns
    // Note: This is a simplified approach - real Twitch extraction is more complex
    const possibleM3U8Urls = [
      `https://usher.ttvnw.net/vod/${videoId}.m3u8`,
      `https://usher.ttvnw.net/vod/${videoId}?allow_source=true&allow_audio_only=true&allow_spectre=false&player=twitchweb&playlist_include_framerate=true&reassignments_supported=true&supported_codecs=avc1&token=&sig=`,
    ];
    
    for (const m3u8Url of possibleM3U8Urls) {
      try {
        console.log(`🔍 Trying M3U8 URL: ${m3u8Url}`);
        
        const response = await axios.head(m3u8Url, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Accept': 'application/x-mpegURL, application/vnd.apple.mpegurl, application/json, text/plain'
          }
        });
        
        if (response.status === 200) {
          console.log(`✅ Found working M3U8 URL: ${m3u8Url}`);
          return m3u8Url;
        }
      } catch (error) {
        console.log(`❌ M3U8 URL failed: ${error.message}`);
        continue;
      }
    }
    
    // Alternative: Try to scrape the page for M3U8 URLs
    console.log('🔍 Attempting to scrape page for M3U8 URLs...');
    
    try {
      const pageResponse = await axios.get(twitchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        },
        timeout: 15000
      });
      
      const pageContent = pageResponse.data;
      
      // Look for M3U8 URLs in the page content
      const m3u8Matches = pageContent.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/g);
      
      if (m3u8Matches && m3u8Matches.length > 0) {
        console.log(`🎯 Found ${m3u8Matches.length} M3U8 URLs in page`);
        
        // Try each M3U8 URL found
        for (const m3u8Url of m3u8Matches) {
          try {
            const testResponse = await axios.head(m3u8Url, {
              timeout: 5000,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
              }
            });
            
            if (testResponse.status === 200) {
              console.log(`✅ Working M3U8 URL found: ${m3u8Url}`);
              return m3u8Url;
            }
          } catch (testError) {
            continue;
          }
        }
      }
    } catch (scrapeError) {
      console.warn('⚠️ Page scraping failed:', scrapeError.message);
    }
    
    throw new Error(`Could not extract M3U8 URL from Twitch video ${videoId}. The video may be private, deleted, or require authentication.`);
    
  } catch (error) {
    throw new Error(`Twitch M3U8 extraction failed: ${error.message}`);
  }
}

// Simple HLS downloader que SÍ funciona
async function downloadHLS(m3u8Url, outputPath) {
  try {
    console.log('🔍 Parsing M3U8 playlist...');
    
    // Get the M3U8 playlist
    const response = await axios.get(m3u8Url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    
    const playlist = response.data;
    console.log('📄 M3U8 content preview:', playlist.split('\n').slice(0, 5).join('\n'));
    
    // Extract segment URLs
    const lines = playlist.split('\n');
    const segments = [];
    const baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    
    // Check if this is a master playlist
    const isMasterPlaylist = lines.some(line => line.includes('#EXT-X-STREAM-INF'));
    
    if (isMasterPlaylist) {
      console.log('📋 Master playlist detected, getting first stream...');
      // Find first stream URL
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('#EXT-X-STREAM-INF')) {
          const streamUrl = lines[i + 1];
          if (streamUrl && !streamUrl.startsWith('#')) {
            const fullStreamUrl = streamUrl.startsWith('http') ? streamUrl : baseUrl + streamUrl;
            console.log('🔄 Recursively downloading stream:', fullStreamUrl);
            return await downloadHLS(fullStreamUrl, outputPath);
          }
        }
      }
    }
    
    // Extract segment URLs from media playlist
    for (let line of lines) {
      if (line && !line.startsWith('#') && line.trim().length > 0) {
        const segmentUrl = line.startsWith('http') ? line : baseUrl + line;
        segments.push(segmentUrl);
      }
    }
    
    console.log(`📦 Found ${segments.length} segments to download`);
    
    if (segments.length === 0) {
      throw new Error('No segments found in playlist');
    }
    
    // Download segments and write directly to file
    const writeStream = fs.createWriteStream(outputPath);
    let downloadedSegments = 0;
    
    for (let i = 0; i < segments.length; i++) {
      try {
        console.log(`⬇️ Downloading segment ${i + 1}/${segments.length}...`);
        
        const segmentResponse = await axios.get(segments[i], {
          responseType: 'stream',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          }
        });
        
        // Pipe segment directly to file
        await new Promise((resolve, reject) => {
          segmentResponse.data.pipe(writeStream, { end: false });
          segmentResponse.data.on('end', resolve);
          segmentResponse.data.on('error', reject);
        });
        
        downloadedSegments++;
        
      } catch (segmentError) {
        console.warn(`⚠️ Segment ${i + 1} failed:`, segmentError.message);
        // Continue with next segment
      }
    }
    
    writeStream.end();
    
    await new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });
    
    console.log(`✅ Downloaded ${downloadedSegments}/${segments.length} segments successfully`);
    
    if (downloadedSegments === 0) {
      throw new Error('No segments were downloaded successfully');
    }
    
    return downloadedSegments;
    
  } catch (error) {
    throw new Error(`HLS download failed: ${error.message}`);
  }
}

// Endpoint que descarga HLS y convierte automáticamente a MP4
app.post('/download-vod', async (req, res) => {
  const { vodUrl, fileName } = req.body;

  if (!vodUrl) {
    return res.status(400).json({ error: 'vodUrl is required' });
  }

  // Generate filenames
  let baseFileName = fileName;
  if (!baseFileName) {
    const timestamp = Date.now();
    const urlPart = vodUrl.split('/').pop().replace('.m3u8', '') || 'video';
    baseFileName = `${urlPart}_${timestamp}`;
  } else {
    baseFileName = baseFileName.replace(/\.[^/.]+$/, '');
  }

  const tsFileName = `${baseFileName}.ts`;
  const mp4FileName = `${baseFileName}.mp4`;
  const tsPath = path.join(DOWNLOAD_DIR, tsFileName);
  const mp4Path = path.join(DOWNLOAD_DIR, mp4FileName);

  try {
    console.log(`🎬 Starting video download from: ${vodUrl}`);
    console.log(`📁 Temporary TS file: ${tsPath}`);
    console.log(`🎯 Final MP4 file: ${mp4Path}`);

    // Step 1: Extract M3U8 URL if it's a Twitch page
    let m3u8Url = vodUrl;
    if (vodUrl.includes('twitch.tv') && !vodUrl.includes('.m3u8')) {
      console.log('🔍 Detected Twitch page URL, extracting M3U8...');
      m3u8Url = await extractTwitchM3U8(vodUrl);
      console.log(`✅ Extracted M3U8 URL: ${m3u8Url}`);
    }

    // Step 2: Download HLS to TS file
    const downloadedSegments = await downloadHLS(m3u8Url, tsPath);
    
    // Verify TS file was created
    if (!fs.existsSync(tsPath)) {
      throw new Error('TS file was not created');
    }

    const tsStats = fs.statSync(tsPath);
    console.log(`✅ TS download complete: ${tsStats.size} bytes`);
    
    // Diagnose TS file quality
    await diagnoseTsFile(tsPath);

    // Step 3: Try to convert TS to MP4
    let finalPath = mp4Path;
    let finalFileName = mp4FileName;
    let finalFormat = 'MP4';
    let conversionSuccess = false;
    
    try {
      console.log(`🔄 Converting to MP4...`);
      await convertTsToMp4(tsPath, mp4Path);

      // Verify MP4 file was created
      if (fs.existsSync(mp4Path)) {
        const mp4Stats = fs.statSync(mp4Path);
        console.log(`✅ MP4 conversion complete: ${mp4Stats.size} bytes`);
        conversionSuccess = true;
        
        // Clean up temporary TS file
        try {
          fs.unlinkSync(tsPath);
          console.log(`🗑️ Cleaned up temporary TS file`);
        } catch (cleanupError) {
          console.warn('Could not clean up TS file:', cleanupError.message);
        }
      }
    } catch (conversionError) {
      console.warn(`⚠️ MP4 conversion failed: ${conversionError.message}`);
      console.log(`📁 Falling back to TS file as final output`);
      
      // Use TS file as final output
      finalPath = tsPath;
      finalFileName = tsFileName;
      finalFormat = 'TS';
      conversionSuccess = false;
    }

    const finalStats = fs.statSync(finalPath);
    console.log(`🎉 SUCCESS! Video ready: ${finalPath} (${finalFormat})`);

    const response = { 
      message: conversionSuccess 
        ? '✅ Video downloaded and converted to MP4 successfully'
        : '✅ Video downloaded as TS (MP4 conversion failed but TS works perfectly)',
      path: finalPath,
      filename: finalFileName,
      size: finalStats.size,
      format: finalFormat,
      segments_downloaded: downloadedSegments,
      method: conversionSuccess 
        ? 'HLS download + FFmpeg conversion'
        : 'HLS download (conversion fallback)',
      playback_info: conversionSuccess 
        ? {
            note: 'Ready to play in any video player',
            compatible_with: 'All browsers, mobile devices, media players'
          }
        : {
            note: 'TS file works perfectly in VLC Media Player',
            how_to_play: 'Open with VLC, MPV, or any media player that supports TS',
            convert_manually: `ffmpeg -i "${finalFileName}" -c copy "${finalFileName.replace('.ts', '.mp4')}"`
          }
    };

    if (conversionSuccess) {
      response.conversion_info = {
        original_ts_size: tsStats.size,
        final_mp4_size: finalStats.size,
        compression_ratio: ((tsStats.size - finalStats.size) / tsStats.size * 100).toFixed(1) + '%'
      };
    }

    res.json(response);

  } catch (error) {
    console.error('❌ Error in download/conversion process:', error.message);
    
    // Clean up any partial files
    [tsPath, mp4Path].forEach(filePath => {
      if (fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`🗑️ Cleaned up partial file: ${path.basename(filePath)}`);
        } catch (cleanupError) {
          console.warn('Could not clean up file:', cleanupError.message);
        }
      }
    });
    
    res.status(500).json({ 
      error: error.message,
      note: 'HLS download or MP4 conversion failed',
      possible_causes: [
        'Invalid or expired Twitch video URL',
        'Video is private, deleted, or subscriber-only',
        'Network connectivity issues',
        'Twitch anti-bot protection',
        'FFmpeg conversion error',
        'Insufficient disk space'
      ],
      suggestions: [
        'Verify the Twitch video URL is public and accessible',
        'Try a different video or check if it requires login',
        'Ensure the video ID is correct in the URL'
      ]
    });
  }
});

// Serve downloaded files
app.get('/vod/:fileName', (req, res) => {
  const filePath = path.join(DOWNLOAD_DIR, req.params.fileName);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'HLS to MP4 Downloader API is running',
    method: 'Direct HLS download + FFmpeg conversion',
    output_format: 'MP4 (Universal compatibility)',
    features: [
      'Downloads HLS streams',
      'Automatic TS to MP4 conversion', 
      'Uses ffmpeg-static (no system dependencies)',
      'Cleans up temporary files'
    ]
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 HLS to MP4 Downloader API running on port ${PORT}`);
  console.log(`📁 Downloads will be saved to: ${DOWNLOAD_DIR}`);
  console.log(`🎯 Automatically converts HLS streams to MP4 format`);
  console.log(`⚡ Uses ffmpeg-static for reliable conversion`);
});