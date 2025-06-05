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
const YOUTUBE_API_KEY = "AIzaSyDVg1W8VQRSt8It1NF7yjufMiyKz4v2iX4"

// Storage management
const MAX_STORAGE_MB = 1500 // Leave 500MB free space
const CLEANUP_THRESHOLD_MB = 1200 // Start cleanup when reaching this
const MIN_FREE_DISK_SPACE_MB = 1000 // Minimum free disk space required

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
    // Get the disk where the bot is running
    const currentDir = process.cwd()

    // Use df command to get disk space info
    const { stdout } = await execAsync(`df -k "${currentDir}"`)

    // Parse the output
    const lines = stdout.trim().split("\n")
    if (lines.length < 2) {
      throw new Error("Unexpected df output format")
    }

    const parts = lines[1].split(/\s+/)
    if (parts.length < 4) {
      throw new Error("Unexpected df output format")
    }

    // Get available space in KB and convert to MB
    const availableKB = Number.parseInt(parts[3], 10)
    const availableMB = availableKB / 1024

    return {
      available: availableMB,
      availableBytes: availableKB * 1024,
      formatted: formatBytes(availableKB * 1024),
    }
  } catch (error) {
    console.error("❌ Error checking disk space:", error)
    // Fallback to Node.js method if df fails
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
      console.error("❌ Fallback disk space check failed:", fallbackError)
      throw new Error("Could not determine available disk space")
    }
  }
}

async function cleanupOldFiles() {
  try {
    const currentSize = getDirectorySize(WORKSPACE_PATH)
    const currentSizeMB = currentSize / (1024 * 1024)

    console.log(`📊 Current storage usage: ${formatBytes(currentSize)}`)

    // Check system disk space
    const diskSpace = await checkSystemDiskSpace()
    console.log(`💾 System disk space available: ${diskSpace.formatted}`)

    // If system disk space is low, be more aggressive with cleanup
    const needsAggresiveCleaning = diskSpace.available < MIN_FREE_DISK_SPACE_MB

    if (currentSizeMB > CLEANUP_THRESHOLD_MB || needsAggresiveCleaning) {
      console.log(`🧹 Starting cleanup of old files... ${needsAggresiveCleaning ? "(Aggressive mode)" : ""}`)

      const files = fs.readdirSync(WORKSPACE_PATH)
      const fileStats = files
        .map((file) => {
          const filePath = path.join(WORKSPACE_PATH, file)
          const stats = fs.statSync(filePath)
          return {
            name: file,
            path: filePath,
            mtime: stats.mtime,
            size: stats.size,
          }
        })
        .sort((a, b) => a.mtime - b.mtime) // Sort by oldest first

      let deletedSize = 0
      let deletedCount = 0

      // Target size to free up
      const targetFreeSizeMB = needsAggresiveCleaning
        ? Math.max(currentSizeMB * 0.5, MIN_FREE_DISK_SPACE_MB - diskSpace.available + 200) // Free 50% or enough to reach minimum + buffer
        : MAX_STORAGE_MB - CLEANUP_THRESHOLD_MB

      for (const file of fileStats) {
        if (deletedSize / (1024 * 1024) >= targetFreeSizeMB && !needsAggresiveCleaning) break

        // If in aggressive mode, keep deleting until we have enough space or run out of files
        if (
          needsAggresiveCleaning &&
          diskSpace.available + deletedSize / (1024 * 1024) > MIN_FREE_DISK_SPACE_MB + 500
        ) {
          break
        }

        try {
          fs.unlinkSync(file.path)
          deletedSize += file.size
          deletedCount++
          console.log(`🗑️ Deleted old file: ${file.name} (${formatBytes(file.size)})`)
        } catch (error) {
          console.error(`❌ Failed to delete ${file.name}:`, error.message)
        }
      }

      console.log(`✅ Cleanup completed: ${deletedCount} files deleted, ${formatBytes(deletedSize)} freed`)

      // Check disk space again after cleanup
      if (needsAggresiveCleaning) {
        const newDiskSpace = await checkSystemDiskSpace()
        console.log(`💾 System disk space after cleanup: ${newDiskSpace.formatted}`)
      }
    }
  } catch (error) {
    console.error("❌ Cleanup error:", error)
  }
}

// Clean up temporary files in system temp directory
async function cleanupTempFiles() {
  try {
    const tempDir = os.tmpdir()
    console.log(`🔍 Checking temporary directory: ${tempDir}`)

    // Look for files that might be related to our bot
    const { stdout } = await execAsync(
      `find "${tempDir}" -type f -name "baileys*" -o -name "wa*" -o -name "whatsapp*" -o -name "*.mp4" -o -name "*.jpg" -mtime -1 2>/dev/null || true`,
    )

    if (!stdout.trim()) {
      console.log("✅ No relevant temporary files found")
      return 0
    }

    const files = stdout.trim().split("\n")
    let deletedCount = 0
    let deletedSize = 0

    for (const filePath of files) {
      try {
        const stats = fs.statSync(filePath)
        fs.unlinkSync(filePath)
        deletedSize += stats.size
        deletedCount++
        console.log(`🗑️ Deleted temp file: ${path.basename(filePath)} (${formatBytes(stats.size)})`)
      } catch (error) {
        // Ignore errors for temp files we can't access
      }
    }

    console.log(`✅ Temp cleanup: ${deletedCount} files deleted, ${formatBytes(deletedSize)} freed`)
    return deletedCount
  } catch (error) {
    console.log(`⚠️ Temp cleanup skipped: ${error.message}`)
    return 0
  }
}

function checkStorageSpace() {
  const currentSize = getDirectorySize(WORKSPACE_PATH)
  const currentSizeMB = currentSize / (1024 * 1024)

  if (currentSizeMB > MAX_STORAGE_MB) {
    throw new Error(`Storage limit exceeded: ${formatBytes(currentSize)} / ${MAX_STORAGE_MB}MB`)
  }

  return {
    used: currentSize,
    usedMB: currentSizeMB,
    available: MAX_STORAGE_MB * 1024 * 1024 - currentSize,
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
    const response = await fetch(url)
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

    // Get video IDs for detailed stats
    const videoIds = data.items.map((item) => item.id.videoId).join(",")

    // Get video statistics (views, likes, etc.)
    const statsUrl = `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails&id=${videoIds}&key=${YOUTUBE_API_KEY}`

    const statsResponse = await fetch(statsUrl)
    const statsData = await statsResponse.json()

    if (!statsResponse.ok) {
      throw new Error(statsData.error?.message || "Failed to get video statistics")
    }

    // Combine search results with statistics
    const videos = data.items.map((item, index) => {
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
        url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
        views: stats?.statistics?.viewCount || "N/A",
        likes: stats?.statistics?.likeCount || "N/A",
        duration: stats?.contentDetails?.duration || "N/A",
      }
    })

    return { success: true, videos }
  } catch (error) {
    console.error("❌ YouTube search failed:", error.message)
    return { success: false, error: error.message }
  }
}

function formatDuration(duration) {
  if (duration === "N/A") return "N/A"

  // Parse ISO 8601 duration (PT4M13S -> 4:13)
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

  if (number >= 1000000000) {
    return (number / 1000000000).toFixed(1) + "B"
  } else if (number >= 1000000) {
    return (number / 1000000).toFixed(1) + "M"
  } else if (number >= 1000) {
    return (number / 1000).toFixed(1) + "K"
  } else {
    return number.toString()
  }
}

// Send individual video cards with thumbnails
async function sendVideoCards(sock, remoteJid, videos) {
  try {
    // Send initial message
    await sock.sendMessage(remoteJid, {
      text: `🔍 *Found ${videos.length} videos:*\n\n💡 *Reply with a number (1-${videos.length}) to download*\n❌ *Reply 'cancel' to exit*`,
    })

    // Send each video as a separate message with thumbnail
    for (let i = 0; i < videos.length; i++) {
      const video = videos[i]
      const publishDate = new Date(video.publishedAt).toLocaleDateString()
      const duration = formatDuration(video.duration)
      const views = formatNumber(video.views)
      const likes = formatNumber(video.likes)

      // Create video info text
      const videoInfo =
        `*${i + 1}.* ${video.title}\n\n` +
        `📺 *Channel:* ${video.channelTitle}\n` +
        `👀 *Views:* ${views} | 👍 *Likes:* ${likes}\n` +
        `⏱️ *Duration:* ${duration} | 📅 *Published:* ${publishDate}\n` +
        `🔗 *URL:* ${video.url}`

      try {
        // Download thumbnail
        const thumbnailBuffer = await downloadImage(video.thumbnail)

        if (thumbnailBuffer) {
          // Send image with caption
          await sock.sendMessage(remoteJid, {
            image: thumbnailBuffer,
            caption: videoInfo,
            mimetype: "image/jpeg",
          })
        } else {
          // Fallback: send text only if thumbnail fails
          await sock.sendMessage(remoteJid, {
            text: `🖼️ ${videoInfo}`,
          })
        }

        // Small delay to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 500))
      } catch (error) {
        console.error(`❌ Error sending video ${i + 1}:`, error.message)
        // Send text fallback
        await sock.sendMessage(remoteJid, {
          text: `📹 ${videoInfo}`,
        })
      }
    }

    // Send final instruction message
    await sock.sendMessage(remoteJid, {
      text: `✅ *All ${videos.length} videos loaded!*\n\n💡 *Reply with a number (1-${videos.length}) to download*\n❌ *Reply 'cancel' to exit*`,
    })
  } catch (error) {
    console.error("❌ Error sending video cards:", error)
    throw error
  }
}

// Handle search result selection with automatic download and send as document
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

  try {
    // Clear search state
    userStates.delete(remoteJid)

    // Check system disk space before download
    const diskSpace = await checkSystemDiskSpace()
    if (diskSpace.available < MIN_FREE_DISK_SPACE_MB) {
      console.log(`⚠️ Low disk space: ${diskSpace.formatted} available`)
      await cleanupTempFiles()
      await cleanupOldFiles()

      // Check again after cleanup
      const newDiskSpace = await checkSystemDiskSpace()
      if (newDiskSpace.available < MIN_FREE_DISK_SPACE_MB) {
        await sock.sendMessage(remoteJid, {
          text: `⚠️ *System disk space is low*\n\nNot enough space to download and process videos.\n\nAvailable: ${newDiskSpace.formatted}\nRequired: ${formatBytes(MIN_FREE_DISK_SPACE_MB * 1024 * 1024)}\n\nPlease try again later or contact the administrator.`,
        })
        return
      }
    }

    // Check storage before download
    await cleanupOldFiles()
    checkStorageSpace()

    // Send typing indicator
    await sock.sendPresenceUpdate("composing", remoteJid)

    // Send download start message with video details
    await sock.sendMessage(remoteJid, {
      text:
        `🎥 *Starting download...*\n\n` +
        `📹 *Title:* ${selectedVideo.title}\n` +
        `📺 *Channel:* ${selectedVideo.channelTitle}\n` +
        `⏱️ *Duration:* ${formatDuration(selectedVideo.duration)}\n\n` +
        `⏳ *Please wait, downloading in FHD quality...*`,
    })

    console.log(`📥 Starting FHD download for: ${selectedVideo.title}`)

    const result = await downloadYouTubeVideo(selectedVideo.url, true) // true for FHD

    if (result.success) {
      const filePath = path.join(WORKSPACE_PATH, result.filename)
      const fileSize = getFileSize(filePath)
      const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024)

      // Check if file is too large for available disk space
      const diskSpace = await checkSystemDiskSpace()
      if (diskSpace.available < fileSizeMB * 1.5) {
        // Need 1.5x file size for safe sending
        await sock.sendMessage(remoteJid, {
          text: `⚠️ *Not enough disk space to send this video*\n\nVideo size: ${fileSize}\nAvailable space: ${diskSpace.formatted}\n\nTry a smaller video or contact the administrator.`,
        })

        // Try to delete the downloaded file to free space
        try {
          fs.unlinkSync(filePath)
          console.log(`🗑️ Deleted file due to insufficient space: ${result.filename}`)
        } catch (deleteError) {
          console.error("❌ Error deleting file:", deleteError)
        }

        return
      }

      // Send success message
      await sock.sendMessage(remoteJid, {
        text: `✅ *Download completed!*\n\n📁 *File:* ${result.filename}\n📊 *Size:* ${fileSize}\n\n📤 *Sending as document...*`,
      })

      // Check if file exists and send it as document
      if (fs.existsSync(filePath)) {
        try {
          // Clean up temp files before sending to ensure maximum space
          await cleanupTempFiles()

          // Send file using optimized method
          await sendLargeFileAsDocument(
            sock,
            remoteJid,
            filePath,
            result.filename,
            "video/mp4",
            `🎥 *${selectedVideo.title}*\n\n📺 *Channel:* ${selectedVideo.channelTitle}\n📊 *Size:* ${fileSize}\n🎬 *Quality:* FHD 1080p\n\n📤 *Downloaded via WhatsApp Bot*`,
          )

          console.log(`📤 Sent video "${result.filename}" as document to ${remoteJid}`)

          // Delete the file locally after sending
          try {
            fs.unlinkSync(filePath)
            console.log(`🗑️ Deleted local file: ${result.filename}`)

            await sock.sendMessage(remoteJid, {
              text: `✅ *Video sent successfully!*\n\n🗑️ *Local file cleaned up to save space*`,
            })
          } catch (deleteError) {
            console.error("❌ Error deleting local file:", deleteError)
            await sock.sendMessage(remoteJid, {
              text: `✅ *Video sent successfully!*\n\n⚠️ *Note: Local file cleanup failed*`,
            })
          }
        } catch (sendError) {
          console.error("❌ Error sending video file:", sendError)
          await sock.sendMessage(remoteJid, {
            text: `❌ *Failed to send video file*\n\n📁 *File downloaded:* ${result.filename}\n📊 *Size:* ${fileSize}\n\n💡 *Use /files command to access the video*`,
          })
        }
      } else {
        await sock.sendMessage(remoteJid, {
          text: `❌ *Downloaded file not found*\n\nPlease try downloading again.`,
        })
      }
    } else {
      await sock.sendMessage(remoteJid, {
        text: `❌ *Download failed*\n\n🔴 *Error:* ${result.error}\n\n💡 *Try another video or check your connection*`,
      })
    }

    // Clear typing indicator
    await sock.sendPresenceUpdate("available", remoteJid)
  } catch (error) {
    console.error("❌ Download error:", error)
    await sock.sendMessage(remoteJid, {
      text: `❌ *Download failed*\n\n🔴 *Error:* ${error.message}\n\n💡 *Please try again later*`,
    })
    await sock.sendPresenceUpdate("available", remoteJid)
    userStates.delete(remoteJid)
  }
}

// Memory-efficient function to send large files as documents
async function sendLargeFileAsDocument(sock, remoteJid, filePath, fileName, mimeType, caption) {
  try {
    const fileStats = fs.statSync(filePath)
    const fileSizeMB = fileStats.size / (1024 * 1024)

    console.log(`📤 Sending file: ${fileName} (${fileSizeMB.toFixed(1)}MB)`)

    // Send progress message for large files
    if (fileSizeMB > 50) {
      await sock.sendMessage(remoteJid, {
        text: `📤 *Sending large file (${fileSizeMB.toFixed(1)}MB)...*\n\n⏳ *Please wait, this may take several minutes*`,
      })
    }

    // For very large files, use a different approach
    if (fileSizeMB > 200) {
      console.log(`🔄 Using optimized approach for large file: ${fileSizeMB.toFixed(1)}MB`)

      // Create a temporary file with a shorter path to avoid any path length issues
      const tempDir = os.tmpdir()
      const tempFileName = `wa_${Date.now()}_${path.basename(fileName)}`
      const tempFilePath = path.join(tempDir, tempFileName)

      // Create a read stream from the source file
      const readStream = fs.createReadStream(filePath)
      // Create a write stream to the temporary file
      const writeStream = fs.createWriteStream(tempFilePath)

      // Wait for the copy to complete
      await new Promise((resolve, reject) => {
        readStream.pipe(writeStream)
        writeStream.on("finish", resolve)
        writeStream.on("error", reject)
      })

      console.log(`✅ Created temporary file: ${tempFilePath}`)

      try {
        // Send the file from the temporary location
        await sock.sendMessage(remoteJid, {
          document: { url: tempFilePath },
          fileName: fileName,
          mimetype: mimeType,
          caption: caption,
        })

        console.log(`✅ File sent successfully from temp location: ${fileName}`)

        // Clean up the temporary file
        fs.unlinkSync(tempFilePath)
        console.log(`🗑️ Deleted temporary file: ${tempFilePath}`)

        return true
      } catch (error) {
        console.error(`❌ Error sending from temp location: ${error.message}`)

        // Clean up the temporary file if it exists
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath)
          console.log(`🗑️ Deleted temporary file after error: ${tempFilePath}`)
        }

        throw error
      }
    } else {
      // For smaller files, use the direct approach
      await sock.sendMessage(remoteJid, {
        document: { url: filePath },
        fileName: fileName,
        mimetype: mimeType,
        caption: caption,
      })

      console.log(`✅ File sent successfully: ${fileName}`)
      return true
    }
  } catch (error) {
    console.error(`❌ Error sending file: ${error.message}`)
    throw error
  }
}

// Cookie management functions
function getCookieFilePath() {
  return path.join(process.cwd(), "youtube_cookies.txt")
}

function checkCookieFile() {
  const cookiePath = getCookieFilePath()
  if (fs.existsSync(cookiePath)) {
    console.log(`✅ Found cookie file: ${cookiePath}`)
    return true
  } else {
    console.log(`❌ Cookie file not found: ${cookiePath}`)
    console.log(`📝 Please export your YouTube cookies and save them as 'youtube_cookies.txt'`)
    return false
  }
}

function createSampleCookieFile() {
  const cookiePath = getCookieFilePath()
  const sampleContent = `# Netscape HTTP Cookie File
# This is a generated file! Do not edit.

# Export your YouTube cookies from Cookie Editor extension:
# 1. Go to youtube.com and make sure you're logged in
# 2. Open Cookie Editor extension
# 3. Click "Export" button
# 4. Choose "Netscape format"
# 5. Save the content to this file: youtube_cookies.txt
# 6. Replace this sample content with your exported cookies

# Sample format (replace with your actual cookies):
# .youtube.com	TRUE	/	FALSE	1234567890	cookie_name	cookie_value
`

  try {
    fs.writeFileSync(cookiePath, sampleContent)
    console.log(`📝 Created sample cookie file: ${cookiePath}`)
    console.log(`🔧 Please follow the instructions in the file to add your YouTube cookies`)
  } catch (error) {
    console.error(`❌ Failed to create sample cookie file: ${error.message}`)
  }
}

// Enhanced YouTube download function with FHD quality and better error handling
async function downloadYouTubeVideo(videoUrl, forceFHD = false) {
  let info = null
  const cookiePath = getCookieFilePath()
  const hasCookies = checkCookieFile()

  // Base options for youtube-dl
  const baseOptions = {
    noWarnings: true,
    noCheckCertificate: true,
    preferFreeFormats: false,
    youtubeSkipDashManifest: false,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  }

  // Add cookies if available
  if (hasCookies) {
    baseOptions.cookies = cookiePath
    console.log(`🍪 Using cookies from: ${cookiePath}`)
  } else {
    console.log(`⚠️  No cookies found - may encounter bot detection`)
  }

  try {
    console.log("⏳ Fetching YouTube video info...")

    // Get video info
    info = await youtubedl(videoUrl, {
      ...baseOptions,
      dumpSingleJson: true,
    })

    const title = sanitize(info.title)
    console.log(`🎬 Title: ${info.title}`)
    console.log(`📊 Duration: ${info.duration} seconds`)
    console.log(`👀 Views: ${info.view_count || "Unknown"}`)

    // Enhanced format selection for FHD quality
    let format
    if (forceFHD) {
      // Force FHD 1080p quality
      format =
        "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]"
      console.log("🎯 Using FHD 1080p quality format")
    } else {
      // Standard quality for regular downloads
      format =
        "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/best"
      console.log("🎯 Using standard quality format")
    }

    console.log("⬇️  Downloading video...")

    const outputPath = path.join(WORKSPACE_PATH, `${title}.%(ext)s`)

    await youtubedl(videoUrl, {
      ...baseOptions,
      output: outputPath,
      format: format,
      mergeOutputFormat: "mp4",
      addMetadata: true,
      embedMetadata: true,
      retries: 3,
      fragmentRetries: 3,
      // Additional options to avoid detection
      sleepInterval: 1,
      maxSleepInterval: 5,
    })

    const finalFilename = `${title}.mp4`
    console.log(`✅ YouTube download completed: ${finalFilename}`)
    return { success: true, filename: finalFilename, title: info.title }
  } catch (err) {
    console.error("❌ YouTube download failed:", err.message)

    // Check if it's a bot detection error
    if (err.message.includes("Sign in to confirm") || err.message.includes("bot")) {
      console.log("🤖 Bot detection encountered - trying alternative methods...")

      if (!hasCookies) {
        console.log("💡 Tip: Add YouTube cookies to bypass bot detection")
        console.log("📝 Check the youtube_cookies.txt file for instructions")
        return {
          success: false,
          error: "Bot detection - Please add YouTube cookies. Check youtube_cookies.txt for instructions.",
        }
      }
    }

    // Try fallback format if the main one fails
    console.log("🔄 Trying fallback format...")
    try {
      const fallbackTitle = info?.title ? sanitize(info.title) : `video_${Date.now()}`
      const fallbackPath = path.join(WORKSPACE_PATH, `${fallbackTitle}.%(ext)s`)

      await youtubedl(videoUrl, {
        ...baseOptions,
        output: fallbackPath,
        format: "worst[ext=mp4]/worst",
        mergeOutputFormat: "mp4",
      })

      const finalFilename = `${fallbackTitle}.mp4`
      console.log("✅ Fallback YouTube download completed!")
      return { success: true, filename: finalFilename, title: fallbackTitle }
    } catch (fallbackErr) {
      console.error("❌ Fallback also failed:", fallbackErr.message)

      let errorMessage = fallbackErr.message
      if (fallbackErr.message.includes("Sign in to confirm") || fallbackErr.message.includes("bot")) {
        errorMessage =
          "YouTube bot detection - Please add cookies using Cookie Editor extension. Check youtube_cookies.txt for instructions."
      }

      return { success: false, error: errorMessage }
    }
  }
}

// Get files from workspace
function getWorkspaceFiles() {
  try {
    const files = fs.readdirSync(WORKSPACE_PATH)
    return files.filter((file) => {
      const ext = path.extname(file).toLowerCase()
      return SUPPORTED_EXTENSIONS.includes(ext)
    })
  } catch (error) {
    console.error("❌ Error reading workspace:", error)
    return []
  }
}

// Delete files from workspace
async function deleteWorkspaceFiles(fileIndices, files) {
  const results = {
    deleted: [],
    failed: [],
    notFound: [],
  }

  for (const index of fileIndices) {
    // Check if index is valid
    if (index < 0 || index >= files.length) {
      results.notFound.push(index + 1) // Convert back to 1-based index for user
      continue
    }

    const fileName = files[index]
    const filePath = path.join(WORKSPACE_PATH, fileName)

    try {
      // Check if file exists
      if (!fs.existsSync(filePath)) {
        results.notFound.push(index + 1)
        continue
      }

      // Delete the file
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

// Format file list message
function formatFileList(files) {
  if (files.length === 0) {
    return "📁 No files available in the workspace.\n\nSupported formats: " + SUPPORTED_EXTENSIONS.join(", ")
  }

  let message = "📁 *Available Files:*\n\n"
  files.forEach((file, index) => {
    const ext = path.extname(file).toLowerCase()
    const emoji = getFileEmoji(ext)
    const size = getFileSize(path.join(WORKSPACE_PATH, file))
    message += `${index + 1}. ${emoji} ${file} (${size})\n`
  })

  message += "\n💡 *Reply with a number to download that file as document*"
  message += "\n❌ *Reply 'cancel' to exit file browser*"

  return message
}

// Get emoji for file type
function getFileEmoji(extension) {
  const emojiMap = {
    ".jpg": "🖼️",
    ".jpeg": "🖼️",
    ".png": "🖼️",
    ".gif": "🖼️",
    ".pdf": "📄",
    ".txt": "📝",
    ".doc": "📄",
    ".docx": "📄",
    ".mp4": "🎥",
    ".mp3": "🎵",
  }
  return emojiMap[extension] || "📎"
}

// Get file size in human readable format
function getFileSize(filePath) {
  try {
    const stats = fs.statSync(filePath)
    const bytes = stats.size
    if (bytes === 0) return "0 B"
    const k = 1024
    const sizes = ["B", "KB", "MB", "GB"]
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return Number.parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i]
  } catch (error) {
    return "Unknown"
  }
}

// Get MIME type for file
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
  }
  return mimeTypes[ext] || "application/octet-stream"
}

// Handle file selection - now sends everything as document
async function handleFileSelection(sock, messageInfo, selection) {
  const { remoteJid } = messageInfo
  const files = getWorkspaceFiles()

  if (selection.toLowerCase() === "cancel") {
    userStates.delete(remoteJid)
    await sock.sendMessage(remoteJid, { text: "❌ File browser cancelled." })
    return
  }

  const fileIndex = Number.parseInt(selection) - 1

  if (isNaN(fileIndex) || fileIndex < 0 || fileIndex >= files.length) {
    await sock.sendMessage(remoteJid, {
      text: "❌ Invalid selection. Please enter a valid number or 'cancel'.",
    })
    return
  }

  const selectedFile = files[fileIndex]
  const filePath = path.join(WORKSPACE_PATH, selectedFile)

  try {
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      await sock.sendMessage(remoteJid, {
        text: "❌ File not found. It may have been moved or deleted.",
      })
      userStates.delete(remoteJid)
      return
    }

    // Check system disk space before sending
    const diskSpace = await checkSystemDiskSpace()
    const fileStats = fs.statSync(filePath)
    const fileSizeMB = fileStats.size / (1024 * 1024)

    if (diskSpace.available < fileSizeMB * 1.5) {
      await sock.sendMessage(remoteJid, {
        text: `⚠️ *Not enough disk space to send this file*\n\nFile size: ${getFileSize(filePath)}\nAvailable space: ${diskSpace.formatted}\n\nTry cleaning up files or contact the administrator.`,
      })
      userStates.delete(remoteJid)
      return
    }

    // Send typing indicator
    await sock.sendPresenceUpdate("composing", remoteJid)

    // Clean up temp files before sending
    await cleanupTempFiles()

    // Get file info
    const mimeType = getMimeType(filePath)
    const fileEmoji = getFileEmoji(path.extname(selectedFile).toLowerCase())
    const fileSize = getFileSize(filePath)

    // Send file directly from disk path
    await sendLargeFileAsDocument(
      sock,
      remoteJid,
      filePath,
      selectedFile,
      mimeType,
      `${fileEmoji} *${selectedFile}*\n\n📊 *Size:* ${fileSize}\n\n📤 Sent as document via WhatsApp Bot`,
    )

    console.log(`📤 Sent file "${selectedFile}" as document to ${remoteJid}`)
    userStates.delete(remoteJid)

    // Clear typing indicator
    await sock.sendPresenceUpdate("available", remoteJid)
  } catch (error) {
    console.error("❌ Error sending file:", error)
    await sock.sendMessage(remoteJid, {
      text: "❌ Sorry, there was an error sending the file. Please try again later.",
    })
    userStates.delete(remoteJid)
    await sock.sendPresenceUpdate("available", remoteJid)
  }
}

// Get filename from HTTP headers using curl
async function getFilenameFromHeaders(url) {
  try {
    // Get headers using curl -I (head request)
    const command = `curl -sIL "${url}"`
    const { stdout } = await execAsync(command)

    // Look for Content-Disposition header
    const contentDisposition = stdout.split("\n").find((line) => line.toLowerCase().startsWith("content-disposition:"))

    if (contentDisposition) {
      // Extract filename from Content-Disposition header
      const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i)
      if (filenameMatch && filenameMatch[1]) {
        let filename = filenameMatch[1].replace(/['"]/g, "")
        // Clean up the filename
        filename = filename.replace(/[<>:"/\\|?*]/g, "_")
        return filename
      }
    }

    // Look for Content-Type header to guess extension
    const contentType = stdout.split("\n").find((line) => line.toLowerCase().startsWith("content-type:"))

    if (contentType) {
      const type = contentType.toLowerCase()
      const timestamp = Date.now()

      if (type.includes("video/mp4")) return `video_${timestamp}.mp4`
      if (type.includes("video/")) return `video_${timestamp}.mp4`
      if (type.includes("audio/mpeg")) return `audio_${timestamp}.mp3`
      if (type.includes("audio/")) return `audio_${timestamp}.mp3`
      if (type.includes("image/jpeg")) return `image_${timestamp}.jpg`
      if (type.includes("image/png")) return `image_${timestamp}.png`
      if (type.includes("image/")) return `image_${timestamp}.jpg`
      if (type.includes("application/pdf")) return `document_${timestamp}.pdf`
      if (type.includes("text/")) return `text_${timestamp}.txt`
    }

    return null
  } catch (error) {
    console.log("Header fetch failed:", error.message)
    return null
  }
}

// Extract filename from URL path
function getFilenameFromUrl(url) {
  try {
    const urlObj = new URL(url)
    let filename = path.basename(urlObj.pathname)

    // Clean filename and remove query parameters
    filename = filename.split("?")[0].split("#")[0]

    // If filename exists and has extension, use it
    if (filename && filename.includes(".") && filename !== "." && !filename.startsWith(".")) {
      return filename.replace(/[<>:"/\\|?*]/g, "_")
    }

    return null
  } catch (error) {
    return null
  }
}

// Generate filename based on URL and headers
async function generateFilename(url) {
  // First try to get filename from HTTP headers
  let filename = await getFilenameFromHeaders(url)
  if (filename) {
    console.log(`📝 Filename from headers: ${filename}`)
    return filename
  }

  // Then try to extract from URL path
  filename = getFilenameFromUrl(url)
  if (filename) {
    console.log(`📝 Filename from URL: ${filename}`)
    return filename
  }

  // Finally, generate a timestamped filename
  const timestamp = Date.now()
  filename = `download_${timestamp}.bin`
  console.log(`📝 Generated filename: ${filename}`)
  return filename
}

// Download file using curl with storage management
async function downloadFile(url) {
  try {
    // Check storage before download
    await cleanupOldFiles()
    checkStorageSpace()

    // Generate appropriate filename
    const filename = await generateFilename(url)
    const outputPath = path.join(WORKSPACE_PATH, filename)

    // Use curl with follow redirects and custom user agent
    const command = `curl -L --user-agent "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" -o "${outputPath}" "${url}"`

    console.log(`📥 Downloading: ${url}`)
    console.log(`📁 Saving as: ${filename}`)

    const { stdout, stderr } = await execAsync(command)

    // Check if file was actually downloaded and has content
    if (!fs.existsSync(outputPath)) {
      throw new Error("File was not downloaded")
    }

    const stats = fs.statSync(outputPath)
    if (stats.size === 0) {
      fs.unlinkSync(outputPath) // Remove empty file
      throw new Error("Downloaded file is empty")
    }

    return { path: outputPath, filename }
  } catch (error) {
    throw new Error(`Download failed: ${error.message}`)
  }
}

// Validate YouTube URL
function isValidYouTubeUrl(url) {
  const youtubeRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|v\/)|youtu\.be\/)[a-zA-Z0-9_-]{11}/
  return youtubeRegex.test(url)
}

// Handle commands
async function handleCommand(sock, messageInfo, command) {
  const { remoteJid } = messageInfo
  const commandParts = command.split(" ")
  const mainCommand = commandParts[0].toLowerCase()

  switch (mainCommand) {
    case "/files":
      const files = getWorkspaceFiles()
      const fileList = formatFileList(files)

      if (files.length > 0) {
        userStates.set(remoteJid, { state: "selecting_file", files: files })
      }

      // Show storage info
      try {
        const storageInfo = checkStorageSpace()
        const diskSpace = await checkSystemDiskSpace()
        const storageMessage = `\n\n📊 *Storage:* ${formatBytes(storageInfo.used)} used / ${MAX_STORAGE_MB}MB limit\n💾 *System disk:* ${diskSpace.formatted} free`
        await sock.sendMessage(remoteJid, { text: fileList + storageMessage })
      } catch (error) {
        await sock.sendMessage(remoteJid, { text: fileList })
      }
      break

    case "/del":
      if (commandParts.length < 2) {
        await sock.sendMessage(remoteJid, {
          text: "❌ Please specify file numbers to delete.\n\nUsage: /del 1,2,3\n\nExample: /del 1,3,5\n\n💡 Use /files first to see the file list.",
        })
        break
      }

      // Get the current file list
      const filesToDelete = getWorkspaceFiles()

      if (filesToDelete.length === 0) {
        await sock.sendMessage(remoteJid, {
          text: "❌ No files available to delete. The workspace is empty.",
        })
        break
      }

      // Parse the file indices to delete
      const indexInput = commandParts.slice(1).join("").trim()
      let indices = []

      try {
        // Handle comma-separated values and ranges (e.g., 1,2,3 or 1-3)
        indices = indexInput.split(",").flatMap((part) => {
          part = part.trim()

          // Check if it's a range (e.g., 1-3)
          if (part.includes("-")) {
            const [start, end] = part.split("-").map((num) => Number.parseInt(num.trim()))
            if (!isNaN(start) && !isNaN(end) && start <= end) {
              return Array.from({ length: end - start + 1 }, (_, i) => start + i - 1) // Convert to 0-based index
            }
          }

          // Regular number
          const num = Number.parseInt(part)
          return !isNaN(num) ? [num - 1] : [] // Convert to 0-based index
        })

        // Remove duplicates
        indices = [...new Set(indices)]

        if (indices.length === 0) {
          throw new Error("No valid file numbers provided")
        }
      } catch (error) {
        await sock.sendMessage(remoteJid, {
          text: `❌ Invalid input: ${error.message}\n\nPlease use comma-separated numbers (e.g., 1,2,3) or ranges (e.g., 1-3).`,
        })
        break
      }

      try {
        // Send typing indicator
        await sock.sendPresenceUpdate("composing", remoteJid)

        // Confirm deletion
        await sock.sendMessage(remoteJid, {
          text: `🗑️ Deleting ${indices.length} file(s)...`,
        })

        // Delete the files
        const results = await deleteWorkspaceFiles(indices, filesToDelete)

        // Prepare result message
        let resultMessage = "🗑️ *File Deletion Results:*\n\n"

        if (results.deleted.length > 0) {
          resultMessage += "✅ *Successfully deleted:*\n"
          results.deleted.forEach((file) => {
            resultMessage += `• ${file.index}. ${file.name}\n`
          })
          resultMessage += "\n"
        }

        if (results.failed.length > 0) {
          resultMessage += "❌ *Failed to delete:*\n"
          results.failed.forEach((file) => {
            resultMessage += `• ${file.index}. ${file.name} - ${file.error}\n`
          })
          resultMessage += "\n"
        }

        if (results.notFound.length > 0) {
          resultMessage += "⚠️ *Files not found:*\n"
          resultMessage += `• File number(s): ${results.notFound.join(", ")}\n\n`
        }

        // Add summary
        resultMessage += `📊 *Summary:* ${results.deleted.length} deleted, ${results.failed.length} failed, ${results.notFound.length} not found`

        // Send result message
        await sock.sendMessage(remoteJid, { text: resultMessage })

        // Clear typing indicator
        await sock.sendPresenceUpdate("available", remoteJid)
      } catch (error) {
        console.error("❌ File deletion error:", error)
        await sock.sendMessage(remoteJid, {
          text: `❌ Error during file deletion: ${error.message}`,
        })
        await sock.sendPresenceUpdate("available", remoteJid)
      }
      break

    case "/cleanup":
      try {
        await sock.sendMessage(remoteJid, {
          text: "🧹 *Starting system cleanup...*\n\nThis will free up disk space by removing temporary files and old downloads.",
        })

        // Clean up temp files
        const tempFilesDeleted = await cleanupTempFiles()

        // Clean up workspace files
        await cleanupOldFiles()

        // Get current disk space
        const diskSpace = await checkSystemDiskSpace()

        await sock.sendMessage(remoteJid, {
          text: `✅ *Cleanup completed!*\n\n🗑️ Removed ${tempFilesDeleted} temporary files\n💾 Current free disk space: ${diskSpace.formatted}`,
        })
      } catch (error) {
        console.error("❌ Cleanup error:", error)
        await sock.sendMessage(remoteJid, {
          text: `❌ Cleanup error: ${error.message}`,
        })
      }
      break

    case "/ys":
      if (commandParts.length < 2) {
        await sock.sendMessage(remoteJid, {
          text: "❌ Please provide a search query.\n\nUsage: /ys <search query>\n\nExample: /ys funny cat videos",
        })
        break
      }

      const searchQuery = commandParts.slice(1).join(" ").trim()

      try {
        // Check disk space before search
        const diskSpace = await checkSystemDiskSpace()
        if (diskSpace.available < MIN_FREE_DISK_SPACE_MB) {
          await sock.sendMessage(remoteJid, {
            text: `⚠️ *Low disk space detected*\n\nNot enough space to download videos.\n\nAvailable: ${diskSpace.formatted}\nRequired: ${formatBytes(MIN_FREE_DISK_SPACE_MB * 1024 * 1024)}\n\nUse /cleanup to free up space.`,
          })
          break
        }

        // Send typing indicator
        await sock.sendPresenceUpdate("composing", remoteJid)

        await sock.sendMessage(remoteJid, {
          text: `🔍 *Searching YouTube for:* "${searchQuery}"\n\n⏳ *Please wait while I find the best videos...*`,
        })

        const searchResult = await searchYouTubeVideos(searchQuery, 20)

        if (searchResult.success) {
          // Store search results in user state
          userStates.set(remoteJid, {
            state: "selecting_search_result",
            searchResults: searchResult.videos,
          })

          // Send video cards with thumbnails
          await sendVideoCards(sock, remoteJid, searchResult.videos)

          console.log(`🔍 Search completed for "${searchQuery}" - ${searchResult.videos.length} results sent`)
        } else {
          await sock.sendMessage(remoteJid, {
            text: `❌ *Search failed:* ${searchResult.error}\n\n💡 *Try a different search query*`,
          })
        }

        // Clear typing indicator
        await sock.sendPresenceUpdate("available", remoteJid)
      } catch (error) {
        console.error("❌ Search error:", error)
        await sock.sendMessage(remoteJid, {
          text: `❌ *Search failed:* ${error.message}\n\n💡 *Please try again later*`,
        })
        await sock.sendPresenceUpdate("available", remoteJid)
      }
      break

    case "/yt":
      if (commandParts.length < 2) {
        await sock.sendMessage(remoteJid, {
          text: "❌ Please provide a YouTube URL to download.\n\nUsage: /yt <youtube-url>\n\nExample: /yt https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        })
        break
      }

      const ytUrl = commandParts.slice(1).join(" ").trim()

      // Validate YouTube URL
      if (!isValidYouTubeUrl(ytUrl)) {
        await sock.sendMessage(remoteJid, {
          text: "❌ Invalid YouTube URL. Please provide a valid YouTube video URL.\n\nSupported formats:\n• https://www.youtube.com/watch?v=VIDEO_ID\n• https://youtu.be/VIDEO_ID",
        })
        break
      }

      try {
        // Check disk space before download
        const diskSpace = await checkSystemDiskSpace()
        if (diskSpace.available < MIN_FREE_DISK_SPACE_MB) {
          await sock.sendMessage(remoteJid, {
            text: `⚠️ *Low disk space detected*\n\nNot enough space to download videos.\n\nAvailable: ${diskSpace.formatted}\nRequired: ${formatBytes(MIN_FREE_DISK_SPACE_MB * 1024 * 1024)}\n\nUse /cleanup to free up space.`,
          })
          break
        }

        // Clean up temp files before download
        await cleanupTempFiles()

        // Check storage before download
        await cleanupOldFiles()
        checkStorageSpace()

        // Send typing indicator
        await sock.sendPresenceUpdate("composing", remoteJid)

        await sock.sendMessage(remoteJid, {
          text: "🎥 Starting YouTube video download in FHD quality... Please wait, this may take a few minutes.",
        })

        const result = await downloadYouTubeVideo(ytUrl, true) // true for FHD

        if (result.success) {
          const filePath = path.join(WORKSPACE_PATH, result.filename)
          const fileSize = getFileSize(filePath)
          const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024)

          // Check if file is too large for available disk space
          const diskSpace = await checkSystemDiskSpace()
          if (diskSpace.available < fileSizeMB * 1.5) {
            await sock.sendMessage(remoteJid, {
              text: `⚠️ *Not enough disk space to send this video*\n\nVideo size: ${fileSize}\nAvailable space: ${diskSpace.formatted}\n\nTry a smaller video or use /cleanup to free space.`,
            })

            // Try to delete the downloaded file to free space
            try {
              fs.unlinkSync(filePath)
              console.log(`🗑️ Deleted file due to insufficient space: ${result.filename}`)
            } catch (deleteError) {
              console.error("❌ Error deleting file:", deleteError)
            }

            break
          }

          // Send the video as document automatically
          if (fs.existsSync(filePath)) {
            try {
              // Clean up temp files before sending
              await cleanupTempFiles()

              // Send file directly from disk path
              await sendLargeFileAsDocument(
                sock,
                remoteJid,
                filePath,
                result.filename,
                "video/mp4",
                `🎥 *${result.title}*\n\n📊 *Size:* ${fileSize}\n🎬 *Quality:* FHD 1080p\n\n📤 *Downloaded via WhatsApp Bot*`,
              )

              console.log(`📤 Sent video "${result.filename}" as document to ${remoteJid}`)

              // Delete local file after sending
              try {
                fs.unlinkSync(filePath)
                console.log(`🗑️ Deleted local file: ${result.filename}`)

                await sock.sendMessage(remoteJid, {
                  text: `✅ *Video sent successfully!*\n\n🗑️ *Local file cleaned up to save space*`,
                })
              } catch (deleteError) {
                console.error("❌ Error deleting local file:", deleteError)

                await sock.sendMessage(remoteJid, {
                  text: `✅ *Video sent successfully!*\n\n⚠️ *Note: Local file cleanup failed*`,
                })
              }
            } catch (sendError) {
              console.error("❌ Error sending video file:", sendError)

              await sock.sendMessage(remoteJid, {
                text: `❌ *Failed to send video file*\n\n📁 *File downloaded:* ${result.filename}\n📊 *Size:* ${fileSize}\n\n💡 *Use /files command to access the video*`,
              })
            }
          } else {
            await sock.sendMessage(remoteJid, {
              text: `❌ *Downloaded file not found*\n\nPlease try downloading again.`,
            })
          }
        } else {
          await sock.sendMessage(remoteJid, {
            text: `❌ YouTube download failed: ${result.error}\n\nPlease check the URL and try again.`,
          })
        }

        // Clear typing indicator
        await sock.sendPresenceUpdate("available", remoteJid)
      } catch (error) {
        console.error("❌ YouTube download error:", error)
        await sock.sendMessage(remoteJid, {
          text: `❌ YouTube download failed: ${error.message}\n\nPlease check the URL and try again.`,
        })
        await sock.sendPresenceUpdate("available", remoteJid)
      }
      break

    case "/download":
      if (commandParts.length < 2) {
        await sock.sendMessage(remoteJid, {
          text: "❌ Please provide a URL to download.\n\nUsage: /download <url>\n\nExample: /download https://example.com/file.pdf",
        })
        break
      }

      const url = commandParts.slice(1).join(" ").trim()

      // Basic URL validation
      if (!url.startsWith("http://") && !url.startsWith("https://")) {
        await sock.sendMessage(remoteJid, {
          text: "❌ Invalid URL. Please provide a valid HTTP or HTTPS URL.",
        })
        break
      }

      try {
        // Send typing indicator
        await sock.sendPresenceUpdate("composing", remoteJid)

        await sock.sendMessage(remoteJid, {
          text: "📥 Starting download... Please wait.",
        })

        const result = await downloadFile(url)
        const fileSize = getFileSize(result.path)

        await sock.sendMessage(remoteJid, {
          text: `✅ Download completed!\n\n📁 File: ${result.filename}\n📊 Size: ${fileSize}\n\n💡 Use /files to access the downloaded file.`,
        })

        console.log(`✅ Downloaded: ${result.filename} (${fileSize})`)

        // Clear typing indicator
        await sock.sendPresenceUpdate("available", remoteJid)
      } catch (error) {
        console.error("❌ Download error:", error)
        await sock.sendMessage(remoteJid, {
          text: `❌ Download failed: ${error.message}\n\nPlease check the URL and try again.`,
        })
        await sock.sendPresenceUpdate("available", remoteJid)
      }
      break

    case "/storage":
      try {
        const storageInfo = checkStorageSpace()
        const diskSpace = await checkSystemDiskSpace()
        const storageMessage =
          `📊 *Storage Information:*\n\n` +
          `💾 *Used:* ${formatBytes(storageInfo.used)}\n` +
          `📈 *Limit:* ${MAX_STORAGE_MB}MB\n` +
          `📉 *Available:* ${formatBytes(storageInfo.available)}\n` +
          `📋 *Usage:* ${((storageInfo.usedMB / MAX_STORAGE_MB) * 100).toFixed(1)}%\n\n` +
          `💽 *System Disk:*\n` +
          `📉 *Free space:* ${diskSpace.formatted}\n` +
          `⚠️ *Minimum required:* ${formatBytes(MIN_FREE_DISK_SPACE_MB * 1024 * 1024)}\n\n` +
          `🧹 *Auto-cleanup:* Enabled at ${CLEANUP_THRESHOLD_MB}MB\n` +
          `📁 *Files:* ${getWorkspaceFiles().length} files in workspace\n\n` +
          `💡 *Use /cleanup to free up disk space*`

        await sock.sendMessage(remoteJid, { text: storageMessage })
      } catch (error) {
        await sock.sendMessage(remoteJid, {
          text: `❌ Storage check failed: ${error.message}`,
        })
      }
      break

    case "/help":
      const helpMessage =
        `🤖 *WhatsApp Bot Help*\n\n` +
        `*Available Commands:*\n` +
        `• /files - Browse and download files as documents\n` +
        `• /del <numbers> - Delete files (e.g., /del 1,2,3)\n` +
        `• /download <url> - Download file from URL\n` +
        `• /yt <youtube-url> - Download YouTube video in FHD\n` +
        `• /ys <search-query> - Search & download YouTube videos\n` +
        `• /storage - Check storage usage\n` +
        `• /cleanup - Free up disk space\n` +
        `• /help - Show this help message\n\n` +
        `*File Sharing:*\n` +
        `• All files sent as documents (up to 2GB)\n` +
        `• Videos sent as documents to support large files\n` +
        `• Supports: ${SUPPORTED_EXTENSIONS.join(", ")}\n` +
        `• Auto-cleanup when storage is full\n\n` +
        `*Download Features:*\n` +
        `• Regular downloads using curl\n` +
        `• YouTube videos in FHD 1080p quality\n` +
        `• Auto-delete after sending (for /ys)\n` +
        `• Smart storage management\n` +
        `• Large video support (up to 2GB as documents)\n\n` +
        `*YouTube Features:*\n` +
        `• Search up to 20 videos with thumbnails\n` +
        `• Automatic FHD download and send as document\n` +
        `• Local file cleanup after sending\n` +
        `• Direct URL downloads in FHD quality\n` +
        `• Supports large videos (sent as documents)\n\n` +
        `*Storage Management:*\n` +
        `• Limit: ${MAX_STORAGE_MB}MB\n` +
        `• Auto-cleanup at ${CLEANUP_THRESHOLD_MB}MB\n` +
        `• Oldest files deleted first\n` +
        `• Use /storage to check usage\n` +
        `• Use /cleanup to free disk space\n\n` +
        `*Tips:*\n` +
        `• Files stored in: ${WORKSPACE_PATH}\n` +
        `• Use numbers to select files/videos\n` +
        `• Type 'cancel' to exit browsers\n` +
        `• /ys downloads and sends automatically\n` +
        `• Large videos sent as documents (2GB limit)\n` +
        `• Use /cleanup if you get disk space errors`

      await sock.sendMessage(remoteJid, { text: helpMessage })
      break

    default:
      await sock.sendMessage(remoteJid, {
        text: "❓ Unknown command. Type /help for available commands.",
      })
  }
}

// Create connection function
async function connectToWhatsApp(defaultMessage) {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys")
  const { version, isLatest } = await fetchLatestBaileysVersion()

  console.log(`🔄 Using WA v${version.join(".")}, isLatest: ${isLatest}`)

  const msgRetryCounterMap = {}

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }), // Set to 'debug' for more logs
    printQRInTerminal: true,
    auth: state,
    // Increase message retry count for large files
    msgRetryCounterMap,
    // Increase timeout for large file transfers
    patchMessageBeforeSending: (message) => {
      const requiresPatch = !!(
        message.imageMessage ||
        message.videoMessage ||
        message.documentMessage ||
        message.audioMessage
      )
      if (requiresPatch) {
        message.messageContextInfo = {
          messageSecret: crypto.randomBytes(32).toString("base64"),
        }
      }
      return message
    },
  })

  // Handle incoming messages
  const handleMessagesUpsert = async (messages) => {
    if (!messages) return

    const message = messages[0]

    if (!message.key.fromMe && message.message) {
      try {
        const remoteJid = message.key.remoteJid
        const messageText = message.message.conversation || message.message.extendedTextMessage?.text || ""

        // Get contact info
        const contactName = message.pushName || remoteJid?.split("@")[0] || "Unknown"

        console.log(`📨 Received from ${contactName}: "${messageText}"`)

        const messageInfo = {
          remoteJid,
          message,
          messageText: messageText.trim(),
        }

        // Handle commands FIRST (before checking any selection state)
        if (messageText.trim().startsWith("/")) {
          await handleCommand(sock, messageInfo, messageText.trim())
          return
        }

        // Check if user is in search result selection mode
        if (userStates.has(remoteJid) && userStates.get(remoteJid).state === "selecting_search_result") {
          await handleSearchSelection(sock, messageInfo, messageText.trim())
          return
        }

        // Check if user is in file selection mode
        if (userStates.has(remoteJid) && userStates.get(remoteJid).state === "selecting_file") {
          await handleFileSelection(sock, messageInfo, messageText.trim())
          return
        }

        // Default response for non-command messages
        if (messageText.trim()) {
          await sock.sendMessage(remoteJid, { text: defaultMessage })
          console.log(`🤖 Replied to ${contactName} with default message`)
        }
      } catch (error) {
        console.error("❌ Error handling message:", error)
      }
    }
  }

  // Handle connection updates
  const connectionUpdateHandler = async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log("\n📱 Scan the QR code above with your WhatsApp")
      console.log("⏳ Waiting for QR code scan...")
    }

    if (connection === "close") {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log("📱 Connection closed due to:", lastDisconnect?.error, ", reconnecting:", shouldReconnect)

      if (shouldReconnect) {
        console.log("🔄 Reconnecting...")
        connectToWhatsApp(defaultMessage)
      }
    } else if (connection === "open") {
      console.log("\n✅ Enhanced WhatsApp bot is ready!")
      console.log("🔐 Session saved in auth_info_baileys folder")
      console.log("📁 File sharing enabled (all as documents)")
      console.log("🎥 YouTube download enabled (FHD 1080p)")
      console.log("🔍 YouTube search enabled with auto-send")
      console.log("🧹 Smart storage management enabled")
      console.log(`📊 Storage limit: ${MAX_STORAGE_MB}MB`)
      console.log("\n📱 Available commands:")
      console.log("   • /files - Browse files")
      console.log("   • /del <numbers> - Delete files")
      console.log("   • /yt <url> - Download YouTube video (FHD)")
      console.log("   • /ys <query> - Search & download YouTube videos")
      console.log("   • /storage - Check storage usage")
      console.log("   • /cleanup - Free up disk space")
      console.log("   • /help - Show help")
      console.log("\n🛑 Press Ctrl+C to stop the bot")
    }
  }

  // Save credentials whenever updated
  const credsUpdateHandler = (creds) => {
    saveCreds(creds)
  }

  sock.ev.on("messages.upsert", (m) => handleMessagesUpsert(m.messages))
  sock.ev.on("connection.update", connectionUpdateHandler)
  sock.ev.on("creds.update", credsUpdateHandler)

  return sock
}

// Main function
async function main() {
  console.log("🚀 Starting Enhanced WhatsApp Bot with Baileys...")
  console.log(`📁 Workspace directory: ${WORKSPACE_PATH}`)
  console.log("📁 Session will be saved in auth_info_baileys folder")
  console.log("🎥 YouTube download feature enabled (FHD 1080p)")
  console.log("🔍 YouTube search feature enabled with auto-send")
  console.log("📤 All files sent as documents")
  console.log("🧹 Smart storage management enabled")
  console.log(`📊 Storage limit: ${MAX_STORAGE_MB}MB`)
  console.log(`💾 Minimum disk space required: ${formatBytes(MIN_FREE_DISK_SPACE_MB * 1024 * 1024)}`)
  console.log(`🔑 YouTube API Key: ${YOUTUBE_API_KEY ? "Configured" : "Not configured"}`)

  // Check for YouTube cookies
  console.log("\n🍪 Checking YouTube cookies...")
  const hasCookies = checkCookieFile()
  if (!hasCookies) {
    createSampleCookieFile()
    console.log("⚠️  YouTube downloads may fail due to bot detection without cookies")
  }

  // Initial storage check
  try {
    const storageInfo = checkStorageSpace()
    console.log(`📊 Current storage: ${formatBytes(storageInfo.used)} / ${MAX_STORAGE_MB}MB`)

    const diskSpace = await checkSystemDiskSpace()
    console.log(`💾 System disk space: ${diskSpace.formatted} free`)

    if (diskSpace.available < MIN_FREE_DISK_SPACE_MB) {
      console.log(`⚠️  Warning: Low disk space! Consider running cleanup.`)
    }
  } catch (error) {
    console.log(`⚠️  Storage check: ${error.message}`)
  }

  // Get the default message from user
  const defaultMessage = await getUserInput()
  console.log(`🤖 Default bot response: "${defaultMessage}"`)

  try {
    const sock = await connectToWhatsApp(defaultMessage)

    // Graceful shutdown
    process.on("SIGINT", async () => {
      console.log("\n🛑 Shutting down bot...")
      try {
        sock?.end()
        console.log("✅ Bot stopped successfully")
      } catch (error) {
        console.error("❌ Error during shutdown:", error)
      }
      rl.close()
      process.exit(0)
    })
  } catch (error) {
    console.error("❌ Failed to initialize bot:", error)
    rl.close()
    process.exit(1)
  }
}

// Start the bot
main().catch(console.error)
