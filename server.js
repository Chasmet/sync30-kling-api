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

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BUCKET = "videos";
const ENGINE_FOLDER = "syncup";

// mémoire simple des jobs en cours
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

function safeErrorMessage(error) {
  return error?.message || "Erreur inconnue";
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "Sync30 API active",
    engine: "syncup",
    modeInfo: "async job polling via Replicate",
    storageMode: "per-user"
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

      if (!REPLICATE_SYNCUP_VERSION) {
        return res.status(500).json({
          ok: false,
          error: "REPLICATE_SYNCUP_VERSION manquante"
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

    // Si déjà fini, renvoie directement
    if (job.status === "succeeded") {
      const { data: urlData } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(job.storedFilePath);

      return res.json({
        ok: true,
        status: "succeeded",
        playUrl: urlData.publicUrl,
        downloadUrl: urlData.publicUrl,
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

    // Interroge Replicate
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

      // éviter double upload si déjà fait
      if (!job.storedFilePath) {
        const generatedVideoResponse = await fetch(outputUrl);
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
      }

      job.status = "succeeded";
      jobs.set(jobId, job);

      const { data: urlData } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(job.storedFilePath);

      return res.json({
        ok: true,
        status: "succeeded",
        playUrl: urlData.publicUrl,
        downloadUrl: urlData.publicUrl,
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
    const folder = `${userId}/${ENGINE_FOLDER}`;

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .list(folder, {
        limit: 100,
        sortBy: { column: "created_at", order: "desc" }
      });

    if (error) {
      throw error;
    }

    const videos = (data || []).map((file) => {
      const filePath = `${folder}/${file.name}`;
      const { data: urlData } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(filePath);

      return {
        name: file.name,
        playUrl: urlData.publicUrl,
        downloadUrl: urlData.publicUrl,
        created_at: file.created_at,
        metadata: file.metadata
      };
    });

    return res.json({ ok: true, videos });
  } catch (error) {
    console.error("VIDEOS ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// 4) Suppression
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

    const filePath = `${userId}/${ENGINE_FOLDER}/${name}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .remove([filePath]);

    if (error) {
      throw error;
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error("DELETE ERROR:", error);
    return res.status(500).json({
      ok: false,
      error: safeErrorMessage(error)
    });
  }
});

// nettoyage simple des jobs vieux de plus de 24h
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
