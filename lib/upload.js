const fs = require('fs')
const path = require('path')

/**
 * Upload file ke CDN svazer-upload.vercel.app
 * @param {Buffer|string} input - Buffer data atau path file
 * @param {string} filename - Nama file (opsional, default dari path)
 * @param {string} mimetype - MIME type (opsional, auto-detect dari ext)
 * @returns {Promise<{status: boolean, url: string, size: number, mimetype: string}>}
 */
async function upload(input, filename, mimetype) {
  let buffer, name

  if (Buffer.isBuffer(input)) {
    buffer = input
    name = filename || 'file'
  } else if (typeof input === 'string' && fs.existsSync(input)) {
    buffer = fs.readFileSync(input)
    name = filename || path.basename(input)
  } else {
    throw new Error('Input harus Buffer atau path file yang valid')
  }

  if (!mimetype) {
    mimetype = guessMime(name)
  }

  let formData = new FormData()
  formData.append('file', new Blob([buffer], { type: mimetype }), name)

  let res = await fetch('https://svazer-upload.vercel.app/api/upload', {
    method: 'POST',
    body: formData
  })
  let data = await res.json()

  if (!data.success || !data.url) {
    throw new Error('Upload gagal: ' + JSON.stringify(data))
  }

  return {
    status: true,
    url: data.url,
    size: data.size,
    mimetype: data.mimetype || mimetype
  }
}

function guessMime(filename) {
  let ext = path.extname(filename).toLowerCase()
  let map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.avi': 'video/avi',
    '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
    '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
    '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.js': 'text/javascript', '.json': 'application/json',
    '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css',
    '.py': 'text/x-python', '.sh': 'text/x-shellscript'
  }
  return map[ext] || 'application/octet-stream'
}

module.exports = { upload, guessMime }
