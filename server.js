import express from "express";
import cors from "cors";
import multer from "multer";
import fetch from "node-fetch";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

// CONFIG
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const BUCKET = "videos";
const ENGINE_FOLDER = "syncup";

// user util
function getUserId(req) {
  return req.headers["x-user-id"] || "public";
}

// wake
app.get("/", (req, res) => {
  res.send("Server Sync-up OK");
});

// sync route
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
        return res.status(400).json({ error: "Fichiers manquants" });
      }

      // Ici on garde ton pipeline Replicate/Sync-up existant
      // Si ton modèle exact est différent, garde sa version actuelle
      const replicateResponse = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: {
          Authorization: `Token ${REPLICATE_API_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          version: process.env.REPLICATE_SYNCUP_VERSION,
          input: {
            video: `data:${videoFile.mimetype};base64,${videoFile.buffer.toString("base64")}`,
            audio: `data:${audioFile.mimetype};base64,${audioFile.buffer.toString("base64")}`
          }
        })
      });

      const prediction = await replicateResponse.json();

      if (!prediction?.urls?.get) {
        throw new Error(prediction?.detail || prediction?.error || "Erreur lancement Replicate");
      }

      let outputUrl = null;

      for (let i = 0; i < 60; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const poll = await fetch(prediction.urls.get, {
          headers: {
            Authorization: `Token ${REPLICATE_API_TOKEN}`
          }
        });

        const data = await poll.json();

        if (data.status === "succeeded") {
          outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
          break;
        }

        if (data.status === "failed" || data.status === "canceled") {
          throw new Error("Replicate a échoué");
        }
      }

      if (!outputUrl) {
        throw new Error("Timeout Replicate");
      }

      // Télécharger la vidéo générée
      const generatedVideoResponse = await fetch(outputUrl);
      const generatedVideoArrayBuffer = await generatedVideoResponse.arrayBuffer();
      const generatedVideoBuffer = Buffer.from(generatedVideoArrayBuffer);

      // stockage multi-user compatible
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
      const filePath = `${userId}/${ENGINE_FOLDER}/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(filePath, generatedVideoBuffer, {
          contentType: "video/mp4",
          upsert: false
        });

      if (uploadError) {
        throw uploadError;
      }

      const { data: publicUrlData } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(filePath);

      // compatibilité avec ton frontend actuel :
      // pour syncup on renvoie le blob vidéo direct
      const directVideoResponse = await fetch(publicUrlData.publicUrl);
      const directVideoBuffer = await directVideoResponse.arrayBuffer();

      res.setHeader("Content-Type", "video/mp4");
      res.send(Buffer.from(directVideoBuffer));
    } catch (error) {
      console.error("SYNC ERROR:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

// list videos
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

    res.json({ ok: true, videos });
  } catch (error) {
    console.error("VIDEOS ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// delete video
app.post("/delete-video", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ ok: false, error: "Nom manquant" });
    }

    const filePath = `${userId}/${ENGINE_FOLDER}/${name}`;

    const { error } = await supabase.storage
      .from(BUCKET)
      .remove([filePath]);

    if (error) {
      throw error;
    }

    res.json({ ok: true });
  } catch (error) {
    console.error("DELETE ERROR:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Sync-up server running on port ${PORT}`);
});
