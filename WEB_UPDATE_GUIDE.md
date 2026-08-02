# 🌐 Web Developer Update Guide: PDF & Video Support

We have upgraded the media server! It is no longer just for images. The server now natively supports **PDF Documents** and highly efficient **Video Streaming**. 

Here is what changed and how you can adapt your web applications to use these new features.

---

## 1. Video Streaming (Chunk-based)
**What changed:** The server now fully supports HTTP Range requests (`206 Partial Content`). Previously, the server would download an entire video into memory before sending it to the client. Now, it streams the video in small chunks (e.g., 30-second buffers).
**How to adapt:** 
You don't need any complex JavaScript! Because we use standard HTTP Range streaming, HTML5 handles everything automatically.

```html
<!-- Simply use the standard HTML5 video tag -->
<video controls width="640">
  <source src="https://your-server.com/api/image/rec_12345?key=sec_abc123" type="video/mp4">
  Your browser does not support the video tag.
</video>
```
*Note: The browser will automatically request chunks of the video as the user watches, saving bandwidth and server memory.*

---

## 2. Native PDF Support
**What changed:** The server now accurately returns the `application/pdf` MIME type instead of treating everything as a JPEG image.
**How to adapt:**
You can now embed PDFs natively in the browser without them breaking.

```html
<!-- Option A: Open in a new tab -->
<a href="https://your-server.com/api/image/rec_12345?key=sec_abc123" target="_blank">
  View PDF Document
</a>

<!-- Option B: Embed directly on the page using iframe -->
<iframe 
  src="https://your-server.com/api/image/rec_12345?key=sec_abc123" 
  width="100%" 
  height="600px">
</iframe>
```

## 3. Uploading Files
Uploading remains completely unchanged. You can upload PDFs and Videos using the exact same `/api/upload` endpoint you used for images. The server automatically detects the file type.
