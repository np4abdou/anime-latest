import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "fs";
import path from "path";

// Base directory inside Pterodactyl
const BASE_DIR = path.resolve("./");
const SESSION_DIR = path.join(BASE_DIR, "auth_info_baileys");
const FILES_DIR = path.join(BASE_DIR, "files");
const TMP_DIR = path.join(BASE_DIR, "tmp");

// Ensure all directories exist
[SESSION_DIR, FILES_DIR, TMP_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Force Node.js and Baileys to use custom tmp directory
process.env.TMPDIR = TMP_DIR;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) qrcode.generate(qr, { small: true });

    if (connection === "close") {
      let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      switch (reason) {
        case DisconnectReason.badSession:
          console.log(`Bad Session. Delete ${SESSION_DIR} and scan again.`);
          process.exit();
        case DisconnectReason.connectionClosed:
        case DisconnectReason.connectionLost:
        case DisconnectReason.restartRequired:
        case DisconnectReason.timedOut:
          console.log("Reconnecting...");
          connectToWhatsApp();
          break;
        case DisconnectReason.loggedOut:
          console.log(`Logged out. Delete ${SESSION_DIR} and scan again.`);
          process.exit();
        default:
          console.log(`Unknown disconnect: ${reason}`, lastDisconnect?.error);
          connectToWhatsApp();
      }
    } else if (connection === "open") {
      console.log("✅ WhatsApp connection opened.");
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.message) return;

    const jid = msg.key.remoteJid;
    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text || "";

    if (text.toLowerCase() === "/files") {
      fs.readdir(FILES_DIR, async (err, files) => {
        if (err) {
          console.error("Error reading files:", err);
          await sock.sendMessage(jid, {
            text: "Couldn't list files.",
          });
          return;
        }

        const validFiles = files.filter((file) =>
          fs.statSync(path.join(FILES_DIR, file)).isFile()
        );

        if (validFiles.length === 0) {
          await sock.sendMessage(jid, {
            text: "No files found in the 'files' directory.",
          });
          return;
        }

        let fileList = "Choose a file by number:\n\n";
        validFiles.forEach((file, i) => {
          fileList += `${i + 1}. ${file}\n`;
        });
        fileList += "\nReply with the number of the file.";

        await sock.sendMessage(jid, { text: fileList });
      });
    } else if (!isNaN(parseInt(text)) && parseInt(text) > 0) {
      fs.readdir(FILES_DIR, async (err, files) => {
        if (err) {
          console.error("Error reading files:", err);
          await sock.sendMessage(jid, {
            text: "Couldn't process your request.",
          });
          return;
        }

        const validFiles = files.filter((file) =>
          fs.statSync(path.join(FILES_DIR, file)).isFile()
        );
        const fileIndex = parseInt(text) - 1;

        if (fileIndex >= 0 && fileIndex < validFiles.length) {
          const fileName = validFiles[fileIndex];
          const filePath = path.join(FILES_DIR, fileName);

          try {
            await sock.sendMessage(jid, {
              document: { url: filePath },
              fileName: fileName,
              mimetype: getMimetype(fileName),
            });
            await sock.sendMessage(jid, {
              text: `✅ Sent "${fileName}" successfully.`,
            });
          } catch (err) {
            console.error(`Error sending file ${fileName}:`, err);
            await sock.sendMessage(jid, {
              text: `❌ Couldn't send "${fileName}".`,
            });
          }
        } else {
          await sock.sendMessage(jid, {
            text: "❌ Invalid number. Please try again.",
          });
        }
      });
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// Helper to get file mimetypes
function getMimetype(filename) {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf": return "application/pdf";
    case ".doc":
    case ".docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xls":
    case ".xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".ppt":
    case ".pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".txt": return "text/plain";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".mp3": return "audio/mpeg";
    case ".mp4": return "video/mp4";
    default: return "application/octet-stream";
  }
}

connectToWhatsApp();
