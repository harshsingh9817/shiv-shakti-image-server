# 🚀 Latest Update: PDF, Video Streaming & Mobile Support!

We are excited to announce a major upgrade to the **Shiv Shakti Image Server**. We've listened to your feedback, and the server now officially supports **PDF Documents, Video Streaming, and Mobile Apps (Flutter/Android)**!

---

## 📄 1. Native PDF & Document Support
You can now upload PDFs exactly the same way you upload images. 
The server will preserve the original quality and stream the PDF securely to the browser.
- **How to use**: Just pass the generated `recordId` and `securityKey` to the `/api/image/` endpoint as usual. The browser will automatically open it in its native PDF viewer instead of treating it as a broken image!

## 🎥 2. Highly Efficient Video Streaming (HTTP Range Support)
Uploading large videos? No problem! 
- **How it works**: The server now fully supports HTTP Range requests (`206 Partial Content`). 
- **What this means for you**: When your users watch a video, their player (like HTML5 `<video>` or Flutter's `video_player`) will automatically request the video in small chunks (e.g., 30-second buffers). 
- **The Benefit**: The server will seamlessly stream these chunks in the background directly from Telegram. This saves massive amounts of memory on your server and guarantees that videos start playing *instantly* without crashing.

## 📱 3. Mobile App Security (Flutter & Android)
For our mobile developers (especially Flutter & Android), we've added a dedicated section in our `SETUP_GUIDE.txt` detailing how to securely authenticate and load media within mobile apps!

Since mobile apps do not have a standard domain origin like a web browser, the "Referer" security check will fail. 
**How to use securely in Flutter:**
You MUST pass your Security Key directly in the URL:
```dart
final mediaUrl = "https://your-server.com/api/image/rec_12345?key=sec_abc123";

// For Images:
Image.network(mediaUrl);

// For Videos: 
// Pass `mediaUrl` directly to the video_player package. It will automatically handle chunked streaming!

// For PDFs:
// Pass `mediaUrl` directly to syncfusion_flutter_pdfviewer.
```

---
*Please check the newly updated `SETUP_GUIDE.txt` (Section 6.1) in the repository for full Flutter code examples.*
