import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import Replicate from "replicate";

const app = express();
const PORT = process.env.PORT || 3000;

const MODEL_VERSION =
  "569bcd925698ea23d4bece4528546992012d84267ce2438ecc803618ce23764c";

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

async function downloadFile(url, outputPath) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Téléchargement sortie impossible: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
}

app.get("/", (req, res) => {
  res.json({
    status: "Sync30 LipSync API active",
    engines: ["lipsync"],
    modeInfo: {
      lipsync: `test tmappdev/lipsync:${MODEL_VERSION} via Replicate`
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

      outputPath = path.join("uploads", `lipsync_output_${Date.now()}.mp4`);

      console.log("LIPSYNC START");
      console.log("Model version:", MODEL_VERSION);
      console.log("Original video:", videoFile.originalname);
      console.log("Original audio:", audioFile.originalname);
      console.log("Temp video path:", videoFile.path);
      console.log("Temp audio path:", audioFile.path);

      const prediction = await replicate.predictions.create({
        version: MODEL_VERSION,
        input: {
          video_input: fs.createReadStream(videoFile.path),
          audio_input: fs.createReadStream(audioFile.path)
        }
      });

      console.log("LIPSYNC prediction created:", prediction.id);

      let result = prediction;

      while (
        result.status !== "succeeded" &&
        result.status !== "failed" &&
        result.status !== "canceled"
      ) {
        await wait(2000);
        result = await replicate.predictions.get(prediction.id);
        console.log("LIPSYNC prediction status:", result.status);
      }

      if (result.status !== "succeeded") {
        console.error("LIPSYNC FAILED RESULT:", result);
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

      console.log("LIPSYNC OUTPUT URL:", videoUrl);

      if (!videoUrl) {
        throw new Error("Aucune URL vidéo retournée par LipSync");
      }

      await downloadFile(videoUrl, outputPath);

      safeDelete(videoFile.path);
      safeDelete(audioFile.path);

      return res.download(outputPath, "sync30-lipsync.mp4", () => {
        safeDelete(outputPath);
      });
    } catch (err) {
      console.error("LIPSYNC ERROR:", err);

      safeDelete(videoFile?.path);
      safeDelete(audioFile?.path);
      safeDelete(outputPath);

      return res.status(500).json({
        error: "Erreur LipSync",
        details: err.message
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Sync30 LipSync server running on port ${PORT}`);
});
