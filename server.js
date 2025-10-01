const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR);
}

// Endpoint para descargar un VOD
app.post('/download-vod', (req, res) => {
  const { vodUrl, fileName } = req.body;

  if (!vodUrl) {
    return res.status(400).json({ error: 'vodUrl is required' });
  }

  const safeFileName = fileName ? fileName : 'vod.mp4';
  const outputPath = path.join(DOWNLOAD_DIR, safeFileName);

  // Ejecutar yt-dlp
  const command = `yt-dlp ${vodUrl} -o "${outputPath}"`;

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error('yt-dlp error:', stderr);
      return res.status(500).json({ error: stderr });
    }
    console.log('yt-dlp output:', stdout);
    res.json({
      message: 'Download complete',
      path: outputPath,
    });
  });
});

// Servir los archivos descargados
app.get('/vod/:fileName', (req, res) => {
  const filePath = path.join(DOWNLOAD_DIR, req.params.fileName);
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Twitch downloader API running on port ${PORT}`);
});
