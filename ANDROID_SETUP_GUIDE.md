# 📱 Android Setup Guide: Viewing & Streaming

Welcome to the Shiv Shakti Image Server Android documentation. 

**IMPORTANT NOTE:** Mobile applications (like Android apps) are currently supported for **Streaming and Viewing only**. Uploading files directly from the Android app is not supported by the default security model (you should handle uploads via your own secure backend server).

---

## 1. Authentication Setup
Since mobile apps do not have a web domain, the server's standard "Referer Check" will reject your requests. 
To authenticate, you **MUST** pass your Web Connection's `Security Key` directly in the URL as a query parameter.

**The Base URL Format:**
```
https://your-server.com/api/image/{RECORD_ID}?key={SECURITY_KEY}
```

## 2. Viewing Images (Glide / Picasso)
You can use standard image loading libraries like Glide or Picasso. Just pass the authenticated URL.

**Using Glide:**
```java
String mediaUrl = "https://your-server.com/api/image/rec_12345?key=sec_abc123";

Glide.with(context)
     .load(mediaUrl)
     .into(imageView);
```

## 3. Streaming Videos (ExoPlayer)
The server fully supports **HTTP Range Requests**. This is perfect for Android! 
When you pass the media URL to ExoPlayer, it will automatically request the video in small chunks (e.g., buffering 30 seconds at a time) instead of trying to download the entire file. This prevents OutOfMemory errors and starts playback instantly.

**Using ExoPlayer:**
```java
String mediaUrl = "https://your-server.com/api/image/rec_12345?key=sec_abc123";

ExoPlayer player = new ExoPlayer.Builder(context).build();
playerView.setPlayer(player);

MediaItem mediaItem = MediaItem.fromUri(mediaUrl);
player.setMediaItem(mediaItem);
player.prepare();
player.play();
```
*Note: ExoPlayer automatically handles the chunked HTTP Range streaming in the background!*

## 4. Viewing PDFs
To view PDFs natively inside your Android app, you can use a library like `AndroidPdfViewer` or download the file stream and render it.

**Using an Intent (Easiest Method):**
```java
String mediaUrl = "https://your-server.com/api/image/rec_12345?key=sec_abc123";
Intent intent = new Intent(Intent.ACTION_VIEW);
intent.setDataAndType(Uri.parse(mediaUrl), "application/pdf");
startActivity(intent);
```
