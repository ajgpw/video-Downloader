const express = require("express");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3010;

const LOG_LEVEL =
  process.env.LOG_LEVEL ||
  (process.env.NODE_ENV === "production" ? "error" : "info");
const logInfo = (...args) => {
  if (LOG_LEVEL === "info") console.log(...args);
};
const logError = (...args) => {
  console.error(...args);
};

// ダウンロード保存先を用意
const downloadsDir = path.join(__dirname, "public", "downloads");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

app.use(express.json());
app.use(express.static("public"));

// YouTube URLから動画IDを抽出・正規化
function extractYouTubeId(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.replace(/^www\./, "");
    if ((host === "youtube.com" || host === "m.youtube.com") && parsed.pathname === "/watch") {
      return parsed.searchParams.get("v");
    }
    if (host === "youtu.be" && parsed.pathname.length > 1) {
      return parsed.pathname.slice(1);
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeUrl(rawUrl) {
  const videoId = extractYouTubeId(rawUrl);
  if (videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }
  return rawUrl;
}

// ファイル名として安全な文字に整形
function sanitizeFilename(name) {
  if (!name) return "video";
  return name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

// yt-dlp 実行 (YouTube以外のフォールバック用)
function runYtDlp(args) {
  return new Promise((resolve) => {
    const ytDlp = spawn("yt-dlp", args);
    let output = "";
    let errorOutput = "";

    ytDlp.stdout.on("data", (data) => {
      output += data.toString();
    });
    ytDlp.stderr.on("data", (data) => {
      errorOutput += data.toString();
    });

    ytDlp.on("close", (code) => {
      resolve({ code, output, errorOutput });
    });
  });
}

// 画質一覧を取得
app.post("/api/info", async (req, res) => {
  const { url, browserSupport } = req.body;
  if (!url) return res.status(400).json({ error: "URLが必要です" });

  const normalizedUrl = normalizeUrl(url);
  const videoId = extractYouTubeId(url);
  logInfo(`情報取得開始: ${normalizedUrl}`);

  if (videoId) {
    // YouTubeの場合: APIからストリーム情報を取得
    try {
      logInfo(`[YouTube] APIから情報取得: ${videoId}`);
      const response = await fetch(`https://siawaseok.f5.si/api/streams/${videoId}`);
      if (!response.ok) throw new Error(`API Error: ${response.status}`);
      const data = await response.json();

      const formats = data.formats
        .filter((f) => f.vcodec !== "none") // 映像があるものを抽出
        .filter((f) => {
          if (!browserSupport) return true;
          const vcodec = (f.vcodec || "").toLowerCase();
          if (vcodec.includes("av01") && !browserSupport.av1) return false;
          if (vcodec.includes("vp9") && !browserSupport.vp9) return false;
          return true;
        })
        .map((f) => {
          return {
            id: f.itag,
            resolution: f.resolution,
            ext: f.ext || "mp4",
            vcodec: f.vcodec || "unknown",
            note: f.acodec !== "none" ? "映像+音声" : "映像のみ (自動結合)",
          };
        })
        .sort((a, b) => {
          const resA = parseInt(a.resolution.split("x")[1] || a.resolution.replace(/[^0-9]/g, "")) || 0;
          const resB = parseInt(b.resolution.split("x")[1] || b.resolution.replace(/[^0-9]/g, "")) || 0;
          return resB - resA;
        });

      return res.json({ title: data.title, normalizedUrl, formats });
    } catch (e) {
      logError(`API取得エラー:`, e.message);
      return res.status(500).json({ error: "動画情報の取得に失敗しました。", details: e.message });
    }
  } else {
    // YouTube以外の場合: yt-dlpで取得
    logInfo(`[通常] yt-dlpで取得`);
    const result = await runYtDlp([
      "--js-runtimes",
      `node:${process.execPath}`,
      "--dump-json",
      normalizedUrl,
    ]);

    if (result.code !== 0) {
      logError(`[yt-dlp 取得エラー]:`, result.errorOutput);
      return res.status(500).json({
        error: "動画情報の取得に失敗しました。",
        details: result.errorOutput,
      });
    }

    try {
      const info = JSON.parse(result.output);
      const formats = info.formats
        .filter((f) => f.vcodec !== "none" && (f.resolution || (f.width && f.height)))
        .map((f) => {
          let resStr = f.resolution;
          if (!resStr || !resStr.includes("x")) {
            resStr = f.width && f.height ? `${f.width}x${f.height}` : "0x0";
          }
          return {
            id: f.format_id,
            resolution: resStr,
            ext: f.ext,
            vcodec: f.vcodec || "unknown",
            note: f.format_note || f.format_id || "",
          };
        })
        .sort((a, b) => {
          const resA = parseInt(a.resolution.split("x")[1] || 0) || 0;
          const resB = parseInt(b.resolution.split("x")[1] || 0) || 0;
          return resB - resA;
        });

      res.json({ title: info.title, normalizedUrl, formats });
    } catch (e) {
      res.status(500).json({ error: "データの解析に失敗しました。", details: e.message });
    }
  }
});

// ダウンロードとSSE (サーバーサイド結合)
app.get("/api/download-stream", async (req, res) => {
  const { url, format, title } = req.query;
  if (!url || !format) return res.status(400).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const fileId = Date.now().toString();
  const safeTitle = sanitizeFilename(title);
  const videoId = extractYouTubeId(url);

  logInfo(`ダウンロード開始: ${url}`);

  if (videoId) {
    // === YouTubeの場合 (ffmpegによるダウンロードと結合) ===
    try {
      const response = await fetch(`https://siawaseok.f5.si/api/streams/${videoId}`);
      if (!response.ok) throw new Error("API取得に失敗しました");
      const data = await response.json();

      // 指定された映像フォーマットを探す
      const videoStream = data.formats.find((f) => String(f.itag) === String(format)) || data.formats[0];
      let audioStream = null;

      // 映像に音声が含まれていない場合、最高音質の音声のみのストリームを取得
      if (videoStream.acodec === "none") {
        audioStream = data.formats.find((f) => f.resolution === "audio only" || (f.vcodec === "none" && f.acodec !== "none"));
      }

      const outputPath = path.join(downloadsDir, `${fileId}-${safeTitle}.mp4`);
      const args = ["-y"];

      // ネットワーク切断対策
      args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
      args.push("-i", videoStream.url);

      if (audioStream) {
        logInfo(`[結合] 映像と音声を結合します (itag: ${videoStream.itag} + audio)`);
        args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5");
        args.push("-i", audioStream.url);
        args.push("-c:v", "copy", "-c:a", "copy"); // 無劣化コピー
      } else {
        logInfo(`[単一] 映像+音声ストリームをダウンロードします`);
        args.push("-c", "copy");
      }

      args.push(outputPath);

      const ffmpeg = spawn("ffmpeg", args);

      // ffmpegは全体時間が分からないとパーセントが出せないため、ダミーの進捗を送信
      let dummyPercent = 0;
      const progressInterval = setInterval(() => {
        dummyPercent += 2.5;
        if (dummyPercent > 95) dummyPercent = 95;
        res.write(`data: ${JSON.stringify({ type: "progress", percent: parseFloat(dummyPercent.toFixed(1)) })}\n\n`);
      }, 2000);

      ffmpeg.stderr.on("data", (data) => {
        // 必要に応じて ffmpeg のログを出力 (通常は進捗情報)
      });

      ffmpeg.on("close", (code) => {
        clearInterval(progressInterval);
        if (code === 0) {
          res.write(
            `data: ${JSON.stringify({
              type: "progress",
              percent: 100,
            })}\n\n`
          );
          res.write(
            `data: ${JSON.stringify({
              type: "complete",
              downloadUrl: `/downloads/${fileId}-${safeTitle}.mp4`,
            })}\n\n`
          );
        } else {
          res.write(
            `data: ${JSON.stringify({
              type: "error",
              message: "ダウンロードまたは結合中にエラーが発生しました。",
            })}\n\n`
          );
        }
        res.end();
      });
    } catch (error) {
      logError("API取得または結合エラー:", error);
      res.write(`data: ${JSON.stringify({ type: "error", message: "API通信に失敗しました。" })}\n\n`);
      res.end();
    }
  } else {
    // === YouTube以外の場合 (従来の yt-dlp 処理) ===
    const args = [
      "--js-runtimes",
      `node:${process.execPath}`,
      "-f",
      format === "best" ? "bestvideo+bestaudio/best" : `${format}+bestaudio/best`,
      "-o",
      `public/downloads/${fileId}-${safeTitle}.%(ext)s`,
      "--newline",
      url,
    ];

    const ytDlp = spawn("yt-dlp", args);
    const progressRegex = /\[download\]\s+([0-9.]+)%/;

    ytDlp.stdout.on("data", (data) => {
      const match = data.toString().match(progressRegex);
      if (match) {
        res.write(`data: ${JSON.stringify({ type: "progress", percent: parseFloat(match[1]) })}\n\n`);
      }
    });

    ytDlp.on("close", (code) => {
      if (code === 0) {
        fs.readdir(downloadsDir, (err, files) => {
          const downloadedFile = files.find((f) => f.startsWith(fileId));
          if (downloadedFile) {
            res.write(`data: ${JSON.stringify({ type: "complete", downloadUrl: `/downloads/${downloadedFile}` })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ type: "error", message: "ファイルの保存に失敗しました。" })}\n\n`);
          }
          res.end();
        });
      } else {
        res.write(`data: ${JSON.stringify({ type: "error", message: "処理中にエラーが発生しました。" })}\n\n`);
        res.end();
      }
    });
  }
});

// 定期クリーンアップ（15分経過したファイルを削除）
const CLEANUP_INTERVAL = 5 * 60 * 1000;
const FILE_MAX_AGE = 15 * 60 * 1000;

setInterval(() => {
  fs.readdir(downloadsDir, (err, files) => {
    if (err) return logError("ディレクトリの読み取りエラー:", err);

    const now = Date.now();
    files.forEach((file) => {
      const filePath = path.join(downloadsDir, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return logError(`ファイル情報取得エラー (${file}):`, err);

        if (now - stats.mtimeMs > FILE_MAX_AGE) {
          fs.unlink(filePath, (err) => {
            if (err) logError(`削除エラー (${file}):`, err);
          });
        }
      });
    });
  });
}, CLEANUP_INTERVAL);

app.listen(PORT, () => {
  logInfo(`Server running: http://localhost:${PORT}`);
  logInfo(`自動お掃除機能が有効です（15分経過したファイルを自動削除します）`);
});