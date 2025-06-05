// Enhanced WhatsApp bot with file sharing and YouTube download capabilities using Baileys
import pkg from "@whiskeysockets/baileys"
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = pkg
import readline from "readline"
import fs from "fs"
import path from "path"
import P from "pino"
import { exec } from "child_process"
import { promisify } from "util"
import crypto from "crypto"
import os from "os"

// YouTube downloader imports
import youtubedl from "youtube-dl-exec"
import sanitize from "sanitize-filename"

const execAsync = promisify(exec)

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

// User state management for file selection and search results
const userStates = new Map()

// Configuration
const WORKSPACE_PATH = "./files"
const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".pdf", ".txt", ".doc", ".docx", ".mp4", ".mp3"]
const YOUTUBE_API_KEY = "AIzaSyDVg1W8VQRSt8It1NF7yjufMiyKz4v2iX4" // Please use your own API key

// Storage management
// const MAX_STORAGE_MB = 1500 // MODIFIED: Removed workspace storage limit
// const CLEANUP_THRESHOLD_MB = 1200 // MODIFIED: Removed workspace cleanup threshold
const MIN_FREE_DISK_SPACE_MB = 1000 // Minimum free disk space required on the system

// Ensure workspace directory exists
if (!fs.existsSync(WORKSPACE_PATH)) {
  fs.mkdirSync(WORKSPACE_PATH, { recursive: true })
  console.log(`📁 Created workspace directory: ${WORKSPACE_PATH}`)
}

// Storage management functions
function getDirectorySize(dirPath) {
  let totalSize = 0
  try {
    const files = fs.readdirSync(dirPath)
    for (const file of files) {
      const filePath = path.join(dirPath, file)
      const stats = fs.statSync(filePath)
      if (stats.isFile()) {
        totalSize += stats.size
      }
    }
  } catch (error) {
    console.error("❌ Error calculating directory size:", error)
  }
  return totalSize
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
}

// Check system disk space
async function checkSystemDiskSpace() {
  try {
    const currentDir = process.cwd()
    const { stdout } = await execAsync(`df -k "${currentDir}"`)
    const lines = stdout.trim().split("\n")
    if (lines.length < 2) {
      throw new Error("Unexpected df output format")
    }
    const parts = lines[1].split(/\s+/)
    if (parts.length < 4) {
      throw new Error("Unexpected df output format")
    }
    const availableKB = Number.parseInt(parts[3], 10)
    const availableMB = availableKB / 1024
    return {
      available: availableMB,
      availableBytes: availableKB * 1024,
      formatted: formatBytes(availableKB * 1024),
    }
  } catch (error) {
    console.error("❌ Error checking disk space (df command):", error.message)
    try {
      const stats = fs.statfsSync(process.cwd())
      const availableBytes = stats.bavail * stats.bsize
      const availableMB = availableBytes / (1024 * 1024)
      return {
        available: availableMB,
        availableBytes: availableBytes,
        formatted: formatBytes(availableBytes),
      }
    } catch (fallbackError) {
      console.error("❌ Fallback disk space check failed:", fallbackError.message)
      // throw new Error("Could not determine available disk space") // MODIFIED: Don't throw, allow bot to attempt to run
      return { available: 0, availableBytes: 0, formatted: "0 B (Error)" }; // Return a default indicating an issue
    }
  }
}

async function cleanupOldFiles() {
  try {
    const currentSize = getDirectorySize(WORKSPACE_PATH)
    const currentSizeMB = currentSize / (1024 * 1024)

    console.log(`📊 Current workspace storage usage: ${formatBytes(currentSize)}`)

    const diskSpace = await checkSystemDiskSpace()
    console.log(`💾 System disk space available: ${diskSpace.formatted}`)

    const needsAggresiveCleaning = diskSpace.available < MIN_FREE_DISK_SPACE_MB

    // MODIFIED: Cleanup is now only triggered by low system disk space for the workspace files
    if (needsAggresiveCleaning) {
      console.log(`🧹 Starting cleanup of old files in workspace due to low system disk space... (Aggressive mode)`)

      const files = fs.readdirSync(WORKSPACE_PATH)
      const fileStats = files
        .map((file) => {
          const filePath = path.join(WORKSPACE_PATH, file)
          try { // Add try-catch for statSync
            const stats = fs.statSync(filePath)
            return {
              name: file,
              path: filePath,
              mtime: stats.mtime,
              size: stats.size,
            }
          } catch (statError) {
            console.error(`❌ Error getting stats for file ${filePath}: ${statError.message}`);
            return null; // Skip this file
          }
        })
        .filter(file => file !== null) // Remove null entries
        .sort((a, b) => a.mtime - b.mtime) // Sort by oldest first

      let deletedSize = 0
      let deletedCount = 0

      // Target size to free up based on system needs
      // Try to free up 50% of current workspace or enough to get above MIN_FREE_DISK_SPACE_MB + 200MB buffer, whichever is larger
      const targetFreeSizeMB = Math.max(currentSizeMB * 0.5, (MIN_FREE_DISK_SPACE_MB - diskSpace.available) + 200)
      console.log(`🎯 Target to free: ${formatBytes(targetFreeSizeMB * 1024 * 1024)}`)


      for (const file of fileStats) {
        // Stop if we've freed enough space OR if adding the current free space to what's deleted gets us comfortably above the minimum
        if (deletedSize / (1024 * 1024) >= targetFreeSizeMB || 
            (diskSpace.available + deletedSize / (1024 * 1024)) > MIN_FREE_DISK_SPACE_MB + 500) {
          break
        }

        try {
          fs.unlinkSync(file.path)
          deletedSize += file.size
          deletedCount++
          console.log(`🗑️ Deleted old file from workspace: ${file.name} (${formatBytes(file.size)})`)
        } catch (error) {
          console.error(`❌ Failed to delete ${file.name} from workspace:`, error.message)
        }
      }

      console.log(`✅ Workspace cleanup completed: ${deletedCount} files deleted, ${formatBytes(deletedSize)} freed`)

      const newDiskSpace = await checkSystemDiskSpace()
      console.log(`💾 System disk space after workspace cleanup: ${newDiskSpace.formatted}`)
    } else {
      console.log("✅ Sufficient system disk space. No workspace cleanup needed at this time.")
    }
  } catch (error) {
    console.error("❌ Workspace cleanup error:", error)
  }
}

// Clean up temporary files in system temp directory
async function cleanupTempFiles() {
  try {
    const tempDir = os.tmpdir()
    console.log(`🔍 Checking system temporary directory: ${tempDir}`)
    
    const commonPatterns = ["baileys*", "wa*", "whatsapp*", "*.mp4", "*.mp3", "*.jpg", "*.jpeg", "*.png", "youtube-dl*", "yt-dlp*"]
    let findCommand = `find "${tempDir}" -maxdepth 1 -type f \\( ` // Limit to current temp dir, not subdirs
    findCommand += commonPatterns.map(p => `-name "${p}"`).join(" -o ")
    findCommand += ` \\) -mtime -1 2>/dev/null || true` // Files modified in the last day

    const { stdout } = await execAsync(findCommand)

    if (!stdout.trim()) {
      console.log("✅ No relevant temporary files found in system temp")
      return 0
    }

    const files = stdout.trim().split("\n")
    let deletedCount = 0
    let deletedSize = 0

    for (const filePath of files) {
      if (!filePath) continue; // Skip empty lines if any
      try {
        const stats = fs.statSync(filePath)
        fs.unlinkSync(filePath)
        deletedSize += stats.size
        deletedCount++
        console.log(`🗑️ Deleted system temp file: ${path.basename(filePath)} (${formatBytes(stats.size)})`)
      } catch (error) {
        // console.warn(`⚠️ Could not delete temp file ${filePath}: ${error.message}`)
      }
    }

    if (deletedCount > 0) {
        console.log(`✅ System temp cleanup: ${deletedCount} files deleted, ${formatBytes(deletedSize)} freed`)
    } else {
        console.log("✅ No system temp files were deleted.")
    }
    return deletedCount
  } catch (error) {
    console.log(`⚠️ System temp cleanup skipped/failed: ${error.message}`)
    return 0
  }
}

function checkStorageSpace() { // MODIFIED: This function no longer enforces MAX_STORAGE_MB
  const currentSize = getDirectorySize(WORKSPACE_PATH)
  // const currentSizeMB = currentSize / (1024 * 1024) // Not strictly needed anymore for throwing error

  // if (currentSizeMB > MAX_STORAGE_MB) { // MODIFIED: Removed this check
  //   throw new Error(`Storage limit exceeded: ${formatBytes(currentSize)} / ${MAX_STORAGE_MB}MB`)
  // }

  return {
    used: currentSize,
    // usedMB: currentSizeMB, // Not strictly needed
    // available: MAX_STORAGE_MB * 1024 * 1024 - currentSize, // MODIFIED: Available in workspace is now effectively unlimited
  }
}

// Get user input for bot response
function getUserInput() {
  return new Promise((resolve) => {
    rl.question("Enter the default message for the bot (or press Enter for default): ", (answer) => {
      resolve(
        answer ||
          "Hello! I'm your WhatsApp bot! 🤖\n\nCommands:\n/files - Browse and download files\n/del <numbers> - Delete files\n/download <url> - Download file from URL\n/yt <youtube-url> - Download YouTube video\n/ys <search-query> - Search YouTube videos\n/help - Show this help message",
      )
    })
  })
}

// Download image from URL
async function downloadImage(url) {
  try {
    const response = await fetch(url) // Ensure fetch is available or use a library like node-fetch
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }
    const arrayBuffer = await response.arrayBuffer()
    return Buffer.from(arrayBuffer)
  } catch (error) {
    console.error(`❌ Failed to download image: ${error.message}`)
    return null
  }
}

// YouTube API functions
async function searchYouTubeVideos(query, maxResults = 20) {
  try {
    const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(query)}&maxResults=${maxResults}&order=relevance&key=${YOUTUBE_API_KEY}`
    console.log(`🔍 Searching YouTube for: "${query}"`)
    const response = await fetch(searchUrl)
    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error?.message || "YouTube API request failed")
    }
    if (!data.items || data.items.length === 0) {
      return { success: false, error: "No videos found for this search query" }
    }
    const videoIds = data.items.map((item) => item.id.videoId).join(",")
    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${YOUTUBE_API_KEY}`
    const statsResponse = await fetch(statsUrl)
    const statsData = await statsResponse.json()

    if (!statsResponse.ok) {
      throw new Error(statsData.error?.message || "Failed to get video statistics")
    }

    const videos = data.items.map((item) => { // Removed index as it's not used
      const stats = statsData.items.find((stat) => stat.id === item.id.videoId)
      return {
        id: item.id.videoId,
        title: item.snippet.title,
        description: item.snippet.description,
        thumbnail:
          item.snippet.thumbnails.high?.url ||
          item.snippet.thumbnails.medium?.url ||
          item.snippet.thumbnails.default?.url,
        channelTitle: item.snippet.channelTitle,
        publishedAt: item.snippet.publishedAt,
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`, // Corrected URL
        views: stats?.statistics?.viewCount || "N/A",
        likes: stats?.statistics?.likeCount || "N/A",
        duration: stats?.contentDetails?.duration || "N/A",
      }
    })
    return { success: true, videos }
  } catch (error) {
    console.error("❌ Youtube failed:", error.message)
    return { success: false, error: error.message }
  }
}

function formatDuration(duration) {
  if (duration === "N/A") return "N/A"
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/)
  if (!match) return duration
  const hours = Number.parseInt(match[1] || 0)
  const minutes = Number.parseInt(match[2] || 0)
  const seconds = Number.parseInt(match[3] || 0)
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`
  } else {
    return `${minutes}:${seconds.toString().padStart(2, "0")}`
  }
}

function formatNumber(num) {
  if (num === "N/A") return "N/A"
  const number = Number.parseInt(num)
  if (isNaN(number)) return "N/A"
  if (number >= 1000000000) return (number / 1000000000).toFixed(1) + "B"
  if (number >= 1000000) return (number / 1000000).toFixed(1) + "M"
  if (number >= 1000) return (number / 1000).toFixed(1) + "K"
  return number.toString()
}

async function sendVideoCards(sock, remoteJid, videos) {
  try {
    await sock.sendMessage(remoteJid, {
      text: `🔍 *Found ${videos.length} videos:*\n\n💡 *Reply with a number (1-${videos.length}) to download*\n❌ *Reply 'cancel' to exit*`,
    })
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i]
      const publishDate = new Date(video.publishedAt).toLocaleDateString()
      const duration = formatDuration(video.duration)
      const views = formatNumber(video.views)
      const likes = formatNumber(video.likes)
      const videoInfo =
        `*${i + 1}.* ${video.title}\n\n` +
        `📺 *Channel:* ${video.channelTitle}\n` +
        `👀 *Views:* ${views} | 👍 *Likes:* ${likes}\n` +
        `⏱️ *Duration:* ${duration} | 📅 *Published:* ${publishDate}\n` +
        `🔗 *URL:* ${video.url}`
      try {
        const thumbnailBuffer = await downloadImage(video.thumbnail)
        if (thumbnailBuffer) {
          await sock.sendMessage(remoteJid, {
            image: thumbnailBuffer,
            caption: videoInfo,
            mimetype: "image/jpeg",
          })
        } else {
          await sock.sendMessage(remoteJid, { text: `🖼️ ${videoInfo}` })
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      } catch (error) {
        console.error(`❌ Error sending video card ${i + 1}:`, error.message)
        await sock.sendMessage(remoteJid, { text: `📹 ${videoInfo}` })
      }
    }
    await sock.sendMessage(remoteJid, {
      text: `✅ *All ${videos.length} videos loaded!*\n\n💡 *Reply with a number (1-${videos.length}) to download*\n❌ *Reply 'cancel' to exit*`,
    })
  } catch (error) {
    console.error("❌ Error sending video cards:", error)
    // Do not re-throw, allow function to complete if some cards failed
    await sock.sendMessage(remoteJid, { text: "❌ Error displaying some video results." });
  }
}

async function handleSearchSelection(sock, messageInfo, selection) {
  const { remoteJid } = messageInfo
  const userState = userStates.get(remoteJid)

  if (!userState || !userState.searchResults) {
    await sock.sendMessage(remoteJid, { text: "❌ No search results found. Please search again using /ys <query>" })
    userStates.delete(remoteJid)
    return
  }

  if (selection.toLowerCase() === "cancel") {
    userStates.delete(remoteJid)
    await sock.sendMessage(remoteJid, { text: "❌ Search cancelled." })
    return
  }

  const videoIndex = Number.parseInt(selection) - 1
  const videos = userState.searchResults

  if (isNaN(videoIndex) || videoIndex < 0 || videoIndex >= videos.length) {
    await sock.sendMessage(remoteJid, {
      text: `❌ Invalid selection. Please enter a number between 1-${videos.length} or 'cancel'.`,
    })
    return
  }

  const selectedVideo = videos[videoIndex]
  userStates.delete(remoteJid) // Clear search state early

  try {
    // Perform system disk space check and cleanup BEFORE attempting download
    console.log("Checking disk space before YouTube download...");
    let diskSpace = await checkSystemDiskSpace();
    if (diskSpace.available < MIN_FREE_DISK_SPACE_MB) {
      console.log(`⚠️ Low system disk space (${diskSpace.formatted}) before YouTube download. Attempting cleanup...`);
      await cleanupTempFiles(); // Clean system temp first
      await cleanupOldFiles();  // Then clean workspace if system disk is still low
      diskSpace = await checkSystemDiskSpace(); // Re-check disk space
      if (diskSpace.available < MIN_FREE_DISK_SPACE_MB) {
        await sock.sendMessage(remoteJid, {
          text: `⚠️ *System disk space is critically low (${diskSpace.formatted})*\n\nNot enough space to download videos.\nRequired: ${formatBytes(MIN_FREE_DISK_SPACE_MB * 1024 * 1024)}\n\nPlease try /cleanup or contact the administrator.`,
        });
        return;
      }
      console.log(`✅ Disk space after cleanup: ${diskSpace.formatted}`);
    }


    await sock.sendPresenceUpdate("composing", remoteJid)
    await sock.sendMessage(remoteJid, {
      text:
        `🎥 *Starting download...*\n\n` +
        `📹 *Title:* ${selectedVideo.title}\n` +
        `📺 *Channel:* ${selectedVideo.channelTitle}\n` +
        `⏱️ *Duration:* ${formatDuration(selectedVideo.duration)}\n\n` +
        `⏳ *Please wait, attempting FHD quality...*`,
    })

    console.log(`📥 Starting FHD download for: ${selectedVideo.title} (${selectedVideo.url})`)
    const result = await downloadYouTubeVideo(selectedVideo.url, true) // true for FHD

    if (result.success) {
      const filePath = path.join(WORKSPACE_PATH, result.filename)
      if (!fs.existsSync(filePath)) {
         console.error(`❌ Downloaded file not found at path: ${filePath}`);
         await sock.sendMessage(remoteJid, { text: `❌ *Download completed but file not found!*\n\nError: File system inconsistency. Please try again.` });
         return;
      }
      const fileSize = getFileSize(filePath)
      const fileStats = fs.statSync(filePath);
      const fileSizeMB = fileStats.size / (1024 * 1024)


      // Check system disk space AGAIN before sending (file might be large)
      diskSpace = await checkSystemDiskSpace();
      if (diskSpace.available < fileSizeMB * 1.2) { // Need at least 1.2x file size for safety
        await sock.sendMessage(remoteJid, {
          text: `⚠️ *Not enough system disk space to safely send this video*\n\nVideo size: ${fileSize}\nAvailable system space: ${diskSpace.formatted}\n\nTry a smaller video or run /cleanup.`,
        })
        try {
          fs.unlinkSync(filePath)
          console.log(`🗑️ Deleted downloaded video due to insufficient system space for sending: ${result.filename}`)
        } catch (deleteError) {
          console.error("❌ Error deleting video file after insufficient space for sending:", deleteError)
        }
        return
      }

      await sock.sendMessage(remoteJid, {
        text: `✅ *Download completed!*\n\n📁 *File:* ${result.filename}\n📊 *Size:* ${fileSize}\n\n📤 *Sending as document...*`,
      })

      try {
        await cleanupTempFiles(); // Clean temp files before sending large file
        console.log(`📤 Attempting to send video: ${result.filename} (${fileSize})`);
        await sendLargeFileAsDocument(
          sock,
          remoteJid,
          filePath,
          result.filename,
          "video/mp4",
          `🎥 *${selectedVideo.title}*\n\n📺 *Channel:* ${selectedVideo.channelTitle}\n📊 *Size:* ${fileSize}\n🎬 *Quality:* ${result.quality || "FHD (Requested)"}\n\n📤 *Downloaded via WhatsApp Bot*`,
        )
        console.log(`📤 Sent video "${result.filename}" as document to ${remoteJid}`)

        try {
          fs.unlinkSync(filePath)
          console.log(`🗑️ Deleted local video file after sending: ${result.filename}`)
          await sock.sendMessage(remoteJid, {
            text: `✅ *Video sent successfully!*\n\n🗑️ *Local file cleaned up to save space*`,
          })
        } catch (deleteError) {
          console.error("❌ Error deleting local video file after sending:", deleteError)
          await sock.sendMessage(remoteJid, {
            text: `✅ *Video sent successfully!*\n\n⚠️ *Note: Local file cleanup failed, but video was sent.*`,
          })
        }
      } catch (sendError) {
        console.error("❌ Error sending video file:", sendError)
        await sock.sendMessage(remoteJid, {
          text: `❌ *Failed to send video file*\n\nError: ${sendError.message}\n\n📁 *File downloaded:* ${result.filename}\n📊 *Size:* ${fileSize}\n\n💡 *Use /files command to access the video*`,
        })
      }
    } else {
      await sock.sendMessage(remoteJid, {
        text: `❌ *Download failed*\n\n🔴 *Error:* ${result.error}\n\n💡 *Try another video, check cookies, or ensure youtube-dl is up-to-date.*`,
      })
    }
    await sock.sendPresenceUpdate("available", remoteJid)
  } catch (error) {
    console.error("❌ YouTube Download/Send error in handleSearchSelection:", error)
    await sock.sendMessage(remoteJid, {
      text: `❌ *An unexpected error occurred during download/send*\n\n🔴 *Error:* ${error.message}\n\n💡 *Please try again later*`,
    })
    await sock.sendPresenceUpdate("available", remoteJid)
  }
}

async function sendLargeFileAsDocument(sock, remoteJid, filePath, fileName, mimeType, caption) {
  try {
    if (!fs.existsSync(filePath)) {
        console.error(`❌ File not found at path for sending: ${filePath}`);
        throw new Error(`File ${fileName} not found for sending.`);
    }
    const fileStats = fs.statSync(filePath)
    const fileSizeMB = fileStats.size / (1024 * 1024)
    console.log(`📤 Preparing to send file: ${fileName} (${fileSizeMB.toFixed(2)}MB)`)

    if (fileSizeMB > 1800) { // Warn if approaching WhatsApp's 2GB limit
        console.warn(`⚠️ Sending very large file: ${fileName} (${fileSizeMB.toFixed(2)}MB). This may take a long time or fail due to WhatsApp limits.`);
        await sock.sendMessage(remoteJid, {
            text: `📤 *Sending very large file (${fileSizeMB.toFixed(1)}MB)...*\n\n⏳ *This is close to WhatsApp's limit and may take a very long time or fail.*`,
        });
    } else if (fileSizeMB > 50) {
      await sock.sendMessage(remoteJid, {
        text: `📤 *Sending large file (${fileSizeMB.toFixed(1)}MB)...*\n\n⏳ *Please wait, this may take several minutes*`,
      })
    }
    
    // The temp file strategy is for very large files, could be useful if direct path causes issues for Baileys.
    // Let's keep it for files > 200MB as originally designed.
    if (fileSizeMB > 200) { // Using 200MB threshold from original code
      console.log(`🔄 Using temp file approach for large file: ${fileName} (${fileSizeMB.toFixed(1)}MB)`)
      const tempDir = os.tmpdir()
      const tempFileName = `wa_${Date.now()}_${sanitize(path.basename(fileName))}` // Sanitize basename
      const tempFilePath = path.join(tempDir, tempFileName)
      console.log(`📝 Copying to temporary file: ${tempFilePath}`)

      const readStream = fs.createReadStream(filePath)
      const writeStream = fs.createWriteStream(tempFilePath)

      await new Promise((resolve, reject) => {
        readStream.pipe(writeStream)
        writeStream.on("finish", resolve)
        readStream.on("error", (err) => reject(new Error(`Read stream error during temp copy: ${err.message}`))); // Added error handling
        writeStream.on("error", (err) => reject(new Error(`Write stream error during temp copy: ${err.message}`))); // Added error handling
      });
      console.log(`✅ Created temporary file for sending: ${tempFilePath}`)

      try {
        console.log(`🚀 Sending from temporary location: ${tempFileName}`);
        await sock.sendMessage(remoteJid, {
          document: { url: tempFilePath }, // Send by URL which Baileys should handle by reading the file
          fileName: fileName,
          mimetype: mimeType,
          caption: caption,
        })
        console.log(`✅ File sent successfully from temp location: ${fileName}`)
      } finally { // Ensure temp file is deleted
        if (fs.existsSync(tempFilePath)) {
          try {
            fs.unlinkSync(tempFilePath)
            console.log(`🗑️ Deleted temporary file: ${tempFilePath}`)
          } catch (unlinkErr) {
            console.error(`❌ Failed to delete temporary file ${tempFilePath}: ${unlinkErr.message}`)
          }
        }
      }
    } else {
      console.log(`🚀 Sending directly: ${fileName}`);
      await sock.sendMessage(remoteJid, {
        document: { url: filePath }, // Send by URL (local file path)
        fileName: fileName,
        mimetype: mimeType,
        caption: caption,
      })
      console.log(`✅ File sent successfully: ${fileName}`)
    }
    return true;
  } catch (error) {
    console.error(`❌ Error in sendLargeFileAsDocument for ${fileName}: ${error.message}`)
    // If the error is from sock.sendMessage, it will be caught by the caller
    // If it's a local error (e.g., file copy), throw it to be caught by caller
    throw error; // Re-throw to be handled by the calling function
  }
}


function getCookieFilePath() {
  return path.join(process.cwd(), "youtube_cookies.txt")
}

function checkCookieFile() {
  const cookiePath = getCookieFilePath()
  if (fs.existsSync(cookiePath)) {
    console.log(`✅ Found YouTube cookie file: ${cookiePath}`)
    return true
  } else {
    console.log(`❌ YouTube cookie file not found: ${cookiePath}`)
    // console.log(`📝 Please export your YouTube cookies and save them as 'youtube_cookies.txt' for potentially better/faster downloads or bypassing restrictions.`)
    return false
  }
}

function createSampleCookieFile() {
  const cookiePath = getCookieFilePath()
  if (fs.existsSync(cookiePath)) return; // Don't overwrite if it exists

  const sampleContent = `# Netscape HTTP Cookie File
# This is a generated file! Do not edit unless you know what you are doing.
# Export your YouTube cookies from a browser extension like "Cookie Editor".
# 1. Go to youtube.com and make sure you are logged in.
# 2. Open the Cookie Editor extension.
# 3. Click "Export" (or similar button).
# 4. Choose "Netscape format" (also called "Netscape HTTP Cookie File").
# 5. Filter for YouTube domain cookies if possible.
# 6. Save the content into this file, replacing this sample.
# 7. Using cookies can help with age-restricted content and might reduce captchas/bot detection.

# Sample format (replace with your actual cookies):
# .youtube.com	TRUE	/	TRUE	1700000000	LOGIN_INFO	<your_login_info_cookie_value>
# .youtube.com	TRUE	/	TRUE	1700000000	SID	<your_sid_cookie_value>
# Ensure the domain includes the leading dot if applicable (e.g., .youtube.com)
`
  try {
    fs.writeFileSync(cookiePath, sampleContent)
    console.log(`📝 Created sample YouTube cookie file: ${cookiePath}`)
    console.log(`🔧 Please follow the instructions in the file to add your YouTube cookies for improved download reliability.`)
  } catch (error) {
    console.error(`❌ Failed to create sample cookie file: ${error.message}`)
  }
}

async function downloadYouTubeVideo(videoUrl, forceFHD = false) {
  let videoInfo = null // To store video metadata from youtube-dl
  const cookiePath = getCookieFilePath()
  const hasCookies = checkCookieFile()

  const baseOptions = {
    noWarnings: true,
    noCheckCertificate: true,
    preferFreeFormats: true, // Prefer non-proprietary formats when quality is same
    youtubeSkipDashManifest: false, // Try to get combined formats if possible
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    retries: 3,
    fragmentRetries: 3,
    sleepInterval: 2, // Slightly increased sleep interval
    maxSleepInterval: 10,
  }

  if (hasCookies) {
    baseOptions.cookies = cookiePath
    console.log(`🍪 Using cookies from: ${cookiePath}`)
  } else {
    console.log(`⚠️ No YouTube cookies found. Downloads might be slower, lower quality, or face restrictions. Consider adding 'youtube_cookies.txt'.`)
  }

  let downloadedFilePathAttempt = ""; // Store the attempted output path

  try {
    console.log("⏳ Fetching YouTube video info and selecting format...");

    // Get video info first to get a sanitized title
    videoInfo = await youtubedl(videoUrl, {
      ...baseOptions,
      dumpSingleJson: true, // Get all info as JSON
    });

    const title = sanitize(videoInfo.title || `youtube_video_${Date.now()}`);
    console.log(`🎬 Video Title: ${title}`);
    console.log(`⏱️ Duration: ${videoInfo.duration_string || (videoInfo.duration ? formatDuration("PT"+videoInfo.duration+"S") : "N/A") }`); // Try to format duration if available
    console.log(`👀 Views: ${videoInfo.view_count ? formatNumber(videoInfo.view_count) : "N/A"}`);

    let format;
    let qualityInfo = "Standard Quality";
    if (forceFHD) {
      // MODIFIED: Stronger preference for 1080p mp4, then fallback.
      // Prioritize combined 1080p mp4. If not available, separate video/audio then merge.
      format = `bestvideo[height=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height=1080]+bestaudio/bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best[height<=1080]/best`;
      qualityInfo = "FHD 1080p (Requested)";
      console.log(`🎯 Requesting FHD 1080p quality. Format string: ${format}`);
    } else {
      format = `bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best[height<=720]/best`;
      qualityInfo = "Standard Quality (Max 720p)";
      console.log(`🎯 Requesting Standard quality (max 720p). Format string: ${format}`);
    }

    const outputPathTemplate = path.join(WORKSPACE_PATH, `${title}.%(ext)s`);
    downloadedFilePathAttempt = path.join(WORKSPACE_PATH, `${title}.mp4`); // Assume mp4 output after merge

    console.log(`⬇️ Starting YouTube download: ${title}`);
    await youtubedl(videoUrl, {
      ...baseOptions,
      output: outputPathTemplate,
      format: format,
      mergeOutputFormat: "mp4", // Ensure merged output is mp4
      addMetadata: true, // Add metadata like title
      embedThumbnail: true, // Embed thumbnail if possible (yt-dlp feature)
      // noPostOverwrites: true, // Don't overwrite if post-processing fails (e.g. merge) - might leave partial files
    });
    
    // Verify file exists after download
    if (!fs.existsSync(downloadedFilePathAttempt)) {
        // Check for other possible extensions if mergeOutputFormat was not respected or failed.
        // This is a simple check, more robust would involve listing files.
        const mkvAttempt = path.join(WORKSPACE_PATH, `${title}.mkv`);
        if (fs.existsSync(mkvAttempt)) {
            downloadedFilePathAttempt = mkvAttempt; // Found .mkv
            console.warn(`⚠️ YouTube download resulted in .mkv, but requested .mp4. Using .mkv: ${downloadedFilePathAttempt}`);
        } else {
            console.error(`❌ YouTube download completed according to youtube-dl, but output file not found: ${downloadedFilePathAttempt}`);
            throw new Error(`Output file ${title}.mp4 not found after download.`);
        }
    }
    
    const finalFilename = path.basename(downloadedFilePathAttempt);
    console.log(`✅ YouTube download completed: ${finalFilename}`);
    return { success: true, filename: finalFilename, title: title, quality: qualityInfo };

  } catch (err) {
    console.error("❌ YouTube download failed:", err.stderr || err.message || err); // Log stderr if available

    let userErrorMessage = `Download failed. ${err.message.substring(0, 200)}`;
    if (err.message && (err.message.includes("Sign in to confirm") || err.message.includes("age-restricted") || err.message.includes("unavailable") || err.message.includes("private video"))) {
      userErrorMessage = `Video may be age-restricted, private, or unavailable. Using cookies (youtube_cookies.txt) might help. Error: ${err.message.substring(0,150)}`;
      if (!hasCookies) createSampleCookieFile();
    } else if (err.message && err.message.includes("format not available")) {
        userErrorMessage = `Requested format (e.g., 1080p) not available for this video. Error: ${err.message.substring(0,150)}`;
    } else if (err.message && err.message.toLowerCase().includes("unable to download webpage")) {
        userErrorMessage = `Failed to fetch video page. Check URL or network. Error: ${err.message.substring(0,150)}`;
    }


    // Fallback attempt is often not very useful if high quality fails due to restrictions.
    // Instead of a blind fallback, we'll just report the error.
    // console.log("🔄 Main download failed. A generic fallback is not attempted by default to avoid very low quality.");

    return { success: false, error: userErrorMessage, title: videoInfo?.title || "Unknown Video" };
  }
}


function getWorkspaceFiles() {
  try {
    if (!fs.existsSync(WORKSPACE_PATH)) return [];
    const files = fs.readdirSync(WORKSPACE_PATH)
    return files.filter((file) => {
      const ext = path.extname(file).toLowerCase()
      // Ensure it's a supported extension and not a hidden file or directory
      return SUPPORTED_EXTENSIONS.includes(ext) && !file.startsWith('.') && fs.statSync(path.join(WORKSPACE_PATH, file)).isFile();
    })
  } catch (error) {
    console.error("❌ Error reading workspace:", error)
    return []
  }
}

async function deleteWorkspaceFiles(fileIndices, files) {
  const results = { deleted: [], failed: [], notFound: [] }
  for (const index of fileIndices) {
    if (index < 0 || index >= files.length) {
      results.notFound.push(index + 1)
      continue
    }
    const fileName = files[index]
    const filePath = path.join(WORKSPACE_PATH, fileName)
    try {
      if (!fs.existsSync(filePath)) {
        results.notFound.push(index + 1)
        continue
      }
      fs.unlinkSync(filePath)
      results.deleted.push({ index: index + 1, name: fileName })
      console.log(`🗑️ Deleted file: ${fileName}`)
    } catch (error) {
      console.error(`❌ Failed to delete file ${fileName}:`, error)
      results.failed.push({ index: index + 1, name: fileName, error: error.message })
    }
  }
  return results
}

function formatFileList(files) {
  if (files.length === 0) {
    return "📁 No files available in the workspace.\n\nSupported formats: " + SUPPORTED_EXTENSIONS.join(", ")
  }
  let message = "📁 *Available Files:*\n\n"
  files.forEach((file, index) => {
    const ext = path.extname(file).toLowerCase()
    const emoji = getFileEmoji(ext)
    const size = getFileSize(path.join(WORKSPACE_PATH, file)) // Make sure getFileSize is robust
    message += `${index + 1}. ${emoji} ${file} (${size})\n`
  })
  message += "\n💡 *Reply with a number to download that file as document*"
  message += "\n❌ *Reply 'cancel' to exit file browser*"
  return message
}

function getFileEmoji(extension) {
  const emojiMap = {
    ".jpg": "🖼️", ".jpeg": "🖼️", ".png": "🖼️", ".gif": "🖼️",
    ".pdf": "📄", ".txt": "📝", ".doc": "📄", ".docx": "📄",
    ".mp4": "🎥", ".mp3": "🎵",
  }
  return emojiMap[extension] || "📎"
}

function getFileSize(filePath) {
  try {
    if (!fs.existsSync(filePath)) return "Not Found";
    const stats = fs.statSync(filePath)
    return formatBytes(stats.size);
  } catch (error) {
    // console.error(`Error getting file size for ${filePath}: ${error.message}`);
    return "Unknown"
  }
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".gif": "image/gif", ".pdf": "application/pdf", ".txt": "text/plain",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".mp4": "video/mp4", ".mp3": "audio/mpeg",
  }
  return mimeTypes[ext] || "application/octet-stream"
}

async function handleFileSelection(sock, messageInfo, selection) {
  const { remoteJid } = messageInfo;
  const userState = userStates.get(remoteJid); // Get current user state for files

  // Ensure files are freshly fetched if not in user state (e.g., after bot restart or timeout)
  const files = (userState && userState.files) ? userState.files : getWorkspaceFiles();


  if (selection.toLowerCase() === "cancel") {
    userStates.delete(remoteJid)
    await sock.sendMessage(remoteJid, { text: "❌ File browser cancelled." })
    return
  }

  const fileIndex = Number.parseInt(selection) - 1

  if (isNaN(fileIndex) || fileIndex < 0 || fileIndex >= files.length) {
    await sock.sendMessage(remoteJid, {
      text: "❌ Invalid selection. Please enter a valid number or 'cancel'.\nUse /files to refresh the list.",
    })
    return
  }

  const selectedFile = files[fileIndex]
  const filePath = path.join(WORKSPACE_PATH, selectedFile)
  userStates.delete(remoteJid); // Clear state after valid selection attempt

  try {
    if (!fs.existsSync(filePath)) {
      await sock.sendMessage(remoteJid, {
        text: "❌ File not found. It may have been moved or deleted. Please use /files to see the current list.",
      })
      return
    }

    const fileStats = fs.statSync(filePath);
    const fileSizeMB = fileStats.size / (1024 * 1024);
    let diskSpace = await checkSystemDiskSpace();
    if (diskSpace.available < fileSizeMB * 1.2) { // 1.2x buffer
      await sock.sendMessage(remoteJid, {
        text: `⚠️ *Not enough system disk space to safely send this file*\n\nFile size: ${getFileSize(filePath)}\nAvailable system space: ${diskSpace.formatted}\n\nTry /cleanup or contact the administrator.`,
      });
      return;
    }

    await sock.sendPresenceUpdate("composing", remoteJid)
    await cleanupTempFiles(); // Clean temp before sending

    const mimeType = getMimeType(filePath)
    const fileEmoji = getFileEmoji(path.extname(selectedFile).toLowerCase())
    const fileSize = getFileSize(filePath)

    console.log(`📤 Attempting to send selected file: ${selectedFile} (${fileSize})`);
    await sendLargeFileAsDocument(
      sock,
      remoteJid,
      filePath,
      selectedFile,
      mimeType,
      `${fileEmoji} *${selectedFile}*\n\n📊 *Size:* ${fileSize}\n\n📤 Sent as document via WhatsApp Bot`,
    )
    console.log(`📤 Sent file "${selectedFile}" as document to ${remoteJid}`)
    // No need to delete userStates again, already done.
    await sock.sendPresenceUpdate("available", remoteJid)
  } catch (error) {
    console.error(`❌ Error sending selected file ${selectedFile}:`, error)
    await sock.sendMessage(remoteJid, {
      text: `❌ Sorry, there was an error sending the file "${selectedFile}".\nError: ${error.message}\nPlease try again later.`,
    })
    // userStates.delete(remoteJid) // Ensure state is clear on error
    await sock.sendPresenceUpdate("available", remoteJid)
  }
}

async function getFilenameFromHeaders(url) {
  try {
    const command = `curl -sIL --max-time 10 "${url}"`; // Added timeout
    const { stdout, stderr } = await execAsync(command);
    if (stderr) console.warn(`Curl header fetch warning for ${url}: ${stderr}`);
    
    const contentDisposition = stdout.split("\n").find((line) => line.toLowerCase().startsWith("content-disposition:"))
    if (contentDisposition) {
      const filenameMatch = contentDisposition.match(/filename\*?=(?:UTF-8'')?([^;]+)/i) || contentDisposition.match(/filename="?([^"]+)"?/i);
      if (filenameMatch && filenameMatch[1]) {
        let filename = decodeURIComponent(filenameMatch[1].replace(/['"]/g, ""));
        filename = sanitize(filename.replace(/[<>:"/\\|?*]/g, "_"));
        if (filename.length > 5 && filename.includes('.')) return filename; // Basic sanity check
      }
    }
    const contentType = stdout.split("\n").find((line) => line.toLowerCase().startsWith("content-type:"))
    if (contentType) {
      const type = contentType.toLowerCase().split(';')[0].trim(); // Get type before semicolon
      const timestamp = Date.now();
      const mimeToExt = {
        'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'image/jpeg': '.jpg',
        'image/png': '.png', 'application/pdf': '.pdf', 'text/plain': '.txt',
        'application/zip': '.zip', 'application/msword': '.doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx'
      };
      if (mimeToExt[type]) return `download_${timestamp}${mimeToExt[type]}`;
      if (type.startsWith('video/')) return `video_${timestamp}.mp4`;
      if (type.startsWith('audio/')) return `audio_${timestamp}.mp3`;
      if (type.startsWith('image/')) return `image_${timestamp}.jpg`;
    }
    return null
  } catch (error) {
    console.warn(`Header fetch failed for ${url}: ${error.message}`)
    return null
  }
}

function getFilenameFromUrl(url) {
  try {
    const urlObj = new URL(url)
    let filename = path.basename(urlObj.pathname)
    filename = decodeURIComponent(filename.split("?")[0].split("#")[0]) // Decode URI components
    if (filename && filename.length > 1 && filename.includes(".") && !filename.startsWith(".")) { // Basic check for extension
      return sanitize(filename.replace(/[<>:"/\\|?*]/g, "_"));
    }
    return null
  } catch (error) {
    return null
  }
}

async function generateFilename(url) {
  let filename = await getFilenameFromHeaders(url)
  if (filename) {
    console.log(`📝 Filename from headers: ${filename}`)
    return sanitize(filename); // Sanitize again just in case
  }
  filename = getFilenameFromUrl(url)
  if (filename) {
    console.log(`📝 Filename from URL: ${filename}`)
    return sanitize(filename);
  }
  const timestamp = Date.now()
  filename = `download_${timestamp}.bin` // Default generic binary extension
  console.log(`📝 Generated generic filename: ${filename}`)
  return sanitize(filename);
}

async function downloadFile(url) { // For /download command
  try {
    console.log("Checking disk space before generic download...");
    let diskSpace = await checkSystemDiskSpace();
    if (diskSpace.available < MIN_FREE_DISK_SPACE_MB / 2) { // Allow download if at least half of min_free is available
        console.log(`⚠️ Low system disk space (${diskSpace.formatted}) before generic download. Attempting cleanup...`);
        await cleanupTempFiles();
        await cleanupOldFiles(); 
        diskSpace = await checkSystemDiskSpace();
        if (diskSpace.available < MIN_FREE_DISK_SPACE_MB / 5) { // Stricter check after cleanup
            throw new Error(`Critically low system disk space (${diskSpace.formatted}). Download aborted.`);
        }
         console.log(`✅ Disk space after cleanup: ${diskSpace.formatted}`);
    }

    const filename = await generateFilename(url)
    const outputPath = path.join(WORKSPACE_PATH, filename)

    const command = `curl -L --connect-timeout 15 --max-time 300 --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" -o "${outputPath}" "${url}" --fail --silent --show-error`
    console.log(`📥 Downloading from URL: ${url}`)
    console.log(`📁 Saving as: ${filename}`)

    await execAsync(command) // Removed stdout, stderr capture as --silent is used

    if (!fs.existsSync(outputPath)) {
      throw new Error("File was not downloaded (curl command completed but file missing). Check URL and permissions.")
    }
    const stats = fs.statSync(outputPath)
    if (stats.size === 0) {
      fs.unlinkSync(outputPath) 
      throw new Error("Downloaded file is empty. URL might be incorrect or file is indeed empty.")
    }
    console.log(`✅ Generic download success: ${filename} (${formatBytes(stats.size)})`);
    return { path: outputPath, filename, size: formatBytes(stats.size) }
  } catch (error) {
    // Attempt to clean up partial download if exists
    const tempFilenameGuess = await generateFilename(url); // Re-generate to guess the name
    const tempOutputPathGuess = path.join(WORKSPACE_PATH, tempFilenameGuess);
    if (fs.existsSync(tempOutputPathGuess)) {
        try {
            fs.unlinkSync(tempOutputPathGuess);
            console.log(`🗑️ Cleaned up potentially partial download: ${tempFilenameGuess}`);
        } catch (e) { /* ignore */ }
    }
    console.error(`❌ Generic download failed for ${url}: ${error.message}`);
    throw new Error(`Download failed: ${error.message.substring(0, 250)}`); // Keep error message concise for user
  }
}

function isValidYouTubeUrl(url) {
  const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}/
  return youtubeRegex.test(url)
}

async function handleCommand(sock, messageInfo, command) {
  const { remoteJid } = messageInfo
  const commandParts = command.split(" ")
  const mainCommand = commandParts[0].toLowerCase()

  switch (mainCommand) {
    case "/files":
      const files = getWorkspaceFiles()
      const fileList = formatFileList(files)
      let storageMessage = "\n\n📊 *Workspace Usage:* " + formatBytes(getDirectorySize(WORKSPACE_PATH));
      try {
        // userStates can be set before sending the message to ensure it's ready for reply
        if (files.length > 0) {
            userStates.set(remoteJid, { state: "selecting_file", files: files });
        }
        const diskSpace = await checkSystemDiskSpace()
        storageMessage += `\n💾 *System Disk Free:* ${diskSpace.formatted}`
        await sock.sendMessage(remoteJid, { text: fileList + storageMessage })
      } catch (error) {
        console.error("Error in /files getting disk space:", error);
        await sock.sendMessage(remoteJid, { text: fileList + storageMessage + "\n⚠️ Couldn't fetch system disk space." })
      }
      break

    case "/del":
      if (commandParts.length < 2) {
        await sock.sendMessage(remoteJid, { text: "❌ Please specify file numbers to delete.\nUsage: /del 1,2,3 or /del 1-3\n💡 Use /files first to see the file list." })
        break
      }
      const filesToDelete = getWorkspaceFiles()
      if (filesToDelete.length === 0) {
        await sock.sendMessage(remoteJid, { text: "❌ No files available in the workspace to delete." })
        break
      }
      const indexInput = commandParts.slice(1).join("").trim()
      let indices = []
      try {
        indices = indexInput.split(",").flatMap((part) => {
          part = part.trim()
          if (part.includes("-")) {
            const [start, end] = part.split("-").map((num) => Number.parseInt(num.trim()))
            if (!isNaN(start) && !isNaN(end) && start <= end && start > 0 && end <= filesToDelete.length) { // Validate range
              return Array.from({ length: end - start + 1 }, (_, i) => start + i - 1)
            }
          }
          const num = Number.parseInt(part)
          return !isNaN(num) && num > 0 && num <= filesToDelete.length ? [num - 1] : [] // Validate number
        })
        indices = [...new Set(indices)].sort((a,b) => a-b); // Sort for clarity
        if (indices.length === 0) throw new Error("No valid file numbers provided or numbers out of range.")
      } catch (error) {
        await sock.sendMessage(remoteJid, { text: `❌ Invalid input: ${error.message}\nPlease use comma-separated numbers (e.g., 1,2,3) or ranges (e.g., 1-3) within the current file list.` })
        break
      }
      try {
        await sock.sendPresenceUpdate("composing", remoteJid)
        await sock.sendMessage(remoteJid, { text: `🗑️ Attempting to delete ${indices.length} file(s)...` })
        const results = await deleteWorkspaceFiles(indices, filesToDelete)
        let resultMessage = "🗑️ *File Deletion Results:*\n\n"
        if (results.deleted.length > 0) resultMessage += `✅ *Deleted:*\n${results.deleted.map(f => `• ${f.index}. ${f.name}`).join("\n")}\n\n`
        if (results.failed.length > 0) resultMessage += `❌ *Failed:*\n${results.failed.map(f => `• ${f.index}. ${f.name} - ${f.error}`).join("\n")}\n\n`
        if (results.notFound.length > 0) resultMessage += `⚠️ *Not Found (invalid index or already deleted):*\n• File number(s): ${results.notFound.join(", ")}\n\n`
        resultMessage += `📊 *Summary:* ${results.deleted.length} deleted, ${results.failed.length} failed, ${results.notFound.length} not found/invalid.`
        await sock.sendMessage(remoteJid, { text: resultMessage })
        await sock.sendPresenceUpdate("available", remoteJid)
      } catch (error) {
        console.error("❌ File deletion error:", error)
        await sock.sendMessage(remoteJid, { text: `❌ Error during file deletion: ${error.message}` })
        await sock.sendPresenceUpdate("available", remoteJid)
      }
      break

    case "/cleanup":
      try {
        await sock.sendMessage(remoteJid, { text: "🧹 *Starting system and workspace cleanup...*\nThis will remove temporary files and, if system disk is very low, oldest workspace downloads." })
        await sock.sendPresenceUpdate("composing", remoteJid);

        const tempFilesDeleted = await cleanupTempFiles();
        await cleanupOldFiles(); // This will now only clean workspace if system disk is low

        const diskSpace = await checkSystemDiskSpace();
        await sock.sendMessage(remoteJid, { text: `✅ *Cleanup process completed!*\n\n🗑️ Removed ${tempFilesDeleted} system temporary files.\n💾 Current free system disk space: ${diskSpace.formatted}\n\nℹ️ Workspace files are only deleted if system disk space is critically low (under ${MIN_FREE_DISK_SPACE_MB}MB).` });
        await sock.sendPresenceUpdate("available", remoteJid);
      } catch (error) {
        console.error("❌ Cleanup command error:", error)
        await sock.sendMessage(remoteJid, { text: `❌ Cleanup error: ${error.message}` })
        await sock.sendPresenceUpdate("available", remoteJid);
      }
      break

    case "/ys": // Youtube
      if (commandParts.length < 2) {
        await sock.sendMessage(remoteJid, { text: "❌ Please provide a search query.\nUsage: /ys <search query>" })
        break
      }
      const searchQuery = commandParts.slice(1).join(" ").trim()
      try {
        let diskSpace = await checkSystemDiskSpace();
        if (diskSpace.available < MIN_FREE_DISK_SPACE_MB) {
          await sock.sendMessage(remoteJid, { text: `⚠️ *Low system disk space (${diskSpace.formatted})*\nRequired for downloads: ${formatBytes(MIN_FREE_DISK_SPACE_MB * 1024 * 1024)}\nUse /cleanup to free up space.` });
          break;
        }
        await sock.sendPresenceUpdate("composing", remoteJid)
        await sock.sendMessage(remoteJid, { text: `🔍 *Searching YouTube for:* "${searchQuery}"\n⏳ *Please wait...*` })
        
        const searchResult = await searchYouTubeVideos(searchQuery, 10); // Reduced to 10 results for faster display

        if (searchResult.success && searchResult.videos.length > 0) {
          userStates.set(remoteJid, { state: "selecting_search_result", searchResults: searchResult.videos });
          await sendVideoCards(sock, remoteJid, searchResult.videos); // This function was already quite good
          console.log(`🔍 Youtube for "${searchQuery}" completed - ${searchResult.videos.length} results shown.`)
        } else {
          await sock.sendMessage(remoteJid, { text: `❌ *Youtube Failed:*\n${searchResult.error || "No videos found or API error."}\n💡 *Try a different query or check API key.*` });
        }
        await sock.sendPresenceUpdate("available", remoteJid)
      } catch (error) {
        console.error("❌ Youtube command error:", error)
        await sock.sendMessage(remoteJid, { text: `❌ *Youtube failed:* ${error.message}\n💡 *Please try again later.*` })
        await sock.sendPresenceUpdate("available", remoteJid)
      }
      break

    case "/yt": // YouTube Direct Download
      if (commandParts.length < 2) {
        await sock.sendMessage(remoteJid, { text: "❌ Please provide a YouTube URL.\nUsage: /yt <youtube-url>" })
        break
      }
      const ytUrl = commandParts.slice(1).join(" ").trim()
      if (!isValidYouTubeUrl(ytUrl)) {
        await sock.sendMessage(remoteJid, { text: "❌ Invalid YouTube URL.\nSupported formats:\n• youtube.com/watch?v=...\n• youtu.be/...\n• youtube.com/shorts/..." })
        break
      }
      try {
        let diskSpace = await checkSystemDiskSpace();
        if (diskSpace.available < MIN_FREE_DISK_SPACE_MB) {
            await sock.sendMessage(remoteJid, { text: `⚠️ *Low system disk space (${diskSpace.formatted})*\nNot enough space for potential video download.\nUse /cleanup then try again.` });
            break;
        }
        await cleanupTempFiles(); // Clean system temp before download
        // await cleanupOldFiles(); // MODIFIED: Only run this if disk space is an issue, handled in downloadYouTubeVideo/handleSearchSelection

        await sock.sendPresenceUpdate("composing", remoteJid)
        await sock.sendMessage(remoteJid, { text: "🎥 Attempting YouTube video download in FHD quality... This may take a few minutes." })

        const result = await downloadYouTubeVideo(ytUrl, true) // true for FHD

        if (result.success) {
          const filePath = path.join(WORKSPACE_PATH, result.filename)
          if (!fs.existsSync(filePath)) {
             await sock.sendMessage(remoteJid, { text: `❌ *Download seemed to complete, but file ${result.filename} not found!*` });
             return; // Exit early
          }
          const fileSize = getFileSize(filePath);
          const fileStats = fs.statSync(filePath);
          const fileSizeMB = fileStats.size / (1024 * 1024);

          diskSpace = await checkSystemDiskSpace(); // Re-check space before sending
          if (diskSpace.available < fileSizeMB * 1.2) {
            await sock.sendMessage(remoteJid, { text: `⚠️ *Not enough system disk space to send video*\n\nVideo: ${result.filename} (${fileSize})\nAvailable: ${diskSpace.formatted}\n\nThe video is downloaded to workspace. Use /files. Or run /cleanup.` });
            // Do not delete the file here, user might want it via /files
            break;
          }
          
          console.log(`📤 Attempting to send downloaded YouTube video: ${result.filename} (${fileSize})`);
          try {
            await sendLargeFileAsDocument(
              sock, remoteJid, filePath, result.filename, "video/mp4",
              `🎥 *${result.title}*\n\n📊 *Size:* ${fileSize}\n🎬 *Quality:* ${result.quality || "FHD (Requested)"}\n\n📤 *Downloaded via WhatsApp Bot*`
            );
            console.log(`📤 Sent YouTube video "${result.filename}" as document.`);
            try { // Delete after successful send
              fs.unlinkSync(filePath);
              console.log(`🗑️ Deleted local YouTube video file after sending: ${result.filename}`);
              await sock.sendMessage(remoteJid, { text: `✅ *Video sent successfully!*\n\n🗑️ *Local file cleaned up.*` });
            } catch (deleteError) {
              console.error("❌ Error deleting local YouTube file post-send:", deleteError);
              await sock.sendMessage(remoteJid, { text: `✅ *Video sent successfully!*\n\n⚠️ *Local file cleanup failed but video sent.*` });
            }
          } catch (sendError) {
            console.error("❌ Error sending YouTube video file:", sendError);
            await sock.sendMessage(remoteJid, { text: `❌ *Failed to send video file*\nError: ${sendError.message}\n\n📁 *File downloaded:* ${result.filename} (${fileSize})\n💡 *Use /files to access it.*` });
          }
        } else {
          await sock.sendMessage(remoteJid, { text: `❌ YouTube download failed: ${result.error}\n\nPlease check URL, cookies (youtube_cookies.txt), or try later.` });
        }
        await sock.sendPresenceUpdate("available", remoteJid)
      } catch (error) {
        console.error("❌ YouTube Direct Download command error:", error)
        await sock.sendMessage(remoteJid, { text: `❌ YouTube download error: ${error.message}\nPlease check URL/cookies and try again.` })
        await sock.sendPresenceUpdate("available", remoteJid)
      }
      break

    case "/download": // Generic URL download
      if (commandParts.length < 2) {
        await sock.sendMessage(remoteJid, { text: "❌ Please provide a URL to download.\nUsage: /download <url>" })
        break
      }
      const url = commandParts.slice(1).join(" ").trim()
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        await sock.sendMessage(remoteJid, { text: "❌ Invalid URL. Must start with http:// or https://" })
        break
      }
      try {
        await sock.sendPresenceUpdate("composing", remoteJid)
        await sock.sendMessage(remoteJid, { text: "📥 Starting download from URL... Please wait." })

        const result = await downloadFile(url) // downloadFile now also checks disk space
        // const fileSize = getFileSize(result.path); // result.size is already formatted

        await sock.sendMessage(remoteJid, { text: `✅ Download completed!\n\n📁 File: ${result.filename}\n📊 Size: ${result.size}\n\n💡 Use /files to access it.` })
        console.log(`✅ URL Downloaded: ${result.filename} (${result.size})`)
        await sock.sendPresenceUpdate("available", remoteJid)
      } catch (error) {
        console.error("❌ Generic Download command error:", error)
        await sock.sendMessage(remoteJid, { text: `❌ Download failed: ${error.message}\n\nPlease check the URL and try again.` })
        await sock.sendPresenceUpdate("available", remoteJid)
      }
      break

    case "/storage":
      try {
        const workspaceSizeBytes = getDirectorySize(WORKSPACE_PATH);
        // const storageInfo = checkStorageSpace(); // MODIFIED: No longer returns 'available' or 'limit'
        const diskSpace = await checkSystemDiskSpace();
        const storageMessage =
          `📊 *Storage Information:*\n\n` +
          `📁 *Workspace Usage:* ${formatBytes(workspaceSizeBytes)}\n` +
          // `📈 *Workspace Limit:* Unlimited (depends on system disk)\n` + // MODIFIED
          `💾 *System Disk Free:* ${diskSpace.formatted}\n` +
          `⚠️ *Min System Free Required for operations:* ${formatBytes(MIN_FREE_DISK_SPACE_MB * 1024 * 1024)}\n\n` +
          `🧹 *Auto-cleanup of workspace:* Triggered if system disk free < ${MIN_FREE_DISK_SPACE_MB}MB\n` +
          `🗂️ *Files in workspace:* ${getWorkspaceFiles().length} files\n\n` +
          `💡 *Use /cleanup to manually free up system temp files and potentially old workspace files (if system disk is low)*`
        await sock.sendMessage(remoteJid, { text: storageMessage })
      } catch (error) {
        console.error("Error in /storage:", error);
        await sock.sendMessage(remoteJid, { text: `❌ Storage check failed: ${error.message}` })
      }
      break

    case "/help":
      const helpMessage =
        `🤖 *WhatsApp Bot Help*\n\n` +
        `*Available Commands:*\n` +
        `• /files - Browse workspace files & download\n` +
        `• /del <numbers> - Delete files from workspace (e.g., /del 1,2 or /del 1-3)\n` +
        `• /download <url> - Download file from any direct URL\n` +
        `• /yt <youtube-url> - Download YouTube video (attempts FHD)\n` +
        `• /ys <search-query> - Search & download YouTube videos\n` +
        `• /storage - Check workspace and system disk usage\n` +
        `• /cleanup - Run manual cleanup of temp files & old downloads (if system disk low)\n` +
        `• /help - Show this help message\n\n` +
        `*File Sharing:*\n` +
        `• All files sent as documents (up to WhatsApp's limit, ~2GB)\n` +
        `• Supported formats: ${SUPPORTED_EXTENSIONS.join(", ")}\n` +
        `• Workspace auto-cleanup if system disk is very low (below ${MIN_FREE_DISK_SPACE_MB}MB)\n\n` +
        `*Download Features:*\n` +
        `• YouTube videos attempt FHD 1080p quality.\n` +
        `• YouTube downloads are auto-deleted from workspace after successful send (for /yt and /ys).\n` +
        `• Generic URL downloads via /download are kept in workspace.\n\n` +
        `*Storage:*\n` +
        `• Workspace storage is limited by your system's available disk space.\n` +
        `• Bot requires at least ${MIN_FREE_DISK_SPACE_MB}MB of free SYSTEM disk space for smooth operation.\n` +
        `• Oldest files in workspace deleted first during auto-cleanup if system disk is critically low.\n\n` +
        `*Tips:*\n` +
        `• Files stored in: ./${WORKSPACE_PATH}\n` +
        `• For YouTube, ensure 'youtube_cookies.txt' is present and configured for best results (especially for restricted content or higher quality).\n` +
        `• Large videos are sent as documents.`
      await sock.sendMessage(remoteJid, { text: helpMessage })
      break

    default:
      await sock.sendMessage(remoteJid, { text: "❓ Unknown command. Type /help for available commands." })
  }
}

async function connectToWhatsApp(defaultMessage) {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys")
  const { version, isLatest } = await fetchLatestBaileysVersion()
  console.log(`🔄 Using WA v${version.join(".")}, isLatest: ${isLatest}`)
  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }), // 'info' or 'debug' for more logs
    printQRInTerminal: true,
    auth: state,
    msgRetryCounterMap: {}, // Default retry map
    // browser: Browsers.macOS('Desktop'), // Example of setting browser type
    patchMessageBeforeSending: (message) => { // Recommended by Baileys
      const requiresPatch = !!( message.buttonsMessage || message.templateMessage || message.listMessage );
      if (requiresPatch) { message.messageContextInfo = { deviceListMetadataVersion: 2, deviceListMetadata: {} }; }
      return message;
    },
    // defaultQueryTimeoutMs: undefined, // Keep default unless issues arise
  })

  sock.ev.on("messages.upsert", async (m) => {
    const message = m.messages[0]
    if (!message.key.fromMe && m.type === "notify" && message.message) { // Process only new messages not from self
      try {
        const remoteJid = message.key.remoteJid
        const messageText = message.message.conversation || message.message.extendedTextMessage?.text || ""
        const contactName = message.pushName || remoteJid?.split("@")[0] || "User"

        console.log(`📨 Received from ${contactName} (${remoteJid}): "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`)

        const messageInfo = { remoteJid, message, messageText: messageText.trim() }

        if (messageText.trim().startsWith("/")) {
          await handleCommand(sock, messageInfo, messageText.trim())
          return
        }
        const userState = userStates.get(remoteJid)
        if (userState) {
          if (userState.state === "selecting_search_result") {
            await handleSearchSelection(sock, messageInfo, messageText.trim())
            return
          }
          if (userState.state === "selecting_file") {
            await handleFileSelection(sock, messageInfo, messageText.trim())
            return
          }
        }
        if (messageText.trim() && defaultMessage) { // Only send default if there's text and a default message exists
          await sock.sendMessage(remoteJid, { text: defaultMessage })
          console.log(`🤖 Replied to ${contactName} with default message`)
        }
      } catch (error) {
        console.error("❌ Error processing incoming message:", error)
        // Avoid crashing the bot, maybe send an error message to user if appropriate
        // await sock.sendMessage(message.key.remoteJid, { text: "Sorry, an internal error occurred." });
      }
    }
  })

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) console.log("\n📱 Scan the QR code above with your WhatsApp. Waiting for scan...")
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && statusCode !== DisconnectReason.connectionReplaced;
      console.log(`📱 Connection closed. Reason: ${DisconnectReason[statusCode] || statusCode || 'Unknown'}. Reconnecting: ${shouldReconnect}`)
      if (shouldReconnect) {
        console.log("🔄 Attempting to reconnect...");
        connectToWhatsApp(defaultMessage); // Re-initiate connection
      } else {
        console.log("🛑 Not reconnecting (logged out or connection replaced). Please restart the bot if needed.");
        rl.close(); // Close readline if not reconnecting
        // process.exit(0); // Optional: exit if logged out
      }
    } else if (connection === "open") {
      console.log("\n✅ Enhanced WhatsApp bot is ready!")
      console.log("🔐 Session saved in auth_info_baileys folder")
      console.log(`📁 Workspace: ./${WORKSPACE_PATH} (No specific size limit, depends on system disk)`)
      console.log(`💾 Min System Disk Free for operations: ${formatBytes(MIN_FREE_DISK_SPACE_MB * 1024 * 1024)}`)
      console.log("🎥 YouTube download & search enabled (attempts FHD)")
      console.log("🧹 Smart storage & temp file management enabled")
      console.log("\n📱 Type /help for commands. Press Ctrl+C to stop.")
    }
  })

  sock.ev.on("creds.update", saveCreds)
  return sock
}

async function main() {
  console.log("🚀 Starting Enhanced WhatsApp Bot with Baileys...")
  console.log(`📁 Workspace directory: ./${WORKSPACE_PATH}`)
  console.log(`💾 Minimum system disk space for operations: ${formatBytes(MIN_FREE_DISK_SPACE_MB * 1024 * 1024)}`)
  console.log(`🔑 YouTube API Key: ${YOUTUBE_API_KEY && YOUTUBE_API_KEY !== "YOUR_YOUTUBE_API_KEY_HERE" ? "Configured" : "Not configured (Search might fail)"}`) // Update API key check

  console.log("\n🍪 Checking for YouTube cookies ('youtube_cookies.txt')...");
  if (!checkCookieFile()) {
    createSampleCookieFile(); // Creates if not found
  }

  try {
    // Initial disk space check
    const diskSpace = await checkSystemDiskSpace();
    console.log(`📊 Initial workspace usage: ${formatBytes(getDirectorySize(WORKSPACE_PATH))}`);
    console.log(`💾 Initial system disk free: ${diskSpace.formatted}`);
    if (diskSpace.available < MIN_FREE_DISK_SPACE_MB) {
      console.warn(`⚠️ Warning: System disk space is low (${diskSpace.formatted})! Consider running /cleanup after bot starts or freeing up space manually.`);
    }
  } catch (error) {
    console.warn(`⚠️ Initial storage/disk check failed: ${error.message}`);
  }

  const defaultMessage = await getUserInput()
  console.log(`🤖 Default bot response set to: "${defaultMessage.substring(0,50)}${defaultMessage.length > 50 ? '...' : ''}"`)

  try {
    const sock = await connectToWhatsApp(defaultMessage)
    process.on("SIGINT", async () => {
      console.log("\n🛑 SIGINT received, shutting down bot...")
      await sock?.end(new Error("SIGINT shutdown")); // Pass an error to indicate intentional close
      // Give a moment for graceful shutdown
      setTimeout(() => {
        console.log("✅ Bot stopped.")
        rl.close()
        process.exit(0)
      }, 1000);
    })
    process.on("SIGTERM", async () => { // Handle SIGTERM too
        console.log("\n🛑 SIGTERM received, shutting down bot...")
        await sock?.end(new Error("SIGTERM shutdown"));
        setTimeout(() => {
            console.log("✅ Bot stopped.")
            rl.close()
            process.exit(0)
        }, 1000);
    })
  } catch (error) {
    console.error("❌ Failed to initialize or connect bot:", error)
    rl.close()
    process.exit(1)
  }
}

main().catch(err => {
    console.error("❌ Unhandled error in main execution:", err);
    process.exit(1);
});