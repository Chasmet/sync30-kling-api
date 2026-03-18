import express from "express";
import cors from "cors";
import multer from "multer";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// CONFIG
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_SYNCUP_VERSION = process.env.REPLICATE_SYNCUP_VERSION;

if (!SUPABASE_URL) {
  throw new Error("SUPABASE_URL manquante");
}
if (!SUPABASE_KEY) {
  throw new Error("SUPABASE_SERVICE_KEY manquante");
}
if (!REPLICATE_API_TOKEN) {
  throw new Error("REPLICATE_API_TOKEN manquante");
}
if (!REPLICATE_SYNCUP_VERSION) {
  throw new Error("REPLICATE_SYNCUP_VERSION manquante");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BUCKET = "videos";
const ENGINE_FOLDER = "syncup";
const MAX_VIDEOS_PER_USER = 3;
const MAX_VIDEO_AGE_HOURS = 24;
const jobs = new Map();

function getUserId(req) {
  return req.headers["x-user-id"] || "public";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildStoragePath(userId, fileName) {
  return `${userId}/${ENGINE_FOLDER}/${fileName}`;
}

function buildFolderPath(userId) {
  return `${userId}/${ENGINE_FOLDER}`;
}

function safeErrorMessage(error) {
  return error?.message || "Erreur inconnue";
}

function buildProxyPlayUrl(fileName) {
  return `/open-video/${encodeURIComponent(fileName)}`;
}

function buildProxyDownloadUrl(fileName) {
  return `/download-video/${encodeURIComponent(fileName)}`;
}

function safeDate(value) {
  const date = new Date(value || 0);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function sortByCreatedAtAsc(files = []) {
  return [...files].sort((a, b) => {
    return safeDate(a.created_at).getTime() - safeDate(b.created_at).getTime();
  });
}

function getExpiredFiles(files = []) {
  const now = Date.now();
  const maxAgeMs = MAX_VIDEO_AGE_HOURS * 60 * 60 * 1000;

  return files.filter((file) => {
    const createdAt = safeDate(file.created_at).getTime();
    return now - createdAt > maxAgeMs;
  });
}

function getOverflowFiles(files = []) {
  const sorted = sortByCreatedAtAsc(files);

  if (sorted.length <= MAX_VIDEOS_PER_USER) {
    return [];
  }

  return sorted.slice(0, sorted.length - MAX_VIDEOS_PER_USER);
}

async function listRawVideos(userId) {
  const folder = buildFolderPath(userId);

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .list(folder, {
      limit: 100,
      sortBy: { column: "created_at", order: "desc" }
    });

  if (error) {
    throw error;
  }

  return data || [];
}

async function deleteStoredVideo(userId, fileName) {
  const filePath = buildStoragePath(userId, fileName);

  const { error } = await supabase.storage
    .from(BUCKET)
    .remove([filePath]);

  if (error) {
    throw error;
  }
}

async function enforceVideoRetention(userId) {
  if (!userId) return;

  const rawFiles = await listRawVideos(userId);

  const expiredFiles = getExpiredFiles(rawFiles);
  const expiredNames = new Set(expiredFiles.map((file) => file.name));

  const freshFiles = rawFiles.filter((file) => !expiredNames.has(file.name));
  const overflowFiles = getOverflowFiles(freshFiles);

  const filesToDelete = [
    ...expiredFiles,
    ...overflowFiles.filter((file) => !expiredNames.has(file.name))
  ];

  for (const file of filesToDelete) {
    try {
      await deleteStoredVideo(userId, file.name);
    } catch (error) {
      console.error("RETENTION DELETE ERROR:", file.name, error.message);
    }
  }
}

async function getUserVideos(userId) {
  await enforceVideoRetention(userId);

  const data = await listRawVideos(userId);

  return data.map((file) => ({
    name: file.name,
    playUrl: buildProxyPlayUrl(file.name),
    downloadUrl: buildProxyDownloadUrl(file.name),
    created_at: file.created_at,
    metadata: file.metadata
  }));
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "Sync30 API active",
    engine: "syncup",
    modeInfo: "async job polling via Replicate",
    storageMode: "per-user",
    bucket: BUCKET,
    retention: {
      maxVideosPerUser: MAX_VIDEOS_PER_USER,
      maxAgeHours: MAX_VIDEO_AGE_HOURS
    }
  });
});

// 1) Lance le job
app.post(
  "/sync",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "audio", maxCount: 1 }
  ]),
  async (req, res) => {
    try {
      const userId = getUserId(req);

      const videoFile = req.files?.video?.[0];
      const audioFile = req.files?.audio?.[0];

      if (!videoFile || !audioFile) {
        return res.status(400).json({
          ok: false,
          error: "Fichiers manquants"
        });
      }

      const replicateResponse = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: {
          Authorization: `Token ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          version: REPLICATE_SYNCUP_VERSION,
          input: {
            video: `data:${videoFile.mimetype};base64,${videoFile.buffer.toString("base64")}`,
            audio: `data:${audioFile.mimetype};base64,${audioFile.buffer.toString("base64")}`
          }
        })
      });

      const prediction = await replicateResponse.json();

      if (!replicateResponse.ok || !prediction?.id || !prediction?.urls?.get) {
        return res.status(500).json({
          ok: false,
          error: prediction?.detail || prediction?.error || "Erreur lancement Replicate"
        });
      }

      jobs.set(prediction.id, {
        userId,
        engine: ENGINE_FOLDER,
        status: "starting",
        createdAt: new Date().toISOString(),
        replicateGetUrl: prediction.urls.get,
        outputUrl: null,
        storedFilePath: null,
        fileName: null,
        error: null
      });

      return res.json({
        ok: true,
        jobId: prediction.id,
        status: prediction.status || "starting"
      });
    } catch (error) {
      console.error("SYNC START ERROR:", error);
      return res.status(500).json({
        ok: false,
        error: safeErrorMessage(error)
      });
    }
  }
);

// 2) Vérifie l’état du job
app.get("/sync-status/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = getUserId(req);

    const job = jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,
        error: "Job introuvable"
      });
    }

    if (job.userId !== userId) {
      return res.status(403).json({
        ok: false,
        error: "Accès refusé"
      });
    }

    if (job.status === "succeeded") {
      return res.json({
        ok: true,
        status: "succeeded",
        playUrl: buildProxyPlayUrl(job.fileName),
        downloadUrl: buildProxyDownloadUrl(job.fileName),
        fileName: job.fileName
      });
    }

    if (job.status === "failed") {
      return res.json({
        ok: true,
        status: "failed",
        error: job.error || "Le traitement a échoué"
      });
    }

    const poll = await fetch(job.replicateGetUrl, {
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`
      }
    });

    const data = await poll.json();

    console.log(`SYNC-UP prediction status: ${data.status}`);

    if (data.status === "starting" || data.status === "processing") {
      job.status = data.status;
      jobs.set(jobId, job);

      return res.json({
        ok: true,
        status: data.status
      });
    }

    if (data.status === "failed" || data.status === "canceled") {
      job.status = "failed";
      job.error = data?.error || "Replicate a échoué";
      jobs.set(jobId, job);

      return res.json({
        ok: true,
        status: "failed",
        error: job.error
      });
    }

    if (data.status === "succeeded") {
      const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;

      if (!outputUrl) {
        job.status = "failed";
        job.error = "Aucune vidéo de sortie";
        jobs.set(jobId, job);

        return res.json({
          ok: true,
          status: "failed",
          error: job.error
        });
      }

      if (!job.storedFilePath) {
        const generatedVideoResponse = await fetch(outputUrl);

        if (!generatedVideoResponse.ok) {
          throw new Error("Impossible de télécharger la vidéo générée");
        }

        const generatedVideoArrayBuffer = await generatedVideoResponse.arrayBuffer();
        const generatedVideoBuffer = Buffer.from(generatedVideoArrayBuffer);

        const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
        const filePath = buildStoragePath(userId, fileName);

        const { error: uploadError } = await supabase.storage
          .from(BUCKET)
          .upload(filePath, generatedVideoBuffer, {
            contentType: "video/mp4",
            upsert: false
          });

        if (uploadError) {
          throw uploadError;
        }

        job.outputUrl = outputUrl;
        job.storedFilePath = filePath;
        job.fileName = fileName;

        // Rétention après sauvegarde
        await enforceVideoRetention(userId);
      }

      job.status = "succeeded";
      jobs.set(jobId, job);

      return res.json({
        ok: true,
        status: "succeeded",
        playUrl: buildProxyPlayUrl(job.fileName),
        downloadUrl: buildProxyDownloadUrl(job.fileName),
        fileName: job.fileName
      });
    }

    return res.json({
      ok: true,
      status: data.status || "processing"
    });
  } catch (error) {
    console.error("SYNC STATUS ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// 3) Liste des vidéos du compte
app.get("/videos", async (req, res) => {
  try {
    const userId = getUserId(req);
    const videos = await getUserVideos(userId);

    return res.json({ ok: true, videos });
  } catch (error) {
    console.error("VIDEOS ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// 4) Ouvrir la vidéo via Render
app.get("/open-video/:name", async (req, res) => {
  try {
    const userId = getUserId(req);
    const fileName = req.params.name;

    if (!fileName) {
      return res.status(400).json({
        ok: false,
        error: "Nom de fichier manquant"
      });
    }

    const filePath = buildStoragePath(userId, fileName);

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(filePath);

    if (error || !data) {
      return res.status(404).json({
        ok: false,
        error: "Vidéo introuvable"
      });
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Cache-Control", "no-store");
    return res.send(buffer);
  } catch (error) {
    console.error("OPEN VIDEO ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// 5) Télécharger la vidéo via Render
app.get("/download-video/:name", async (req, res) => {
  try {
    const userId = getUserId(req);
    const fileName = req.params.name;

    if (!fileName) {
      return res.status(400).json({
        ok: false,
        error: "Nom de fichier manquant"
      });
    }

    const filePath = buildStoragePath(userId, fileName);

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .download(filePath);

    if (error || !data) {
      return res.status(404).json({
        ok: false,
        error: "Vidéo introuvable"
      });
    }

    const arrayBuffer = await data.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.setHeader("Cache-Control", "no-store");
    return res.send(buffer);
  } catch (error) {
    console.error("DOWNLOAD VIDEO ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// 6) Suppression
app.post("/delete-video", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "Nom manquant"
      });
    }

    await deleteStoredVideo(userId, name);

    return res.json({ ok: true });
  } catch (error) {
    console.error("DELETE ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// nettoyage jobs > 24h
setInterval(() => {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    const created = new Date(job.createdAt).getTime();
    if (!Number.isNaN(created) && now - created > 24 * 60 * 60 * 1000) {
      jobs.delete(jobId);
    }
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sync-up server running on ${PORT}`);
});
