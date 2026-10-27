DJ WHISTER 256 — STATUS HD BACKEND (FFmpeg MP4)

WHAT THIS PACKAGE DOES
- Preserves the Status HD WhatsApp activation/webhook endpoints.
- POST /api/compress accepts multipart/form-data with a video file field named "video", resolution (1080p, 720p, or 480p), and duration (30, 60, or full).
- Produces a finalized H.264/AAC MP4 with yuv420p and fast-start metadata, suitable for playback on most phones.
- POST /api/trim-to-size remains available from the existing backend code.
- Upload limit: 500 MB. The full-duration option is limited to source clips of 3 minutes or less to protect the service. For WhatsApp Status, select 30 or 60 seconds.

IMPORTANT ABOUT WHATSAPP HD
This backend produces a high-quality MP4, but cannot force WhatsApp to preserve every pixel/bitrate after upload. WhatsApp may recompress videos. When posting, select the HD option if WhatsApp shows it, and use a strong connection. 1080p does not mean a low-resolution source can become true HD; it avoids upscaling and preserves source aspect ratio.

DEPLOY TO RENDER
1. Unzip this package.
2. Put the package files at the root of a GitHub repository, then connect that repository to your existing Status HD Render web service (or create a new web service if you cannot change the existing source).
3. In Render, choose Docker as the runtime so Dockerfile installs FFmpeg. Do not set a separate build command. Start command comes from Dockerfile.
4. Keep the existing environment variables already configured for WhatsApp activation. Add/update ALLOWED_ORIGINS to include your website origin. Do not paste secrets into this file or a public repository.
5. Deploy and check https://YOUR-STATUS-HD.onrender.com/ . It should return JSON with status=ok and videoCompression=true.
6. Test the compressor from the website using a short video first.

ENVIRONMENT VARIABLES
- SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed for activation database features.
- WHATSAPP_VERIFY_TOKEN, META_APP_SECRET, and WHATSAPP_PHONE_NUMBER_ID are needed for WhatsApp Cloud API webhook activation.
- ALLOWED_ORIGINS should include https://djwhister256uganda.netlify.app. Add any other legitimate site origin separated by commas.

FRONTEND CONNECTION
The frontend must POST to:
https://YOUR-STATUS-HD.onrender.com/api/compress
as multipart/form-data with fields:
  video = selected video file
  resolution = 1080p (or 720p / 480p)
  duration = 30 (or 60 / full)
The response body is the MP4 file. The browser must download the response as a Blob; do not treat it as JSON on success.

SECURITY
Never expose SUPABASE_SERVICE_ROLE_KEY, META_APP_SECRET, or any API secret in HTML or public source code. Render's filesystem is temporary; this endpoint cleans up input and output files after each request. Video processing consumes CPU and memory, so large files may need a paid Render instance.
