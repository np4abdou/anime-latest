const { chromium } = require('playwright');
const { PlaywrightBlocker } = require('@ghostery/adblocker-playwright');
const fetch = require('cross-fetch');
const readline = require('readline');
const fs = require('fs').promises;
const path = require('path');
const { spawn, exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

/**
 * ⚡ ULTRA-TURBO One Piece Episode Downloader with Auto-Download - Maximum Speed Edition ⚡
 */
class HyperTurboAnimeDownloader {
  constructor(options = {}) {
    this.config = {
      timeout: options.timeout || 20000,
      headless: options.headless ?? true,
      retryAttempts: options.retryAttempts || 1,
      maxConcurrent: options.maxConcurrent || 8,
      delay: options.delay || 500,
      downloadPath: options.downloadPath || './downloads',
      autoDownload: options.autoDownload ?? true,
      ...options
    };
    
    this.results = {};
    this.stats = { 
      total: 0, 
      success: 0, 
      failed: 0, 
      skipped: 0,
      downloaded: 0,
      downloadFailed: 0
    };
    this.browser = null;
    this.context = null;
    this.blocker = null;
    this.completedEpisodes = new Map();
    this.printedUpTo = 0;
    this.processedCount = 0;
    this.allEpisodes = [];
    this.downloadQueue = [];
    this.activeDownloads = new Map();
    
    // Enhanced visual elements
    this.spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.spinnerIndex = 0;
    
    // Filler episodes to skip
    this.fillerEpisodes = new Set([
      54, 55, 56, 57, 58, 59, 60,
      98, 99, 102,
      131, 132, 133, 134, 135, 136, 137, 138, 139, 140, 141, 142, 143,
      196, 197, 198, 199, 200, 201, 202, 203, 204, 205, 206,
      220, 221, 222, 223, 224, 225,
      279, 280, 281, 282, 283,
      291, 292, 303,
      317, 318, 319,
      326, 327, 328, 329, 330, 331, 332, 333, 334, 335, 336,
      382, 383, 384,
      406, 407,
      426, 427, 428, 429,
      457, 458, 492, 542,
      575, 576, 577, 578, 590,
      626, 627,
      747, 748, 749, 750,
      780, 781, 782,
      895, 896, 907,
      1029, 1030
    ]);
  }

  /**
   * 🎨 Enhanced visual banner
   */
  showBanner() {
    console.log('\n' + '='.repeat(80));
    console.log('🏴‍☠️'.repeat(20));
    console.log('⚡⚡⚡⚡ ONE PIECE TURBO DOWNLOADER + AUTO-DOWNLOAD ⚡⚡⚡⚡');
    console.log('🏴‍☠️'.repeat(20));
    console.log('='.repeat(80));
    console.log('🚀 Features: URL Extraction + Automatic Downloads');
    console.log('📁 Download Path:', this.config.downloadPath);
    console.log('🔥 Auto-Download:', this.config.autoDownload ? 'ENABLED' : 'DISABLED');
    console.log('='.repeat(80) + '\n');
  }

  /**
   * 📁 Setup download directory
   */
  async setupDownloadDirectory() {
    try {
      await fs.mkdir(this.config.downloadPath, { recursive: true });
      console.log(`📁 Download directory ready: ${this.config.downloadPath}`);
    } catch (error) {
      console.error('❌ Failed to create download directory:', error.message);
      throw error;
    }
  }

  /**
   * 🐍 Check if gdown is available
   */
  async checkGdownAvailable() {
    try {
      await execAsync('gdown --version');
      console.log('✅ gdown is available');
      return true;
    } catch (error) {
      console.log('❌ gdown not found. Please install it: pip install gdown');
      return false;
    }
  }

  /**
   * 🚀 Enhanced browser initialization
   */
  async init() {
    this.showBanner();
    
    console.log('🔥 Initializing TURBO mode...');
    
    if (this.config.autoDownload) {
      await this.setupDownloadDirectory();
      const gdownAvailable = await this.checkGdownAvailable();
      if (!gdownAvailable) {
        this.config.autoDownload = false;
        console.log('⚠️  Auto-download disabled due to missing gdown');
      }
    }
    
    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-images',
        '--disable-web-security',
        '--disable-features=TranslateUI',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-client-side-phishing-detection',
        '--disable-sync',
        '--disable-default-apps',
        '--no-first-run',
        '--disable-extensions',
        '--aggressive-cache-discard',
        '--memory-pressure-off',
        '--max_old_space_size=8192',
        '--v8-cache-options=code'
      ]
    });

    this.context = await this.browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      javaScriptEnabled: true,
      acceptDownloads: false,
      bypassCSP: true
    });

    this.blocker = await PlaywrightBlocker.fromPrebuiltAdsAndTracking(fetch);
    console.log('✅ TURBO mode ready!');
  }

  /**
   * ⚡ Ultra-aggressive resource blocking
   */
  async setupPageOptimizations(page) {
    await this.blocker.enableBlockingInPage(page);
    
    await page.route('**/*', (route) => {
      const request = route.request();
      const resourceType = request.resourceType();
      const url = request.url();

      const allowedTypes = ['document', 'script', 'xhr', 'fetch'];
      const blockedPatterns = [
        /google-analytics/i, /googletagmanager/i, /doubleclick/i, /adsystem/i,
        /facebook/i, /twitter/i, /instagram/i, /tiktok/i, /amazon-adsystem/i,
        /googlesyndication/i, /googleadservices/i, /bing\.com/i, /youtube\.com/i,
        /\.css$/i, /\.png$/i, /\.jpg$/i, /\.jpeg$/i, /\.gif$/i, /\.svg$/i,
        /\.woff/i, /\.ttf$/i, /\.ico$/i, /analytics/i, /tracking/i, /ads/i
      ];

      if (!allowedTypes.includes(resourceType) || 
          blockedPatterns.some(pattern => pattern.test(url))) {
        route.abort();
        return;
      }

      route.continue();
    });

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      delete window.caches;
      delete window.indexedDB;
    });
  }

  /**
   * 🎯 Enhanced URL conversion
   */
  convertGoogleDriveUrl(url) {
    if (!url || typeof url !== 'string') return null;
    
    const patterns = [
      /id=([a-zA-Z0-9_-]+)/,
      /\/d\/([a-zA-Z0-9_-]+)/,
      /file\/d\/([a-zA-Z0-9_-]+)/
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match) {
        const fileId = match[1];
        return `https://drive.google.com/uc?id=${fileId}&export=download`;
      }
    }
    return url;
  }

  /**
   * 🏗️ Build episode URL
   */
  buildEpisodeUrl(episodeNumber) {
    const episode = parseInt(episodeNumber);
    if (isNaN(episode) || episode < 1) throw new Error('Invalid episode number');
    return `https://witanime.cyou/episode/one-piece-%D8%A7%D9%84%D8%AD%D9%84%D9%82%D8%A9-${episode}/`;
  }

  /**
   * 🔍 Hyper-speed link extraction
   */
  async extractDownloadLinks(page) {
    return await page.evaluate(() => {
      return new Promise((resolve) => {
        const results = { mediafire: null, gdrive: null };
        const originalOpen = window.open;
        let resolved = false;
        
        const resolveResults = () => {
          if (!resolved) {
            resolved = true;
            window.open = originalOpen;
            resolve(results);
          }
        };

        const extractDirectLinks = () => {
          const links = document.querySelectorAll('a[href]');
          links.forEach(link => {
            const href = link.href;
            if (href.includes('mediafire.com') && !results.mediafire) {
              results.mediafire = href;
            }
            if (href.includes('drive.google.com') && !results.gdrive) {
              results.gdrive = href;
            }
          });
        };

        window.open = function(url, target, features) {
          if (url) {
            if (url.includes('mediafire') && !results.mediafire) {
              results.mediafire = url;
            }
            if (url.includes('drive.google.com') && !results.gdrive) {
              results.gdrive = url;
            }
          }
          return null;
        };

        const clickAllButtons = () => {
          const selectors = [
            'a.btn.btn-default.download-link',
            'a[href*="mediafire"]',
            'a[href*="drive.google.com"]',
            '.download-link',
            '.btn-download',
            'a.btn',
            'button[onclick*="mediafire"]',
            'button[onclick*="drive.google"]',
            '[onclick*="window.open"]',
            '.download-btn'
          ];
          
          selectors.forEach(selector => {
            try {
              document.querySelectorAll(selector).forEach(el => {
                el.click();
                setTimeout(() => el.click(), 100);
              });
            } catch (e) {}
          });

          const allClickable = document.querySelectorAll('a, button, .btn, [onclick], .download, [role="button"]');
          allClickable.forEach(el => {
            try {
              const text = (el.textContent || '').toLowerCase();
              const onclick = el.getAttribute('onclick') || '';
              
              if (text.includes('mediafire') || onclick.includes('mediafire') ||
                  text.includes('google') || text.includes('drive') || onclick.includes('drive') ||
                  text.includes('download') || text.includes('تحميل')) {
                el.click();
                setTimeout(() => el.click(), 50);
              }
            } catch (e) {}
          });
        };

        extractDirectLinks();
        clickAllButtons();
        
        if (results.mediafire && results.gdrive) {
          setTimeout(resolveResults, 500);
        } else {
          setTimeout(() => {
            if (!results.mediafire || !results.gdrive) {
              try {
                const pageContent = document.body.innerHTML;
                
                if (!results.mediafire) {
                  const mediafireMatch = pageContent.match(/https?:\/\/[^"'\s]*mediafire[^"'\s]*/i);
                  if (mediafireMatch) results.mediafire = mediafireMatch[0];
                }
                
                if (!results.gdrive) {
                  const driveMatch = pageContent.match(/https?:\/\/[^"'\s]*drive\.google\.com[^"'\s]*/i);
                  if (driveMatch) results.gdrive = driveMatch[0];
                }
              } catch (e) {}
            }
            resolveResults();
          }, 3000);
        }
      });
    });
  }

  /**
   * 📥 Download episode using gdown
   */
  async downloadEpisode(episodeNumber, googleDriveUrl) {
    return new Promise((resolve, reject) => {
      if (!googleDriveUrl) {
        reject(new Error('No Google Drive URL available'));
        return;
      }

      const fileName = `One_Piece_Episode_${episodeNumber.toString().padStart(4, '0')}.mp4`;
      const outputPath = path.join(this.config.downloadPath, fileName);
      
      console.log(`📥 Starting download: EP${episodeNumber.toString().padStart(4, '0')}`);
      
      const gdownProcess = spawn('gdown', [
        googleDriveUrl,
        '-O', outputPath,
        '--fuzzy'
      ], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let downloadProgress = '';
      this.activeDownloads.set(episodeNumber, {
        process: gdownProcess,
        startTime: Date.now(),
        fileName: fileName
      });

      gdownProcess.stdout.on('data', (data) => {
        downloadProgress = data.toString();
        this.updateDownloadProgress(episodeNumber, downloadProgress);
      });

      gdownProcess.stderr.on('data', (data) => {
        const errorData = data.toString();
        if (errorData.includes('%')) {
          this.updateDownloadProgress(episodeNumber, errorData);
        }
      });

      gdownProcess.on('close', (code) => {
        this.activeDownloads.delete(episodeNumber);
        
        if (code === 0) {
          this.stats.downloaded++;
          console.log(`✅ Download complete: EP${episodeNumber.toString().padStart(4, '0')} → ${fileName}`);
          resolve({ success: true, fileName });
        } else {
          this.stats.downloadFailed++;
          console.log(`❌ Download failed: EP${episodeNumber.toString().padStart(4, '0')} (Exit code: ${code})`);
          reject(new Error(`Download failed with exit code: ${code}`));
        }
      });

      gdownProcess.on('error', (error) => {
        this.activeDownloads.delete(episodeNumber);
        this.stats.downloadFailed++;
        console.log(`❌ Download error: EP${episodeNumber.toString().padStart(4, '0')} - ${error.message}`);
        reject(error);
      });
    });
  }

  /**
   * 📊 Update download progress display
   */
  updateDownloadProgress(episodeNumber, progressData) {
    const lines = progressData.split('\n');
    const progressLine = lines.find(line => line.includes('%'));
    
    if (progressLine) {
      const match = progressLine.match(/(\d+)%/);
      if (match) {
        const percent = match[1];
        const spinner = this.spinner[this.spinnerIndex % this.spinner.length];
        this.spinnerIndex++;
        
        process.stdout.write(`\r${spinner} EP${episodeNumber.toString().padStart(4, '0')} downloading... ${percent}%`);
      }
    }
  }

  /**
   * 🎬 Process single episode with auto-download
   */
  async processEpisode(episodeNumber, retryCount = 0) {
    if (this.fillerEpisodes.has(episodeNumber)) {
      this.stats.skipped++;
      this.markEpisodeComplete(episodeNumber, { skipped: true });
      return { skipped: true };
    }

    let page = null;
    
    try {
      const url = this.buildEpisodeUrl(episodeNumber);
      page = await this.context.newPage();
      
      await this.setupPageOptimizations(page);
      
      await page.goto(url, { 
        waitUntil: 'domcontentloaded', 
        timeout: this.config.timeout 
      });

      const contentFound = await page.waitForSelector(
        '.content.episode-download-container, .episode-download-container, .download-container, .episode-content',
        { timeout: 3000 }
      ).catch(() => false);

      if (!contentFound) throw new Error('Content not found');

      const downloadData = await this.extractDownloadLinks(page);
      
      const episodeResult = {};
      
      if (downloadData.mediafire) {
        episodeResult.mediafire_url = downloadData.mediafire;
      }
      
      if (downloadData.gdrive) {
        episodeResult.google_drive_url = this.convertGoogleDriveUrl(downloadData.gdrive);
      }

      this.results[`ep${episodeNumber}`] = episodeResult;
      this.stats.success++;
      
      // Auto-download if enabled and Google Drive URL is available
      if (this.config.autoDownload && episodeResult.google_drive_url) {
        try {
          const downloadResult = await this.downloadEpisode(episodeNumber, episodeResult.google_drive_url);
          episodeResult.download_status = 'completed';
          episodeResult.file_name = downloadResult.fileName;
        } catch (downloadError) {
          episodeResult.download_status = 'failed';
          episodeResult.download_error = downloadError.message;
        }
      }
      
      this.markEpisodeComplete(episodeNumber, episodeResult);
      return episodeResult;

    } catch (error) {
      if (retryCount < this.config.retryAttempts) {
        await new Promise(resolve => setTimeout(resolve, 200));
        return this.processEpisode(episodeNumber, retryCount + 1);
      }
      
      this.stats.failed++;
      this.markEpisodeComplete(episodeNumber, { error: error.message });
      throw error;
    } finally {
      if (page) await page.close();
    }
  }

  /**
   * 📝 Mark episode as complete and trigger ordered printing
   */
  markEpisodeComplete(episodeNumber, result) {
    this.completedEpisodes.set(episodeNumber, result);
    this.processedCount++;
    this.printCompletedEpisodesInOrder();
    this.showProgressUpdate();
  }

  /**
   * 🖨️ Print completed episodes in numerical order
   */
  printCompletedEpisodesInOrder() {
    while (true) {
      const nextEpisode = this.findNextEpisodeToPrint();
      if (nextEpisode === null) break;
      
      const data = this.completedEpisodes.get(nextEpisode);
      this.printEpisodeResult(nextEpisode, data);
      this.completedEpisodes.delete(nextEpisode);
      this.printedUpTo = nextEpisode;
    }
  }

  /**
   * 🔍 Find the next episode number that should be printed
   */
  findNextEpisodeToPrint() {
    const completedNumbers = Array.from(this.completedEpisodes.keys());
    const candidates = completedNumbers
      .filter(num => num > this.printedUpTo)
      .sort((a, b) => a - b);
    
    if (candidates.length === 0) return null;
    
    const nextInSequence = this.allEpisodes
      .filter(ep => ep > this.printedUpTo)
      .sort((a, b) => a - b)[0];
    
    if (candidates[0] === nextInSequence) {
      return candidates[0];
    }
    
    return null;
  }

  /**
   * 🖨️ Enhanced episode result printing
   */
  printEpisodeResult(episodeNumber, result) {
    if (result.skipped) {
      console.log(`🟡 EP${episodeNumber.toString().padStart(4, '0')} | 🚫 FILLER - SKIPPED`);
    } else if (result.error) {
      console.log(`🔴 EP${episodeNumber.toString().padStart(4, '0')} | ❌ FAILED | ${result.error}`);
    } else {
      const mfStatus = result.mediafire_url ? '✅' : '❌';
      const gdStatus = result.google_drive_url ? '✅' : '❌';
      let downloadStatus = '';
      
      if (this.config.autoDownload && result.google_drive_url) {
        if (result.download_status === 'completed') {
          downloadStatus = ' | 📥 ✅ Downloaded';
        } else if (result.download_status === 'failed') {
          downloadStatus = ' | 📥 ❌ Download Failed';
        }
      }
      
      console.log(`🟢 EP${episodeNumber.toString().padStart(4, '0')} | MediaFire ${mfStatus} | Google Drive ${gdStatus}${downloadStatus}`);
    }
  }

  /**
   * 📊 Enhanced progress update
   */
  showProgressUpdate() {
    if (this.processedCount % 5 === 0 || this.processedCount === this.stats.total) {
      const percent = Math.round((this.processedCount / this.stats.total) * 100);
      const activeDownloads = this.activeDownloads.size;
      
      console.log(`\n⚡ Progress: ${this.processedCount}/${this.stats.total} (${percent}%)`);
      if (activeDownloads > 0) {
        console.log(`📥 Active Downloads: ${activeDownloads}`);
      }
      console.log('━'.repeat(50));
    }
  }

  /**
   * 🚀 Enhanced concurrent processing
   */
  async processMultipleEpisodesTurbo(episodes) {
    const concurrent = this.config.maxConcurrent;
    console.log(`\n🔥 TURBO MODE ENGAGED`);
    console.log(`📺 Processing ${episodes.length} episodes (${concurrent} concurrent)`);
    console.log(`📥 Auto-Download: ${this.config.autoDownload ? 'ENABLED' : 'DISABLED'}\n`);
    
    this.allEpisodes = [...episodes].sort((a, b) => a - b);
    
    const canonEpisodes = episodes.filter(ep => !this.fillerEpisodes.has(ep));
    const fillerCount = episodes.length - canonEpisodes.length;
    
    if (fillerCount > 0) {
      console.log(`🟡 Skipping ${fillerCount} filler episodes automatically\n`);
      episodes.filter(ep => this.fillerEpisodes.has(ep)).forEach(ep => {
        this.stats.skipped++;
        this.markEpisodeComplete(ep, { skipped: true });
      });
    }
    
    for (let i = 0; i < canonEpisodes.length; i += concurrent) {
      const chunk = canonEpisodes.slice(i, i + concurrent);
      const chunkPromises = chunk.map(episode => 
        this.processEpisode(episode).catch(() => null)
      );
      
      await Promise.all(chunkPromises);
      
      if (i + concurrent < canonEpisodes.length) {
        await new Promise(resolve => setTimeout(resolve, this.config.delay));
      }
    }

    this.printRemainingEpisodes();
  }

  /**
   * 🖨️ Print any remaining episodes at the end
   */
  printRemainingEpisodes() {
    const remaining = Array.from(this.completedEpisodes.keys()).sort((a, b) => a - b);
    remaining.forEach(episodeNumber => {
      const data = this.completedEpisodes.get(episodeNumber);
      this.printEpisodeResult(episodeNumber, data);
    });
    this.completedEpisodes.clear();
  }

  /**
   * 💾 Enhanced JSON save
   */
  async saveResults(filename = 'one_piece_episodes.json') {
    try {
      const metadata = {
        generated_at: new Date().toISOString(),
        total_episodes: this.stats.total,
        successful: this.stats.success,
        failed: this.stats.failed,
        skipped_fillers: this.stats.skipped,
        downloaded: this.stats.downloaded,
        download_failed: this.stats.downloadFailed,
        auto_download_enabled: this.config.autoDownload,
        download_path: this.config.downloadPath,
        version: '3.0-TURBO-DOWNLOAD'
      };
      
      const orderedEpisodes = {};
      const episodeKeys = Object.keys(this.results).sort((a, b) => {
        const numA = parseInt(a.replace('ep', ''));
        const numB = parseInt(b.replace('ep', ''));
        return numA - numB;
      });
      
      episodeKeys.forEach(key => {
        orderedEpisodes[key] = this.results[key];
      });
      
      const output = {
        metadata,
        episodes: orderedEpisodes
      };
      
      await fs.writeFile(filename, JSON.stringify(output, null, 2));
      console.log(`\n💾 Results saved: ${filename}`);
    } catch (error) {
      console.error('❌ Save failed:', error.message);
    }
  }

  /**
   * 📊 Enhanced statistics display
   */
  showStats() {
    console.log('\n' + '='.repeat(80));
    console.log('📊 FINAL STATISTICS');
    console.log('='.repeat(80));
    console.log(`✅ URL Extraction Successful: ${this.stats.success}`);
    console.log(`❌ URL Extraction Failed: ${this.stats.failed}`);
    console.log(`🚫 Skipped (Fillers): ${this.stats.skipped}`);
    
    if (this.config.autoDownload) {
      console.log(`📥 Downloads Completed: ${this.stats.downloaded}`);
      console.log(`📥 Downloads Failed: ${this.stats.downloadFailed}`);
    }
    
    console.log(`📊 Total Processed: ${this.stats.total}`);
    
    const successRate = ((this.stats.success / (this.stats.total - this.stats.skipped)) * 100).toFixed(1);
    console.log(`🎯 URL Success Rate: ${successRate}%`);
    
    if (this.config.autoDownload && this.stats.success > 0) {
      const downloadRate = ((this.stats.downloaded / this.stats.success) * 100).toFixed(1);
      console.log(`📥 Download Success Rate: ${downloadRate}%`);
    }
    
    console.log('='.repeat(80));
  }

  /**
   * 🧹 Resource cleanup
   */
  async cleanup() {
    // Cancel any active downloads
    for (const [episodeNumber, downloadInfo] of this.activeDownloads) {
      console.log(`🛑 Cancelling download: EP${episodeNumber}`);
      downloadInfo.process.kill('SIGTERM');
    }
    
    if (this.browser) {
      await this.browser.close();
    }
    console.log('🧹 Cleanup complete');
  }

  /**
   * 🎮 Enhanced interactive interface
   */
  async startInteractive() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

    try {
      const choice = await question(
        '🎯 Select mode:\n' +
        '1️⃣  Single episode (TURBO + Download)\n' +
        '2️⃣  Multiple episodes (TURBO + Download)\n' +
        '3️⃣  Episode range (TURBO + Download)\n' +
        '4️⃣  HYPER-TURBO range (Max Speed + Download)\n' +
        '5️⃣  Extract URLs only (No Download)\n' +
        '\n🚀 Choice: '
      );

      let episodes = [];
      let autoDownload = this.config.autoDownload;

      if (choice === '5') {
        autoDownload = false;
        this.config.autoDownload = false;
        console.log('📋 URL extraction mode selected - downloads disabled');
      }

      switch (choice) {
        case '1':
        case '5':
          const episode = await question('📺 Episode number: ');
          episodes = [parseInt(episode)];
          break;
          
        case '2':
          const episodeList = await question('📺 Episodes (comma-separated): ');
          episodes = episodeList.split(',').map(e => parseInt(e.trim()));
          break;
          
        case '3':
        case '4':
          const start = await question('📺 Start episode: ');
          const end = await question('📺 End episode: ');
          episodes = Array.from(
            { length: parseInt(end) - parseInt(start) + 1 }, 
            (_, i) => parseInt(start) + i
          );
          
          if (choice === '4') {
            this.config.maxConcurrent = 12;
            this.config.delay = 200;
            console.log('🔥 HYPER-TURBO mode activated!');
          }
          break;
          
        default:
          throw new Error('Invalid choice');
      }

      rl.close();

      episodes = episodes.filter(e => !isNaN(e) && e > 0);
      if (episodes.length === 0) throw new Error('No valid episodes');

      this.stats.total = episodes.length;
      
      const fillerInRange = episodes.filter(ep => this.fillerEpisodes.has(ep)).length;
      const canonInRange = episodes.length - fillerInRange;
      
      console.log(`\n🎯 Target: ${episodes.length} episode(s)`);
      console.log(`📺 Canon episodes: ${canonInRange}`);
      console.log(`🚫 Filler episodes: ${fillerInRange} (will be skipped)`);
      console.log(`⚡ Mode: ${choice === '4' ? 'HYPER-TURBO' : 'TURBO'}`);
      console.log(`📥 Auto-Download: ${autoDownload ? 'ENABLED' : 'DISABLED'}\n`);

      if (episodes.length === 1) {
        await this.processEpisode(episodes[0]);
      } else {
        await this.processMultipleEpisodesTurbo(episodes);
      }

      await this.saveResults();
      this.showStats();

    } catch (error) {
      console.error('❌ Error:', error.message);
    } finally {
      rl.close?.();
    }
  }
}

// 🚀 Enhanced main execution
(async () => {
  const args = process.argv.slice(2);
  const isNoHeadless = args.includes('--nohead') || args.includes('nohead');
  const isBatch = args.includes('--batch');
  const isHyper = args.includes('--hyper');
  const noDownload = args.includes('--no-download');
  const customPath = args.find(arg => arg.startsWith('--path='));
  
  const downloadPath = customPath ? customPath.split('=')[1] : './downloads';
  
  const downloader = new HyperTurboAnimeDownloader({
    headless: !isNoHeadless,
    timeout: 18000,
    retryAttempts: 1,
    maxConcurrent: isHyper ? 12 : 8,
    delay: isHyper ? 200 : 500,
    downloadPath: downloadPath,
    autoDownload: !noDownload
  });

  // Handle Ctrl+C gracefully
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Received interrupt signal...');
    console.log('🧹 Cleaning up and saving results...');
    
    try {
      await downloader.saveResults('interrupted_results.json');
      downloader.showStats();
    } catch (error) {
      console.error('❌ Error during cleanup:', error.message);
    }
    
    await downloader.cleanup();
    process.exit(0);
  });

  try {
    await downloader.init();
    
    if (isBatch) {
      const episodes = args
        .filter(arg => !arg.startsWith('-') && !isNaN(arg))
        .map(arg => parseInt(arg));
      
      if (episodes.length > 0) {
        downloader.stats.total = episodes.length;
        console.log(`\n🚀 ${isHyper ? 'HYPER-' : ''}TURBO Batch mode: ${episodes.length} episodes\n`);
        
        await downloader.processMultipleEpisodesTurbo(episodes);
        await downloader.saveResults();
        downloader.showStats();
      } else {
        console.log('❌ No valid episode numbers provided');
        console.log('\n📖 Usage examples:');
        console.log('  node bot.js --batch 1 2 3 4 5');
        console.log('  node bot.js --batch --hyper --path=./my_downloads 100 101 102');
        console.log('  node bot.js --batch --no-download 1 2 3  # Extract URLs only');
      }
    } else {
      await downloader.startInteractive();
    }
  } catch (error) {
    console.error('💥 Fatal error:', error.message);
  } finally {
    await downloader.cleanup();
  }
})();

// 🎨 Enhanced CLI Help
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('\n' + '='.repeat(80));
  console.log('🏴‍☠️ ONE PIECE TURBO DOWNLOADER + AUTO-DOWNLOAD - HELP 🏴‍☠️');
  console.log('='.repeat(80));
  console.log('\n📖 USAGE:');
  console.log('  Interactive Mode:  node bot.js');
  console.log('  Batch Mode:       node bot.js --batch [episodes...]');
  console.log('\n🚀 OPTIONS:');
  console.log('  --batch           Batch processing mode');
  console.log('  --hyper           Enable HYPER-TURBO mode (max speed)');
  console.log('  --nohead          Run browser in non-headless mode');
  console.log('  --no-download     Extract URLs only, skip downloading');
  console.log('  --path=PATH       Custom download directory');
  console.log('  --help, -h        Show this help message');
  console.log('\n💡 EXAMPLES:');
  console.log('  node bot.js');
  console.log('  node bot.js --batch 1 2 3 4 5');
  console.log('  node bot.js --batch --hyper 100 110 120');
  console.log('  node bot.js --batch --path=./one_piece_episodes 1 5 10');
  console.log('  node bot.js --batch --no-download 1 2 3  # URLs only');
  console.log('\n📁 FEATURES:');
  console.log('  ✅ Automatic filler episode detection and skipping');
  console.log('  ✅ Concurrent processing for maximum speed');
  console.log('  ✅ Automatic Google Drive downloads using gdown');
  console.log('  ✅ Progress tracking and visual feedback');
  console.log('  ✅ Graceful interruption handling (Ctrl+C)');
  console.log('  ✅ Comprehensive statistics and reporting');
  console.log('\n📋 REQUIREMENTS:');
  console.log('  • Node.js with required packages (playwright, etc.)');
  console.log('  • Python with gdown installed: pip install gdown');
  console.log('\n' + '='.repeat(80));
  process.exit(0);
}