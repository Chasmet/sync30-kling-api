import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import Replicate from "replicate";
import { v2 as cloudinary } from "cloudinary";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

const MODEL_VERSION =
  "65f20c2c3f6c3cdd1d1a1dd8a6c87173ebe64906ee4bddf3ae7ba41d0a684325";

const SUPABASE_BUCKET = "videos";
const ENGINE_FOLDER = "syncup";
const MAX_SYNCUP_VIDEOS = 5;

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

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

function sleep(ms) {
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

function sanitizeFileName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

function normalizeEngineFolder(engine) {
  return engine === "syncup" ? "syncup" : engine;
}

async function uploadToCloudinary(filePath, folder, originalName, fallbackExt) {
  const ext = getExtension(originalName, fallbackExt);
  const publicId = `${folder}/${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 10)}${ext}`;

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

async function createJob(engine = "syncup") {
  const { data, error } = await supabase
    .from("jobs")
    .insert([{ status: "processing", engine }])
    .select()
    .single();

  if (error) {
    throw new Error(`Création job impossible: ${error.message}`);
  }

  return data;
}

async function updateJob(jobId, patch) {
  if (!jobId) return;

  const { error } = await supabase
    .from("jobs")
    .update(patch)
    .eq("id", jobId);

  if (error) {
    console.error("SUPABASE JOB UPDATE ERROR:", error.message);
  }
}

async function uploadResultToSupabase(filePath, originalName, engine = ENGINE_FOLDER) {
  const fileBuffer = fs.readFileSync(filePath);
  const cleanName = sanitizeFileName(
    originalName?.replace(/\.[^/.]+$/, "") || `${engine}-result`
  );
  const finalPath = `${engine}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}-${cleanName}.mp4`;

  const { error: uploadError } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .upload(finalPath, fileBuffer, {
      contentType: "video/mp4",
      upsert: false,
      cacheControl: "3600"
    });

  if (uploadError) {
    throw new Error(`Upload Supabase impossible: ${uploadError.message}`);
  }

  const { data } = supabase.storage
    .from(SUPABASE_BUCKET)
    .getPublicUrl(finalPath);

  return {
    path: finalPath,
    publicUrl: data?.publicUrl || null
  };
}

async function downloadFromSupabase(storagePath) {
  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .download(storagePath);

  if (error) {
    throw new Error(`Lecture Supabase impossible: ${error.message}`);
  }

  if (!data) {
    throw new Error("Fichier Supabase introuvable");
  }

  const arrayBuffer = await data.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function listEngineVideos(engine = ENGINE_FOLDER) {
  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .list(engine, {
      limit: 100,
      offset: 0,
      sortBy: { column: "created_at", order: "desc" }
    });

  if (error) {
    throw new Error(`Liste vidéos impossible: ${error.message}`);
  }

  return data || [];
}

async function deleteStoragePaths(storagePaths = []) {
  if (!Array.isArray(storagePaths) || storagePaths.length === 0) return;

  const { data, error } = await supabase.storage
    .from(SUPABASE_BUCKET)
    .remove(storagePaths);

  if (error) {
    throw new Error(`Suppression Supabase impossible: ${error.message}`);
  }

  return data || [];
}

async function enforceVideoLimit(engine = ENGINE_FOLDER, maxVideos = MAX_SYNCUP_VIDEOS) {
  const items = await listEngineVideos(engine);

  if (items.length <= maxVideos) {
    return { deleted: [] };
  }

  const sortedOldestFirst = [...items].sort((a, b) => {
    const dateA = new Date(a.created_at || 0).getTime();
    const dateB = new Date(b.created_at || 0).getTime();
    return dateA - dateB;
  });

  const toDelete = sortedOldestFirst.slice(0, items.length - maxVideos);
  const storagePaths = toDelete.map((item) => `${engine}/${item.name}`);

  await deleteStoragePaths(storagePaths);

  return { deleted: storagePaths };
}

app.get("/", (req, res) => {
  res.json({
    status: "sync-up server running",
    mode: "cloudinary + replicate + supabase",
    model: `xconda/sync-up:${MODEL_VERSION}`,
    storageLimit: MAX_SYNCUP_VIDEOS
  });
});

app.get("/jobs", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json({
      ok: true,
      jobs: data || []
    });
  } catch (err) {
    return res.status(500).json({
      error: "jobs_list_error",
      details: err.message || "Erreur inconnue"
    });
  }
});

app.get("/jobs/:id", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("jobs")
      .select("*")
      .eq("id", req.params.id)
      .single();

    if (error) throw error;

    return res.json({
      ok: true,
      job: data
    });
  } catch (err) {
    return res.status(404).json({
      error: "job_not_found",
      details: err.message || "Job introuvable"
    });
  }
});

app.get("/video/:engine/:name", async (req, res) => {
  try {
    const engine = normalizeEngineFolder(req.params.engine);
    const name = decodeURIComponent(req.params.name || "");

    if (!name) {
      return res.status(400).json({
        error: "missing_name",
        details: "Nom de fichier manquant"
      });
    }

    const storagePath = `${engine}/${name}`;
    const fileBuffer = await downloadFromSupabase(storagePath);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", fileBuffer.length);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Disposition", `inline; filename="${name}"`);

    return res.send(fileBuffer);
  } catch (err) {
    return res.status(404).json({
      error: "video_read_error",
      details: err.message || "Lecture impossible"
    });
  }
});

app.get("/download/:engine/:name", async (req, res) => {
  try {
    const engine = normalizeEngineFolder(req.params.engine);
    const name = decodeURIComponent(req.params.name || "");

    if (!name) {
      return res.status(400).json({
        error: "missing_name",
        details: "Nom de fichier manquant"
      });
    }

    const storagePath = `${engine}/${name}`;
    const fileBuffer = await downloadFromSupabase(storagePath);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", fileBuffer.length);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);

    return res.send(fileBuffer);
  } catch (err) {
    return res.status(404).json({
      error: "video_download_error",
      details: err.message || "Téléchargement impossible"
    });
  }
});

app.get("/videos", async (req, res) => {
  try {
    const items = await listEngineVideos(ENGINE_FOLDER);
    const baseUrl = getBaseUrl(req);

    const videos = items.map((item) => {
      const encodedName = encodeURIComponent(item.name);

      return {
        name: item.name,
        created_at: item.created_at,
        updated_at: item.updated_at,
        metadata: item.metadata,
        path: `${ENGINE_FOLDER}/${item.name}`,
        playUrl: `${baseUrl}/video/${ENGINE_FOLDER}/${encodedName}`,
        downloadUrl: `${baseUrl}/download/${ENGINE_FOLDER}/${encodedName}`
      };
    });

    return res.json({
      ok: true,
      limit: MAX_SYNCUP_VIDEOS,
      count: videos.length,
      videos
    });
  } catch (err) {
    return res.status(500).json({
      error: "videos_list_error",
      details: err.message || "Erreur inconnue"
    });
  }
});

app.delete("/video/:engine/:name", async (req, res) => {
  try {
    const engine = normalizeEngineFolder(req.params.engine);
    const name = decodeURIComponent(req.params.name || "");

    if (!name) {
      return res.status(400).json({
        error: "missing_name",
        details: "Nom de fichier manquant"
      });
    }

    const storagePath = `${engine}/${name}`;
    await deleteStoragePaths([storagePath]);

    return res.json({
      ok: true,
      deleted: storagePath
    });
  } catch (err) {
    return res.status(500).json({
      error: "video_delete_error",
      details: err.message || "Suppression impossible"
    });
  }
});

app.post("/delete-video", async (req, res) => {
  try {
    const engine = normalizeEngineFolder(req.body?.engine || ENGINE_FOLDER);
    const name = String(req.body?.name || "").trim();

    if (!name) {
      return res.status(400).json({
        error: "missing_name",
        details: "Nom de fichier manquant"
      });
    }

    const storagePath = `${engine}/${name}`;
    await deleteStoragePaths([storagePath]);

    return res.json({
      ok: true,
      deleted: storagePath
    });
  } catch (err) {
    return res.status(500).json({
      error: "video_delete_error",
      details: err.message || "Suppression impossible"
    });
  }
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
    let jobId = null;

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

      if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({
          error: "Variables Supabase manquantes sur Render"
        });
      }

      if (!videoFile || !audioFile) {
        return res.status(400).json({
          error: "Vidéo ou audio manquant"
        });
      }

      const job = await createJob(ENGINE_FOLDER);
      jobId = job.id;

      console.log("SYNC-UP START");
      console.log("JOB ID:", jobId);
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

        await updateJob(jobId, {
          status: "error",
          error_message: result.error || result.status || "Prediction failed"
        });

        throw new Error(result.error || result.status || "Prediction failed");
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
        await updateJob(jobId, {
          status: "error",
          error_message: "Aucune URL vidéo retournée par sync-up"
        });

        throw new Error("Aucune URL vidéo retournée par sync-up");
      }

      outputPath = path.join("uploads", `syncup_${Date.now()}.mp4`);
      await downloadFile(videoUrl, outputPath);

      const savedVideo = await uploadResultToSupabase(
        outputPath,
        videoFile.originalname,
        ENGINE_FOLDER
      );

      const cleanupResult = await enforceVideoLimit(
        ENGINE_FOLDER,
        MAX_SYNCUP_VIDEOS
      );

      await updateJob(jobId, {
        status: "done",
        video_url: savedVideo.publicUrl,
        error_message: null
      });

      safeDelete(videoFile.path);
      safeDelete(audioFile.path);

      await destroyCloudinaryFile(cloudinaryVideo);
      await destroyCloudinaryFile(cloudinaryAudio);

      res.setHeader("x-job-id", jobId);
      res.setHeader("x-video-url", savedVideo.publicUrl || "");
      res.setHeader(
        "x-auto-deleted-count",
        String(cleanupResult.deleted.length)
      );

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

      await updateJob(jobId, {
        status: "error",
        error_message: err.message || "Erreur inconnue"
      });

      return res.status(500).json({
        error: "sync-up error",
        details: err.message || "Erreur inconnue",
        jobId
      });
    }
  }
);

app.listen(PORT, async () => {
  await sleep(200);
  console.log(`Sync-up server running on ${PORT}`);
});
