import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import Replicate from "replicate";

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;
const KLING_MODEL_ID = "kwaivgi/kling-lip-sync";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

app.use(cors());
app.use(express.json());

const upload = multer({ dest: "uploads/" });

function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileToDataUrl(filePath, mimeType) {
  const base64 = fs.readFileSync(filePath, { encoding: "base64" });
  return `data:${mimeType};base64,${base64}`;
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Téléchargement sortie impossible: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

function convertVideoForKling(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .videoCodec("libx264")
      .noAudio()
      .outputOptions([
        "-preset veryfast",
        "-crf 23",
        "-pix_fmt yuv420p",
        "-r 25",
        "-movflags +faststart"
      ])
      .videoFilters("scale='min(1080,iw)':-2,setsar=1")
      .format("mp4")
      .save(outputPath)
      .on("end", resolve)
      .on("error", reject);
  });
}

function convertAudioForKling(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioChannels(1)
      .audioFrequency(44100)
      .audioBitrate("128k")
      .format("mp3")
      .save(outputPath)
      .on("end", resolve)
      .on("error", reject);
  });
}

app.get("/", (req, res) => {
  res.json({
    status: "Sync30 Kling API active",
    engines: ["kling"],
    modeInfo: {
      kling: `test ${KLING_MODEL_ID} via Replicate`
    }
  });
});

app.post(
  "/sync",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  async (req, res) => {
    const videoFile = req.files?.video?.[0];
    const audioFile = req.files?.audio?.[0];

    let normalizedVideoPath = null;
    let normalizedAudioPath = null;
    let outputPath = null;

    try {
      if (!process.env.REPLICATE_API_TOKEN) {
        return res.status(500).json({
          error: "REPLICATE_API_TOKEN manquant sur Render"
        });
      }

      if (!videoFile || !audioFile) {
        return res.status(400).json({
          error: "Vidéo ou audio manquant"
        });
      }

      normalizedVideoPath = path.join("uploads", `kling_video_${Date.now()}.mp4`);
      normalizedAudioPath = path.join("uploads", `kling_audio_${Date.now()}.mp3`);
      outputPath = path.join("uploads", `kling_output_${Date.now()}.mp4`);

      console.log("KLING START");
      console.log("Model:", KLING_MODEL_ID);
      console.log("Original video:", videoFile.originalname);
      console.log("Original audio:", audioFile.originalname);

      await convertVideoForKling(videoFile.path, normalizedVideoPath);
      await convertAudioForKling(audioFile.path, normalizedAudioPath);

      console.log("KLING video normalized:", normalizedVideoPath);
      console.log("KLING audio normalized:", normalizedAudioPath);

      const videoDataUrl = fileToDataUrl(normalizedVideoPath, "video/mp4");
      const audioDataUrl = fileToDataUrl(normalizedAudioPath, "audio/mpeg");

      const prediction = await replicate.predictions.create({
        model: KLING_MODEL_ID,
        input: {
          video_url: videoDataUrl,
          audio_file: audioDataUrl
        }
      });

      console.log("KLING prediction created:", prediction.id);

      let result = prediction;

      while (
        result.status !== "succeeded" &&
        result.status !== "failed" &&
        result.status !== "canceled"
      ) {
        await wait(2000);
        result = await replicate.predictions.get(prediction.id);
        console.log("KLING prediction status:", result.status);
      }

      if (result.status !== "succeeded") {
        console.error("KLING FAILED RESULT:", result);
        throw new Error(`Replicate status: ${result.status}`);
      }

      let videoUrl = null;

      if (typeof result.output === "string") {
        videoUrl = result.output;
      } else if (Array.isArray(result.output) && result.output.length > 0) {
        videoUrl = String(result.output[0]);
      } else if (result.output && typeof result.output.url === "function") {
        videoUrl = result.output.url();
      } else if (result.output && result.output.toString) {
        videoUrl = result.output.toString();
      }

      console.log("KLING OUTPUT URL:", videoUrl);

      if (!videoUrl) {
        throw new Error("Aucune URL vidéo retournée
