import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import Replicate from "replicate";
import { v2 as cloudinary } from "cloudinary";

const app = express();
const PORT = process.env.PORT || 3000;

const MODEL_VERSION =
  "65f20c2c3f6c3cdd1d1a1dd8a6c87173ebe64906ee4bddf3ae7ba41d0a684325";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
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

function getExtension(filename, fallback) {
  const ext = path.extname(filename || "").toLowerCase();
  return ext || fallback;
}

async function uploadToCloudinary(filePath, folder, originalName, fallbackExt) {
  const ext = getExtension(originalName, fallbackExt);
  const publicId = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`;

  const result = await cloudinary.uploader.upload(filePath, {
    resource_type: "auto",
    public_id: publicId,
    use_filename: false,
    unique_filename: false,
    overwrite: true
  });

  return result;
}

async function destroyCloudinaryFile(result) {
  try {
    if (!result?.public_id) return;

    await cloudinary.uploader.destroy(result.public_id, {
      resource_type: result.resource_type || "image",
      invalidate: true
    });
  } catch (err) {
    console.error("CLOUDINARY DELETE ERROR:", err?.message || err);
  }
}

app.get("/", (req, res) => {
  res.json({
    status: "sync-up server running",
    mode: "cloudinary + replicate",
    model: `xconda/sync-up:${MODEL_VERSION}`
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
    let cloudinaryVideo = null;
    let cloudinaryAudio = null;

    try {
      if (!process.env.REPLICATE_API_TOKEN) {
        return res.status(500).json({
          error: "REPLICATE_API_TOKEN manquant sur Render"
        });
      }

      if (
        !process.env.CLOUDINARY_CLOUD_NAME ||
        !process.env.CLOUDINARY_API_KEY ||
        !process.env.CLOUDINARY_API_SECRET
      ) {
        return res.status(500).json({
          error: "Variables Cloudinary manquantes sur Render"
        });
      }

      if (!videoFile || !audioFile) {
        return res.status(400).json({
          error: "Vidéo ou audio manquant"
        });
      }

      console.log("SYNC-UP START");
      console.log("Original video:", videoFile.originalname);
      console.log("Original audio:", audioFile.originalname);

      cloudinaryVideo = await uploadToCloudinary(
        videoFile.path,
        "sync30/video",
        videoFile.originalname,
        ".mp4"
      );

      cloudinaryAudio = await uploadToCloudinary(
        audioFile.path,
        "sync30/audio",
        audioFile.originalname,
        ".mp3"
      );

      console.log("CLOUDINARY VIDEO URL:", cloudinaryVideo.secure_url);
      console.log("CLOUDINARY AUDIO URL:", cloudinaryAudio.secure_url);

      const prediction = await replicate.predictions.create({
        version: MODEL_VERSION,
        input: {
          video: cloudinaryVideo.secure_url,
          audio: cloudinaryAudio.secure_url,
          guidance_scale: 2,
          inference_steps: 20,
          seed: 0
        }
      });

      console.log("SYNC-UP prediction created:", prediction.id);

      let result = prediction;

      while (
        result.status !== "succeeded" &&
        result.status !== "failed" &&
        result.status !== "canceled"
      ) {
        await wait(2000);
        result = await replicate.predictions.get(prediction.id);
        console.log("SYNC-UP prediction status:", result.status);
      }

      if (result.status !== "succeeded") {
        console.error("SYNC-UP FAILED RESULT:", result);
        throw new Error(
          result.error || result.status || "Prediction failed"
        );
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

      if (!videoUrl) {
        throw new Error("Aucune URL vidéo retournée par sync-up");
      }

      outputPath = path.join("uploads", `syncup_${Date.now()}.mp4`);
      await downloadFile(videoUrl, outputPath);

      safeDelete(videoFile.path);
      safeDelete(audioFile.path);

      await destroyCloudinaryFile(cloudinaryVideo);
      await destroyCloudinaryFile(cloudinaryAudio);

      return res.download(outputPath, "sync-up.mp4", () => {
        safeDelete(outputPath);
      });
    } catch (err) {
      console.error("SYNC-UP ERROR:", err);

      safeDelete(videoFile?.path);
      safeDelete(audioFile?.path);
      safeDelete(outputPath);

      await destroyCloudinaryFile(cloudinaryVideo);
      await destroyCloudinaryFile(cloudinaryAudio);

      return res.status(500).json({
        error: "sync-up error",
        details: err.message || "Erreur inconnue"
      });
    }
  }
);

app.listen(PORT, () => {
  console.log(`Sync-up server running on ${PORT}`);
});
